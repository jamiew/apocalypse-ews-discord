CREATE TABLE IF NOT EXISTS subscribers (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK(kind IN ('guild_channel','dm')),
  discord_id    TEXT NOT NULL,
  guild_id      TEXT,
  status        TEXT NOT NULL CHECK(status IN ('active','unsubscribed')),
  subscribed_at TEXT NOT NULL,
  last_reminded TEXT,
  UNIQUE(kind, discord_id)
);

CREATE INDEX IF NOT EXISTS idx_subscribers_active
  ON subscribers (status, kind);

CREATE TABLE IF NOT EXISTS seen_alerts (
  guid        TEXT PRIMARY KEY,
  title       TEXT,
  link        TEXT,
  pub_date    TEXT,
  ingested_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seen_alerts_ingested
  ON seen_alerts (ingested_at DESC);
