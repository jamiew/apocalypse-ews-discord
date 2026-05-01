import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { LastAlert } from "./copy.js";

export type SubscriberKind = "guild_channel" | "dm";
export type SubscriberStatus = "active" | "unsubscribed";

/**
 * Closed set of event kinds the bot records. Adding a new kind is a one-line
 * change here plus a callsite — keeping the union closed lets the type system
 * catch typos and lets us enumerate them in queries.
 */
export type EventKind =
  | "startup"
  | "shutdown"
  | "guild_create"
  | "guild_delete"
  | "guild_welcome_sent"
  | "command"
  | "subscribe"
  | "unsubscribe"
  | "dm_in"
  | "dm_out"
  | "alert_seen"
  | "alert_dispatch_ok"
  | "alert_dispatch_fail"
  | "reminder_ok"
  | "reminder_fail"
  | "error";

export interface EventRecord {
  id: number;
  ts: string;
  kind: EventKind;
  guild_id: string | null;
  channel_id: string | null;
  user_id: string | null;
  payload: string | null;
}

export interface RecordEventInput {
  kind: EventKind;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface Subscriber {
  id: number;
  kind: SubscriberKind;
  discord_id: string;
  guild_id: string | null;
  status: SubscriberStatus;
  subscribed_at: string;
  last_reminded: string | null;
}

export interface SeenAlert {
  guid: string;
  title: string | null;
  link: string | null;
  pub_date: string | null;
  ingested_at: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

export class DB {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(resolve(path)), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  /** Runs every .sql file in the migrations directory in lexical order. */
  private migrate(): void {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      this.db.exec(sql);
    }
  }

  upsertSubscribed(args: {
    kind: SubscriberKind;
    discordId: string;
    guildId: string | null;
    now: string;
  }): { created: boolean; reactivated: boolean } {
    const existing = this.findSubscriber(args.kind, args.discordId);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO subscribers (kind, discord_id, guild_id, status, subscribed_at)
           VALUES (?, ?, ?, 'active', ?)`,
        )
        .run(args.kind, args.discordId, args.guildId, args.now);
      return { created: true, reactivated: false };
    }
    if (existing.status === "active") {
      return { created: false, reactivated: false };
    }
    this.db
      .prepare(
        `UPDATE subscribers
         SET status = 'active', subscribed_at = ?, last_reminded = NULL, guild_id = ?
         WHERE id = ?`,
      )
      .run(args.now, args.guildId, existing.id);
    return { created: false, reactivated: true };
  }

  markUnsubscribed(kind: SubscriberKind, discordId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE subscribers SET status = 'unsubscribed'
         WHERE kind = ? AND discord_id = ? AND status = 'active'`,
      )
      .run(kind, discordId);
    return result.changes > 0;
  }

  findSubscriber(kind: SubscriberKind, discordId: string): Subscriber | undefined {
    return this.db
      .prepare<[SubscriberKind, string], Subscriber>(
        `SELECT * FROM subscribers WHERE kind = ? AND discord_id = ?`,
      )
      .get(kind, discordId);
  }

  listActive(kind?: SubscriberKind): Subscriber[] {
    if (kind) {
      return this.db
        .prepare<[SubscriberKind], Subscriber>(
          `SELECT * FROM subscribers WHERE status = 'active' AND kind = ?`,
        )
        .all(kind);
    }
    return this.db
      .prepare<[], Subscriber>(`SELECT * FROM subscribers WHERE status = 'active'`)
      .all();
  }

  // Subscribers active for ≥ 1 year and either never reminded or last reminded ≥ 1 year ago.
  selectDueForReminder(now: Date): Subscriber[] {
    const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare<[string, string], Subscriber>(
        `SELECT * FROM subscribers
         WHERE status = 'active'
           AND subscribed_at <= ?
           AND (last_reminded IS NULL OR last_reminded <= ?)
         ORDER BY id`,
      )
      .all(cutoff, cutoff);
  }

  stampReminded(id: number, now: string): void {
    this.db.prepare(`UPDATE subscribers SET last_reminded = ? WHERE id = ?`).run(now, id);
  }

  hasSeenAlert(guid: string): boolean {
    const row = this.db
      .prepare<[string], { guid: string }>(`SELECT guid FROM seen_alerts WHERE guid = ?`)
      .get(guid);
    return Boolean(row);
  }

  recordSeenAlert(alert: Omit<SeenAlert, "ingested_at"> & { ingested_at?: string }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO seen_alerts (guid, title, link, pub_date, ingested_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        alert.guid,
        alert.title,
        alert.link,
        alert.pub_date,
        alert.ingested_at ?? new Date().toISOString(),
      );
  }

  lastSeenAlert(): SeenAlert | undefined {
    return this.db
      .prepare<[], SeenAlert>(`SELECT * FROM seen_alerts ORDER BY ingested_at DESC LIMIT 1`)
      .get();
  }

  lastAlertForDisplay(): LastAlert {
    const row = this.lastSeenAlert();
    if (!row?.title) return null;
    return { title: row.title, pubDate: row.pub_date ?? "" };
  }

  /**
   * Append a row to the durable event log. Throws are swallowed by the
   * caller's try/catch — recording an event must never crash a request path.
   */
  recordEvent(input: RecordEventInput): void {
    const payload = input.payload == null ? null : JSON.stringify(input.payload, errorReplacer);
    this.db
      .prepare<[EventKind, string | null, string | null, string | null, string | null]>(
        `INSERT INTO events (kind, guild_id, channel_id, user_id, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.guildId ?? null,
        input.channelId ?? null,
        input.userId ?? null,
        payload,
      );
  }

  /** Recent events, newest first. Useful for spot-checking from a console. */
  recentEvents(limit = 100): EventRecord[] {
    return this.db
      .prepare<[number], EventRecord>(`SELECT * FROM events ORDER BY id DESC LIMIT ?`)
      .all(limit);
  }

  /** Count of events in a (kind, since) window. Useful for tests and dashboards. */
  countEvents(kind: EventKind, sinceIsoTimestamp?: string): number {
    if (sinceIsoTimestamp) {
      const row = this.db
        .prepare<[EventKind, string], { n: number }>(
          `SELECT COUNT(*) AS n FROM events WHERE kind = ? AND ts >= ?`,
        )
        .get(kind, sinceIsoTimestamp);
      return row?.n ?? 0;
    }
    const row = this.db
      .prepare<[EventKind], { n: number }>(`SELECT COUNT(*) AS n FROM events WHERE kind = ?`)
      .get(kind);
    return row?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

// JSON.stringify replacer that turns Errors into something useful instead of `{}`.
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}
