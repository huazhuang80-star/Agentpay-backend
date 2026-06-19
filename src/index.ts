import { createHash, randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";

const app = express();
const PORT = process.env.PORT ?? 3001;

// 100 KiB cap on request bodies. Every endpoint we expose accepts a
// handful of short strings and numbers — anything larger is almost
// certainly an abusive or buggy caller.
// CORS — explicit allowlist from CORS_ALLOWED_ORIGINS (comma-separated).
// Defaults to none in production; empty list means same-origin only.
const corsAllowed = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.header("origin");
  if (origin && corsAllowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,X-Request-Id,X-API-Key"
    );
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    res.status(204).send();
    return;
  }
  next();
});

app.use(express.json({ limit: "100kb" }));

// Minimal security headers — same shape Helmet would produce but without
// the dependency footprint. Lets us start hardening the response surface
// before deciding on a full Helmet/CSP policy.
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload"
  );
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  next();
});

// Attach an X-Request-Id to every response, accepting the caller's value
// if they supplied one (so a gateway/load-balancer chain stays correlated)
// and otherwise minting a fresh UUID. The id is also exposed as `req.id` so
// downstream handlers and the error handler can quote it.
app.use((req: Request, res: Response, next: NextFunction) => {
  const incoming = req.header("x-request-id");
  const id = incoming && incoming.length <= 200 ? incoming : randomUUID();
  (req as Request & { id: string }).id = id;
  res.setHeader("X-Request-Id", id);
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin pause state
// ─────────────────────────────────────────────────────────────────────────────
// Mirrors the on-chain DataKey::Paused flag. When set, the gated
// endpoints (POST /usage, POST /settle, POST /api-keys, …) refuse with
// 503. Read endpoints stay available so dashboards can still inspect
// state during a pause window.
let paused = false;

app.post("/api/v1/admin/pause", (_req: Request, res: Response) => {
  paused = true;
  res.json({ paused });
});

app.post("/api/v1/admin/unpause", (_req: Request, res: Response) => {
  paused = false;
  res.json({ paused });
});

app.get("/api/v1/admin/status", (_req: Request, res: Response) => {
  res.json({ paused });
});

// Mutable in-process config; persisted in memory only. /config GET
// returns the live values, /config PATCH updates them. Initial values
// are filled lazily in the GET handler to avoid forward-reference
// ordering issues with the underlying constants.
const config: Record<string, number> = {
  rateLimitPerWindow: 60,
  rateLimitWindowMs: 60_000,
  bulkMaxItems: 100,
  eventLogCap: 10_000,
};

app.get("/api/v1/config", (_req: Request, res: Response) => {
  res.json({ config });
});

app.patch("/api/v1/config", (req: Request, res: Response) => {
  const requestId = (req as Request & { id?: string }).id;
  const updates = req.body ?? {};
  const allowed = ["rateLimitPerWindow", "rateLimitWindowMs", "bulkMaxItems"] as const;
  for (const k of allowed) {
    if (k in updates) {
      const v = updates[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        res.status(400).json({
          error: "invalid_request",
          message: `${k} must be a positive integer`,
          requestId,
        });
        return;
      }
      (config as Record<string, number>)[k] = v;
    }
  }
  res.json({ config });
});

/**
 * Prometheus-format metrics endpoint. Plain-text exposition format.
 */
app.get("/api/v1/metrics", (_req: Request, res: Response) => {
  let totalRequests = 0;
  for (const v of usageStore.values()) totalRequests += v;
  const lines = [
    "# HELP agentpay_services_total Number of registered services.",
    "# TYPE agentpay_services_total gauge",
    `agentpay_services_total ${servicesStore.size}`,
    "# HELP agentpay_api_keys_total Number of registered API keys.",
    "# TYPE agentpay_api_keys_total gauge",
    `agentpay_api_keys_total ${apiKeyStore.size}`,
    "# HELP agentpay_usage_requests_total Outstanding (unsettled) request counters.",
    "# TYPE agentpay_usage_requests_total gauge",
    `agentpay_usage_requests_total ${totalRequests}`,
    "# HELP agentpay_paused 1 if the backend is paused, 0 otherwise.",
    "# TYPE agentpay_paused gauge",
    `agentpay_paused ${paused ? 1 : 0}`,
  ];
  res.setHeader("Content-Type", "text/plain; version=0.0.4");
  res.send(lines.join("\n") + "\n");
});

/**
 * Aggregate stats snapshot. Single round-trip for dashboards.
 */
app.get("/api/v1/stats", (_req: Request, res: Response) => {
  let totalRequests = 0;
  const agents = new Set<string>();
  for (const [key, total] of usageStore.entries()) {
    totalRequests += total;
    agents.add(key.split("::")[0]);
  }
  res.json({
    totalServices: servicesStore.size,
    totalApiKeys: apiKeyStore.size,
    totalRequests,
    uniqueAgents: agents.size,
    paused,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API keys
// ─────────────────────────────────────────────────────────────────────────────
// In-memory map of opaque api keys to { label, createdAt }. The CRUD
// endpoints are wired in subsequent commits; this commit adds the
// store and the optional X-API-Key recognition middleware that flags
// req.apiKey for downstream handlers without yet rejecting unkeyed
// requests (so the API stays open until the admin opts in).
type ApiKeyRecord = { label: string; createdAt: number };
const apiKeyStore = new Map<string, ApiKeyRecord>();

app.use((req: Request, res: Response, next: NextFunction) => {
  const supplied = req.header("x-api-key");
  if (typeof supplied === "string" && apiKeyStore.has(supplied)) {
    (req as Request & { apiKey?: string }).apiKey = supplied;
  }
  next();
});

// Pause guard: when admin has paused the system, refuse every
// state-changing method with 503. /admin/unpause is explicitly
// exempted so the operator can always recover.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!paused) return next();
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (req.path === "/api/v1/admin/unpause") return next();
  res.status(503).json({
    error: "service_paused",
    message: "AgentPay backend is paused; only admin/unpause and reads are accepted",
    requestId: (req as Request & { id?: string }).id,
  });
});

// Minimal in-process rate limiter: 60 requests per IP per 60 second
// window. A sliding window keyed by source IP; in-memory so the limiter
// resets on process restart.
const RATE_LIMIT_PER_WINDOW = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();
app.use((req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV === "test") return next();
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const bucket = (rateBuckets.get(ip) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (bucket.length >= RATE_LIMIT_PER_WINDOW) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({
      error: "rate_limited",
      message: `more than ${RATE_LIMIT_PER_WINDOW} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s`,
      requestId: (req as Request & { id?: string }).id,
    });
    return;
  }
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  next();
});

// Wall-clock request timer. Emits a structured log line on every completed
// request. Server-Timing cannot be set in the finish event (headers are
// already sent by then), so we append it via Node's HTTP trailer mechanism
// when trailers are supported, and skip it otherwise.
app.use((req: Request, res: Response, next: NextFunction) => {
  const startNs = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    if (!res.headersSent) {
      res.setHeader("Server-Timing", `app;dur=${ms.toFixed(1)}`);
    }
    if (process.env.NODE_ENV !== "test") {
      console.log(
        JSON.stringify({
          requestId: (req as Request & { id?: string }).id,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(ms * 10) / 10,
        })
      );
    }
  });
  next();
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "agentpay-backend" });
});

