import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ok as assert } from "node:assert/strict";
import type { Client } from "discord.js";
import { DB } from "./db.js";
import {
	HEARTBEAT_MAX_DELAY_MS,
	HEARTBEAT_MIN_DELAY_MS,
	LEVEL_CHANGE_SUPPRESSION_MS,
	nextHeartbeatDelayMs,
	sendHeartbeat,
	shouldFireHeartbeat,
} from "./heartbeat.js";

const DAY = 24 * 60 * 60 * 1000;

describe("nextHeartbeatDelayMs", () => {
	it("returns the floor with rng=0", () => {
		expect(nextHeartbeatDelayMs(() => 0)).toBe(HEARTBEAT_MIN_DELAY_MS);
	});

	it("returns the ceiling minus epsilon with rng→1", () => {
		const out = nextHeartbeatDelayMs(() => 0.999999);
		expect(out).toBeGreaterThan(HEARTBEAT_MIN_DELAY_MS);
		expect(out).toBeLessThanOrEqual(HEARTBEAT_MAX_DELAY_MS);
	});

	it("midpoint rng returns midpoint delay", () => {
		const mid = (HEARTBEAT_MIN_DELAY_MS + HEARTBEAT_MAX_DELAY_MS) / 2;
		expect(nextHeartbeatDelayMs(() => 0.5)).toBe(mid);
	});
});

describe("shouldFireHeartbeat", () => {
	const now = new Date("2026-05-09T14:00:00.000Z");

	it("fires when never fired before and nothing else suppresses", () => {
		const out = shouldFireHeartbeat({
			now,
			lastFireIso: null,
			lastLevelChangeIso: null,
			nextDelayMs: 7 * DAY,
		});
		expect(out.fire).toBe(true);
	});

	it("not_due when last fire is inside the window", () => {
		const fiveDaysAgo = new Date(now.getTime() - 5 * DAY).toISOString();
		const out = shouldFireHeartbeat({
			now,
			lastFireIso: fiveDaysAgo,
			lastLevelChangeIso: null,
			nextDelayMs: 7 * DAY,
		});
		assert(out.fire === false);
		expect(out.reason).toBe("not_due");
	});

	it("fires when last fire is older than the window", () => {
		const eightDaysAgo = new Date(now.getTime() - 8 * DAY).toISOString();
		const out = shouldFireHeartbeat({
			now,
			lastFireIso: eightDaysAgo,
			lastLevelChangeIso: null,
			nextDelayMs: 7 * DAY,
		});
		expect(out.fire).toBe(true);
	});

	it("suppresses when a level change was broadcast inside the suppression window", () => {
		const eightDaysAgo = new Date(now.getTime() - 8 * DAY).toISOString();
		const recentLevelChange = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
		const out = shouldFireHeartbeat({
			now,
			lastFireIso: eightDaysAgo,
			lastLevelChangeIso: recentLevelChange,
			nextDelayMs: 7 * DAY,
		});
		assert(out.fire === false);
		expect(out.reason).toBe("recent_level_change");
	});

	it("ignores stale level changes outside the suppression window", () => {
		const eightDaysAgo = new Date(now.getTime() - 8 * DAY).toISOString();
		const oldLevelChange = new Date(
			now.getTime() - LEVEL_CHANGE_SUPPRESSION_MS - 60_000,
		).toISOString();
		const out = shouldFireHeartbeat({
			now,
			lastFireIso: eightDaysAgo,
			lastLevelChangeIso: oldLevelChange,
			nextDelayMs: 7 * DAY,
		});
		expect(out.fire).toBe(true);
	});
});

interface SendCall {
	id: string;
	body: string;
}
interface MockClient {
	client: Client;
	usersSent: SendCall[];
	channelsSent: SendCall[];
	failChannel: (id: string) => void;
}
function makeMockClient(): MockClient {
	const usersSent: SendCall[] = [];
	const channelsSent: SendCall[] = [];
	const failChannelIds = new Set<string>();
	const client = {
		users: {
			fetch: async (id: string) => ({
				send: async (body: string) => {
					usersSent.push({ id, body });
				},
			}),
		},
		channels: {
			fetch: async (id: string) => ({
				send: async (body: string) => {
					if (failChannelIds.has(id)) throw new Error(`channel ${id} unsendable`);
					channelsSent.push({ id, body });
				},
			}),
		},
	} as unknown as Client;
	return {
		client,
		usersSent,
		channelsSent,
		failChannel: (id) => failChannelIds.add(id),
	};
}

