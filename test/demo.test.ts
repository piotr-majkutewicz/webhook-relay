import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSampleBody, checkRateLimit, parseSampleRequest, runRetention, simulateDestination } from "../src/core/demo";
import type { Env } from "../src/config";
import { createWorker } from "../src/index";
import { MemoryRepository } from "./memoryRepo";

const HOUR = 3_600_000;

function harness(vars: Record<string, string> = {}) {
  const repo = new MemoryRepository();
  const worker = createWorker(() => repo);
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const env = { DB: {}, DEMO_SOURCE_SECRET: "demo-secret", ADMIN_TOKEN: "admin-token", RETRY_BASE_SECONDS: "1", ...vars } as unknown as Env;
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await worker.fetch!(new Request(`https://relay.test${path}`, init) as never, env, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };
  return { repo, env, call, worker, ctx, pending };
}
const DEMO = { DEMO_MODE: "true" };
const post = (body?: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sample request parsing and payload", () => {
  it("defaults to flaky and accepts only the scenario field", () => {
    expect(parseSampleRequest("")).toEqual({ ok: true, scenario: "flaky" });
    expect(parseSampleRequest("{}")).toEqual({ ok: true, scenario: "flaky" });
    expect(parseSampleRequest('{"scenario":"down"}')).toEqual({ ok: true, scenario: "down" });
    for (const bad of ['{"scenario":"x"}', '{"scenario":1}', '{"scenario":"ok","url":"https://evil.test"}', "[]", "null", "nope", '{"body":"<img>"}']) {
      expect(parseSampleRequest(bad).ok, bad).toBe(false);
    }
  });

  it("builds a small payload of fixed shape", () => {
    const body = buildSampleBody("evt_abc", "ok", 0.99, 0);
    expect(Object.keys(JSON.parse(body))).toEqual(["id", "type", "scenario", "amount", "currency", "created"]);
    expect(body.length).toBeLessThan(200);
  });

  it("simulates failures per scenario without a network", async () => {
    const st = (n: number, sc: string) => simulateDestination(n, JSON.stringify({ scenario: sc })).status;
    expect([1, 2, 3, 4].map((n) => st(n, "flaky"))).toEqual([503, 503, 200, 200]);
    expect([1, 5].map((n) => st(n, "down"))).toEqual([503, 503]);
    expect(st(1, "ok")).toBe(200);
  });
});

describe("rate limits", () => {
  const limits = { windowMs: HOUR, perIp: 2, global: 3 };

  it("limits per client and globally, and resets in the next window", async () => {
    const repo = new MemoryRepository();
    const t = 10 * HOUR + 5;
    expect((await checkRateLimit(repo, t, "a", limits)).ok).toBe(true);
    expect((await checkRateLimit(repo, t, "a", limits)).ok).toBe(true);
    const third = await checkRateLimit(repo, t, "a", limits);
    expect(third).toMatchObject({ ok: false, scope: "ip" });
    expect((await checkRateLimit(repo, t, "b", limits)).ok).toBe(true); // 3rd global hit
    expect(await checkRateLimit(repo, t, "c", limits)).toMatchObject({ ok: false, scope: "global" });
    expect((await checkRateLimit(repo, t + HOUR, "a", limits)).ok).toBe(true);
  });

  it("a client over its own limit does not use up the global budget", async () => {
    const repo = new MemoryRepository();
    for (let i = 0; i < 20; i++) await checkRateLimit(repo, 0, "a", limits);
    expect((await checkRateLimit(repo, 0, "b", limits)).ok).toBe(true);
  });
});