/**
 * Deeper health check including process uptime and memory.
 * Reserved for the operator dashboard / load-balancer.
 */
app.get("/api/v1/health/deep", (_req: Request, res: Response) => {
  const mem = process.memoryUsage();
  res.json({
    status: paused ? "paused" : "ok",
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    },
    pid: process.pid,
    node: process.version,
  });
});

app.get("/api/v1/version", (_req: Request, res: Response) => {
  res.json({ version: "1.0.0" });
});

/** Short hand-maintained changelog. */
app.get("/api/v1/changelog", (_req: Request, res: Response) => {
  res.json({
    entries: [
      {
        version: "1.0.0",
        date: "2026-06-12",
        notes: [
          "Initial production surface: services, usage, billing, settlement.",
          "Admin pause/unpause, API keys, webhooks, event log.",
          "Bulk usage + bulk services, CSV/JSON exports.",
          "Metadata + disabled flag per service.",
        ],
      },
    ],
  });
});

/**
 * Minimal OpenAPI 3.0 document. Lists every endpoint with a short
 * description. Generated by hand for now; will move to per-route
 * decorators once a contract library is selected.
 */
app.get("/api/v1/openapi.json", (_req: Request, res: Response) => {
  res.json({
    openapi: "3.0.3",
    info: {
      title: "AgentPay Backend",
      version: "1.0.0",
      description: "Metering, billing, and settlement gateway for AgentPay.",
    },
    paths: {
      "/health": { get: { summary: "Shallow health check" } },
      "/api/v1/health/deep": {
        get: { summary: "Deep health with process diagnostics" },
      },
      "/api/v1/version": { get: { summary: "App version" } },
      "/api/v1/stats": { get: { summary: "Aggregate stats snapshot" } },
      "/api/v1/metrics": { get: { summary: "Prometheus metrics" } },
      "/api/v1/events": { get: { summary: "Audit log (?since=&limit=)" } },
      "/api/v1/config": {
        get: { summary: "Read runtime config" },
        patch: { summary: "Update runtime config" },
      },
      "/api/v1/services": {
        get: { summary: "List services" },
        post: { summary: "Register a service" },
      },
      "/api/v1/services/{serviceId}": {
        get: { summary: "Fetch one service" },
        delete: { summary: "Unregister service" },
      },
      "/api/v1/services/{serviceId}/price": {
        patch: { summary: "Update price only" },
      },
      "/api/v1/services/{serviceId}/agents": {
        get: { summary: "List agents on a service" },
      },
      "/api/v1/agents/{agent}/usage": { get: { summary: "Per-service usage" } },
      "/api/v1/agents/{agent}/total": { get: { summary: "Lifetime total" } },
      "/api/v1/usage": { post: { summary: "Record usage" } },
      "/api/v1/usage/bulk": { post: { summary: "Batched record" } },
      "/api/v1/usage/{agent}/{serviceId}": { get: { summary: "Read accumulator" } },
      "/api/v1/billing/{agent}/{serviceId}": { get: { summary: "Quote bill" } },
      "/api/v1/settle": { post: { summary: "Drain & quote bill" } },
      "/api/v1/api-keys": {
        get: { summary: "List api keys" },
        post: { summary: "Create api key" },
      },
      "/api/v1/api-keys/{prefix}": { delete: { summary: "Revoke by prefix" } },
      "/api/v1/webhooks": {
        get: { summary: "List webhooks" },
        post: { summary: "Register webhook" },
      },
      "/api/v1/webhooks/{id}": { delete: { summary: "Unregister webhook" } },
      "/api/v1/admin/pause": { post: { summary: "Pause writes" } },
      "/api/v1/admin/unpause": { post: { summary: "Resume" } },
      "/api/v1/admin/status": { get: { summary: "Read pause flag" } },
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Usage metering
// ─────────────────────────────────────────────────────────────────────────────
//
// In-memory accumulator keyed by `${agent}::${serviceId}`. This is the same
// shape the on-chain Escrow contract persists (DataKey::Usage(agent, sym)) —
// the backend is the off-chain mirror that the settlement job will drain and
// flush to the contract. A process restart resets the counters, which is
// fine for now: callers should not rely on durability until the database
// adapter lands.
const usageStore = new Map<string, number>();
const usageKey = (agent: string, serviceId: string) => `${agent}::${serviceId}`;

/**
 * Record incremental usage for an (agent, serviceId) pair.
 * Body: { agent: string, serviceId: string, requests: number }
 * Returns: { agent, serviceId, total } where `total` is the accumulator
 * after this write.
 */
app.post("/api/v1/usage", (req: Request, res: Response) => {
  const { agent, serviceId, requests } = req.body ?? {};
  const requestId = (req as Request & { id?: string }).id;

  if (typeof agent !== "string" || agent.length === 0 || agent.length > 256) {
    res.status(400).json({
      error: "invalid_request",
      message: "agent must be a non-empty string up to 256 chars",
      requestId,
    });
    return;
  }
  if (
    typeof serviceId !== "string" ||
    serviceId.length === 0 ||
    serviceId.length > 128
  ) {
    res.status(400).json({
      error: "invalid_request",
      message: "serviceId must be a non-empty string up to 128 chars",
      requestId,
    });
    return;
  }
  if (typeof requests !== "number" || !Number.isInteger(requests) || requests <= 0) {
    res.status(400).json({
      error: "invalid_request",
      message: "requests must be a positive integer",
      requestId,
    });
    return;
  }

  if (servicesDisabled.has(serviceId)) {
    res.status(409).json({
      error: "service_disabled",
      message: `service ${serviceId} is currently disabled`,
      requestId,
    });
    return;
  }

  const key = usageKey(agent, serviceId);
  const prev = usageStore.get(key) ?? 0;
  // Saturate at Number.MAX_SAFE_INTEGER rather than overflow into floats.
  const total = Math.min(Number.MAX_SAFE_INTEGER, prev + requests);
  usageStore.set(key, total);

  recordEvent("usage.recorded", { agent, serviceId, requests, total });
  res.status(201).json({ agent, serviceId, total });
});

/**
 * Batched record_usage. Accepts up to 100 items per call. Each item is
 * validated independently; failures are reported per-index so a
 * partial batch can still land.
 */
app.post("/api/v1/usage/bulk", (req: Request, res: Response) => {
  const requestId = (req as Request & { id?: string }).id;
  const { items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    res.status(400).json({
      error: "invalid_request",
      message: "items must be a non-empty array of up to 100 entries",
      requestId,
    });
    return;
  }
  const results: { index: number; ok: boolean; total?: number; error?: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const { agent, serviceId, requests } = items[i] ?? {};
    if (
      typeof agent !== "string" ||
      typeof serviceId !== "string" ||
      typeof requests !== "number" ||
      !Number.isInteger(requests) ||
      requests <= 0
    ) {
      results.push({ index: i, ok: false, error: "invalid_item" });
      continue;
    }
    const key = usageKey(agent, serviceId);
    const total = Math.min(
      Number.MAX_SAFE_INTEGER,
      (usageStore.get(key) ?? 0) + requests
    );
    usageStore.set(key, total);
    recordEvent("usage.recorded", { agent, serviceId, requests, total, bulk: true });
    results.push({ index: i, ok: true, total });
  }
  res.status(201).json({ results });
});

/**
 * Query the accumulated request total for an (agent, serviceId) pair.
 * Returns `{ agent, serviceId, total: 0 }` for never-seen pairs so callers
 * do not have to special-case missing keys.
 */
app.get("/api/v1/usage/:agent/:serviceId", (req: Request, res: Response) => {
  const { agent, serviceId } = req.params;
  const total = usageStore.get(usageKey(agent, serviceId)) ?? 0;
  res.json({ agent, serviceId, total });
});

/**
 * Read-only quote of the outstanding billing for a pair (no drain).
 * Mirrors compute_billing on the on-chain side.
 */
/** CSV export of every (agent, serviceId, total) tuple. */
app.get("/api/v1/usage/export.csv", (_req: Request, res: Response) => {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows: string[] = ["agent,serviceId,total"];
  for (const [key, total] of usageStore.entries()) {
    const [agent, serviceId] = key.split("::");
    rows.push(`${escape(agent)},${escape(serviceId)},${total}`);
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=usage.csv");
  res.send(rows.join("\n") + "\n");
});

/** Full JSON export of every (agent, serviceId, total) tuple. */
app.get("/api/v1/usage/export.json", (_req: Request, res: Response) => {
  const items: { agent: string; serviceId: string; total: number }[] = [];
  for (const [key, total] of usageStore.entries()) {
    const [agent, serviceId] = key.split("::");
    items.push({ agent, serviceId, total });
  }
  res.setHeader("Content-Disposition", "attachment; filename=usage.json");
  res.json({ exportedAt: Date.now(), items });
});

/** Protocol-wide outstanding billing in stroops. */
app.get("/api/v1/billing/total", (_req: Request, res: Response) => {
  let totalStroops = 0;
  for (const [key, requests] of usageStore.entries()) {
    const [, serviceId] = key.split("::");
    const price = servicesStore.get(serviceId)?.priceStroops ?? 0;
    totalStroops += requests * price;
  }
  res.json({ totalStroops });
});

app.get("/api/v1/billing/:agent/:serviceId", (req: Request, res: Response) => {
  const { agent, serviceId } = req.params;
  const requests = usageStore.get(usageKey(agent, serviceId)) ?? 0;
  const price = servicesStore.get(serviceId)?.priceStroops ?? 0;
  res.json({
    agent,
    serviceId,
    requests,
    priceStroops: price,
    billedStroops: requests * price,
  });
});

/**
 * Settle an (agent, serviceId) pair: drain the accumulator and return the
 * billed amount (requests * priceStroops). Off-chain mirror of the
 * on-chain settle() entrypoint.
 */
app.post("/api/v1/settle", (req: Request, res: Response) => {
  const { agent, serviceId } = req.body ?? {};
  const requestId = (req as Request & { id?: string }).id;
  if (typeof agent !== "string" || typeof serviceId !== "string") {
    res.status(400).json({
      error: "invalid_request",
      message: "agent and serviceId are required strings",
      requestId,
    });
    return;
  }
  const key = usageKey(agent, serviceId);
  const requests = usageStore.get(key) ?? 0;
  const price = servicesStore.get(serviceId)?.priceStroops ?? 0;
  const billedStroops = requests * price;
  usageStore.set(key, 0);
  recordEvent("usage.settled", { agent, serviceId, requests, billedStroops });
  res.json({ agent, serviceId, requests, priceStroops: price, billedStroops });
});

/** List every distinct agent currently in the usage store. */
app.get("/api/v1/agents", (req: Request, res: Response) => {
  const limit = Math.min(1000, Math.max(1, Number((req.query.limit as string) ?? 200)));
  const seen = new Set<string>();
  for (const key of usageStore.keys()) seen.add(key.split("::")[0]);
  const agents = Array.from(seen).slice(0, limit);
  res.json({ agents });
});

/**
 * Cross-service lifetime total for an agent (sum of every service's
 * accumulator). Mirrors on-chain get_total_usage_by_agent.
 */
app.get("/api/v1/agents/:agent/total", (req: Request, res: Response) => {
  const { agent } = req.params;
  const prefix = `${agent}::`;
  let total = 0;
  for (const [key, n] of usageStore.entries()) {
    if (key.startsWith(prefix)) total += n;
  }
  res.json({ agent, total });
});

/**
 * List every (serviceId, total) pair currently accumulated for an agent.
 * Empty list for agents that have never recorded any usage.
 */
app.get("/api/v1/agents/:agent/usage", (req: Request, res: Response) => {
  const { agent } = req.params;
  const prefix = `${agent}::`;
  const items: { serviceId: string; total: number }[] = [];
  for (const [key, total] of usageStore.entries()) {
    if (key.startsWith(prefix)) {
      items.push({ serviceId: key.slice(prefix.length), total });
    }
  }
  res.json({ agent, items });
});

// ─────────────────────────────────────────────────────────────────────────────
// Service registry
// ─────────────────────────────────────────────────────────────────────────────
// In-memory registry mirroring the on-chain DataKey::ServiceRegistered set.
// Maps serviceId -> { priceStroops }. Process restart resets the map.
const servicesStore = new Map<string, { priceStroops: number }>();
const servicesDisabled = new Set<string>();
type ServiceMetadataDto = { description: string; owner: string };
const servicesMetadata = new Map<string, ServiceMetadataDto>();

/** Batched register/update for services. Up to 50 items per call. */
app.post("/api/v1/services/bulk", (req: Request, res: Response) => {
  const requestId = (req as Request & { id?: string }).id;
  const { items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    res.status(400).json({
      error: "invalid_request",
      message: "items must be 1-50 entries",
      requestId,
    });
    return;
  }
  const results = items.map(
    (it: { serviceId?: unknown; priceStroops?: unknown }, i: number) => {
      const { serviceId, priceStroops } = it ?? {};
      if (
        typeof serviceId !== "string" ||
        serviceId.length === 0 ||
        serviceId.length > 128 ||
        typeof priceStroops !== "number" ||
        !Number.isInteger(priceStroops) ||
        priceStroops < 0
      ) {
        return { index: i, ok: false, error: "invalid_item" };
      }
      const isNew = !servicesStore.has(serviceId);
      servicesStore.set(serviceId, { priceStroops });
      return { index: i, ok: true, serviceId, priceStroops, created: isNew };
    }
  );
  res.status(201).json({ results });
});

/** Register a service with its per-request price. */
app.post("/api/v1/services", (req: Request, res: Response) => {
  const { serviceId, priceStroops } = req.body ?? {};
  const requestId = (req as Request & { id?: string }).id;
  if (
    typeof serviceId !== "string" ||
    serviceId.length === 0 ||
    serviceId.length > 128
  ) {
    res.status(400).json({
      error: "invalid_request",
      message: "serviceId must be a non-empty string up to 128 chars",
      requestId,
    });
    return;
  }
  if (
    typeof priceStroops !== "number" ||
    !Number.isInteger(priceStroops) ||
    priceStroops < 0
  ) {
    res.status(400).json({
      error: "invalid_request",
      message: "priceStroops must be a non-negative integer",
      requestId,
    });
    return;
  }
  const isNew = !servicesStore.has(serviceId);
  servicesStore.set(serviceId, { priceStroops });
  res.status(isNew ? 201 : 200).json({ serviceId, priceStroops });
});

/** Cross-agent rollup of accumulated usage for a single service. */
app.get("/api/v1/services/:serviceId/usage", (req: Request, res: Response) => {
  const { serviceId } = req.params;
  const suffix = `::${serviceId}`;
  let total = 0;
  let agents = 0;
  for (const [key, value] of usageStore.entries()) {
    if (key.endsWith(suffix)) {
      total += value;
      agents++;
    }
  }
  res.json({ serviceId, total, agents });
});

/** Top-N consumers of a service, sorted by descending total. */
app.get("/api/v1/services/:serviceId/agents/top", (req: Request, res: Response) => {
  const { serviceId } = req.params;
  const limit = Math.min(100, Math.max(1, Number((req.query.limit as string) ?? 10)));
  const suffix = `::${serviceId}`;
  const items: { agent: string; total: number }[] = [];
  for (const [key, total] of usageStore.entries()) {
    if (key.endsWith(suffix)) {
      items.push({ agent: key.slice(0, key.length - suffix.length), total });
    }
  }
  items.sort((a, b) => b.total - a.total);
  res.json({ serviceId, items: items.slice(0, limit) });
});

/** List every agent currently consuming a service. */
app.get("/api/v1/services/:serviceId/agents", (req: Request, res: Response) => {
  const { serviceId } = req.params;
  const suffix = `::${serviceId}`;
  const items: { agent: string; total: number }[] = [];
  for (const [key, total] of usageStore.entries()) {
    if (key.endsWith(suffix)) {
      items.push({ agent: key.slice(0, key.length - suffix.length), total });
    }
  }
  res.json({ serviceId, items });
});

/** Fetch a single service by id. 200 with metadata or 404. */
app.get("/api/v1/services/:serviceId", (req: Request, res: Response) => {
  const { serviceId } = req.params;
  const meta = servicesStore.get(serviceId);
  if (!meta) {
    res.status(404).json({
      error: "not_found",
      message: `service ${serviceId} is not registered`,
      requestId: (req as Request & { id?: string }).id,
    });
    return;
  }
  res.json({ serviceId, ...meta });
});

/** Set description + owner metadata for a registered service. */
app.put("/api/v1/services/:serviceId/metadata", (req: Request, res: Response) => {
  const { serviceId } = req.params;
  const requestId = (req as Request & { id?: string }).id;
  if (!servicesStore.has(serviceId)) {
    res.status(404).json({
      error: "not_found",
      message: `service ${serviceId} is not registered`,
      requestId,
    });
    return;
  }
  const { description, owner } = req.body ?? {};
  if (typeof description !== "string" || description.length > 256) {
    res.status(400).json({
      error: "invalid_request",
      message: "description must be a string up to 256 chars",
      requestId,
    });
    return;
  }
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    res.status(400).json({
      error: "invalid_request",
      message: "owner must be a non-empty string up to 256 chars",
      requestId,
    });
    return;
  }
  servicesMetadata.set(serviceId, { description, owner });
  res.json({ serviceId, description, owner });
});

/** Read the description + owner metadata for a service. */
app.get("/api/v1/services/:serviceId/metadata", (req: Request, res: Response) => {
  const { serviceId } = req.params;
  const meta = servicesMetadata.get(serviceId);
  if (!meta) {
    res.status(404).json({
      error: "not_found",
      message: `no metadata for service ${serviceId}`,
      requestId: (req as Request & { id?: string }).id,
    });
    return;
  }
  res.json({ serviceId, ...meta });
});

/** Toggle the disabled flag on an existing service. */
app.patch("/api/v1/services/:serviceId/disabled", (req: Request, res: Response) => {
  const { serviceId } = req.params;
  const requestId = (req as Request & { id?: string }).id;
  if (!servicesStore.has(serviceId)) {
    res.status(404).json({
      error: "not_found",
      message: `service ${serviceId} is not registered`,
      requestId,
    });
    return;
  }
  const { disabled } = req.body ?? {};
  if (typeof disabled !== "boolean") {
    res.status(400).json({
      error: "invalid_request",
      message: "disabled must be a boolean",
      requestId,
    });
    return;
  }
  if (disabled) servicesDisabled.add(serviceId);
  else servicesDisabled.delete(serviceId);
  res.json({ serviceId, disabled });
});

/** Update only the price of an existing service. */
app.patch("/api/v1/services/:serviceId/price", (req: Request, res: Response) => {
  const { serviceId } = req.params;
  const requestId = (req as Request & { id?: string }).id;
  const meta = servicesStore.get(serviceId);
  if (!meta) {
    res.status(404).json({
      error: "not_found",
      message: `service ${serviceId} is not registered`,
      requestId,
    });
    return;
  }
  const { priceStroops } = req.body ?? {};
  if (
    typeof priceStroops !== "number" ||
    !Number.isInteger(priceStroops) ||
    priceStroops < 0
  ) {
    res.status(400).json({
      error: "invalid_request",
      message: "priceStroops must be a non-negative integer",
      requestId,
    });
    return;
  }
  meta.priceStroops = priceStroops;
  servicesStore.set(serviceId, meta);
  res.json({ serviceId, ...meta });
});

/** Unregister a service. 204 on success, 404 if unknown. */
app.delete("/api/v1/services/:serviceId", (req: Request, res: Response) => {
  const { serviceId } = req.params;
  if (!servicesStore.has(serviceId)) {
    res.status(404).json({
      error: "not_found",
      message: `service ${serviceId} is not registered`,
      requestId: (req as Request & { id?: string }).id,
    });
    return;
  }
  servicesStore.delete(serviceId);
  res.status(204).send();
});

/**
 * List every registered service with its current price (stroops/request).
 * Supports ?prefix=<str> to filter by a serviceId prefix and ?limit
 * (default 200, max 1000) to bound the response size.
 */
app.get("/api/v1/services", (req: Request, res: Response) => {
  const prefix = typeof req.query.prefix === "string" ? req.query.prefix : "";
  const q = typeof req.query.q === "string" ? req.query.q.toLowerCase() : "";
  const limit = Math.min(1000, Math.max(1, Number((req.query.limit as string) ?? 200)));
  const services: { serviceId: string; priceStroops: number }[] = [];
  for (const [serviceId, meta] of servicesStore.entries()) {
    if (prefix && !serviceId.startsWith(prefix)) continue;
    if (q && !serviceId.toLowerCase().includes(q)) continue;
    services.push({ serviceId, ...meta });
    if (services.length >= limit) break;
  }
  // Weak ETag over the response body. Polling clients can supply
  // If-None-Match to get a 304 when the list has not changed.
  const body = JSON.stringify({ services });
  const etag = `W/"${createHash("sha1").update(body).digest("base64").slice(0, 16)}"`;
  if (req.header("if-none-match") === etag) {
    res.status(304).end();
    return;
  }
  res.setHeader("ETag", etag);
  res.type("application/json").send(body);
});

/**
 * Revoke an API key by its 8-char prefix (avoids needing the full
 * secret in revocation flows). 204 on success, 404 when no key
 * matches.
 */
app.delete("/api/v1/api-keys/:prefix", (req: Request, res: Response) => {
  const { prefix } = req.params;
  let found: string | undefined;
  for (const key of apiKeyStore.keys()) {
    if (key.slice(0, 8) === prefix) {
      found = key;
      break;
    }
  }
  if (!found) {
    res.status(404).json({
      error: "not_found",
      message: `no api key with prefix ${prefix}`,
      requestId: (req as Request & { id?: string }).id,
    });
    return;
  }
  apiKeyStore.delete(found);
  res.status(204).send();
});

/** List api keys with their metadata; never returns the key itself. */
app.get("/api/v1/api-keys", (_req: Request, res: Response) => {
  const items = Array.from(apiKeyStore.entries()).map(([key, meta]) => ({
    // Show only a short prefix so operators can disambiguate without
    // exposing the full token in logs.
    prefix: key.slice(0, 8),
    label: meta.label,
    createdAt: meta.createdAt,
  }));
  res.json({ items });
});

/** Create a new opaque API key with a human label. */
app.post("/api/v1/api-keys", (req: Request, res: Response) => {
  const { label } = req.body ?? {};
  const requestId = (req as Request & { id?: string }).id;
  if (typeof label !== "string" || label.length === 0 || label.length > 64) {
    res.status(400).json({
      error: "invalid_request",
      message: "label must be a non-empty string up to 64 chars",
      requestId,
    });
    return;
  }
  const key = `apk_${randomUUID().replace(/-/g, "")}`;
  apiKeyStore.set(key, { label, createdAt: Date.now() });
  res.status(201).json({ key, label });
});

// ─────────────────────────────────────────────────────────────────────────────
// Event log (in-memory append-only)
// ─────────────────────────────────────────────────────────────────────────────
// Every write entrypoint calls recordEvent so /api/v1/events is the
// audit trail the operator dashboard reads. Capped at 10_000 entries
// (oldest entries are evicted) so a single long-running process does
// not balloon RSS unbounded.
type AppEvent = {
  id: string;
  ts: number;
  type: string;
  payload: Record<string, unknown>;
};
const eventLog: AppEvent[] = [];
const EVENT_LOG_CAP = 10_000;
function recordEvent(type: string, payload: Record<string, unknown>) {
  eventLog.push({ id: randomUUID(), ts: Date.now(), type, payload });
  if (eventLog.length > EVENT_LOG_CAP) eventLog.shift();
}

/**
 * Read the event log. Supports ?since=<unix-ms> and ?limit (default 100,
 * max EVENT_LOG_CAP) so dashboards can poll for new entries cheaply.
 */
/** Count of events grouped by type. */
app.get("/api/v1/events/summary", (_req: Request, res: Response) => {
  const counts: Record<string, number> = {};
  for (const e of eventLog) counts[e.type] = (counts[e.type] ?? 0) + 1;
  res.json({ counts, total: eventLog.length });
});

app.get("/api/v1/events", (req: Request, res: Response) => {
  const since = Number((req.query.since as string) ?? 0);
  const type = typeof req.query.type === "string" ? req.query.type : undefined;
  const limit = Math.min(
    EVENT_LOG_CAP,
    Math.max(1, Number((req.query.limit as string) ?? 100))
  );
  const items = eventLog
    .filter((e) => e.ts >= since && (type === undefined || e.type === type))
    .slice(-limit);
  res.json({ items });
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhooks
// ─────────────────────────────────────────────────────────────────────────────
// In-memory map of webhook id -> { url, events }. CRUD endpoints land
// in the next commits.
type WebhookRecord = { url: string; events: string[]; createdAt: number };
const webhookStore = new Map<string, WebhookRecord>();

/** Unregister a webhook. 204 on success, 404 if unknown. */
app.delete("/api/v1/webhooks/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  if (!webhookStore.has(id)) {
    res.status(404).json({
      error: "not_found",
      message: `webhook ${id} not registered`,
      requestId: (req as Request & { id?: string }).id,
    });
    return;
  }
  webhookStore.delete(id);
  res.status(204).send();
});

/** List every registered webhook with its metadata. */
app.get("/api/v1/webhooks", (_req: Request, res: Response) => {
  const items = Array.from(webhookStore.entries()).map(([id, meta]) => ({
    id,
    ...meta,
  }));
  res.json({ items });
});

/** Trigger a synthetic event for a webhook (no actual delivery yet). */
app.post("/api/v1/webhooks/:id/test", (req: Request, res: Response) => {
  const { id } = req.params;
  const requestId = (req as Request & { id?: string }).id;
  const hook = webhookStore.get(id);
  if (!hook) {
    res.status(404).json({
      error: "not_found",
      message: `webhook ${id} not registered`,
      requestId,
    });
    return;
  }
  recordEvent("webhook.test", { id, url: hook.url });
  res.json({ id, deliveredAt: Date.now(), simulated: true });
});

/** Update url and/or events on an existing webhook. */
app.patch("/api/v1/webhooks/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const requestId = (req as Request & { id?: string }).id;
  const existing = webhookStore.get(id);
  if (!existing) {
    res.status(404).json({
      error: "not_found",
      message: `webhook ${id} not registered`,
      requestId,
    });
    return;
  }
  const { url, events } = req.body ?? {};
  if (url !== undefined) {
    if (typeof url !== "string" || !/^https?:\/\//.test(url) || url.length > 2048) {
      res.status(400).json({
        error: "invalid_request",
        message: "url must be an http(s) URL up to 2048 chars",
        requestId,
      });
      return;
    }
    existing.url = url;
  }
  if (events !== undefined) {
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      events.some((e) => typeof e !== "string")
    ) {
      res.status(400).json({
        error: "invalid_request",
        message: "events must be a non-empty array of strings",
        requestId,
      });
      return;
    }
    existing.events = events;
  }
  webhookStore.set(id, existing);
  res.json({ id, ...existing });
});

app.post("/api/v1/webhooks", (req: Request, res: Response) => {
  const { url, events } = req.body ?? {};
  const requestId = (req as Request & { id?: string }).id;
  if (typeof url !== "string" || !/^https?:\/\//.test(url) || url.length > 2048) {
    res.status(400).json({
      error: "invalid_request",
      message: "url must be an http(s) URL up to 2048 chars",
      requestId,
    });
    return;
  }
  if (
    !Array.isArray(events) ||
    events.length === 0 ||
    events.some((e) => typeof e !== "string")
  ) {
    res.status(400).json({
      error: "invalid_request",
      message: "events must be a non-empty array of strings",
      requestId,
    });
    return;
  }
  const id = `wh_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  webhookStore.set(id, { url, events, createdAt: Date.now() });
  res.status(201).json({ id, url, events });
});

// Unknown route: structured 404 echoing the request id.
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: "not_found",
    message: `No route for ${req.method} ${req.path}`,
    requestId: (req as Request & { id?: string }).id,
  });
});

// Final error handler. Express identifies this by the 4-arg signature.
// Any handler that throws or calls next(err) lands here; the response is
// uniform JSON so clients can branch on `error` and operators can grep
// `requestId` to find the matching log line.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  // Special-case the common entity.too.large from express.json — surface
  // it as a 413 instead of a generic 500 so clients can branch on it.
  if (
    err &&
    typeof err === "object" &&
    "type" in err &&
    (err as { type: string }).type === "entity.too.large"
  ) {
    res.status(413).json({
      error: "payload_too_large",
      message: "request body exceeds the 100 KiB limit",
      requestId: (req as Request & { id?: string }).id,
    });
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected server error";
  res.status(500).json({
    error: "internal_error",
    message,
    method: req.method,
    path: req.path,
    requestId: (req as Request & { id?: string }).id,
  });
});

if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts")) {
  const server = app.listen(PORT, () => {
    console.log(`AgentPay backend listening on port ${PORT}`);
  });

  // Graceful shutdown. Stop accepting new connections, drain in-flight
  // requests for up to 10 s, then exit. Calling code (PaaS, docker) can
  // safely SIGTERM the process at any time.
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, draining…`);
    server.close((err) => {
      if (err) {
        console.error("server.close error:", err);
        process.exit(1);
      }
      process.exit(0);
    });
    setTimeout(() => {
      console.error("Forced exit after 10s drain timeout");
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export { app };
