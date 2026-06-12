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
