import { sha256Hex } from "./signature";

const MAX_KEY_LENGTH = 200;

function readPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export type KeyResult = { ok: true; key: string } | { ok: false; reason: string };

/**
 * Extracts the event key from a header or a JSON path. If the source has no
 * configured key location at all, falls back to a hash of the raw body, which
 * deduplicates exact retransmissions only.
 */
export async function extractEventKey(
  cfg: { header?: string; jsonPath?: string },
  headers: Headers,
  rawBody: string,
  parsedBody: unknown,
): Promise<KeyResult> {
  const configured = Boolean(cfg.header || cfg.jsonPath);
  let raw: unknown;
  if (cfg.header) raw = headers.get(cfg.header);
  if ((raw === null || raw === undefined || raw === "") && cfg.jsonPath) raw = readPath(parsedBody, cfg.jsonPath);

  if (typeof raw === "number") raw = String(raw);
  if (typeof raw === "string" && raw.trim() !== "") {
    const key = raw.trim();
    if (key.length > MAX_KEY_LENGTH) return { ok: false, reason: "event key too long" };
    return { ok: true, key };
  }
  if (configured) return { ok: false, reason: "event key missing" };
  return { ok: true, key: `sha256:${await sha256Hex(rawBody)}` };
}
