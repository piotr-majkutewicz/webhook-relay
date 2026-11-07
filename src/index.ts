import { destinations, isAllowedDestinationUrl, num, sources, str, type Env } from "./config";
import {
  DEMO_DESTINATION,
  DEMO_SOURCE,
  MAX_SAMPLE_REQUEST_BYTES,
  buildSampleBody,
  checkRateLimit,
  isEmptyRequest,
  demoSource,
  parseDemoLimits,
  parseSampleRequest,
  runRetention,
  simulateDestination,
  type DemoStore,
} from "./core/demo";
import { processDue, type DeliverDeps } from "./core/deliver";
import { handleIngest } from "./core/ingest";
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from "./core/signature";
import type { DeliveryStatus, Repository } from "./core/types";
import { D1Repository } from "./d1repo";
import { parseLang } from "./i18n";
import { panelHtml } from "./panel";

const STATUSES: DeliveryStatus[] = ["pending", "delivered", "failed", "dead"];

function json(status: number, data: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

/** Reads the body as text, refusing anything larger than `max` bytes (also without Content-Length). */
async function readLimited(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export function isDemo(env: Env): boolean {
  return env.DEMO_MODE === "true";
}

function deliverDeps(env: Env, repo: Repository): DeliverDeps {
  const demo = isDemo(env);
  return {
    repo,
    getDestination(name) {
      // Demo: the only destination is the simulated one below. No URL from config or users is ever used.
      if (demo) return name === DEMO_DESTINATION ? { url: "https://simulated.invalid/", secret: "simulated" } : null;
      const d = destinations[name];
      if (!d) return null;
      const url = str(env, d.urlEnv);
      const secret = str(env, d.secretEnv);
      if (!url || !secret || !isAllowedDestinationUrl(url)) return null;
      return { url, secret };
    },
    fetch: demo
      ? async (_url, init) => simulateDestination(Number(new Headers(init.headers).get("x-relay-attempt")), String(init.body ?? ""))
      : (url, init) => fetch(url, init),
    nowMs: () => Date.now(),
    random: Math.random,
    maxAttempts: num(env.MAX_ATTEMPTS, 6),
    backoff: { baseSeconds: num(env.RETRY_BASE_SECONDS, 30), maxSeconds: num(env.RETRY_MAX_SECONDS, 3600) },
    timeoutMs: num(env.DELIVERY_TIMEOUT_MS, 10_000),
    batchSize: num(env.BATCH_SIZE, 10),
  };
}

async function isAdmin(req: Request, env: Env): Promise<boolean> {
  const expected = str(env, "ADMIN_TOKEN");
  if (!expected) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  // Compare fixed-length digests so neither length nor content leaks through timing.
  return timingSafeEqual(await sha256Hex(m[1]!), await sha256Hex(expected));
}

async function runDelivery(env: Env, repo: Repository): Promise<void> {
  try {
    await processDue(deliverDeps(env, repo));
  } catch (e) {
    console.error("delivery run failed", e instanceof Error ? e.message : e);
  }
}

async function handleAdmin(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  repo: Repository & DemoStore,
  lazyDelivery: () => void,
): Promise<Response> {
  if (isDemo(env)) {
    // Public and strictly read-only: no token, and nothing but GET (so no replay) even with a token.
    if (req.method !== "GET") return json(403, { error: "read-only in demo mode" }, { allow: "GET" });
    if (url.pathname.endsWith("/replay")) return json(403, { error: "replay is disabled in demo mode" });
  } else if (!(await isAdmin(req, env))) {
    return json(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="admin"' });
  }
  const parts = url.pathname.split("/").filter(Boolean); // ["admin", "events", id?, "replay"?]

  // Demo only: duplicates ignored and requests rejected, so the panel can show them.
  if (isDemo(env) && parts[1] === "intake" && parts.length === 2) {
    return json(200, { entries: await repo.listIntake(30) });
  }

  if (parts[1] !== "events") return json(404, { error: "not found" });

  // Demo only: due retries are also processed when the panel reads (see createWorker).
  if (isDemo(env)) lazyDelivery();

  if (parts.length === 2 && req.method === "GET") {
    const status = url.searchParams.get("status");
    if (status && !STATUSES.includes(status as DeliveryStatus)) return json(400, { error: "invalid status" });
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const events = await repo.listEvents({ status: (status as DeliveryStatus) || undefined, limit, offset });
    return json(200, { events, limit, offset });
  }

  const id = parts[2];
  if (!id) return json(404, { error: "not found" });

  if (parts.length === 3 && req.method === "GET") {
    const ev = await repo.getEvent(id);
    return ev ? json(200, ev) : json(404, { error: "event not found" });
  }

  if (parts.length === 4 && parts[3] === "replay") {
    if (req.method !== "POST") return json(405, { error: "method not allowed" }, { allow: "POST" });
    const n = await repo.replayEvent(id, Date.now());
    if (n === null) return json(404, { error: "event not found" });
    if (n === 0) return json(409, { error: "no failed or dead deliveries to replay" });
    ctx.waitUntil(runDelivery(env, repo));
    return json(202, { result: "replay scheduled", deliveries: n });
  }
  return json(404, { error: "not found" });
}

type RepoFactory = (env: Env) => Repository & DemoStore;

async function clientKey(req: Request, pepper: string): Promise<string> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  return (await hmacSha256Hex(pepper, ip)).slice(0, 24); // salted hash: raw IPs are never stored
}

type DemoAction = "sample" | "duplicate" | "bad-signature";

/**
 * POST /demo/sample, /demo/duplicate, /demo/bad-signature. Demo mode only.
 * Every event is generated and signed on the server; the visitor only picks the action
 * (and, for "sample", one of three scenarios). All three share the same limits.
 */
async function handleDemoAction(
  action: DemoAction,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  repo: Repository & DemoStore,
): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method not allowed" }, { allow: "POST" });
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== url.origin) return json(403, { error: "cross-origin requests are not allowed" });
  const secret = str(env, demoSource.secretEnv);
  if (!secret) return json(503, { error: "demo is not configured" });

  const raw = await readLimited(req, MAX_SAMPLE_REQUEST_BYTES);
  if (raw === null) return json(413, { error: "request too large" });
  let scenario: "flaky" | "ok" | "down" = "ok";
  if (action === "sample") {
    const parsed = parseSampleRequest(raw);
    if (!parsed.ok) return json(400, { error: parsed.error });
    scenario = parsed.scenario;
  } else if (!isEmptyRequest(raw)) {
    return json(400, { error: "this action takes no input" });
  }

  const limits = parseDemoLimits(env);
  const now = Date.now();
  const verdict = await checkRateLimit(repo, now, await clientKey(req, secret), limits);
  if (!verdict.ok) {
    return json(
      429,
      { error: verdict.scope === "ip" ? "too many sample events from your address, try again later" : "the demo has reached its hourly limit, try again later" },
      { "retry-after": String(verdict.retryAfterSeconds) },
    );
  }

  // Hard cap: make room before inserting (oldest events go first).
  if ((await repo.countEvents()) >= limits.maxEvents) await repo.trimEventsTo(limits.maxEvents - 1);

  const id = `evt_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const body = buildSampleBody(id, scenario, Math.random(), now);
  const ts = String(Math.floor(now / 1000));
  // A bad signature is made by signing with a different key; the real secret is never involved.
  const signingKey = action === "bad-signature" ? `${secret}:not-the-key` : secret;
  const headers = new Headers({
    "x-signature": `sha256=${await hmacSha256Hex(signingKey, `${ts}.${body}`)}`,
    "x-timestamp": ts,
    "x-event-id": id,
  });
  // The same ingest path as a real webhook: signature, idempotency, atomic insert.
  const ingest = () =>
    handleIngest(
      { repo, getSource: () => ({ cfg: demoSource, secret }), nowMs: () => now, newId: () => crypto.randomUUID() },
      DEMO_SOURCE,
      headers,
      body,
    );
  const result = await ingest();
  if (result.status === 202) ctx.waitUntil(runDelivery(env, repo));

  if (action === "bad-signature") {
    await repo.logIntake({ receivedAt: now, kind: "rejected", reason: result.body.error ?? "rejected", eventId: null, eventKey: id });
    return json(200, { result: "rejected", reason: result.body.error ?? "rejected" });
  }
  if (action === "duplicate" && result.status === 202) {
    // The very same request arrives a second time: the unique key makes it a no-op.
    const again = await ingest();
    await repo.logIntake({ receivedAt: now, kind: "duplicate", reason: "duplicate", eventId: result.body.id ?? null, eventKey: id });
    return json(202, { ...result.body, scenario, duplicateIgnored: again.status === 200 });
  }
  return json(result.status, { ...result.body, scenario });
}

function robots(): Response {
  return new Response("User-agent: *\nAllow: /\n", {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

/**
 * Demo only: besides the cron trigger (once a minute), due deliveries are also processed when the
 * panel reads, so a retry shows up after seconds, not minutes. It is bounded (the usual batch size,
 * at most one run per LAZY_MIN_INTERVAL_MS per Worker instance) and can only reach the simulated
 * destination. It is an optimisation: correctness still comes from the lease in claimDue and the cron.
 */
const LAZY_MIN_INTERVAL_MS = 2000;

function lazyDelivery(env: Env, ctx: ExecutionContext, repo: Repository, state: { lastLazyRun: number }): void {
  const now = Date.now();
  if (now - state.lastLazyRun < LAZY_MIN_INTERVAL_MS) return;
  state.lastLazyRun = now;
  ctx.waitUntil(runDelivery(env, repo));
}

async function route(req: Request, env: Env, ctx: ExecutionContext, makeRepo: RepoFactory, state: { lastLazyRun: number }): Promise<Response> {
  const url = new URL(req.url);
  const demo = isDemo(env);

  if (url.pathname === "/robots.txt" && req.method === "GET") return robots();

  const hook = /^\/hooks\/([a-z0-9_-]{1,40})$/.exec(url.pathname);
  if (hook) {
    // Demo: the public must not write arbitrary payloads. Events only come from /demo/sample.
    if (demo) return json(404, { error: "not found" });
    if (req.method !== "POST") return json(405, { error: "method not allowed" }, { allow: "POST" });
    const raw = await readLimited(req, num(env.MAX_BODY_BYTES, 262_144));
    if (raw === null) return json(413, { result: "error", error: "payload too large" });

    const repo = makeRepo(env);
    const result = await handleIngest(
      {
        repo,
        getSource(name) {
          const cfg = sources[name];
          const secret = cfg && str(env, cfg.secretEnv);
          return cfg && secret ? { cfg, secret } : null;
        },
        nowMs: () => Date.now(),
        newId: () => crypto.randomUUID(),
      },
      hook[1]!,
      req.headers,
      raw,
    );
    // Respond now; the first delivery attempt runs after the response.
    // If this invocation is cut short, the cron trigger picks the event up.
    if (result.status === 202) ctx.waitUntil(runDelivery(env, repo));
    return json(result.status, result.body);
  }

  const demoAction = demo ? /^\/demo\/(sample|duplicate|bad-signature)$/.exec(url.pathname) : null;
  if (demoAction) return handleDemoAction(demoAction[1] as DemoAction, req, env, ctx, url, makeRepo(env));

  if (url.pathname.startsWith("/admin/")) {
    const repo = makeRepo(env);
    return handleAdmin(req, env, ctx, url, repo, () => lazyDelivery(env, ctx, repo, state));
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const limits = parseDemoLimits(env);
    return new Response(panelHtml(nonce, demo ? { ttlHours: limits.ttlMs / 3_600_000, maxEvents: limits.maxEvents } : null, parseLang(url.searchParams.get("lang")) ?? undefined), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      },
    });
  }
  return json(404, { error: "not found" });
}

/** The Worker, with the repository injected so tests can run it without D1. */
export function createWorker(makeRepo: RepoFactory): ExportedHandler<Env> {
  const state = { lastLazyRun: 0 };
  return {
    async fetch(req, env, ctx) {
      let res: Response;
      try {
        res = await route(req, env, ctx, makeRepo, state);
      } catch (e) {
        console.error("request failed", e instanceof Error ? e.message : e);
        res = json(500, { error: "internal error" });
      }
      // Never indexed, whatever the response is (also errors, JSON, robots.txt).
      const headers = new Headers(res.headers);
      headers.set("x-robots-tag", "noindex, nofollow");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    },

    async scheduled(_controller, env, ctx) {
      const repo = makeRepo(env);
      ctx.waitUntil(
        (async () => {
          await runDelivery(env, repo);
          if (!isDemo(env)) return;
          try {
            const r = await runRetention(repo, Date.now(), parseDemoLimits(env));
            if (r.expired || r.evicted) console.log(`retention: expired=${r.expired} evicted=${r.evicted}`);
          } catch (e) {
            console.error("retention failed", e instanceof Error ? e.message : e);
          }
        })(),
      );
    },
  };
}

export default createWorker((env) => new D1Repository(env.DB)) satisfies ExportedHandler<Env>;
