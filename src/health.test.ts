import { describe, it } from "node:test";
import assert from "node:assert";
import request from "supertest";
import { app } from "./index.js";

describe("AgentPay Backend", () => {
  it("app is defined", () => {
    assert.ok(app);
  });

  it("health endpoint returns 200 and status ok", async () => {
    const res = await request(app).get("/health");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body?.status, "ok");
    assert.strictEqual(res.body?.service, "agentpay-backend");
  });

  it("version endpoint returns version", async () => {
    const res = await request(app).get("/api/v1/version");
    assert.strictEqual(res.status, 200);
    assert.ok(res.body?.version);
  });

  it("attaches a fresh X-Request-Id when caller omits it", async () => {
    const res = await request(app).get("/health");
    assert.strictEqual(res.status, 200);
    const id = res.headers["x-request-id"];
    assert.ok(typeof id === "string" && id.length > 0, "X-Request-Id missing");
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("echoes the caller-provided X-Request-Id when present", async () => {
    const caller = "my-trace-id-abc-123";
    const res = await request(app)
      .get("/health")
      .set("X-Request-Id", caller);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers["x-request-id"], caller);
  });

  it("returns a structured 404 with requestId for unknown routes", async () => {
    const res = await request(app).get("/api/v1/this-route-does-not-exist");
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body?.error, "not_found");
    assert.ok(res.body?.message?.includes("/api/v1/this-route-does-not-exist"));
    assert.ok(res.body?.requestId);
  });
});
