import { extractEventKey } from "./idempotency";
import { verifySignature } from "./signature";
import type { Repository, SourceConfig } from "./types";

export interface IngestDeps {
  repo: Repository;
  /** Returns the source config and its secret, or null if the source is unknown / not configured. */
  getSource(name: string): { cfg: SourceConfig; secret: string } | null;
  nowMs(): number;
  newId(): string;
}

export interface IngestResult {
  status: number;
  body: { result: string; id?: string; error?: string };
}

const reply = (status: number, body: IngestResult["body"]): IngestResult => ({ status, body });

/**
 * Handles an already-read webhook request: verify, deduplicate, store.
 * Never performs delivery; that happens later, outside the request path.
 */
export async function handleIngest(
  deps: IngestDeps,
  sourceName: string,
  headers: Headers,
  rawBody: string,
): Promise<IngestResult> {
  const source = deps.getSource(sourceName);
  if (!source) return reply(404, { result: "error", error: "unknown source" });
  const { cfg, secret } = source;

  const verdict = await verifySignature({
    secret,
    body: rawBody,
    signatureHeader: headers.get(cfg.signatureHeader),
    timestampHeader: cfg.timestampHeader ? headers.get(cfg.timestampHeader) : null,
    requireTimestamp: Boolean(cfg.timestampHeader),
    toleranceSeconds: cfg.toleranceSeconds,
    nowSeconds: Math.floor(deps.nowMs() / 1000),
  });
  if (!verdict.ok) return reply(401, { result: "rejected", error: verdict.reason });

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return reply(400, { result: "error", error: "body is not valid JSON" });
  }

  const key = await extractEventKey(cfg.idempotency, headers, rawBody, parsed);
  if (!key.ok) return reply(400, { result: "error", error: key.reason });

  const { id, duplicate } = await deps.repo.insertEvent(
    { id: deps.newId(), source: sourceName, eventKey: key.key, body: rawBody, receivedAt: deps.nowMs() },
    cfg.destinations,
  );
  return duplicate ? reply(200, { result: "duplicate", id }) : reply(202, { result: "accepted", id });
}