describe("sendHeartbeat", () => {
	let db: DB;
	const NOW = new Date("2026-05-09T14:00:00.000Z");

	beforeEach(() => {
		db = new DB(":memory:");
	});
	afterEach(() => {
		db.close();
	});

	function seed() {
		const subAt = new Date(NOW.getTime() - 30 * DAY).toISOString();
		db.upsertSubscribed({
			kind: "guild_channel",
			discordId: "channel-1",
			guildId: "guild-1",
			now: subAt,
		});
		db.upsertSubscribed({
			kind: "guild_channel",
			discordId: "channel-2",
			guildId: "guild-2",
			now: subAt,
		});
		db.upsertSubscribed({
			kind: "dm",
			discordId: "user-1",
			guildId: null,
			now: subAt,
		});
	}

	it("broadcasts to guild_channel subscribers only and skips DMs", async () => {
		seed();
		const mock = makeMockClient();
		const result = await sendHeartbeat({
			db,
			client: mock.client,
			now: NOW,
			rng: () => 0,
		});

		expect(result).toEqual({ fired: true, sent: 2, failed: 0 });
		expect(mock.usersSent).toEqual([]);
		expect(mock.channelsSent.map((c) => c.id).sort()).toEqual(["channel-1", "channel-2"]);
		for (const c of mock.channelsSent) {
			expect(c.body).toContain("STANDING BY.");
		}
		expect(db.countEvents("heartbeat_ok")).toBe(2);
		expect(db.countEvents("heartbeat_fail")).toBe(0);
	});

	it("records heartbeat_fail for per-channel failures", async () => {
		seed();
		const mock = makeMockClient();
		mock.failChannel("channel-2");
		const result = await sendHeartbeat({
			db,
			client: mock.client,
			now: NOW,
			rng: () => 0,
		});
		expect(result).toEqual({ fired: true, sent: 1, failed: 1 });
		expect(db.countEvents("heartbeat_ok")).toBe(1);
		expect(db.countEvents("heartbeat_fail")).toBe(1);
	});

	it("skips and records heartbeat_skipped when not due", async () => {
		seed();
		// Fire one heartbeat first to set lastFireIso = NOW.
		const mock1 = makeMockClient();
		await sendHeartbeat({ db, client: mock1.client, now: NOW, rng: () => 0 });

		// Tick 1 day later — well inside any 6–10d window.
		const oneDayLater = new Date(NOW.getTime() + DAY);
		const mock2 = makeMockClient();
		const result = await sendHeartbeat({
			db,
			client: mock2.client,
			now: oneDayLater,
			rng: () => 0,
		});
		expect(result).toEqual({ fired: false, reason: "not_due" });
		expect(mock2.channelsSent).toEqual([]);
		const skipped = db.countEvents("heartbeat_skipped");
		expect(skipped).toBe(1);
	});

	it("suppresses on a recent level_change when no prior heartbeat", async () => {
		seed();
		db.recordEvent({
			kind: "level_change",
			payload: {
				level: 3,
				prevLevel: 1,
				alertLevel: null,
				asOf: null,
				zScore: null,
				body: "x",
			},
		});
		const mock = makeMockClient();
		const result = await sendHeartbeat({
			db,
			client: mock.client,
			now: NOW,
			rng: () => 0,
		});
		assert(result.fired === false);
		expect(result.reason).toBe("recent_level_change");
		expect(mock.channelsSent).toEqual([]);
		expect(db.countEvents("heartbeat_skipped")).toBe(1);
	});

	it("returns {fired:false, reason} cleanly with no subscribers and never-fired", async () => {
		const mock = makeMockClient();
		const result = await sendHeartbeat({
			db,
			client: mock.client,
			now: NOW,
			rng: () => 0,
		});
		// Fires (never-fired), but zero recipients.
		expect(result).toEqual({ fired: true, sent: 0, failed: 0 });
	});
});
