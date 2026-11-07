import { describe, expect, it } from "vitest";
import { processDue, type DeliverDeps } from "../src/core/deliver";
import { handleIngest, type IngestDeps } from "../src/core/ingest";
import { hmacSha256Hex } from "../src/core/signature";
import type { SourceConfig } from "../src/core/types";
import { MemoryRepository } from "./memoryRepo";

const cfg: SourceConfig = {
  secretEnv: "X",
  signatureHeader: "x-signature",
  timestampHeader: "x-timestamp",
  toleranceSeconds: 300,
  idempotency: { header: "x-event-id" },
  destinations: ["crm", "erp"],
};

function setup(startMs = 1_000_000_000) {
  let now = startMs;
  let n = 0;
  const repo = new MemoryRepository();
  const ingest: IngestDeps = {
    repo,
    getSource: (name) => (name === "shop" ? { cfg, secret: "s3cret" } : null),
    nowMs: () => now,
    newId: () => `evt${++n}`,
  };
  const responses: Record<string, number[]> = {};
  const calls: { url: string; headers: Headers }[] = [];
  const deliver: DeliverDeps = {
    repo,
    getDestination: (name) => (name === "crm" || name === "erp" ? { url: `https://${name}.test/hook`, secret: "d" } : null),
    fetch: async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers) });
      const queue = responses[new URL(url).hostname] ?? [200];
      const status = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (status === 0) throw new Error("connection refused");
      return new Response("", { status });
    },
    nowMs: () => now,
    random: () => 0,
    maxAttempts: 3,
    backoff: { baseSeconds: 10, maxSeconds: 100 },
    timeoutMs: 1000,
    batchSize: 10,
  };
  return { repo, ingest, deliver, responses, calls, advance: (ms: number) => (now += ms), nowMs: () => now };
}

async function signed(body: string, ts: number, secret = "s3cret", id = "e-1") {
  return new Headers({
    "x-signature": `sha256=${await hmacSha256Hex(secret, `${ts}.${body}`)}`,
    "x-timestamp": String(ts),
    "x-event-id": id,
  });
}

describe("ingest", () => {
  it("accepts a signed event and stores one delivery per destination", async () => {
    const s = setup();
    const body = '{"order":1}';
    const res = await handleIngest(s.ingest, "shop", await signed(body, s.nowMs() / 1000), body);
    expect(res.status).toBe(202);
    expect(s.repo.events).toHaveLength(1);
    expect(s.repo.deliveries.map((d) => d.destination)).toEqual(["crm", "erp"]);
    expect(s.calls).toHaveLength(0); // ingest never delivers
  });

  it("does not create a duplicate for a repeated event key", async () => {
    const s = setup();
    const body = '{"order":1}';
    const ts = s.nowMs() / 1000;
    const first = await handleIngest(s.ingest, "shop", await signed(body, ts), body);
    const second = await handleIngest(s.ingest, "shop", await signed(body, ts), body);
    const third = await handleIngest(s.ingest, "shop", await signed('{"order":1,"x":0}', ts, "s3cret", "e-1"), '{"order":1,"x":0}');
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ result: "duplicate", id: first.body.id });
    expect(third.body.result).toBe("duplicate");
    expect(s.repo.events).toHaveLength(1);
    expect(s.repo.deliveries).toHaveLength(2);
    await processDue(s.deliver);
    expect(s.calls).toHaveLength(2); // one call per destination, not per submission
  });

  it("rejects bad signatures, stale timestamps, unknown sources and bad JSON", async () => {
    const s = setup();
    const body = '{"a":1}';
    const ts = s.nowMs() / 1000;
    expect((await handleIngest(s.ingest, "shop", await signed(body, ts, "wrong"), body)).status).toBe(401);
    expect((await handleIngest(s.ingest, "shop", await signed(body, ts - 1000), body)).body.error).toBe("stale_timestamp");
    expect((await handleIngest(s.ingest, "nope", await signed(body, ts), body)).status).toBe(404);
    expect((await handleIngest(s.ingest, "shop", await signed("not json", ts), "not json")).status).toBe(400);
    const noId = await signed(body, ts);
    noId.delete("x-event-id");
    expect((await handleIngest(s.ingest, "shop", noId, body)).status).toBe(400);
    expect(s.repo.events).toHaveLength(0);
  });
});

