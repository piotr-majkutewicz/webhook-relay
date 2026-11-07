import { backoffSeconds, type BackoffOptions } from "./backoff";
import type { AttemptOutcome, DeliveryStatus } from "./types";

export interface Transition {
  status: DeliveryStatus;
  /** Epoch milliseconds. For terminal states it is just the time of the transition. */
  nextAttemptAt: number;
}

/**
 * Pure state transition after an attempt.
 * `attempts` already includes the attempt that just finished.
 */
export function nextState(
  outcome: AttemptOutcome,
  attempts: number,
  maxAttempts: number,
  nowMs: number,
  backoff: BackoffOptions,
  random: () => number = Math.random,
): Transition {
  if (outcome === "success") return { status: "delivered", nextAttemptAt: nowMs };
  if (outcome === "permanent") return { status: "failed", nextAttemptAt: nowMs };
  if (attempts >= maxAttempts) return { status: "dead", nextAttemptAt: nowMs };
  return { status: "pending", nextAttemptAt: nowMs + Math.round(backoffSeconds(attempts, backoff, random) * 1000) };
}

export function canReplay(status: DeliveryStatus): boolean {
  return status === "failed" || status === "dead";
}

/** Overall event status derived from its deliveries: dead > failed > pending > delivered. */
export function aggregateStatus(statuses: DeliveryStatus[]): DeliveryStatus {
  if (statuses.includes("dead")) return "dead";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("pending")) return "pending";
  return "delivered";
}