describe("retention", () => {
  async function seed(repo: MemoryRepository, n: number, startMs: number) {
    for (let i = 0; i < n; i++) {
      await repo.insertEvent({ id: `e${startMs}-${i}`, source: "demo", eventKey: `k${startMs}-${i}`, body: "{}", receivedAt: startMs + i }, ["simulated"]);
    }
  }

  it("deletes events older than the TTL together with their deliveries", async () => {
    const repo = new MemoryRepository();
    const now = 100 * HOUR;
    await seed(repo, 3, now - 25 * HOUR);
    await seed(repo, 2, now - HOUR);
    const r = await runRetention(repo, now, { ttlMs: 24 * HOUR, maxEvents: 100, windowMs: HOUR });
    expect(r).toEqual({ expired: 3, evicted: 0 });
    expect(repo.events).toHaveLength(2);
    expect(repo.deliveries).toHaveLength(2);
  });

  it("enforces the cap by evicting the oldest events", async () => {
    const repo = new MemoryRepository();
    await seed(repo, 10, 1000);
    const r = await runRetention(repo, 2000, { ttlMs: 24 * HOUR, maxEvents: 4, windowMs: HOUR });
    expect(r.evicted).toBe(6);
    expect(repo.events.map((e) => e.receivedAt)).toEqual([1006, 1007, 1008, 1009]);
    expect(repo.deliveries).toHaveLength(4);
  });

  it("drops counters older than two windows", async () => {
    const repo = new MemoryRepository();
    await repo.hitCounter("old", 0);
    await repo.hitCounter("new", 5 * HOUR);
    await runRetention(repo, 5 * HOUR, { ttlMs: HOUR, maxEvents: 10, windowMs: HOUR });
    expect([...repo.counters.keys()]).toEqual(["new"]);
  });
});

