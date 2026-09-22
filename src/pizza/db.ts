import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Snowflake } from "discord.js";
import { childLogger } from "../log.js";
import type { Busyness, SignalLevel } from "./signal.js";

const log = childLogger("pizza-db");

export type SubscriberKind = "guild_channel" | "dm";
export type SubscriberStatus = "active" | "unsubscribed";

export type EventKind =
	| "startup"
	| "shutdown"
	| "guild_create"
	| "guild_delete"
	| "guild_welcome_sent"
	| "guild_welcome_failed"
	| "command"
	| "subscribe"
	| "unsubscribe"
	| "dm_in"
	| "dm_out"
	| "mention_in"
	| "mention_out"
	| "post_seen"
	| "post_skipped"
	| "signal_change"
	| "signal_suppressed"
	| "dispatch_ok"
	| "dispatch_fail"
	| "poll_fail"
	| "error";

export type SubscribeVia = "command" | "dm" | "mention" | "install";
export type PizzaIntent = "subscribe" | "unsubscribe" | "status" | "help" | "latest" | "other";

export interface SignalSnapshot {
	level: SignalLevel;
	pizza: Busyness | null;
	bar: Busyness | null;
	postId: string;
	postText: string;
	postedAt: string | null;
	url: string;
}

export interface SignalChange extends SignalSnapshot {
	prevLevel: SignalLevel | null;
}

interface DispatchMeta {
	postId: string;
	level: SignalLevel;
	prevLevel: SignalLevel | null;
	kind: SubscriberKind;
}

/** Closed map: kind -> expected payload shape. */
export interface EventPayloadByKind {
	startup: { account: string; poll: string; minAlertLevel: number };
	shutdown: { signal: string };
	guild_create: {
		name: string;
		memberCount: number;
		ownerId: Snowflake;
		ownerTag: string | null;
		channelCount: number;
		botJoinedAt: string | null;
	};
	guild_delete: { name: string; memberCount: number | null; tenureMs: number | null };
	guild_welcome_sent: undefined;
	guild_welcome_failed: { reason: "no_channel" | "missing_access" | "other"; err?: unknown };
	command: { name: string; options: ReadonlyArray<{ name: string; value: unknown }> };
	subscribe: { kind: SubscriberKind; via: SubscribeVia; reactivated: boolean };
	unsubscribe: { kind: SubscriberKind; via: SubscribeVia };
	dm_in: { content: string; intent: PizzaIntent };
	dm_out: { content: string };
	mention_in: { content: string; stripped: string; intent: PizzaIntent };
	mention_out: { content: string };
	post_seen: {
		postId: string;
		text: string;
		postedAt: string | null;
		level: SignalLevel | null;
		pizza: Busyness | null;
		bar: Busyness | null;
	};
	post_skipped: { postId: string; reason: "not_reportable" | "unreadable" };
	signal_change: {
		level: SignalLevel;
		prevLevel: SignalLevel | null;
		pizza: Busyness | null;
		bar: Busyness | null;
		postId: string;
		body: string;
	};
	signal_suppressed: {
		level: SignalLevel;
		prevLevel: SignalLevel | null;
		postId: string;
		reason: "below_floor" | "first_observation" | "unchanged";
	};
	dispatch_ok: DispatchMeta;
	dispatch_fail: DispatchMeta & { err: unknown };
	poll_fail: { err: unknown };
	error: { op: string; command?: string; err: unknown };
}

// Adding an EventKind without extending EventPayloadByKind is a type error here.
type _AssertCovered = EventPayloadByKind[EventKind];

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

export interface Subscriber {
	id: number;
	kind: SubscriberKind;
	discord_id: Snowflake;
	guild_id: Snowflake | null;
	status: SubscriberStatus;
	subscribed_at: string;
	last_reminded: string | null;
}

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

export interface SeenPost {
	post_id: string;
	text: string | null;
	posted_at: string | null;
	level: number | null;
	pizza: number | null;
	bar: number | null;
	ingested_at: string;
}

export interface SignalState {
	id: 1;
	level: number | null;
	pizza: number | null;
	bar: number | null;
	post_id: string | null;
	post_text: string | null;
	posted_at: string | null;
	updated_at: string;
}

export interface EventRecord {
	id: number;
	ts: string;
	kind: EventKind;
	guild_id: Snowflake | null;
	channel_id: Snowflake | null;
	user_id: Snowflake | null;
	payload: string | null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations/pizza");

export class PizzaDB {
	private readonly db: Database;

	constructor(path: string) {
		if (path !== ":memory:") {
			mkdirSync(dirname(resolve(path)), { recursive: true });
		}
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	private migrate(): void {
		const files = readdirSync(MIGRATIONS_DIR)
			.filter((f) => f.endsWith(".sql"))
			.sort();
		for (const file of files) {
			this.db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
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
		if (existing.status === "active") return { created: false, reactivated: false };
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
		return (
			this.db
				.query(
					`UPDATE subscribers SET status = 'unsubscribed'
           WHERE kind = ? AND discord_id = ? AND status = 'active'`,
				)
				.run(kind, discordId).changes > 0
		);
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

	hasSeenPost(postId: string): boolean {
		return (
			this.db
				.query<{ post_id: string }, [string]>(`SELECT post_id FROM seen_posts WHERE post_id = ?`)
				.get(postId) != null
		);
	}

	recordSeenPost(post: {
		postId: string;
		text: string;
		postedAt: string | null;
		level: SignalLevel | null;
		pizza: Busyness | null;
		bar: Busyness | null;
		ingestedAt?: string;
	}): void {
		this.db
			.query(
				`INSERT OR IGNORE INTO seen_posts (post_id, text, posted_at, level, pizza, bar, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				post.postId,
				post.text,
				post.postedAt,
				post.level,
				post.pizza,
				post.bar,
				post.ingestedAt ?? new Date().toISOString(),
			);
	}

	/** Read the single-row signal snapshot. */
	getSignalState(): SignalState {
		const row = this.db.query<SignalState, []>(`SELECT * FROM signal_state WHERE id = 1`).get();
		if (!row) throw new Error("signal_state missing row id=1; was the migration run?");
		return row;
	}

	setSignalState(snapshot: SignalSnapshot): void {
		this.db
			.query(
				`UPDATE signal_state
         SET level = ?, pizza = ?, bar = ?, post_id = ?, post_text = ?, posted_at = ?, updated_at = ?
         WHERE id = 1`,
			)
			.run(
				snapshot.level,
				snapshot.pizza,
				snapshot.bar,
				snapshot.postId,
				snapshot.postText,
				snapshot.postedAt,
				new Date().toISOString(),
			);
	}

	/**
	 * Append to the durable event log. Failures are swallowed and logged —
	 * recording an event must never crash a request path.
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

	recentEvents(limit = 100): EventRecord[] {
		return this.db
			.query<EventRecord, [number]>(`SELECT * FROM events ORDER BY id DESC LIMIT ?`)
			.all(limit);
	}

	countEvents(kind: EventKind): number {
		return (
			this.db
				.query<{ n: number }, [EventKind]>(`SELECT COUNT(*) AS n FROM events WHERE kind = ?`)
				.get(kind)?.n ?? 0
		);
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
