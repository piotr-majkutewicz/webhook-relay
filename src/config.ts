import type { DestinationConfig, SourceConfig } from "./core/types";

/**
 * Sources and destinations are declared here. Secrets and URLs are not:
 * they are read from the environment (Worker secrets / vars) by name.
 * To add a source: add an entry below and `wrangler secret put SOURCE_<NAME>_SECRET`.
 */
export const sources: Record<string, SourceConfig> = {
  shop: {
    secretEnv: "SOURCE_SHOP_SECRET",
    signatureHeader: "x-signature",
    timestampHeader: "x-timestamp",
    toleranceSeconds: 300,
    idempotency: { header: "x-event-id" },
    destinations: ["crm"],
  },
  payments: {
    secretEnv: "SOURCE_PAYMENTS_SECRET",
    signatureHeader: "x-payments-signature",
    // No timestamp: replay is neutralised by the idempotency key instead.
    idempotency: { jsonPath: "id" },
    destinations: ["crm"],
  },
};

export const destinations: Record<string, DestinationConfig> = {
  crm: { urlEnv: "DEST_CRM_URL", secretEnv: "DEST_CRM_SECRET" },
};

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  MAX_BODY_BYTES?: string;
  MAX_ATTEMPTS?: string;
  RETRY_BASE_SECONDS?: string;
  RETRY_MAX_SECONDS?: string;
  DELIVERY_TIMEOUT_MS?: string;
  BATCH_SIZE?: string;
  /** "true" turns on the public, read-only demo behaviour (see README). Off by default. */
  DEMO_MODE?: string;
  DEMO_SOURCE_SECRET?: string;
  DEMO_TTL_HOURS?: string;
  DEMO_MAX_EVENTS?: string;
  DEMO_RATE_WINDOW_SECONDS?: string;
  DEMO_RATE_PER_IP?: string;
  DEMO_RATE_GLOBAL?: string;
  /** Multiplies the simulated step delays of the order story (default 1; tests use 0). */
  DEMO_STEP_DELAY_SCALE?: string;
  [key: string]: unknown;
}

export function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function str(env: Env, name: string): string | undefined {
  const v = env[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Plain HTTP is only accepted for loopback targets (local development). */
export function isAllowedDestinationUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}
