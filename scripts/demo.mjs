// Demo: sends signed sample events to a local worker (npm run dev) and shows
// how retries, deduplication and signature checks behave.
// Requires: `cp .dev.vars.example .dev.vars`, migrations applied, and the
// worker started with `npm run dev` (cron simulation enabled).
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const BASE = process.env.RELAY_URL ?? "http://127.0.0.1:8787";
const ADMIN = process.env.ADMIN_TOKEN ?? "dev-admin-token";
const SHOP_SECRET = process.env.SOURCE_SHOP_SECRET ?? "dev-shop-secret";
const PAY_SECRET = process.env.SOURCE_PAYMENTS_SECRET ?? "dev-payments-secret";
const CRM_SECRET = process.env.DEST_CRM_SECRET ?? "dev-crm-secret";
const FAILURES = 3; // the fake CRM answers 500 this many times per event, then 200

const hmac = (secret, msg) => createHmac("sha256", secret).update(msg).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// --- fake "unreliable" target system -------------------------------------
const hits = new Map(); // event id -> number of requests received
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const id = req.headers["x-relay-event-id"];
    const ts = req.headers["x-relay-timestamp"];
    const valid = req.headers["x-relay-signature"] === `sha256=${hmac(CRM_SECRET, `${ts}.${body}`)}`;
    const n = (hits.get(id) ?? 0) + 1;
    hits.set(id, n);
    const status = !valid ? 401 : n <= FAILURES ? 500 : 200;
    log(`    [crm] request #${n} for ${String(id).slice(0, 8)} signature ${valid ? "valid" : "INVALID"} -> ${status}`);
    res.writeHead(status).end();
  });
});
await new Promise((r) => server.listen(9100, "127.0.0.1", r));

// --- helpers --------------------------------------------------------------
async function send(source, body, { secret, eventId, ts = Math.floor(Date.now() / 1000) }) {
  const headers = { "content-type": "application/json" };
  if (source === "shop") {
    headers["x-timestamp"] = String(ts);
    headers["x-signature"] = `sha256=${hmac(secret, `${ts}.${body}`)}`;
    headers["x-event-id"] = eventId;
  } else {
    headers["x-payments-signature"] = `sha256=${hmac(secret, body)}`;
  }
  const res = await fetch(`${BASE}/hooks/${source}`, { method: "POST", headers, body });
  return { status: res.status, body: await res.json() };
}
const admin = (path, init = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${ADMIN}` } }).then((r) => r.json());
const tick = () => fetch(`${BASE}/cdn-cgi/handler/scheduled`).catch(() => {}); // simulates the cron trigger

try {
  const health = await fetch(`${BASE}/`).catch(() => null);
  if (!health) throw new Error(`Worker not reachable at ${BASE}. Start it with: npm run dev`);

  const run = Date.now().toString(36);
  const order = JSON.stringify({ type: "order.paid", order: `A-${run}`, amount: 249 });

  log("1) valid signed event from 'shop'");
  const first = await send("shop", order, { secret: SHOP_SECRET, eventId: `evt-${run}` });
  log("   ->", first.status, JSON.stringify(first.body));

  log("2) the same event sent again (same event id)");
  const dup = await send("shop", order, { secret: SHOP_SECRET, eventId: `evt-${run}` });
  log("   ->", dup.status, JSON.stringify(dup.body));

  log("3) event with a wrong signature");
  const bad = await send("shop", order, { secret: "wrong-secret", eventId: `evt-bad-${run}` });
  log("   ->", bad.status, JSON.stringify(bad.body));

  log("4) event with a stale timestamp (signed correctly, 1 hour old)");
  const old = await send("shop", order, { secret: SHOP_SECRET, eventId: `evt-old-${run}`, ts: Math.floor(Date.now() / 1000) - 3600 });
  log("   ->", old.status, JSON.stringify(old.body));

  log("5) valid event from 'payments' (idempotency key taken from payload field 'id')");
  const pay = JSON.stringify({ id: `pay_${run}`, type: "payment.succeeded", amount: 4900 });
  const p = await send("payments", pay, { secret: PAY_SECRET });
  log("   ->", p.status, JSON.stringify(p.body));

  log(`\nWaiting for retries (the fake CRM fails ${FAILURES} times per event, then recovers)...`);
  const ids = [first.body.id, p.body.id];
  for (let i = 0; i < 60; i++) {
    await tick();
    await sleep(1000);
    const evs = await Promise.all(ids.map((id) => admin(`/admin/events/${id}`)));
    if (evs.every((e) => e.status === "delivered")) break;
  }

  log("\nResult:");
  for (const id of ids) {
    const e = await admin(`/admin/events/${id}`);
    log(`  event ${e.source}/${e.eventKey}: ${e.status}`);
    for (const d of e.deliveryList) {
      log(`    -> ${d.destination}: ${d.status}, attempts=${d.attempts}, codes=[${d.attemptLog.map((a) => a.statusCode).join(", ")}]`);
    }
  }
  const all = await admin("/admin/events");
  log(`\nEvents in the database: ${all.events.length} (this run adds two; the duplicate, the bad signature and the stale timestamp are never stored)`);
} catch (e) {
  console.error(String(e.message ?? e));
  process.exitCode = 1;
} finally {
  server.close();
}
