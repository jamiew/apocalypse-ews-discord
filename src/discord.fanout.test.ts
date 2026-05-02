import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ok as assert } from "node:assert/strict";
import type { Client } from "discord.js";
import { DB } from "./db.js";
import { fanOutAlert, fanOutLevelChange } from "./discord.js";

/**
 * Tests for the actual send-to-subscriber fan-out — the hottest path in
 * the system. A bug here = users miss alerts (or get duplicates), so
 * exercise the realistic shapes: mixed kinds, partial failures, body
 * content, and the per-subscriber audit events.
 */

interface SendCall {
	id: string;
	body: string;
}

interface MockClient {
	client: Client;
	usersSent: SendCall[];
	channelsSent: SendCall[];
	failUser: (id: string) => void;
	failChannel: (id: string) => void;
	missingChannel: (id: string) => void;
}

function makeMockClient(): MockClient {
	const usersSent: SendCall[] = [];
	const channelsSent: SendCall[] = [];
	const failUserIds = new Set<string>();
	const failChannelIds = new Set<string>();
	const missingChannelIds = new Set<string>();

	const client = {
		users: {
			fetch: async (id: string) => ({
				send: async (body: string) => {
					if (failUserIds.has(id)) throw new Error(`user ${id} blocked the bot`);
					usersSent.push({ id, body });
				},
			}),
		},
		channels: {
			fetch: async (id: string) => {
				if (missingChannelIds.has(id)) return null;
				return {
					send: async (body: string) => {
						if (failChannelIds.has(id)) throw new Error(`channel ${id} unsendable`);
						channelsSent.push({ id, body });
					},
				};
			},
		},
	} as unknown as Client;

	return {
		client,
		usersSent,
		channelsSent,
		failUser: (id) => failUserIds.add(id),
		failChannel: (id) => failChannelIds.add(id),
		missingChannel: (id) => missingChannelIds.add(id),
	};
}

function seedSubscribers(
	db: DB,
	defs: Array<{ kind: "dm" | "guild_channel"; id: string; guild?: string }>,
) {
	const now = "2026-05-02T00:00:00.000Z";
	for (const def of defs) {
		db.upsertSubscribed({
			kind: def.kind,
			discordId: def.id,
			guildId: def.guild ?? null,
			now,
		});
	}
}

describe("fanOutAlert", () => {
	let db: DB;
	const deps = () => ({ db });
	const ALERT = {
		guid: "g-42",
		title: "Emergency level 5.",
		link: "https://ews.kylemcdonald.net/",
		pubDate: "Fri, 01 May 2026 23:00:00 GMT",
	};

	beforeEach(() => {
		db = new DB(":memory:");
	});
	afterEach(() => {
		db.close();
	});

	it("delivers to every active subscriber across kinds, with the formatted alert body", async () => {
		seedSubscribers(db, [
			{ kind: "dm", id: "user-a" },
			{ kind: "dm", id: "user-b" },
			{ kind: "guild_channel", id: "channel-1", guild: "guild-1" },
			{ kind: "guild_channel", id: "thread-1", guild: "guild-1" }, // a thread snowflake — same kind
		]);

		const mock = makeMockClient();
		const result = await fanOutAlert(mock.client, deps(), ALERT);

		expect(result).toEqual({ sent: 4, failed: 0 });
		expect(mock.usersSent.map((s) => s.id).sort()).toEqual(["user-a", "user-b"]);
		expect(mock.channelsSent.map((s) => s.id).sort()).toEqual(["channel-1", "thread-1"]);

		// Body content — the full alertPayload reaches every recipient.
		const allBodies = [...mock.usersSent, ...mock.channelsSent].map((s) => s.body);
		for (const body of allBodies) {
			expect(body).toContain("ATTENTION. EMERGENCY LEVEL 5.");
			expect(body).toContain(ALERT.title);
			expect(body).toContain(ALERT.pubDate);
			expect(body).toContain(ALERT.link);
		}
	});

	it("skips unsubscribed rows", async () => {
		seedSubscribers(db, [
			{ kind: "dm", id: "active-1" },
			{ kind: "dm", id: "leaving" },
		]);
		db.markUnsubscribed("dm", "leaving");

		const mock = makeMockClient();
		const result = await fanOutAlert(mock.client, deps(), ALERT);
		expect(result).toEqual({ sent: 1, failed: 0 });
		expect(mock.usersSent.map((s) => s.id)).toEqual(["active-1"]);
	});

	it("treats per-recipient failures independently and continues fan-out", async () => {
		seedSubscribers(db, [
			{ kind: "dm", id: "blocked-user" }, // will fail
			{ kind: "dm", id: "happy-user" },
			{ kind: "guild_channel", id: "broken-channel", guild: "g1" }, // will fail
			{ kind: "guild_channel", id: "good-channel", guild: "g1" },
		]);
		const mock = makeMockClient();
		mock.failUser("blocked-user");
		mock.failChannel("broken-channel");

		const result = await fanOutAlert(mock.client, deps(), ALERT);
		expect(result).toEqual({ sent: 2, failed: 2 });

		expect(mock.usersSent.map((s) => s.id)).toEqual(["happy-user"]);
		expect(mock.channelsSent.map((s) => s.id)).toEqual(["good-channel"]);
	});

	it("treats a missing channel (fetch returns null) as a failure", async () => {
		seedSubscribers(db, [{ kind: "guild_channel", id: "deleted-channel", guild: "g1" }]);
		const mock = makeMockClient();
		mock.missingChannel("deleted-channel");

		const result = await fanOutAlert(mock.client, deps(), ALERT);
		expect(result).toEqual({ sent: 0, failed: 1 });
		expect(db.countEvents("alert_dispatch_fail")).toBe(1);
	});

	it("records one alert_dispatch_ok per success and one alert_dispatch_fail per failure", async () => {
		seedSubscribers(db, [
			{ kind: "dm", id: "ok-user" },
			{ kind: "guild_channel", id: "fail-channel", guild: "g1" },
		]);
		const mock = makeMockClient();
		mock.failChannel("fail-channel");

		await fanOutAlert(mock.client, deps(), ALERT);

		expect(db.countEvents("alert_dispatch_ok")).toBe(1);
		expect(db.countEvents("alert_dispatch_fail")).toBe(1);

		const recent = db.recentEvents(10);
		const okEvent = recent.find((e) => e.kind === "alert_dispatch_ok");
		assert(okEvent?.payload);
		const okPayload = JSON.parse(okEvent.payload);
		expect(okPayload).toMatchObject({ guid: ALERT.guid, kind: "dm" });
		expect(okEvent.user_id).toBe("ok-user");

		const failEvent = recent.find((e) => e.kind === "alert_dispatch_fail");
		assert(failEvent?.payload);
		const failPayload = JSON.parse(failEvent.payload);
		expect(failPayload).toMatchObject({ guid: ALERT.guid, kind: "guild_channel" });
		// The Error gets serialized via the replacer
		expect(failEvent.payload).toContain("unsendable");
		expect(failEvent.guild_id).toBe("g1");
		expect(failEvent.channel_id).toBe("fail-channel");
	});

	it("returns {0,0} cleanly when there are no active subscribers", async () => {
		const mock = makeMockClient();
		const result = await fanOutAlert(mock.client, deps(), ALERT);
		expect(result).toEqual({ sent: 0, failed: 0 });
		expect(db.countEvents("alert_dispatch_ok")).toBe(0);
		expect(db.countEvents("alert_dispatch_fail")).toBe(0);
	});
});

