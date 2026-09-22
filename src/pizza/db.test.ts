import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ok as assert } from "node:assert/strict";
import { PizzaDB, type SubscriberKind, subscriberAddress } from "./db.js";

const NOW = "2026-09-19T00:00:00.000Z";

function subId(db: PizzaDB, kind: SubscriberKind, discordId: string): number {
	const sub = db.findSubscriber(kind, discordId);
	assert(sub, `subscriber ${kind}:${discordId} not found`);
	return sub.id;
}

describe("PizzaDB", () => {
	let db: PizzaDB;

	beforeEach(() => {
		db = new PizzaDB(":memory:");
	});
	afterEach(() => {
		db.close();
	});

	describe("migrations", () => {
		it("seeds the single signal_state row", () => {
			const state = db.getSignalState();
			expect(state.id).toBe(1);
			expect(state.level).toBeNull();
			expect(state.post_id).toBeNull();
		});
	});

	describe("upsertSubscribed", () => {
		it("creates an active subscriber on first call", () => {
			expect(db.upsertSubscribed({ kind: "dm", discordId: "u1", guildId: null, now: NOW })).toEqual(
				{ created: true, reactivated: false },
			);
			expect(db.findSubscriber("dm", "u1")?.status).toBe("active");
		});

		it("is idempotent for an already-active subscriber", () => {
			db.upsertSubscribed({ kind: "dm", discordId: "u1", guildId: null, now: NOW });
			expect(db.upsertSubscribed({ kind: "dm", discordId: "u1", guildId: null, now: NOW })).toEqual(
				{ created: false, reactivated: false },
			);
		});

		it("reactivates an unsubscribed row", () => {
			db.upsertSubscribed({ kind: "dm", discordId: "u1", guildId: null, now: NOW });
			db.markUnsubscribed("dm", "u1");
			expect(
				db.upsertSubscribed({
					kind: "dm",
					discordId: "u1",
					guildId: null,
					now: "2026-09-20T00:00:00.000Z",
				}),
			).toEqual({ created: false, reactivated: true });
			expect(db.findSubscriber("dm", "u1")?.status).toBe("active");
		});

		it("keeps the same channel subscribed once across kinds", () => {
			db.upsertSubscribed({ kind: "dm", discordId: "shared", guildId: null, now: NOW });
			db.upsertSubscribed({
				kind: "guild_channel",
				discordId: "shared",
				guildId: "g1",
				now: NOW,
			});
			expect(db.listActive()).toHaveLength(2);
			expect(db.listActive("dm")).toHaveLength(1);
		});
	});

	describe("markUnsubscribed", () => {
		it("reports whether a row actually changed", () => {
			db.upsertSubscribed({ kind: "dm", discordId: "u1", guildId: null, now: NOW });
			expect(db.markUnsubscribed("dm", "u1")).toBe(true);
			expect(db.markUnsubscribed("dm", "u1")).toBe(false);
			expect(db.markUnsubscribed("dm", "ghost")).toBe(false);
		});

		it("removes the row from listActive", () => {
			db.upsertSubscribed({ kind: "dm", discordId: "u1", guildId: null, now: NOW });
			db.markUnsubscribed("dm", "u1");
			expect(db.listActive()).toEqual([]);
		});
	});

	describe("seen_posts", () => {
		it("records a post once and reports it as seen", () => {
			db.recordSeenPost({
				postId: "p1",
				text: "hello",
				postedAt: NOW,
				level: 5,
				pizza: 3,
				bar: -2,
			});
			expect(db.hasSeenPost("p1")).toBe(true);
			expect(db.hasSeenPost("p2")).toBe(false);
		});

		it("ignores a duplicate insert rather than throwing", () => {
			const row = {
				postId: "p1",
				text: "hello",
				postedAt: NOW,
				level: 5,
				pizza: 3,
				bar: -2,
			} as const;
			db.recordSeenPost(row);
			expect(() => db.recordSeenPost({ ...row, text: "changed" })).not.toThrow();
			expect(db.hasSeenPost("p1")).toBe(true);
		});

		it("stores an unreadable post with null readings", () => {
			db.recordSeenPost({
				postId: "p2",
				text: "thanks for the follows",
				postedAt: null,
				level: null,
				pizza: null,
				bar: null,
			});
			expect(db.hasSeenPost("p2")).toBe(true);
		});
	});

	describe("signal_state", () => {
		it("round-trips a snapshot", () => {
			db.setSignalState({
				level: 4,
				pizza: 3,
				bar: null,
				postId: "p9",
				postText: "very high traffic",
				postedAt: NOW,
				url: "https://x.com/PenPizzaReport/status/p9",
			});
			const state = db.getSignalState();
			expect(state.level).toBe(4);
			expect(state.pizza).toBe(3);
			expect(state.bar).toBeNull();
			expect(state.post_id).toBe("p9");
			expect(state.posted_at).toBe(NOW);
		});

		it("overwrites rather than accumulating rows", () => {
			const base = {
				pizza: 1,
				bar: -1,
				postText: "t",
				postedAt: NOW,
				url: "u",
			} as const;
			db.setSignalState({ ...base, level: 3, postId: "a" });
			db.setSignalState({ ...base, level: 5, postId: "b" });
			expect(db.getSignalState().level).toBe(5);
			expect(db.getSignalState().post_id).toBe("b");
		});
	});

	describe("recordEvent", () => {
		it("round-trips a typed payload", () => {
			db.recordEvent({
				kind: "subscribe",
				userId: "u1",
				payload: { kind: "dm", via: "dm", reactivated: false },
			});
			const [event] = db.recentEvents(1);
			expect(event?.kind).toBe("subscribe");
			expect(event?.user_id).toBe("u1");
			expect(JSON.parse(event?.payload ?? "{}")).toEqual({
				kind: "dm",
				via: "dm",
				reactivated: false,
			});
		});

		it("serializes an Error into something readable", () => {
			db.recordEvent({ kind: "poll_fail", payload: { err: new Error("xpoz down") } });
			const [event] = db.recentEvents(1);
			expect(event?.payload).toContain("xpoz down");
			expect(event?.payload).toContain("Error");
		});

		it("accepts a payload-free kind", () => {
			db.recordEvent({ kind: "guild_welcome_sent", guildId: "g1", channelId: "c1" });
			expect(db.countEvents("guild_welcome_sent")).toBe(1);
		});

		it("counts by kind", () => {
			db.recordEvent({ kind: "poll_fail", payload: { err: "a" } });
			db.recordEvent({ kind: "poll_fail", payload: { err: "b" } });
			expect(db.countEvents("poll_fail")).toBe(2);
			expect(db.countEvents("signal_change")).toBe(0);
		});
	});

	describe("subscriberAddress", () => {
		it("routes a guild channel to channelId", () => {
			db.upsertSubscribed({ kind: "guild_channel", discordId: "c1", guildId: "g1", now: NOW });
			const sub = db.findSubscriber("guild_channel", "c1");
			assert(sub);
			expect(subscriberAddress(sub)).toEqual({
				guildId: "g1",
				channelId: "c1",
				userId: null,
			});
		});

		it("routes a DM to userId", () => {
			db.upsertSubscribed({ kind: "dm", discordId: "u1", guildId: null, now: NOW });
			const sub = db.findSubscriber("dm", "u1");
			assert(sub);
			expect(subscriberAddress(sub)).toEqual({
				guildId: null,
				channelId: null,
				userId: "u1",
			});
		});
	});

	describe("ids", () => {
		it("assigns stable row ids", () => {
			db.upsertSubscribed({ kind: "dm", discordId: "u1", guildId: null, now: NOW });
			const first = subId(db, "dm", "u1");
			db.markUnsubscribed("dm", "u1");
			db.upsertSubscribed({ kind: "dm", discordId: "u1", guildId: null, now: NOW });
			expect(subId(db, "dm", "u1")).toBe(first);
		});
	});
});