describe("worker in DEMO_MODE", () => {
  it("serves the panel and reads without a token", async () => {
    const h = harness(DEMO);
    const page = await h.call("/");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('href="https://piotrmajkutewicz.pl" rel="noopener"');
    expect(html).not.toContain("Replay failed deliveries");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect((await h.call("/admin/events")).status).toBe(200);
  });

  it("is read-only: replay and any write method are forbidden, with or without a token", async () => {
    const h = harness(DEMO);
    await h.call("/demo/sample", post({ scenario: "down" }));
    const id = h.repo.events[0]!.id;
    for (const headers of [{} as Record<string, string>, { authorization: "Bearer admin-token" }]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect((await h.call(`/admin/events/${id}/replay`, { method, headers })).status).toBe(403);
        expect((await h.call(`/admin/events/${id}`, { method, headers })).status).toBe(403);
      }
      expect((await h.call(`/admin/events/${id}/replay`, { headers })).status).toBe(403);
    }
    expect(h.repo.deliveries[0]!.replays).toBe(0);
  });

  it("does not accept external webhooks", async () => {
    const h = harness(DEMO);
    expect((await h.call("/hooks/demo", post({ id: "x" }))).status).toBe(404);
    expect((await h.call("/hooks/shop", post({ id: "x" }))).status).toBe(404);
  });

  it("creates a signed sample event and delivers it to the simulation only, retrying visibly", async () => {
    const netFetch = vi.fn(() => {
      throw new Error("network must not be used in demo mode");
    });
    vi.stubGlobal("fetch", netFetch);
    const h = harness(DEMO);
    const base = Date.now();
    const res = await h.call("/demo/sample", post({ scenario: "flaky" }));
    expect(res.status).toBe(202);
    expect(h.repo.events).toHaveLength(1);
    expect(h.repo.events[0]!.source).toBe("demo");
    expect(h.repo.deliveries[0]!.destination).toBe("simulated");
    // First attempt ran after the response and failed.
    expect(h.repo.deliveries[0]!).toMatchObject({ status: "pending", attempts: 1, lastStatusCode: 503 });
    // Cron ticks later: second failure, then success.
    for (let i = 0; i < 2; i++) {
      vi.spyOn(Date, "now").mockReturnValue(base + (i + 1) * 600_000);
      await h.worker.scheduled!({} as never, h.env, h.ctx);
      await Promise.all(h.pending.splice(0));
    }
    expect(h.repo.deliveries[0]!).toMatchObject({ status: "delivered", attempts: 3 });
    expect(h.repo.deliveries[0]!.log.map((a) => a.statusCode)).toEqual([503, 503, 200]);
    expect(netFetch).not.toHaveBeenCalled();
    const detail = await (await h.call(`/admin/events/${h.repo.events[0]!.id}`)).json();
    expect((detail as { deliveryList: unknown[] }).deliveryList).toHaveLength(1);
  });

  it("bounds the request: size, shape, content, origin", async () => {
    const h = harness(DEMO);
    expect((await h.call("/demo/sample", { method: "POST", body: "x".repeat(300) })).status).toBe(413);
    expect((await h.call("/demo/sample", post({ scenario: "nope" }))).status).toBe(400);
    expect((await h.call("/demo/sample", post({ scenario: "ok", destination: "https://evil.test" }))).status).toBe(400);
    expect((await h.call("/demo/sample", post({ scenario: "ok" }, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await h.call("/demo/sample", { method: "GET" })).status).toBe(405);
    expect(h.repo.events).toHaveLength(0);
    expect((await h.call("/demo/sample", post({ scenario: "ok" }, { origin: "https://relay.test" }))).status).toBe(202);
  });

  it("returns 429 with Retry-After when the per-IP limit is exceeded", async () => {
    const h = harness({ ...DEMO, DEMO_RATE_PER_IP: "2" });
    const ip = { "cf-connecting-ip": "203.0.113.7" };
    expect((await h.call("/demo/sample", post({ scenario: "ok" }, ip))).status).toBe(202);
    expect((await h.call("/demo/sample", post({ scenario: "ok" }, ip))).status).toBe(202);
    const res = await h.call("/demo/sample", post({ scenario: "ok" }, ip));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(h.repo.events).toHaveLength(2);
    expect((await h.call("/demo/sample", post({ scenario: "ok" }, { "cf-connecting-ip": "203.0.113.8" }))).status).toBe(202);
  });

  it("returns 429 when the global limit is exceeded", async () => {
    const h = harness({ ...DEMO, DEMO_RATE_GLOBAL: "2" });
    for (const n of [1, 2]) expect((await h.call("/demo/sample", post({}, { "cf-connecting-ip": `198.51.100.${n}` }))).status).toBe(202);
    expect((await h.call("/demo/sample", post({}, { "cf-connecting-ip": "198.51.100.3" }))).status).toBe(429);
  });

  it("keeps the event count under the cap when creating samples", async () => {
    const h = harness({ ...DEMO, DEMO_MAX_EVENTS: "3", DEMO_RATE_PER_IP: "100", DEMO_RATE_GLOBAL: "100" });
    for (let i = 0; i < 6; i++) expect((await h.call("/demo/sample", post({ scenario: "ok" }))).status).toBe(202);
    expect(h.repo.events).toHaveLength(3);
  });

  it("fails closed when the demo secret is missing", async () => {
    const h = harness({ ...DEMO, DEMO_SOURCE_SECRET: "" });
    expect((await h.call("/demo/sample", post({}))).status).toBe(503);
  });

  it("runs retention from the cron trigger", async () => {
    const h = harness({ ...DEMO, DEMO_TTL_HOURS: "1" });
    await h.repo.insertEvent({ id: "old", source: "demo", eventKey: "o", body: "{}", receivedAt: Date.now() - 2 * HOUR }, ["simulated"]);
    await h.repo.insertEvent({ id: "new", source: "demo", eventKey: "n", body: "{}", receivedAt: Date.now() }, ["simulated"]);
    await h.worker.scheduled!({} as never, h.env, h.ctx);
    await Promise.all(h.pending.splice(0));
    expect(h.repo.events.map((e) => e.id)).toEqual(["new"]);
  });
});

describe("worker in normal mode", () => {
  it("still requires the Bearer token for the admin API", async () => {
    const h = harness();
    expect((await h.call("/admin/events")).status).toBe(401);
    expect((await h.call("/admin/events", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await h.call("/admin/events", { headers: { authorization: "Bearer admin-token" } })).status).toBe(200);
  });

  it("keeps replay behind the token", async () => {
    const h = harness();
    expect((await h.call("/admin/events/x/replay", { method: "POST" })).status).toBe(401);
    expect((await h.call("/admin/events/x/replay", { method: "POST", headers: { authorization: "Bearer admin-token" } })).status).toBe(404);
  });

  it("does not expose the demo endpoint, and shows the token field in the panel", async () => {
    const h = harness({ DEMO_MODE: "false" });
    expect((await h.call("/demo/sample", post({}))).status).toBe(404);
    expect(h.repo.events).toHaveLength(0);
    const html = await (await h.call("/")).text();
    expect(html).toContain('id="token"');
    expect(html).not.toContain("piotrmajkutewicz.pl");
    expect(html).not.toContain('id="send"');
  });

  it("does not turn demo on for values other than 'true'", async () => {
    for (const v of ["1", "TRUE", "yes", ""]) {
      const h = harness({ DEMO_MODE: v });
      expect((await h.call("/admin/events")).status, v).toBe(401);
    }
  });

  it("handles /hooks as before (unknown source is 404, GET is 405)", async () => {
    const h = harness();
    expect((await h.call("/hooks/nope", post({}))).status).toBe(404);
    expect((await h.call("/hooks/shop")).status).toBe(405);
  });
});

describe("no indexing", () => {
  it("sends X-Robots-Tag on every response in both modes", async () => {
    for (const vars of [{}, DEMO]) {
      const h = harness(vars);
      const requests: [string, RequestInit?][] = [
        ["/"], ["/admin"], ["/robots.txt"], ["/sitemap.xml"], ["/nope"], ["/admin/events"], ["/admin/events/x"],
        ["/hooks/shop", post({})], ["/hooks/shop"], ["/demo/sample", post({})], ["/demo/sample"],
      ];
      for (const [path, init] of requests) {
        const res = await h.call(path, init);
        expect(res.headers.get("x-robots-tag"), `${path} ${res.status}`).toBe("noindex, nofollow");
      }
    }
  });

  it("serves a permissive robots.txt and no sitemap", async () => {
    const h = harness(DEMO);
    const res = await h.call("/robots.txt");
    expect(await res.text()).toBe("User-agent: *\nAllow: /\n");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect((await h.call("/sitemap.xml")).status).toBe(404);
  });

  it("sets the robots meta tag and a strict CSP on the panel", async () => {
    for (const vars of [{}, DEMO]) {
      const res = await harness(vars).call("/");
      const html = await res.text();
      expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toMatch(/unsafe-inline|https?:/);
      expect(html).not.toMatch(/innerHTML|<script[^>]+src=/);
    }
  });
});

describe("demo actions: duplicate, bad signature, intake log", () => {
  it("duplicate: stores and delivers the event once, logs the ignored copy", async () => {
    const h = harness(DEMO);
    const res = await h.call("/demo/duplicate", post({}));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; duplicateIgnored: boolean };
    expect(body.duplicateIgnored).toBe(true);
    expect(h.repo.events).toHaveLength(1);
    expect(h.repo.deliveries).toHaveLength(1);
    expect(h.repo.deliveries[0]!.log).toHaveLength(1); // delivered once, not twice
    expect(h.repo.deliveries[0]!.status).toBe("delivered");
    expect(h.repo.intake).toMatchObject([{ kind: "duplicate", reason: "duplicate", eventId: body.id }]);
    const list = (await (await h.call("/admin/intake")).json()) as { entries: { kind: string; eventId: string }[] };
    expect(list.entries[0]).toMatchObject({ kind: "duplicate", eventId: body.id });
  });

  it("bad signature: rejected, no event, logged", async () => {
    const h = harness(DEMO);
    const res = await h.call("/demo/bad-signature", post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "rejected", reason: "bad_signature" });
    expect(h.repo.events).toHaveLength(0);
    expect(h.repo.intake).toMatchObject([{ kind: "rejected", reason: "bad_signature", eventId: null }]);
  });

  it("take no input, share the rate limits, and respect the same origin rules", async () => {
    const h = harness({ ...DEMO, DEMO_RATE_PER_IP: "3" });
    for (const path of ["/demo/duplicate", "/demo/bad-signature"]) {
      expect((await h.call(path, post({ scenario: "down" }))).status).toBe(400);
      expect((await h.call(path, post({}, { origin: "https://evil.test" }))).status).toBe(403);
      expect((await h.call(path, { method: "GET" })).status).toBe(405);
    }
    expect((await h.call("/demo/sample", post({}))).status).toBe(202);
    expect((await h.call("/demo/duplicate", post({}))).status).toBe(202);
    expect((await h.call("/demo/bad-signature", post({}))).status).toBe(200);
    expect((await h.call("/demo/bad-signature", post({}))).status).toBe(429);
    expect((await h.call("/demo/duplicate", post({}))).status).toBe(429);
  });

  it("do not exist in normal mode, and /admin/intake needs the token there", async () => {
    const h = harness();
    for (const path of ["/demo/duplicate", "/demo/bad-signature"]) expect((await h.call(path, post({}))).status).toBe(404);
    expect((await h.call("/admin/intake")).status).toBe(401);
    expect((await h.call("/admin/intake", { headers: { authorization: "Bearer admin-token" } })).status).toBe(404);
  });

  it("/admin/intake is read-only", async () => {
    const h = harness(DEMO);
    expect((await h.call("/admin/intake", { method: "POST" })).status).toBe(403);
    expect((await h.call("/admin/intake", { method: "DELETE" })).status).toBe(403);
  });

  it("retention also removes old intake entries and keeps the cap", async () => {
    const h = harness({ ...DEMO, DEMO_TTL_HOURS: "1", DEMO_MAX_EVENTS: "2" });
    const now = Date.now();
    await h.repo.logIntake({ receivedAt: now - 2 * HOUR, kind: "rejected", reason: "bad_signature", eventId: null, eventKey: "old" });
    for (let i = 0; i < 4; i++) await h.repo.logIntake({ receivedAt: now - i, kind: "rejected", reason: "bad_signature", eventId: null, eventKey: `k${i}` });
    await h.worker.scheduled!({} as never, h.env, h.ctx);
    await Promise.all(h.pending.splice(0));
    expect(h.repo.intake.map((e) => e.eventKey).sort()).toEqual(["k0", "k1"]);
  });
});

