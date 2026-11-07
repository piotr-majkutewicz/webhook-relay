-- Events: one row per accepted webhook. (source, event_key) is the idempotency key.
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  event_key   TEXT NOT NULL,
  body        TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX events_source_key ON events (source, event_key);
CREATE INDEX events_received_at ON events (received_at DESC);

-- Deliveries: one row per (event, destination).
-- status: pending | delivered | failed (permanent error) | dead (retries exhausted)
CREATE TABLE deliveries (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  destination      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  replays          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_status_code INTEGER,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  delivered_at     INTEGER
);
CREATE UNIQUE INDEX deliveries_event_dest ON deliveries (event_id, destination);
CREATE INDEX deliveries_due ON deliveries (status, next_attempt_at);

-- Attempts: append-only history of every delivery attempt.
CREATE TABLE attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
  attempt_no  INTEGER NOT NULL,
  replay_no   INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  outcome     TEXT NOT NULL,
  status_code INTEGER,
  error       TEXT
);
CREATE INDEX attempts_delivery ON attempts (delivery_id, id);
