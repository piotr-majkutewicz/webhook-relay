export interface BackoffOptions {
  baseSeconds: number;
  maxSeconds: number;
}

/**
 * Exponential backoff with "equal jitter": the delay is half of the capped
 * exponential value plus a random part of the other half.
 * `attempt` is the number of the attempt that just failed (1 = first).
 * `random` must return a value in [0, 1).
 */
export function backoffSeconds(attempt: number, opts: BackoffOptions, random: () => number = Math.random): number {
  const exp = Math.min(opts.maxSeconds, opts.baseSeconds * 2 ** Math.max(0, attempt - 1));
  const half = exp / 2;
  return half + random() * half;
}
