import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Snowflake } from "discord.js";
import type { LastAlert } from "./copy.js";
import { childLogger } from "./log.js";

const log = childLogger("db");

/** A subscriber row keys on a Discord channel id (guild_channel) or user id (dm). */
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
	| "mention_in"
	| "mention_out"
	| "alert_seen"
	| "alert_dispatch_ok"
	| "alert_dispatch_fail"
	| "level_change"
	| "reminder_ok"
	| "reminder_fail"
	| "error";

/** A row in the events table. Timestamps are ISO-8601 with millisecond precision. */
export interface EventRecord {
	id: number;
	ts: string;
	kind: EventKind;
	guild_id: Snowflake | null;
	channel_id: Snowflake | null;
	user_id: Snowflake | null;
	payload: string | null;
}

// ---------------------------------------------------------------------------
// Typed event payloads. Each EventKind has a known shape, so the discriminated
// union below catches typos / drift at the call site rather than at read time
// (when you're staring at a SQLite row trying to figure out what's in there).
// ---------------------------------------------------------------------------

type SubscribeVia = "command" | "dm" | "mention";
type DmIntentLiteral = "subscribe" | "unsubscribe" | "other";
type MentionIntentLiteral = DmIntentLiteral | "status" | "help";

/** Provenance for an alert dispatch — RSS item or level-poller transition. */
type DispatchSource = "rss" | "level_change";

interface AlertDispatchRssMeta {
	source: "rss";
	guid: string;
	kind: SubscriberKind;
}
interface AlertDispatchLevelMeta {
	source: "level_change";
	level: number;
	prevLevel: number | null;
	kind: SubscriberKind;
}
type AlertDispatchOkPayload = AlertDispatchRssMeta | AlertDispatchLevelMeta;
type AlertDispatchFailPayload = AlertDispatchOkPayload & { err: unknown };

/** Closed map: kind → expected payload shape. */
export interface EventPayloadByKind {
	startup: { rss: string; dashboard?: string };
	shutdown: { signal: string };
	guild_create: { name: string; memberCount: number };
	guild_delete: { name: string };
	guild_welcome_sent: undefined;
	command: { name: string; options: ReadonlyArray<{ name: string; value: unknown }> };
	subscribe: { kind: SubscriberKind; via: SubscribeVia; reactivated: boolean };
	unsubscribe: { kind: SubscriberKind; via: SubscribeVia };
	dm_in: { content: string; intent: DmIntentLiteral };
	dm_out: { content: string };
	mention_in: { content: string; stripped: string; intent: MentionIntentLiteral };
	mention_out: { content: string };
	alert_seen: {
		guid: string;
		title: string | null;
		link: string | null;
		pubDate: string | null;
	};
	alert_dispatch_ok: AlertDispatchOkPayload;
	alert_dispatch_fail: AlertDispatchFailPayload;
	level_change: {
		level: number;
		prevLevel: number | null;
		alertLevel: string | null;
		asOf: string | null;
		zScore: number | null;
		body: string;
	};
	reminder_ok: { kind: SubscriberKind; subscribedAt: string };
	reminder_fail: { kind: SubscriberKind; err: unknown };
	error: { op: string; command?: string; err: unknown };
}

// Sanity: every EventKind must appear in EventPayloadByKind. If you add a kind
// to the union above and forget the shape here, this line is a type error.
type _AssertCovered = EventPayloadByKind[EventKind];

/**
 * Args for {@link DB.recordEvent}. Discriminated by `kind`; the payload type
 * is forced to match. Adding a new event kind requires extending both
 * {@link EventKind} and {@link EventPayloadByKind} — TypeScript will refuse
 * the call site otherwise.
 */
export type RecordEventInput = {
	[K in EventKind]: {
		kind: K;
		guildId?: Snowflake | null;
		channelId?: Snowflake | null;
		userId?: Snowflake | null;
	} & (EventPayloadByKind[K] extends undefined
		? { payload?: undefined }
		: { payload: EventPayloadByKind[K] });
}[EventKind];

// re-export for callers that want to type-only-import the literal unions
export type { DispatchSource, DmIntentLiteral, MentionIntentLiteral, SubscribeVia };

/** A subscriber: one Discord channel or DM target receiving alerts. */
export interface Subscriber {
	id: number;
	kind: SubscriberKind;
	/** Channel id when kind=guild_channel, user id when kind=dm. */
	discord_id: Snowflake;
	guild_id: Snowflake | null;
	status: SubscriberStatus;
	subscribed_at: string;
	last_reminded: string | null;
}

/**
 * Project a Subscriber onto the (guildId, channelId, userId) triple used as
 * the event-row "where did this happen" columns. Avoids inlining the same
 * `kind === "guild_channel" ? sub.discord_id : null` ternary at every event
 * recording site.
 */
export function subscriberAddress(sub: Subscriber): {
	guildId: Snowflake | null;
	channelId: Snowflake | null;
	userId: Snowflake | null;
} {
	return {
		guildId: sub.guild_id,
		channelId: sub.kind === "guild_channel" ? sub.discord_id : null,
		userId: sub.kind === "dm" ? sub.discord_id : null,
	};
}

/** A row from seen_alerts — every RSS item the poller has ingested. */
export interface SeenAlert {
	guid: string;
	title: string | null;
	link: string | null;
	pub_date: string | null;
	ingested_at: string;
}

/** Single-row level snapshot. `emergency_level` is null until first observation. */
export interface LevelState {
	id: 1;
	emergency_level: number | null;
	alert_level: string | null;
	z_score: number | null;
	as_of: string | null;
	updated_at: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

/**
 * SQLite-backed persistence for the bot. Owns one bun:sqlite handle per
 * process. All queries are sync — bun:sqlite doesn't do async — so call
 * sites read like regular code. WAL is on by default.
 */
export class DB {
	private readonly db: Database;

