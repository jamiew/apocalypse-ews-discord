import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ok as assert } from "node:assert/strict";
import { PizzaDB } from "./db.js";
import { orderOldestFirst, pollPizzaOnce, shouldAnnounce } from "./poller.js";
import type { PostSource, SourcePost } from "./xpoz.js";

const CLASSIC =
	"The closest Dominos to the Pentagon is reporting very high traffic. Freddies Beach Bar, the closest gay bar to the Pentagon, is reporting low traffic.";
const QUIET = "Every pizzeria nearby the Pentagon is reporting below average traffic.";
const ELEVATED = "District Pizza Palace is reporting above average traffic.";

function post(overrides: Partial<SourcePost> & { id: string }): SourcePost {
	return {
		text: CLASSIC,
		authorUsername: "PenPizzaReport",
		postedAt: "2026-09-19T21:00:00.000Z",
		isRetweet: false,
		replyToUsername: null,
		...overrides,
	};
}

function sourceOf(...batches: SourcePost[][]): PostSource {
	const queue = [...batches];
	return {
		recentPosts: async () => queue.shift() ?? [],
		close: async () => {},
	};
}

describe("shouldAnnounce", () => {
	it("stays silent on the very first observation", () => {
		expect(shouldAnnounce({ prevLevel: null, nextLevel: 5, minAlertLevel: 3 })).toEqual({
			announce: false,
			reason: "first_observation",
		});
	});

	it("stays silent when the level has not moved", () => {
		expect(shouldAnnounce({ prevLevel: 4, nextLevel: 4, minAlertLevel: 3 })).toEqual({
			announce: false,
			reason: "unchanged",
		});
	});

	it("announces an escalation into the alert band", () => {
		expect(shouldAnnounce({ prevLevel: 1, nextLevel: 3, minAlertLevel: 3 })).toEqual({
			announce: true,
		});
	});

	it("announces a move within the alert band, in both directions", () => {
		expect(shouldAnnounce({ prevLevel: 3, nextLevel: 5, minAlertLevel: 3 })).toEqual({
			announce: true,
		});
		expect(shouldAnnounce({ prevLevel: 5, nextLevel: 3, minAlertLevel: 3 })).toEqual({
			announce: true,
		});
	});

	it("announces the stand-down out of the alert band", () => {
		expect(shouldAnnounce({ prevLevel: 4, nextLevel: 1, minAlertLevel: 3 })).toEqual({
			announce: true,
		});
	});

	it("suppresses wobble entirely below the floor", () => {
		expect(shouldAnnounce({ prevLevel: 1, nextLevel: 2, minAlertLevel: 3 })).toEqual({
			announce: false,
			reason: "below_floor",
		});
	});

	it("respects a floor of 1 by announcing every change", () => {
		expect(shouldAnnounce({ prevLevel: 1, nextLevel: 2, minAlertLevel: 1 })).toEqual({
			announce: true,
		});
	});
});

describe("orderOldestFirst", () => {
	it("sorts by post time ascending", () => {
		const ordered = orderOldestFirst([
			post({ id: "b", postedAt: "2026-09-19T22:00:00.000Z" }),
			post({ id: "a", postedAt: "2026-09-19T20:00:00.000Z" }),
		]);
		expect(ordered.map((p) => p.id)).toEqual(["a", "b"]);
	});

	it("falls back to id order when a timestamp is missing", () => {
		const ordered = orderOldestFirst([post({ id: "2", postedAt: null }), post({ id: "1" })]);
		expect(ordered.map((p) => p.id)).toEqual(["1", "2"]);
	});
});

