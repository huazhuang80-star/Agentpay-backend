import express, { type Request, type Response } from "express";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "agentpay-backend" });
});

app.get("/api/v1/version", (_req: Request, res: Response) => {
  res.json({ version: "1.0.0" });
});

if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts")) {
  app.listen(PORT, () => {
    console.log(`AgentPay backend listening on port ${PORT}`);
  });
}

export { app };
