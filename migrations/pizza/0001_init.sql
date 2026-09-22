-- Pentagon Pizza Watch. Separate database file from the EWS bot: separate
-- process, separate Discord application, separate subscriber list.

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

-- Idempotency boundary. A post observed here is never dispatched again, so a
-- restart mid-poll skips rather than double-posting.
CREATE TABLE IF NOT EXISTS seen_posts (
  post_id     TEXT PRIMARY KEY,
  text        TEXT,
  posted_at   TEXT,
  level       INTEGER,            -- 1..5, NULL when the post carried no venue reading
  pizza       INTEGER,            -- -3..3, NULL when no pizzeria was described
  bar         INTEGER,            -- -3..3, NULL when no bar was described
  ingested_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seen_posts_posted
  ON seen_posts (posted_at DESC);

CREATE INDEX IF NOT EXISTS idx_seen_posts_ingested
  ON seen_posts (ingested_at DESC);

-- Durable activity log, same shape as the EWS bot's.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind       TEXT NOT NULL,
  guild_id   TEXT,
  channel_id TEXT,
  user_id    TEXT,
  payload    TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts       ON events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts  ON events (kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_user_ts  ON events (user_id, ts DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_guild_ts ON events (guild_id, ts DESC) WHERE guild_id IS NOT NULL;

-- Single-row "last announced signal" tracker. The poller diffs against this to
-- decide whether a new post is a transition worth announcing.
CREATE TABLE IF NOT EXISTS signal_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  level         INTEGER,          -- 1..5; NULL = never observed
  pizza         INTEGER,
  bar           INTEGER,
  post_id       TEXT,
  post_text     TEXT,
  posted_at     TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO signal_state (id) VALUES (1);
