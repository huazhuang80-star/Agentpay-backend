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

  it("registers and lists a service via /api/v1/services", async () => {
    const create = await request(app)
      .post("/api/v1/services")
      .send({ serviceId: "svc-test-1", priceStroops: 100 });
    assert.strictEqual(create.status, 201);
    assert.strictEqual(create.body.serviceId, "svc-test-1");

    const list = await request(app).get("/api/v1/services");
    assert.strictEqual(list.status, 200);
    const found = list.body.services.find(
      (s: { serviceId: string }) => s.serviceId === "svc-test-1"
    );
    assert.ok(found, "service not present in list");
    assert.strictEqual(found.priceStroops, 100);
  });

  it("returns a structured 404 with requestId for unknown routes", async () => {
    const res = await request(app).get("/api/v1/this-route-does-not-exist");
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body?.error, "not_found");
    assert.ok(res.body?.message?.includes("/api/v1/this-route-does-not-exist"));
    assert.ok(res.body?.requestId);
  });

  it("POST /api/v1/usage records a first write and returns the new total", async () => {
    const res = await request(app)
      .post("/api/v1/usage")
      .send({ agent: "agent-a", serviceId: "weather_api", requests: 40 });
    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(res.body, {
      agent: "agent-a",
      serviceId: "weather_api",
      total: 40,
    });
  });

  it("POST /api/v1/usage accumulates across calls for the same pair", async () => {
    // First call: 100
    await request(app)
      .post("/api/v1/usage")
      .send({ agent: "agent-b", serviceId: "infer", requests: 100 });
    // Second call: +25 → 125
    const res = await request(app)
      .post("/api/v1/usage")
      .send({ agent: "agent-b", serviceId: "infer", requests: 25 });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.total, 125);
  });

  it("GET /api/v1/usage/:agent/:serviceId returns the accumulated total", async () => {
    await request(app)
      .post("/api/v1/usage")
      .send({ agent: "agent-get", serviceId: "weather", requests: 7 });
    await request(app)
      .post("/api/v1/usage")
      .send({ agent: "agent-get", serviceId: "weather", requests: 3 });
    const res = await request(app).get("/api/v1/usage/agent-get/weather");
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      agent: "agent-get",
      serviceId: "weather",
      total: 10,
    });
  });

  it("GET /api/v1/usage/:agent/:serviceId returns 0 for an unseen pair", async () => {
    const res = await request(app).get("/api/v1/usage/never-seen/never");
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      agent: "never-seen",
      serviceId: "never",
      total: 0,
    });
  });

  for (const [label, payload] of [
    ["empty agent", { agent: "", serviceId: "s", requests: 1 }],
    ["empty serviceId", { agent: "a", serviceId: "", requests: 1 }],
    ["zero requests", { agent: "a", serviceId: "s", requests: 0 }],
    ["negative requests", { agent: "a", serviceId: "s", requests: -3 }],
    ["non-integer requests", { agent: "a", serviceId: "s", requests: 1.5 }],
    ["wrong-type agent", { agent: 7, serviceId: "s", requests: 1 }],
  ] as const) {
    it(`POST /api/v1/usage rejects ${label} with 400`, async () => {
      const res = await request(app).post("/api/v1/usage").send(payload);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, "invalid_request");
      assert.ok(res.body.requestId);
    });
  }
});
