export type DeliveryStatus = "pending" | "delivered" | "failed" | "dead";
export type AttemptOutcome = "success" | "permanent" | "retry";

export interface SourceConfig {
  /** Name of the Worker secret that holds the HMAC key, e.g. SOURCE_SHOP_SECRET. */
  secretEnv: string;
  /** Header carrying the hex HMAC-SHA256 signature (optionally prefixed with "sha256="). */
  signatureHeader: string;
  /** If set, the timestamp is part of the signed payload ("<ts>.<body>") and must be fresh. */
  timestampHeader?: string;
  toleranceSeconds?: number;
  /** Where to find the idempotency key: a header or a dot path in the JSON payload. */
  idempotency: { header?: string; jsonPath?: string };
  /** Names of destinations (keys of the destinations config) to deliver to. */
  destinations: string[];
}

export interface DestinationConfig {
  /** Name of the env var with the target URL. */
  urlEnv: string;
  /** Name of the Worker secret used to sign outgoing requests. */
  secretEnv: string;
}

export interface AttemptRecord {
  attemptNo: number;
  replayNo: number;
  startedAt: number;
  durationMs: number;
  outcome: AttemptOutcome;
  statusCode: number | null;
  error: string | null;
}

export interface NewEvent {
  id: string;
  source: string;
  eventKey: string;
  body: string;
  receivedAt: number;
}

export interface ClaimedDelivery {
  deliveryId: string;
  eventId: string;
  source: string;
  eventKey: string;
  destination: string;
  body: string;
  /** Attempt number of this try (already counted when claimed). */
  attempts: number;
  replays: number;
}

export interface DeliveryUpdate {
  status: DeliveryStatus;
  nextAttemptAt: number;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: number | null;
}

export interface DeliveryView {
  id: string;
  destination: string;
  status: DeliveryStatus;
  attempts: number;
  replays: number;
  nextAttemptAt: number;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: number | null;
  attemptLog: AttemptRecord[];
}

export interface EventSummary {
  id: string;
  source: string;
  eventKey: string;
  receivedAt: number;
  status: DeliveryStatus;
  deliveries: number;
}

export interface EventDetail extends EventSummary {
  body: string;
  deliveryList: DeliveryView[];
}

export interface Repository {
  /** Atomically stores the event and one pending delivery per destination, unless (source, eventKey) exists. */
  insertEvent(event: NewEvent, destinations: string[]): Promise<{ id: string; duplicate: boolean }>;
  /** Marks due deliveries as in flight (lease), counts the attempt, and returns them. */
  claimDue(now: number, limit: number, leaseMs: number, maxAttempts: number): Promise<ClaimedDelivery[]>;
  recordAttempt(deliveryId: string, attempt: AttemptRecord, update: DeliveryUpdate): Promise<void>;
  listEvents(q: { status?: DeliveryStatus; limit: number; offset: number }): Promise<EventSummary[]>;
  getEvent(id: string): Promise<EventDetail | null>;
  /** Puts failed/dead deliveries of the event back to pending. Returns the number reset, or null if no such event. */
  replayEvent(id: string, now: number): Promise<number | null>;
}
