-- Fixed-window counters for rate limiting sample events in DEMO_MODE.
-- key = "<scope>:<window start>" (scope is a salted IP hash or "global").
-- Rows older than two windows are removed by the cron trigger.
CREATE TABLE demo_rate_counters (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits         INTEGER NOT NULL
);
CREATE INDEX demo_rate_window ON demo_rate_counters (window_start);
