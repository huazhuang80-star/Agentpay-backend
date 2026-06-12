import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";

const app = express();
const PORT = process.env.PORT ?? 3001;

// 100 KiB cap on request bodies. Every endpoint we expose accepts a
// handful of short strings and numbers — anything larger is almost
// certainly an abusive or buggy caller.
app.use(express.json({ limit: "100kb" }));

// Minimal security headers — same shape Helmet would produce but without
// the dependency footprint. Lets us start hardening the response surface
// before deciding on a full Helmet/CSP policy.
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
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

// Wall-clock request timer. Sets Server-Timing on the response and
// emits a single structured log line on every completed request.
app.use((req: Request, res: Response, next: NextFunction) => {
  const startNs = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    res.setHeader("Server-Timing", `app;dur=${ms.toFixed(1)}`);
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

app.get("/api/v1/version", (_req: Request, res: Response) => {
  res.json({ version: "1.0.0" });
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
  if (
    typeof requests !== "number" ||
    !Number.isInteger(requests) ||
    requests <= 0
  ) {
    res.status(400).json({
      error: "invalid_request",
      message: "requests must be a positive integer",
      requestId,
    });
    return;
  }

  const key = usageKey(agent, serviceId);
  const prev = usageStore.get(key) ?? 0;
  // Saturate at Number.MAX_SAFE_INTEGER rather than overflow into floats.
  const total = Math.min(Number.MAX_SAFE_INTEGER, prev + requests);
  usageStore.set(key, total);

  res.status(201).json({ agent, serviceId, total });
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
  res.json({ agent, serviceId, requests, priceStroops: price, billedStroops });
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

/** Register a service with its per-request price. */
app.post("/api/v1/services", (req: Request, res: Response) => {
  const { serviceId, priceStroops } = req.body ?? {};
  const requestId = (req as Request & { id?: string }).id;
  if (typeof serviceId !== "string" || serviceId.length === 0 || serviceId.length > 128) {
    res.status(400).json({
      error: "invalid_request",
      message: "serviceId must be a non-empty string up to 128 chars",
      requestId,
    });
    return;
  }
  if (typeof priceStroops !== "number" || !Number.isInteger(priceStroops) || priceStroops < 0) {
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
  if (typeof priceStroops !== "number" || !Number.isInteger(priceStroops) || priceStroops < 0) {
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

/** List every registered service with its current price (stroops/request). */
app.get("/api/v1/services", (_req: Request, res: Response) => {
  const services = Array.from(servicesStore.entries()).map(
    ([serviceId, meta]) => ({ serviceId, ...meta })
  );
  res.json({ services });
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
  const message =
    err instanceof Error ? err.message : "Unexpected server error";
  res.status(500).json({
    error: "internal_error",
    message,
    requestId: (req as Request & { id?: string }).id,
  });
});

if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts")) {
  app.listen(PORT, () => {
    console.log(`AgentPay backend listening on port ${PORT}`);
  });
}

export { app };
