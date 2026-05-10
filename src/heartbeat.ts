import type { Client } from "discord.js";
import { heartbeatPayload } from "./copy.js";
import { type DB, subscriberAddress } from "./db.js";
import { sendToSubscriber } from "./discord.js";
import { childLogger } from "./log.js";

const log = childLogger("heartbeat");

const DAY = 24 * 60 * 60 * 1000;
export const HEARTBEAT_MIN_DELAY_MS = 6 * DAY;
export const HEARTBEAT_MAX_DELAY_MS = 10 * DAY;
export const LEVEL_CHANGE_SUPPRESSION_MS = 24 * 60 * 60 * 1000;

export function nextHeartbeatDelayMs(rng: () => number): number {
	const span = HEARTBEAT_MAX_DELAY_MS - HEARTBEAT_MIN_DELAY_MS;
	return HEARTBEAT_MIN_DELAY_MS + Math.floor(rng() * (span + 1));
}

export type ShouldFireResult =
	| { fire: true }
	| { fire: false; reason: "not_due" | "recent_level_change" };

export function shouldFireHeartbeat(args: {
	now: Date;
	lastFireIso: string | null;
	lastLevelChangeIso: string | null;
	nextDelayMs: number;
}): ShouldFireResult {
	const nowMs = args.now.getTime();
	if (args.lastLevelChangeIso) {
		const lcMs = new Date(args.lastLevelChangeIso).getTime();
		if (nowMs - lcMs < LEVEL_CHANGE_SUPPRESSION_MS) {
			return { fire: false, reason: "recent_level_change" };
		}
	}
	if (args.lastFireIso) {
		const lastMs = new Date(args.lastFireIso).getTime();
		if (nowMs - lastMs < args.nextDelayMs) {
			return { fire: false, reason: "not_due" };
		}
	}
	return { fire: true };
}

// Per-channel failures are caught and recorded — never throws.
export async function sendHeartbeat(args: {
	db: DB;
	client: Client;
	now?: Date;
	rng?: () => number;
}): Promise<
	| { fired: true; sent: number; failed: number }
	| { fired: false; reason: "not_due" | "recent_level_change" }
> {
	const now = args.now ?? new Date();
	const rng = args.rng ?? Math.random;

	const lastFireIso = args.db.lastEventTs("heartbeat_ok");
	const lastLevelChangeIso = args.db.lastEventTs("level_change");
	const nextDelayMs = nextHeartbeatDelayMs(rng);

	const decision = shouldFireHeartbeat({ now, lastFireIso, lastLevelChangeIso, nextDelayMs });
	if (!decision.fire) {
		args.db.recordEvent({
			kind: "heartbeat_skipped",
			payload: { reason: decision.reason, nextDelayMs },
		});
		return { fired: false, reason: decision.reason };
	}

	const level = args.db.getLevelState().emergency_level;
	const body = heartbeatPayload(level);
	const subs = args.db.listActive("guild_channel");
	let sent = 0;
	let failed = 0;
	for (const sub of subs) {
		const where = subscriberAddress(sub);
		try {
			await sendToSubscriber(args.client, sub, body);
			sent++;
			args.db.recordEvent({
				kind: "heartbeat_ok",
				...where,
				payload: { kind: sub.kind, level },
			});
		} catch (err) {
			failed++;
			log.error("heartbeat failed", { err, channelId: sub.discord_id });
			args.db.recordEvent({
				kind: "heartbeat_fail",
				...where,
				payload: { kind: sub.kind, level, err },
			});
		}
	}
	return { fired: true, sent, failed };
}