describe("delivery", () => {
  async function seed(s: ReturnType<typeof setup>) {
    const body = '{"order":1}';
    const res = await handleIngest(s.ingest, "shop", await signed(body, s.nowMs() / 1000), body);
    return res.body.id!;
  }

  it("signs outgoing requests and marks success as delivered", async () => {
    const s = setup();
    const id = await seed(s);
    await processDue(s.deliver);
    const h = s.calls[0]!.headers;
    const expected = await hmacSha256Hex("d", `${h.get("x-relay-timestamp")}.{"order":1}`);
    expect(h.get("x-relay-signature")).toBe(`sha256=${expected}`);
    expect(h.get("idempotency-key")).toBe(id);
    expect((await s.repo.getEvent(id))!.status).toBe("delivered");
    expect(await processDue(s.deliver)).toBe(0);
  });

  it("retries 5xx with backoff and succeeds later", async () => {
    const s = setup();
    s.responses["crm.test"] = [500, 503, 200];
    const id = await seed(s);
    await processDue(s.deliver);
    let ev = (await s.repo.getEvent(id))!;
    const crm = () => ev.deliveryList.find((d) => d.destination === "crm")!;
    expect(crm().status).toBe("pending");
    expect(await processDue(s.deliver)).toBe(0); // not due yet
    s.advance(5_000);
    expect(await processDue(s.deliver)).toBe(1);
    s.advance(10_000);
    expect(await processDue(s.deliver)).toBe(1);
    ev = (await s.repo.getEvent(id))!;
    expect(crm().status).toBe("delivered");
    expect(crm().attemptLog.map((a) => a.statusCode)).toEqual([500, 503, 200]);
    expect(ev.status).toBe("delivered");
  });

  it("treats 4xx as a permanent failure without retrying", async () => {
    const s = setup();
    s.responses["crm.test"] = [422];
    const id = await seed(s);
    await processDue(s.deliver);
    s.advance(3_600_000);
    expect(await processDue(s.deliver)).toBe(0);
    const ev = (await s.repo.getEvent(id))!;
    expect(ev.deliveryList.find((d) => d.destination === "crm")!.status).toBe("failed");
    expect(ev.status).toBe("failed");
  });

  it("goes dead after the attempt limit and can be replayed", async () => {
    const s = setup();
    s.responses["crm.test"] = [0, 500, 500, 200]; // network error, then 500s
    const id = await seed(s);
    for (let i = 0; i < 5; i++) {
      await processDue(s.deliver);
      s.advance(200_000);
    }
    let ev = (await s.repo.getEvent(id))!;
    const crm = () => ev.deliveryList.find((d) => d.destination === "crm")!;
    expect(crm().status).toBe("dead");
    expect(crm().attempts).toBe(3);
    expect(crm().attemptLog).toHaveLength(3);
    expect(ev.status).toBe("dead");

    expect(await s.repo.replayEvent(id, s.nowMs())).toBe(1); // erp was delivered, crm was dead
    expect(await s.repo.replayEvent("missing", s.nowMs())).toBeNull();
    await processDue(s.deliver);
    ev = (await s.repo.getEvent(id))!;
    expect(crm().status).toBe("delivered");
    expect(crm().replays).toBe(1);
    expect(await s.repo.replayEvent(id, s.nowMs())).toBe(0); // nothing left to replay
  });

  it("does not claim the same delivery twice while the lease is active", async () => {
    const s = setup();
    await seed(s);
    const a = await s.repo.claimDue(s.nowMs(), 10, 60_000, 3);
    const b = await s.repo.claimDue(s.nowMs(), 10, 60_000, 3);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(0);
  });

  it("buries a delivery whose final claimed attempt was never recorded", async () => {
    const s = setup();
    const id = await seed(s);
    for (let i = 0; i < 3; i++) {
      await s.repo.claimDue(s.nowMs(), 10, 1_000, 3); // claimed, then "crash"
      s.advance(2_000);
    }
    await s.repo.claimDue(s.nowMs(), 10, 1_000, 3);
    expect((await s.repo.getEvent(id))!.status).toBe("dead");
  });

  it("reports an unconfigured destination as a permanent failure", async () => {
    const s = setup();
    s.ingest.getSource = () => ({ cfg: { ...cfg, destinations: ["ghost"] }, secret: "s3cret" });
    const id = await seed(s);
    await processDue(s.deliver);
    expect((await s.repo.getEvent(id))!.status).toBe("failed");
  });

  it("classifies a timeout as retryable", async () => {
    const s = setup();
    s.deliver.timeoutMs = 20;
    s.deliver.fetch = (_url, init) =>
      new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    const id = await seed(s);
    await processDue(s.deliver);
    const ev = (await s.repo.getEvent(id))!;
    expect(ev.deliveryList[0]!.status).toBe("pending");
    expect(ev.deliveryList[0]!.lastError).toMatch(/timeout/);
  });
});
