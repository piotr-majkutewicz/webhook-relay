import type { BackoffOptions } from "./backoff";
import { classifyError, classifyStatus } from "./classify";
import { hmacSha256Hex } from "./signature";
import { nextState } from "./state";
import type { AttemptOutcome, ClaimedDelivery, Repository } from "./types";

export interface DeliverDeps {
  repo: Repository;
  /** Resolves a destination name to its URL and signing secret, or null if misconfigured. */
  getDestination(name: string): { url: string; secret: string } | null;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  nowMs(): number;
  random(): number;
  maxAttempts: number;
  backoff: BackoffOptions;
  timeoutMs: number;
  batchSize: number;
}

/** Builds the signed outgoing request. The signature covers "<timestamp>.<body>". */
export async function buildRequest(d: ClaimedDelivery, secret: string, nowMs: number): Promise<RequestInit> {
  const ts = String(Math.floor(nowMs / 1000));
  const sig = await hmacSha256Hex(secret, `${ts}.${d.body}`);
  return {
    method: "POST",
    redirect: "manual",
    body: d.body,
    headers: {
      "content-type": "application/json",
      "x-relay-event-id": d.eventId,
      "x-relay-source": d.source,
      "x-relay-attempt": String(d.attempts),
      "x-relay-timestamp": ts,
      "x-relay-signature": `sha256=${sig}`,
      // Receivers should deduplicate on this: delivery is at-least-once.
      "idempotency-key": d.eventId,
    },
  };
}

export async function attemptDelivery(deps: DeliverDeps, d: ClaimedDelivery): Promise<AttemptOutcome> {
  const startedAt = deps.nowMs();
  let outcome: AttemptOutcome;
  let statusCode: number | null = null;
  let error: string | null = null;

  const dest = deps.getDestination(d.destination);
  if (!dest) {
    // Misconfiguration is an operator problem, not a transient one.
    outcome = "permanent";
    error = "destination is not configured";
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    try {
      const init = await buildRequest(d, dest.secret, startedAt);
      const res = await deps.fetch(dest.url, { ...init, signal: controller.signal });
      statusCode = res.status;
      outcome = classifyStatus(res.status);
      if (outcome !== "success") error = `HTTP ${res.status}`;
      // Drain the body so the connection can be released.
      await res.body?.cancel();
    } catch (e) {
      outcome = classifyError();
      error = controller.signal.aborted ? `timeout after ${deps.timeoutMs} ms` : e instanceof Error ? e.message : "network error";
    } finally {
      clearTimeout(timer);
    }
  }

  const finishedAt = deps.nowMs();
  const t = nextState(outcome, d.attempts, deps.maxAttempts, finishedAt, deps.backoff, deps.random);
  await deps.repo.recordAttempt(
    d.deliveryId,
    {
      attemptNo: d.attempts,
      replayNo: d.replays,
      startedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
      outcome,
      statusCode,
      error,
    },
    {
      status: t.status,
      nextAttemptAt: t.nextAttemptAt,
      lastStatusCode: statusCode,
      lastError: error,
      deliveredAt: t.status === "delivered" ? finishedAt : null,
    },
  );
  return outcome;
}

/** Claims due deliveries and attempts each of them. Returns how many were processed. */
export async function processDue(deps: DeliverDeps): Promise<number> {
  const lease = deps.timeoutMs * 3 + 5000;
  const claimed = await deps.repo.claimDue(deps.nowMs(), deps.batchSize, lease, deps.maxAttempts);
  // Small fixed concurrency keeps the number of simultaneous outgoing connections low.
  const concurrency = 5;
  for (let i = 0; i < claimed.length; i += concurrency) {
    await Promise.all(claimed.slice(i, i + concurrency).map((d) => attemptDelivery(deps, d)));
  }
  return claimed.length;
}
