const encoder = new TextEncoder();

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export async function sha256Hex(message: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(message)));
}

/** Constant-time comparison of two strings (length is not secret for fixed-size hex digests). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_signature" | "bad_signature" | "missing_timestamp" | "stale_timestamp" };

export interface VerifyInput {
  secret: string;
  /** Raw request body, exactly as received. */
  body: string;
  signatureHeader: string | null;
  /** Provide both to enable replay protection. */
  timestampHeader?: string | null;
  requireTimestamp?: boolean;
  toleranceSeconds?: number;
  /** Current time in seconds since the epoch. */
  nowSeconds: number;
}

/** The signed message: "<timestamp>.<body>" when a timestamp is used, otherwise the body. */
export function signedPayload(body: string, timestamp?: string | null): string {
  return timestamp ? `${timestamp}.${body}` : body;
}

export async function verifySignature(input: VerifyInput): Promise<VerifyResult> {
  if (!input.signatureHeader) return { ok: false, reason: "missing_signature" };

  let timestamp: string | null = null;
  if (input.requireTimestamp) {
    if (!input.timestampHeader) return { ok: false, reason: "missing_timestamp" };
    timestamp = input.timestampHeader;
  }

  const provided = input.signatureHeader.trim().replace(/^sha256=/i, "").toLowerCase();
  const expected = await hmacSha256Hex(input.secret, signedPayload(input.body, timestamp));
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: "bad_signature" };

  // The timestamp is checked after the signature so that only authentic
  // timestamps are evaluated (and error details are not leaked to forgers).
  if (timestamp !== null) {
    const ts = Number(timestamp);
    const tolerance = input.toleranceSeconds ?? 300;
    if (!Number.isFinite(ts) || Math.abs(input.nowSeconds - ts) > tolerance) {
      return { ok: false, reason: "stale_timestamp" };
    }
  }
  return { ok: true };
}