describe("demo: fast retries on read", () => {
  it("processes due deliveries when the panel reads, at most once per interval, simulated destination only", async () => {
    const netFetch = vi.fn(() => {
      throw new Error("network must not be used in demo mode");
    });
    vi.stubGlobal("fetch", netFetch);
    const h = harness({ ...DEMO, RETRY_BASE_SECONDS: "5", RETRY_MAX_SECONDS: "10" });
    const base = Date.now();
    await h.call("/demo/sample", post({ scenario: "flaky" }));
    expect(h.repo.deliveries[0]!.attempts).toBe(1);
    const at = (s: number) => vi.spyOn(Date, "now").mockReturnValue(base + s * 1000);
    at(12); // past the first backoff (at most 5 s)
    await h.call("/admin/events");
    expect(h.repo.deliveries[0]!.attempts).toBe(2);
    at(12.5); // within 2 s of the previous run: skipped
    await h.call("/admin/events");
    expect(h.repo.deliveries[0]!.attempts).toBe(2);
    at(30); // past the second backoff (at most 10 s)
    await h.call(`/admin/events/${h.repo.events[0]!.id}`);
    expect(h.repo.deliveries[0]!).toMatchObject({ status: "delivered", attempts: 3 });
    expect(netFetch).not.toHaveBeenCalled();
  });

  it("does not run in normal mode", async () => {
    const h = harness({ RETRY_BASE_SECONDS: "5" });
    await h.repo.insertEvent({ id: "e", source: "shop", eventKey: "k", body: "{}", receivedAt: 0 }, ["crm"]);
    vi.spyOn(Date, "now").mockReturnValue(10 * HOUR);
    await h.call("/admin/events", { headers: { authorization: "Bearer admin-token" } });
    expect(h.repo.deliveries[0]!.attempts).toBe(0);
  });
});