describe("pollPizzaOnce", () => {
	let db: PizzaDB;

	beforeEach(() => {
		db = new PizzaDB(":memory:");
	});
	afterEach(() => {
		db.close();
	});

	const poll = async (source: PostSource, onChange: (c: unknown) => void = () => {}) =>
		pollPizzaOnce({ db, source, minAlertLevel: 3, onSignalChange: onChange });

	it("records the first observation without announcing it", async () => {
		const seen: unknown[] = [];
		const result = await poll(sourceOf([post({ id: "1" })]), (c) => void seen.push(c));

		expect(result.fresh).toBe(1);
		expect(result.change).toBeNull();
		expect(seen).toEqual([]);
		expect(db.getSignalState().level).toBe(5);
		expect(db.countEvents("signal_suppressed")).toBe(1);
	});

	it("announces the next real transition", async () => {
		const source = sourceOf([post({ id: "1", text: QUIET })], [post({ id: "2", text: CLASSIC })]);
		const seen: Array<{ level: number; prevLevel: number | null }> = [];
		const record = (c: unknown) => {
			const change = c as { level: number; prevLevel: number | null };
			seen.push({ level: change.level, prevLevel: change.prevLevel });
		};
		await poll(source, record);
		const result = await poll(source, record);

		expect(result.change?.level).toBe(5);
		expect(seen).toEqual([{ level: 5, prevLevel: 1 }]);
		expect(db.countEvents("signal_change")).toBe(1);
	});

	it("never dispatches the same post twice", async () => {
		const source: PostSource = {
			recentPosts: async () => [post({ id: "1", text: QUIET }), post({ id: "2" })],
			close: async () => {},
		};
		let dispatches = 0;
		await poll(source, () => {
			dispatches++;
		});
		const second = await poll(source, () => {
			dispatches++;
		});

		expect(second.fresh).toBe(0);
		expect(second.change).toBeNull();
		// First tick was the initial observation, so nothing went out at all.
		expect(dispatches).toBe(0);
	});

	it("sends one dispatch for a burst, carrying the newest post", async () => {
		await poll(sourceOf([post({ id: "0", text: QUIET })]));
		const burst = [
			post({ id: "1", text: ELEVATED, postedAt: "2026-09-19T21:00:00.000Z" }),
			post({ id: "2", text: CLASSIC, postedAt: "2026-09-19T22:00:00.000Z" }),
		];
		const seen: Array<{ level: number; postId: string }> = [];
		await pollPizzaOnce({
			db,
			source: sourceOf(burst),
			minAlertLevel: 3,
			onSignalChange: (c) => void seen.push({ level: c.level, postId: c.postId }),
		});

		expect(seen).toEqual([{ level: 5, postId: "2" }]);
		// Both posts are still recorded, so neither can be re-dispatched later.
		expect(db.hasSeenPost("1")).toBe(true);
		expect(db.hasSeenPost("2")).toBe(true);
	});

	it("records but does not classify retweets and outward replies", async () => {
		const source = sourceOf([
			post({ id: "rt", isRetweet: true }),
			post({ id: "reply", text: "@AutismCapital Freddies is about average." }),
		]);
		const result = await poll(source);

		expect(result.fresh).toBe(2);
		expect(db.getSignalState().level).toBeNull();
		expect(db.countEvents("post_skipped")).toBe(2);
	});

	it("records an unreadable post without moving the signal", async () => {
		await poll(sourceOf([post({ id: "1", text: ELEVATED })]));
		const before = db.getSignalState().level;
		await poll(sourceOf([post({ id: "2", text: "Thanks for the follows." })]));

		expect(db.getSignalState().level).toBe(before);
		const skipped = db
			.recentEvents(20)
			.filter((e) => e.kind === "post_skipped")
			.map((e) => JSON.parse(e.payload ?? "{}"));
		expect(skipped).toContainEqual({ postId: "2", reason: "unreadable" });
	});

	it("suppresses a transition below the alert floor", async () => {
		await poll(sourceOf([post({ id: "1", text: QUIET })]));
		const seen: unknown[] = [];
		const result = await poll(
			sourceOf([post({ id: "2", text: "Pizza traffic is about average." })]),
			(c) => void seen.push(c),
		);

		expect(result.change).toBeNull();
		expect(seen).toEqual([]);
		const suppressed = db
			.recentEvents(20)
			.filter((e) => e.kind === "signal_suppressed")
			.map((e) => JSON.parse(e.payload ?? "{}"));
		expect(suppressed.some((s) => s.reason === "below_floor")).toBe(true);
	});

	it("stores the announced body on the signal_change event", async () => {
		await poll(sourceOf([post({ id: "1", text: QUIET })]));
		await poll(sourceOf([post({ id: "2", text: CLASSIC })]));

		const change = db.recentEvents(20).find((e) => e.kind === "signal_change");
		assert(change?.payload);
		const payload = JSON.parse(change.payload);
		expect(payload.body).toContain("SIGNAL LEVEL INCREASE");
		expect(payload.body).toContain("x.com/PenPizzaReport/status/2");
	});

	it("propagates a source failure to the caller", async () => {
		const broken: PostSource = {
			recentPosts: async () => {
				throw new Error("xpoz unreachable");
			},
			close: async () => {},
		};
		await expect(poll(broken)).rejects.toThrow(/xpoz unreachable/);
	});
});
