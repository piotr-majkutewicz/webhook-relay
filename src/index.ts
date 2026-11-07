import { destinations, isAllowedDestinationUrl, num, sources, str, type Env } from "./config";
import { processDue, type DeliverDeps } from "./core/deliver";
import { handleIngest } from "./core/ingest";
import { sha256Hex, timingSafeEqual } from "./core/signature";
import type { DeliveryStatus, Repository } from "./core/types";
import { D1Repository } from "./d1repo";
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

function deliverDeps(env: Env, repo: Repository): DeliverDeps {
  return {
    repo,
    getDestination(name) {
      const d = destinations[name];
      if (!d) return null;
      const url = str(env, d.urlEnv);
      const secret = str(env, d.secretEnv);
      if (!url || !secret || !isAllowedDestinationUrl(url)) return null;
      return { url, secret };
    },
    fetch: (url, init) => fetch(url, init),
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

async function handleAdmin(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (!(await isAdmin(req, env))) {
    return json(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="admin"' });
  }
  const repo = new D1Repository(env.DB);
  const parts = url.pathname.split("/").filter(Boolean); // ["admin", "events", id?, "replay"?]

  if (parts[1] !== "events") return json(404, { error: "not found" });

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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    const hook = /^\/hooks\/([a-z0-9_-]{1,40})$/.exec(url.pathname);
    if (hook) {
      if (req.method !== "POST") return json(405, { error: "method not allowed" }, { allow: "POST" });
      const raw = await readLimited(req, num(env.MAX_BODY_BYTES, 262_144));
      if (raw === null) return json(413, { result: "error", error: "payload too large" });

      const repo = new D1Repository(env.DB);
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

    if (url.pathname.startsWith("/admin/")) return handleAdmin(req, env, ctx, url);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      return new Response(panelHtml(nonce), {
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
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDelivery(env, new D1Repository(env.DB)));
  },
} satisfies ExportedHandler<Env>;
