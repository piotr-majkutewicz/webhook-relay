import { describe, expect, it } from "vitest";
import { backoffSeconds } from "../src/core/backoff";
import { classifyError, classifyStatus } from "../src/core/classify";
import { extractEventKey } from "../src/core/idempotency";
import { hmacSha256Hex, timingSafeEqual, verifySignature } from "../src/core/signature";
import { aggregateStatus, canReplay, nextState } from "../src/core/state";

describe("signature", () => {
  it("matches a known HMAC-SHA256 vector (RFC 4231 test case 2)", async () => {
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("accepts a valid signature, with and without the sha256= prefix", async () => {
    const sig = await hmacSha256Hex("s", "{}");
    for (const header of [sig, `sha256=${sig}`, sig.toUpperCase()]) {
      expect(await verifySignature({ secret: "s", body: "{}", signatureHeader: header, nowSeconds: 0 })).toEqual({ ok: true });
    }
  });

  it("rejects a missing, wrong or body-tampered signature", async () => {
    const sig = await hmacSha256Hex("s", "{}");
    expect(await verifySignature({ secret: "s", body: "{}", signatureHeader: null, nowSeconds: 0 })).toEqual({ ok: false, reason: "missing_signature" });
    expect(await verifySignature({ secret: "other", body: "{}", signatureHeader: sig, nowSeconds: 0 })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifySignature({ secret: "s", body: '{"a":1}', signatureHeader: sig, nowSeconds: 0 })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("signs the timestamp together with the body and enforces the window", async () => {
    const ts = "1000";
    const sig = await hmacSha256Hex("s", `${ts}.{}`);
    const base = { secret: "s", body: "{}", signatureHeader: sig, timestampHeader: ts, requireTimestamp: true, toleranceSeconds: 300 };
    expect(await verifySignature({ ...base, nowSeconds: 1200 })).toEqual({ ok: true });
    expect(await verifySignature({ ...base, nowSeconds: 1301 })).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(await verifySignature({ ...base, nowSeconds: 600 })).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(await verifySignature({ ...base, timestampHeader: null, nowSeconds: 1000 })).toEqual({ ok: false, reason: "missing_timestamp" });
    // Changing the timestamp header invalidates the signature.
    expect(await verifySignature({ ...base, timestampHeader: "1001", nowSeconds: 1001 })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("timingSafeEqual compares correctly", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("backoff", () => {
  const opts = { baseSeconds: 10, maxSeconds: 100 };
  it("grows exponentially and stays within [exp/2, exp]", () => {
    expect(backoffSeconds(1, opts, () => 0)).toBe(5);
    expect(backoffSeconds(1, opts, () => 0.999999)).toBeCloseTo(10, 3);
    expect(backoffSeconds(2, opts, () => 0)).toBe(10);
    expect(backoffSeconds(3, opts, () => 0)).toBe(20);
  });
  it("is capped at the maximum", () => {
    expect(backoffSeconds(10, opts, () => 0)).toBe(50);
    expect(backoffSeconds(50, opts, () => 0.5)).toBe(75);
  });
});

describe("classification", () => {
  it("maps statuses", () => {
    expect(classifyStatus(200)).toBe("success");
    expect(classifyStatus(204)).toBe("success");
    for (const s of [408, 425, 429, 500, 502, 503, 504]) expect(classifyStatus(s)).toBe("retry");
    for (const s of [301, 302, 400, 401, 403, 404, 410, 422]) expect(classifyStatus(s)).toBe("permanent");
    expect(classifyError()).toBe("retry");
  });
});

describe("state machine", () => {
  const b = { baseSeconds: 10, maxSeconds: 100 };
  it("success and permanent errors are terminal", () => {
    expect(nextState("success", 1, 5, 1000, b).status).toBe("delivered");
    expect(nextState("permanent", 1, 5, 1000, b).status).toBe("failed");
  });
  it("retry schedules the next attempt until the limit, then dead", () => {
    const t = nextState("retry", 1, 3, 1000, b, () => 0);
    expect(t).toEqual({ status: "pending", nextAttemptAt: 1000 + 5000 });
    expect(nextState("retry", 2, 3, 1000, b, () => 0).status).toBe("pending");
    expect(nextState("retry", 3, 3, 1000, b).status).toBe("dead");
  });
  it("only failed and dead can be replayed", () => {
    expect(canReplay("failed")).toBe(true);
    expect(canReplay("dead")).toBe(true);
    expect(canReplay("pending")).toBe(false);
    expect(canReplay("delivered")).toBe(false);
  });
  it("aggregates statuses by severity", () => {
    expect(aggregateStatus(["delivered", "pending"])).toBe("pending");
    expect(aggregateStatus(["delivered", "failed", "pending"])).toBe("failed");
    expect(aggregateStatus(["dead", "failed"])).toBe("dead");
    expect(aggregateStatus(["delivered"])).toBe("delivered");
  });
});

describe("event key extraction", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("reads from header, then from a JSON path", async () => {
    expect(await extractEventKey({ header: "x-id" }, h({ "x-id": " a1 " }), "{}", {})).toEqual({ ok: true, key: "a1" });
    expect(await extractEventKey({ jsonPath: "data.id" }, h({}), "", { data: { id: 42 } })).toEqual({ ok: true, key: "42" });
    expect(await extractEventKey({ header: "x-id", jsonPath: "id" }, h({}), "", { id: "p" })).toEqual({ ok: true, key: "p" });
  });
  it("fails when a configured key is missing or too long", async () => {
    expect((await extractEventKey({ header: "x-id" }, h({}), "{}", {})).ok).toBe(false);
    expect((await extractEventKey({ jsonPath: "id" }, h({}), "{}", { id: "x".repeat(201) })).ok).toBe(false);
  });
  it("falls back to a body hash only when nothing is configured", async () => {
    const a = await extractEventKey({}, h({}), '{"a":1}', {});
    const b = await extractEventKey({}, h({}), '{"a":1}', {});
    const c = await extractEventKey({}, h({}), '{"a":2}', {});
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});
