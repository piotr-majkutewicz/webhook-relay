import type { SourceConfig } from "./types";
import { num } from "../config";

/** Built-in source and destination used by DEMO_MODE. Nothing else is reachable in that mode. */
export const DEMO_SOURCE = "demo";
export const DEMO_DESTINATION = "simulated";

export const demoSource: SourceConfig = {
  secretEnv: "DEMO_SOURCE_SECRET",
  signatureHeader: "x-signature",
  timestampHeader: "x-timestamp",
  toleranceSeconds: 300,
  idempotency: { header: "x-event-id" },
  destinations: [DEMO_DESTINATION],
};

export const SCENARIOS = ["flaky", "ok", "down"] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** Largest request body accepted by the sample endpoint. The real input is one enum value. */
export const MAX_SAMPLE_REQUEST_BYTES = 256;

const AMOUNTS = [1900, 4900, 12900, 24900];

export interface DemoLimits {
  ttlMs: number;
  maxEvents: number;
  windowMs: number;
  perIp: number;
  global: number;
}

export function parseDemoLimits(env: Record<string, unknown>): DemoLimits {
  const s = (k: string) => (typeof env[k] === "string" ? (env[k] as string) : undefined);
  return {
    ttlMs: num(s("DEMO_TTL_HOURS"), 24) * 3_600_000,
    maxEvents: Math.floor(num(s("DEMO_MAX_EVENTS"), 500)),
    windowMs: num(s("DEMO_RATE_WINDOW_SECONDS"), 3600) * 1000,
    perIp: Math.floor(num(s("DEMO_RATE_PER_IP"), 10)),
    global: Math.floor(num(s("DEMO_RATE_GLOBAL"), 100)),
  };
}

/**
 * Validates the sample request. The body is optional; if present it must be exactly
 * `{"scenario": "flaky" | "ok" | "down"}` (no other keys). Everything else in the
 * stored event is generated on the server.
 */
export function parseSampleRequest(raw: string): { ok: true; scenario: Scenario } | { ok: false; error: string } {
  if (raw.trim() === "") return { ok: true, scenario: "flaky" };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, error: "body must be JSON" };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, error: "body must be a JSON object" };
  const keys = Object.keys(v);
  if (keys.length === 0) return { ok: true, scenario: "flaky" };
  if (keys.length !== 1 || keys[0] !== "scenario") return { ok: false, error: "only the field 'scenario' is accepted" };
  const sc = (v as { scenario: unknown }).scenario;
  if (typeof sc !== "string" || !(SCENARIOS as readonly string[]).includes(sc)) {
    return { ok: false, error: `scenario must be one of: ${SCENARIOS.join(", ")}` };
  }
  return { ok: true, scenario: sc as Scenario };
}

/** The whole stored payload. Fixed shape, fixed small vocabulary, about 150 bytes. */
export function buildSampleBody(id: string, scenario: Scenario, random: number, nowMs: number): string {
  const amount = AMOUNTS[Math.min(AMOUNTS.length - 1, Math.floor(random * AMOUNTS.length))]!;
  return JSON.stringify({
    id,
    type: "order.paid",
    scenario,
    amount,
    currency: "PLN",
    created: new Date(nowMs).toISOString(),
  });
}

/**
 * The simulated destination. It never touches the network: it answers from the
 * attempt number and the scenario inside the (server generated) payload.
 *   ok:    always 200
 *   flaky: 503 on attempts 1 and 2, 200 from attempt 3
 *   down:  always 503, so the delivery ends up dead after MAX_ATTEMPTS
 */
export function simulateDestination(attempt: number, body: string): Response {
  let scenario: unknown;
  try {
    scenario = (JSON.parse(body) as { scenario?: unknown }).scenario;
  } catch {
    scenario = undefined;
  }
  const fail = scenario === "down" || (scenario === "flaky" && attempt <= 2);
  return new Response(null, { status: fail ? 503 : 200 });
}

export interface IntakeEntry {
  id: number;
  receivedAt: number;
  /** "duplicate": an identical event was ignored. "rejected": the request was refused. */
  kind: "duplicate" | "rejected";
  /** Stable identifier: "duplicate" or a signature verdict such as "bad_signature". */
  reason: string;
  eventId: string | null;
  eventKey: string | null;
}

/** Only an empty body or `{}` is accepted by the actions that take no input. */
export function isEmptyRequest(raw: string): boolean {
  if (raw.trim() === "") return true;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;
  } catch {
    return false;
  }
}

/** Counters and retention operations needed by DEMO_MODE (implemented by D1 and in memory). */
export interface DemoStore {
  /** Adds one hit to the counter and returns the new value. */
  hitCounter(key: string, windowStart: number): Promise<number>;
  purgeCounters(olderThanWindowStart: number): Promise<void>;
  countEvents(): Promise<number>;
  /** Deletes events (with deliveries and attempts) received before `cutoffMs`. Returns the number of events. */
  purgeEventsBefore(cutoffMs: number): Promise<number>;
  /** Keeps only the newest `keep` events and deletes the rest. Returns the number of events deleted. */
  trimEventsTo(keep: number): Promise<number>;
  logIntake(entry: Omit<IntakeEntry, "id">): Promise<void>;
  listIntake(limit: number): Promise<IntakeEntry[]>;
  purgeIntakeBefore(cutoffMs: number): Promise<void>;
  trimIntakeTo(keep: number): Promise<void>;
}

export type RateVerdict = { ok: true } | { ok: false; scope: "ip" | "global"; retryAfterSeconds: number };

/**
 * Fixed-window limits: first per client (salted hash), then global.
 * A client that is over its own limit does not consume the global budget.
 */
export async function checkRateLimit(
  store: DemoStore,
  nowMs: number,
  clientKey: string,
  limits: Pick<DemoLimits, "windowMs" | "perIp" | "global">,
): Promise<RateVerdict> {
  const windowStart = Math.floor(nowMs / limits.windowMs) * limits.windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + limits.windowMs - nowMs) / 1000));
  if ((await store.hitCounter(`ip:${clientKey}:${windowStart}`, windowStart)) > limits.perIp) {
    return { ok: false, scope: "ip", retryAfterSeconds };
  }
  if ((await store.hitCounter(`global:${windowStart}`, windowStart)) > limits.global) {
    return { ok: false, scope: "global", retryAfterSeconds };
  }
  return { ok: true };
}

/** Run by the cron trigger: TTL first, then the hard cap (oldest evicted), then old counters. */
export async function runRetention(
  store: DemoStore,
  nowMs: number,
  limits: Pick<DemoLimits, "ttlMs" | "maxEvents" | "windowMs">,
): Promise<{ expired: number; evicted: number }> {
  const expired = await store.purgeEventsBefore(nowMs - limits.ttlMs);
  const evicted = await store.trimEventsTo(limits.maxEvents);
  await store.purgeIntakeBefore(nowMs - limits.ttlMs);
  await store.trimIntakeTo(limits.maxEvents);
  await store.purgeCounters(nowMs - 2 * limits.windowMs);
  return { expired, evicted };
}