	/** Opens (or creates + migrates) the database at `path`. Pass `:memory:` for tests. */
	constructor(path: string) {
		if (path !== ":memory:") {
			mkdirSync(dirname(resolve(path)), { recursive: true });
		}
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
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
		discordId: Snowflake;
		guildId: Snowflake | null;
		now: string;
	}): { created: boolean; reactivated: boolean } {
		const existing = this.findSubscriber(args.kind, args.discordId);
		if (!existing) {
			this.db
				.query(
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
			.query(
				`UPDATE subscribers
         SET status = 'active', subscribed_at = ?, last_reminded = NULL, guild_id = ?
         WHERE id = ?`,
			)
			.run(args.now, args.guildId, existing.id);
		return { created: false, reactivated: true };
	}

	markUnsubscribed(kind: SubscriberKind, discordId: Snowflake): boolean {
		const result = this.db
			.query(
				`UPDATE subscribers SET status = 'unsubscribed'
         WHERE kind = ? AND discord_id = ? AND status = 'active'`,
			)
			.run(kind, discordId);
		return result.changes > 0;
	}

	findSubscriber(kind: SubscriberKind, discordId: Snowflake): Subscriber | undefined {
		return (
			this.db
				.query<Subscriber, [SubscriberKind, Snowflake]>(
					`SELECT * FROM subscribers WHERE kind = ? AND discord_id = ?`,
				)
				.get(kind, discordId) ?? undefined
		);
	}

	listActive(kind?: SubscriberKind): Subscriber[] {
		if (kind) {
			return this.db
				.query<Subscriber, [SubscriberKind]>(
					`SELECT * FROM subscribers WHERE status = 'active' AND kind = ?`,
				)
				.all(kind);
		}
		return this.db.query<Subscriber, []>(`SELECT * FROM subscribers WHERE status = 'active'`).all();
	}

	// Subscribers active for ≥ 1 year and either never reminded or last reminded ≥ 1 year ago.
	selectDueForReminder(now: Date): Subscriber[] {
		const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
		return this.db
			.query<Subscriber, [string, string]>(
				`SELECT * FROM subscribers
         WHERE status = 'active'
           AND subscribed_at <= ?
           AND (last_reminded IS NULL OR last_reminded <= ?)
         ORDER BY id`,
			)
			.all(cutoff, cutoff);
	}

	stampReminded(id: number, now: string): void {
		this.db.query(`UPDATE subscribers SET last_reminded = ? WHERE id = ?`).run(now, id);
	}

	hasSeenAlert(guid: string): boolean {
		const row = this.db
			.query<{ guid: string }, [string]>(`SELECT guid FROM seen_alerts WHERE guid = ?`)
			.get(guid);
		return row != null;
	}

	recordSeenAlert(alert: Omit<SeenAlert, "ingested_at"> & { ingested_at?: string }): void {
		this.db
			.query(
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
		return (
			this.db
				.query<SeenAlert, []>(`SELECT * FROM seen_alerts ORDER BY ingested_at DESC LIMIT 1`)
				.get() ?? undefined
		);
	}

	lastAlertForDisplay(): LastAlert {
		const row = this.lastSeenAlert();
		if (!row?.title) return null;
		return { title: row.title, pubDate: row.pub_date ?? "" };
	}

	/** Read the single-row level snapshot. */
	getLevelState(): LevelState {
		const row = this.db.query<LevelState, []>(`SELECT * FROM level_state WHERE id = 1`).get();
		if (!row) {
			// Defensive — migration's INSERT OR IGNORE should have populated it.
			throw new Error("level_state missing row id=1; was the migration run?");
		}
		return row;
	}

	/** Persist the latest observed level. */
	setLevelState(args: {
		emergencyLevel: number;
		alertLevel: string | null;
		zScore: number | null;
		asOf: string;
	}): void {
		this.db
			.query(
				`UPDATE level_state
				 SET emergency_level = ?, alert_level = ?, z_score = ?, as_of = ?, updated_at = ?
				 WHERE id = 1`,
			)
			.run(args.emergencyLevel, args.alertLevel, args.zScore, args.asOf, new Date().toISOString());
	}

	/**
	 * Append a row to the durable event log. Failures are swallowed and logged
	 * — recording an event must never crash a request path.
	 */
	recordEvent(input: RecordEventInput): void {
		try {
			const payload = input.payload == null ? null : JSON.stringify(input.payload, errorReplacer);
			this.db
				.query(
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
		} catch (err) {
			log.error("recordEvent failed", { err, kind: input.kind });
		}
	}

	/** Recent events, newest first. Useful for spot-checking from a console. */
	recentEvents(limit = 100): EventRecord[] {
		return this.db
			.query<EventRecord, [number]>(`SELECT * FROM events ORDER BY id DESC LIMIT ?`)
			.all(limit);
	}

	/** Count of events in a (kind, since) window. Useful for tests and dashboards. */
	countEvents(kind: EventKind, sinceIsoTimestamp?: string): number {
		if (sinceIsoTimestamp) {
			const row = this.db
				.query<{ n: number }, [EventKind, string]>(
					`SELECT COUNT(*) AS n FROM events WHERE kind = ? AND ts >= ?`,
				)
				.get(kind, sinceIsoTimestamp);
			return row?.n ?? 0;
		}
		const row = this.db
			.query<{ n: number }, [EventKind]>(`SELECT COUNT(*) AS n FROM events WHERE kind = ?`)
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
