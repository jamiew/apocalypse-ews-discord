import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ok as assert } from "node:assert/strict";
import {
	ApplicationIntegrationType,
	type Client,
	InteractionContextType,
	PermissionFlagsBits,
} from "discord.js";
import { PizzaDB, type SignalChange } from "./db.js";
import {
	classifyPizzaText,
	commandDefinitions,
	fanOutSignalChange,
	latestViewFrom,
} from "./discord.js";

interface SendCall {
	id: string;
	body: string;
}

function makeMockClient() {
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
		failUser: (id: string) => failUserIds.add(id),
		failChannel: (id: string) => failChannelIds.add(id),
		missingChannel: (id: string) => missingChannelIds.add(id),
	};
}

describe("classifyPizzaText", () => {
	it.each([
		["subscribe", "subscribe"],
		["sign me up", "subscribe"],
		["unsubscribe", "unsubscribe"],
		["stop", "unsubscribe"],
		["status", "status"],
		["what's my level", "status"],
		["help", "help"],
		["?", "help"],
		["latest", "latest"],
		["last report", "latest"],
		["now", "latest"],
		["what's the latest", "latest"],
		["hello", "other"],
		["", "other"],
	] as const)("classifies %j as %s", (input, expected) => {
		expect(classifyPizzaText(input)).toBe(expected);
	});
});

describe("commandDefinitions", () => {
	it("registers exactly the expected slash commands", () => {
		expect(commandDefinitions.map((c) => c.name).sort()).toEqual([
			"help",
			"latest",
			"status",
			"subscribe",
			"unsubscribe",
		]);
	});

	it("supports both install types in every context", () => {
		const allCtx = [
			InteractionContextType.Guild,
			InteractionContextType.BotDM,
			InteractionContextType.PrivateChannel,
		];
		const both = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];
		for (const c of commandDefinitions) {
			expect(c.contexts).toEqual(allCtx);
			expect(c.integration_types).toEqual(both);
		}
	});

	it("gates subscribe and unsubscribe behind ManageGuild only", () => {
		const byName = Object.fromEntries(commandDefinitions.map((c) => [c.name, c]));
		expect(byName["subscribe"]?.default_member_permissions).toBe(
			String(PermissionFlagsBits.ManageGuild),
		);
		expect(byName["unsubscribe"]?.default_member_permissions).toBe(
			String(PermissionFlagsBits.ManageGuild),
		);
		expect(byName["status"]?.default_member_permissions).toBeUndefined();
		expect(byName["latest"]?.default_member_permissions).toBeUndefined();
		expect(byName["help"]?.default_member_permissions).toBeUndefined();
	});
});

describe("latestViewFrom", () => {
	let db: PizzaDB;

	beforeEach(() => {
		db = new PizzaDB(":memory:");
	});
	afterEach(() => {
		db.close();
	});

	it("returns null before anything has been observed", () => {
		expect(latestViewFrom({ db })).toBeNull();
	});

	it("rebuilds the view from the stored snapshot", () => {
		db.setSignalState({
			level: 5,
			pizza: 3,
			bar: -2,
			postId: "p1",
			postText: "very high traffic",
			postedAt: "2026-09-19T21:00:00.000Z",
			url: "ignored",
		});
		expect(latestViewFrom({ db })).toEqual({
			level: 5,
			pizza: 3,
			bar: -2,
			postText: "very high traffic",
			postedAt: "2026-09-19T21:00:00.000Z",
			url: "https://x.com/PenPizzaReport/status/p1",
		});
	});
});

