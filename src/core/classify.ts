import type { AttemptOutcome } from "./types";

/**
 * Classifies the destination's HTTP response.
 * - 2xx: success
 * - 408, 425, 429 and 5xx: transient, retry
 * - other 4xx and 3xx (redirects are not followed): permanent
 */
export function classifyStatus(status: number): AttemptOutcome {
  if (status >= 200 && status < 300) return "success";
  if (status === 408 || status === 425 || status === 429) return "retry";
  if (status >= 500) return "retry";
  return "permanent";
}

/** Network errors and timeouts are always treated as transient. */
export function classifyError(): AttemptOutcome {
  return "retry";
}
