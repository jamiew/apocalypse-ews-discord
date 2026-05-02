-- Single-row state for the upstream emergencyLevel tracker. Lets the
-- level-poller compare current state to the last observation and emit a
-- level_change event when they differ.
--
-- Level history is recorded in the events table (kind='level_change') —
-- no separate audit table needed.

CREATE TABLE IF NOT EXISTS level_state (
	id              INTEGER PRIMARY KEY CHECK (id = 1),
	emergency_level INTEGER,                              -- 1..5; NULL = never observed
	alert_level     TEXT,                                 -- e.g. "normal", "elevated", "alarm"
	z_score         REAL,
	as_of           TEXT,                                 -- upstream's `current.asOf`
	updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO level_state (id) VALUES (1);
