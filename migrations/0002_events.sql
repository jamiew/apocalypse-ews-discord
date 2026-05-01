-- Durable activity log. Every meaningful action records one row so we can
-- audit production behaviour (deliveries, signups, errors, raw user messages)
-- without trawling stdout. Payload is a JSON blob; the indexed columns are
-- the dimensions we expect to filter on.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind       TEXT NOT NULL,
  guild_id   TEXT,
  channel_id TEXT,
  user_id    TEXT,
  payload    TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts        ON events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts   ON events (kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_user_ts   ON events (user_id, ts DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_guild_ts  ON events (guild_id, ts DESC) WHERE guild_id IS NOT NULL;