describe("fanOutLevelChange", () => {
	let db: DB;
	const deps = () => ({ db });
	const CHANGE = {
		level: 4,
		prevLevel: 3,
		alertLevel: "elevated",
		zScore: 4.7,
		asOf: "2026-05-02T01:29:50+00:00",
	};

	beforeEach(() => {
		db = new DB(":memory:");
	});
	afterEach(() => {
		db.close();
	});

	it("delivers level-change body to every active subscriber", async () => {
		seedSubscribers(db, [
			{ kind: "dm", id: "user-a" },
			{ kind: "guild_channel", id: "channel-1", guild: "g1" },
		]);
		const mock = makeMockClient();
		const result = await fanOutLevelChange(mock.client, deps(), CHANGE);

		expect(result).toEqual({ sent: 2, failed: 0 });

		const allBodies = [...mock.usersSent, ...mock.channelsSent].map((s) => s.body);
		for (const body of allBodies) {
			expect(body).toContain("WARNING. Emergency level 4.");
			expect(body).toContain("Was 3, now 4.");
			expect(body).toContain("z=4.70");
			expect(body).toContain("https://ews.kylemcdonald.net");
		}
	});

	it("tags dispatch events with source=level_change and the level metadata", async () => {
		seedSubscribers(db, [{ kind: "dm", id: "u" }]);
		const mock = makeMockClient();
		await fanOutLevelChange(mock.client, deps(), CHANGE);

		const [evt] = db.recentEvents(1);
		assert(evt?.payload);
		const payload = JSON.parse(evt.payload);
		expect(payload).toMatchObject({
			source: "level_change",
			level: 4,
			prevLevel: 3,
			kind: "dm",
		});
	});

	it("falls cleanly with the Stand-down header on a drop", async () => {
		seedSubscribers(db, [{ kind: "dm", id: "u" }]);
		const mock = makeMockClient();
		await fanOutLevelChange(mock.client, deps(), {
			level: 1,
			prevLevel: 5,
			alertLevel: "normal",
			zScore: -2.1,
			asOf: "2026-05-02T02:00:00+00:00",
		});
		expect(mock.usersSent[0]?.body).toContain("Stand-down. Emergency level returned to 1.");
	});

	it("records alert_dispatch_fail on per-recipient failure with source=level_change", async () => {
		seedSubscribers(db, [{ kind: "dm", id: "blocked" }]);
		const mock = makeMockClient();
		mock.failUser("blocked");

		const result = await fanOutLevelChange(mock.client, deps(), CHANGE);
		expect(result).toEqual({ sent: 0, failed: 1 });

		const [evt] = db.recentEvents(1);
		assert(evt?.payload);
		expect(evt.kind).toBe("alert_dispatch_fail");
		const payload = JSON.parse(evt.payload);
		expect(payload).toMatchObject({ source: "level_change", level: 4, prevLevel: 3 });
		expect(evt.payload).toContain("blocked the bot");
	});
});
