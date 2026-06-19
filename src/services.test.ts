import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import request from "supertest";
import { app } from "./index.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Unique service id per test to avoid cross-test state pollution. */
let seq = 0;
const sid = () => `svc-${Date.now()}-${++seq}`;

/** Register a service and assert 201. */
async function createService(serviceId: string, priceStroops = 100) {
  const res = await request(app)
    .post("/api/v1/services")
    .send({ serviceId, priceStroops });
  assert.strictEqual(res.status, 201);
  return res;
}

// Ensure system is unpaused before each test so pause state from other
// test files doesn't bleed over.
beforeEach(async () => {
  await request(app).post("/api/v1/admin/unpause");
});

// ─── Services CRUD ────────────────────────────────────────────────────────────

void describe("Services CRUD", () => {
  // ── POST /api/v1/services ──────────────────────────────────────────────────

  void it("POST /api/v1/services creates a new service and returns 201", async () => {
    const id = sid();
    const res = await createService(id, 500);
    assert.deepStrictEqual(res.body, { serviceId: id, priceStroops: 500 });
  });

  void it("POST /api/v1/services returns 200 on re-registration (upsert)", async () => {
    const id = sid();
    await createService(id, 100);
    const res = await request(app)
      .post("/api/v1/services")
      .send({ serviceId: id, priceStroops: 200 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.priceStroops, 200);
  });

  void it("POST /api/v1/services accepts priceStroops = 0", async () => {
    const id = sid();
    const res = await request(app)
      .post("/api/v1/services")
      .send({ serviceId: id, priceStroops: 0 });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.priceStroops, 0);
  });

  for (const [label, body] of [
    ["missing serviceId", { priceStroops: 10 }],
    ["empty serviceId", { serviceId: "", priceStroops: 10 }],
    ["missing priceStroops", { serviceId: "x" }],
    ["negative priceStroops", { serviceId: "x", priceStroops: -1 }],
    ["float priceStroops", { serviceId: "x", priceStroops: 1.5 }],
  ] as const) {
    void it(`POST /api/v1/services rejects ${label} with 400`, async () => {
      const res = await request(app).post("/api/v1/services").send(body);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, "invalid_request");
    });
  }

  // ── GET /api/v1/services ───────────────────────────────────────────────────

  void it("GET /api/v1/services lists registered services", async () => {
    const id = sid();
    await createService(id, 42);
    const res = await request(app).get("/api/v1/services");
    assert.strictEqual(res.status, 200);
    const found = (res.body.services as { serviceId: string; priceStroops: number }[])
      .find((s) => s.serviceId === id);
    assert.ok(found, "service missing from list");
    assert.strictEqual(found.priceStroops, 42);
  });

  void it("GET /api/v1/services supports ?prefix= filter", async () => {
    const prefix = `pfx-${Date.now()}`;
    await createService(`${prefix}-a`);
    await createService(`${prefix}-b`);
    await createService(`other-${Date.now()}`);
    const res = await request(app).get(`/api/v1/services?prefix=${prefix}`);
    assert.strictEqual(res.status, 200);
    const ids = (res.body.services as { serviceId: string }[]).map((s) => s.serviceId);
    assert.ok(ids.some((id) => id.startsWith(prefix)));
    assert.ok(ids.every((id) => id.startsWith(prefix)));
  });

  void it("GET /api/v1/services respects ?limit=", async () => {
    for (let i = 0; i < 3; i++) await createService(sid());
    const res = await request(app).get("/api/v1/services?limit=1");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.services.length, 1);
  });

  void it("GET /api/v1/services returns ETag and 304 on repeat with If-None-Match", async () => {
    const first = await request(app).get("/api/v1/services");
    assert.strictEqual(first.status, 200);
    const etag = first.headers.etag as string;
    assert.ok(etag, "ETag header missing");
    const second = await request(app).get("/api/v1/services").set("If-None-Match", etag);
    assert.strictEqual(second.status, 304);
  });

  // ── GET /api/v1/services/:serviceId ───────────────────────────────────────

  void it("GET /api/v1/services/:serviceId returns the service", async () => {
    const id = sid();
    await createService(id, 999);
    const res = await request(app).get(`/api/v1/services/${id}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.serviceId, id);
    assert.strictEqual(res.body.priceStroops, 999);
  });

  void it("GET /api/v1/services/:serviceId returns 404 for unknown id", async () => {
    const res = await request(app).get("/api/v1/services/does-not-exist-xyz");
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, "not_found");
    assert.ok(res.body.requestId);
  });

  // ── PATCH /api/v1/services/:serviceId/price ────────────────────────────────

  void it("PATCH /api/v1/services/:serviceId/price updates the price", async () => {
    const id = sid();
    await createService(id, 100);
    const res = await request(app)
      .patch(`/api/v1/services/${id}/price`)
      .send({ priceStroops: 250 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.priceStroops, 250);

    // Confirm persisted
    const fetched = await request(app).get(`/api/v1/services/${id}`);
    assert.strictEqual(fetched.body.priceStroops, 250);
  });

  void it("PATCH /api/v1/services/:serviceId/price returns 404 for unknown service", async () => {
    const res = await request(app)
      .patch("/api/v1/services/no-such-svc/price")
      .send({ priceStroops: 10 });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, "not_found");
  });

  for (const [label, body] of [
    ["missing priceStroops", {}],
    ["negative priceStroops", { priceStroops: -5 }],
    ["float priceStroops", { priceStroops: 0.5 }],
  ] as const) {
    void it(`PATCH price rejects ${label} with 400`, async () => {
      const id = sid();
      await createService(id);
      const res = await request(app)
        .patch(`/api/v1/services/${id}/price`)
        .send(body);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, "invalid_request");
    });
  }

  // ── DELETE /api/v1/services/:serviceId ────────────────────────────────────

  void it("DELETE /api/v1/services/:serviceId removes the service and returns 204", async () => {
    const id = sid();
    await createService(id);
    const del = await request(app).delete(`/api/v1/services/${id}`);
    assert.strictEqual(del.status, 204);

    const fetch = await request(app).get(`/api/v1/services/${id}`);
    assert.strictEqual(fetch.status, 404);
  });

  void it("DELETE /api/v1/services/:serviceId returns 404 for unknown service", async () => {
    const res = await request(app).delete("/api/v1/services/ghost-svc");
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, "not_found");
  });

  // ── PATCH /api/v1/services/:serviceId/disabled ────────────────────────────

  void it("PATCH disabled=true prevents usage recording (409)", async () => {
    const id = sid();
    await createService(id, 10);
    await request(app)
      .patch(`/api/v1/services/${id}/disabled`)
      .send({ disabled: true });
    const usage = await request(app)
      .post("/api/v1/usage")
      .send({ agent: "ag", serviceId: id, requests: 1 });
    assert.strictEqual(usage.status, 409);
    assert.strictEqual(usage.body.error, "service_disabled");
  });

  void it("PATCH disabled=false re-enables usage recording", async () => {
    const id = sid();
    await createService(id, 10);
    await request(app)
      .patch(`/api/v1/services/${id}/disabled`)
      .send({ disabled: true });
    await request(app)
      .patch(`/api/v1/services/${id}/disabled`)
      .send({ disabled: false });
    const usage = await request(app)
      .post("/api/v1/usage")
      .send({ agent: "ag", serviceId: id, requests: 1 });
    assert.strictEqual(usage.status, 201);
  });

  void it("PATCH disabled returns 404 for unknown service", async () => {
    const res = await request(app)
      .patch("/api/v1/services/no-svc/disabled")
      .send({ disabled: true });
    assert.strictEqual(res.status, 404);
  });

  void it("PATCH disabled rejects non-boolean with 400", async () => {
    const id = sid();
    await createService(id);
    const res = await request(app)
      .patch(`/api/v1/services/${id}/disabled`)
      .send({ disabled: "yes" });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, "invalid_request");
  });

  // ── PUT /api/v1/services/:serviceId/metadata ──────────────────────────────

  void it("PUT metadata sets description and owner", async () => {
    const id = sid();
    await createService(id);
    const res = await request(app)
      .put(`/api/v1/services/${id}/metadata`)
      .send({ description: "A test service", owner: "alice" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.description, "A test service");
    assert.strictEqual(res.body.owner, "alice");
  });

  void it("GET metadata returns stored values", async () => {
    const id = sid();
    await createService(id);
    await request(app)
      .put(`/api/v1/services/${id}/metadata`)
      .send({ description: "desc", owner: "bob" });
    const res = await request(app).get(`/api/v1/services/${id}/metadata`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.owner, "bob");
  });

  void it("GET metadata returns 404 when not set", async () => {
    const id = sid();
    await createService(id);
    const res = await request(app).get(`/api/v1/services/${id}/metadata`);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, "not_found");
  });

  void it("PUT metadata returns 404 for unknown service", async () => {
    const res = await request(app)
      .put("/api/v1/services/ghost/metadata")
      .send({ description: "", owner: "x" });
    assert.strictEqual(res.status, 404);
  });

  for (const [label, body] of [
    ["missing owner", { description: "ok" }],
    ["empty owner", { description: "ok", owner: "" }],
    ["description too long", { description: "x".repeat(257), owner: "x" }],
  ] as const) {
    void it(`PUT metadata rejects ${label} with 400`, async () => {
      const id = sid();
      await createService(id);
      const res = await request(app)
        .put(`/api/v1/services/${id}/metadata`)
        .send(body);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, "invalid_request");
    });
  }
});

// ─── Services bulk endpoint ───────────────────────────────────────────────────

void describe("POST /api/v1/services/bulk", () => {
  void it("registers multiple services in one call", async () => {
    const a = sid();
    const b = sid();
    const res = await request(app)
      .post("/api/v1/services/bulk")
      .send({
        items: [
          { serviceId: a, priceStroops: 10 },
          { serviceId: b, priceStroops: 20 },
        ],
      });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.results.length, 2);
    assert.ok(res.body.results.every((r: { ok: boolean }) => r.ok));

    // Confirm both are now retrievable
    for (const id of [a, b]) {
      const fetch = await request(app).get(`/api/v1/services/${id}`);
      assert.strictEqual(fetch.status, 200);
    }
  });

  void it("sets created=true only for new services", async () => {
    const id = sid();
    await createService(id, 5);
    const res = await request(app)
      .post("/api/v1/services/bulk")
      .send({ items: [{ serviceId: id, priceStroops: 50 }] });
    assert.strictEqual(res.status, 201);
    const [result] = res.body.results as { ok: boolean; created: boolean }[];
    assert.ok(result.ok);
    assert.strictEqual(result.created, false); // upsert, not new
  });

  void it("reports invalid items per-index without failing the whole batch", async () => {
    const good = sid();
    const res = await request(app)
      .post("/api/v1/services/bulk")
      .send({
        items: [
          { serviceId: good, priceStroops: 10 },   // index 0 — valid
          { serviceId: "", priceStroops: 5 },       // index 1 — invalid
          { serviceId: sid(), priceStroops: -1 },   // index 2 — invalid
        ],
      });
    assert.strictEqual(res.status, 201);
    const [r0, r1, r2] = res.body.results as { ok: boolean; error?: string }[];
    assert.ok(r0.ok);
    assert.strictEqual(r0.error, undefined);
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.error, "invalid_item");
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.error, "invalid_item");
  });

  for (const [label, body] of [
    ["empty items array", { items: [] }],
    ["items not an array", { items: "bad" }],
    ["missing items key", {}],
    ["items > 50", { items: Array.from({ length: 51 }, (_, i) => ({ serviceId: `s${i}`, priceStroops: 1 })) }],
  ] as const) {
    void it(`bulk rejects ${label} with 400`, async () => {
      const res = await request(app).post("/api/v1/services/bulk").send(body);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, "invalid_request");
    });
  }
});
