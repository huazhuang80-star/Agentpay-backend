import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(express.json());

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
