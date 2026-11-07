-- DEMO_MODE only: a short log of intake outcomes that do not create an event
-- (a duplicate that was ignored, a request rejected for a bad signature), so the
-- panel can show them. Purged by the retention job together with old events.
CREATE TABLE demo_intake_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  event_id    TEXT,
  event_key   TEXT
);
CREATE INDEX demo_intake_received ON demo_intake_log (received_at DESC);