describe("fanOutSignalChange", () => {
	let db: PizzaDB;
	const deps = () => ({ db });
	const CHANGE: SignalChange = {
		level: 5,
		prevLevel: 3,
		pizza: 3,
		bar: -2,
		postId: "p42",
		postText: "The closest Dominos is reporting very high traffic.",
		postedAt: "2026-09-19T21:00:00.000Z",
		url: "https://x.com/PenPizzaReport/status/p42",
	};

	beforeEach(() => {
		db = new PizzaDB(":memory:");
	});
	afterEach(() => {
		db.close();
	});

	const seed = (defs: Array<{ kind: "dm" | "guild_channel"; id: string; guild?: string }>) => {
		for (const def of defs) {
			db.upsertSubscribed({
				kind: def.kind,
				discordId: def.id,
				guildId: def.guild ?? null,
				now: "2026-09-01T00:00:00.000Z",
			});
		}
	};

	it("delivers to every active subscriber across kinds", async () => {
		seed([
			{ kind: "dm", id: "user-a" },
			{ kind: "dm", id: "user-b" },
			{ kind: "guild_channel", id: "channel-1", guild: "g1" },
		]);
		const mock = makeMockClient();
		const result = await fanOutSignalChange(mock.client, deps(), CHANGE);

		expect(result).toEqual({ sent: 3, failed: 0 });
		expect(mock.usersSent.map((s) => s.id).sort()).toEqual(["user-a", "user-b"]);
		expect(mock.channelsSent.map((s) => s.id)).toEqual(["channel-1"]);
	});

	it("sends the rendered body, quote and link included", async () => {
		seed([{ kind: "dm", id: "u" }]);
		const mock = makeMockClient();
		await fanOutSignalChange(mock.client, deps(), CHANGE);

		const body = mock.usersSent[0]?.body ?? "";
		expect(body).toContain("PENTAGON PIZZA WATCH // SIGNAL LEVEL INCREASE");
		expect(body).toContain("ATTENTION: LEVEL 5 — CLASSIC INDICATOR.");
		expect(body).toContain("> The closest Dominos is reporting very high traffic.");
		expect(body).toContain(`<${CHANGE.url}>`);
	});

	it("skips unsubscribed rows", async () => {
		seed([
			{ kind: "dm", id: "active-1" },
			{ kind: "dm", id: "leaving" },
		]);
		db.markUnsubscribed("dm", "leaving");
		const mock = makeMockClient();

		expect(await fanOutSignalChange(mock.client, deps(), CHANGE)).toEqual({
			sent: 1,
			failed: 0,
		});
		expect(mock.usersSent.map((s) => s.id)).toEqual(["active-1"]);
	});

	it("treats per-recipient failures independently and continues", async () => {
		seed([
			{ kind: "dm", id: "blocked-user" },
			{ kind: "dm", id: "happy-user" },
			{ kind: "guild_channel", id: "broken-channel", guild: "g1" },
			{ kind: "guild_channel", id: "good-channel", guild: "g1" },
		]);
		const mock = makeMockClient();
		mock.failUser("blocked-user");
		mock.failChannel("broken-channel");

		expect(await fanOutSignalChange(mock.client, deps(), CHANGE)).toEqual({
			sent: 2,
			failed: 2,
		});
		expect(mock.usersSent.map((s) => s.id)).toEqual(["happy-user"]);
		expect(mock.channelsSent.map((s) => s.id)).toEqual(["good-channel"]);
	});

	it("treats a deleted channel as a failure", async () => {
		seed([{ kind: "guild_channel", id: "deleted-channel", guild: "g1" }]);
		const mock = makeMockClient();
		mock.missingChannel("deleted-channel");

		expect(await fanOutSignalChange(mock.client, deps(), CHANGE)).toEqual({
			sent: 0,
			failed: 1,
		});
		expect(db.countEvents("dispatch_fail")).toBe(1);
	});

	it("records one dispatch event per recipient with the post metadata", async () => {
		seed([
			{ kind: "dm", id: "ok-user" },
			{ kind: "guild_channel", id: "fail-channel", guild: "g1" },
		]);
		const mock = makeMockClient();
		mock.failChannel("fail-channel");
		await fanOutSignalChange(mock.client, deps(), CHANGE);

		expect(db.countEvents("dispatch_ok")).toBe(1);
		expect(db.countEvents("dispatch_fail")).toBe(1);

		const recent = db.recentEvents(10);
		const ok = recent.find((e) => e.kind === "dispatch_ok");
		assert(ok?.payload);
		expect(JSON.parse(ok.payload)).toMatchObject({
			postId: "p42",
			level: 5,
			prevLevel: 3,
			kind: "dm",
		});
		expect(ok.user_id).toBe("ok-user");

		const failed = recent.find((e) => e.kind === "dispatch_fail");
		assert(failed?.payload);
		expect(failed.payload).toContain("unsendable");
		expect(failed.guild_id).toBe("g1");
		expect(failed.channel_id).toBe("fail-channel");
	});

	it("returns zeroes cleanly with no subscribers", async () => {
		const mock = makeMockClient();
		expect(await fanOutSignalChange(mock.client, deps(), CHANGE)).toEqual({
			sent: 0,
			failed: 0,
		});
		expect(db.countEvents("dispatch_ok")).toBe(0);
	});
});
