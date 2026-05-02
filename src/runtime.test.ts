import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DB } from "./db.js";

describe("bun runtime", () => {
	test("Bun is the test runtime", () => {
		expect(typeof Bun).toBe("object");
		expect(Bun.version).toMatch(/^\d+\.\d+/);
	});
});

describe("DB under Bun runtime", () => {
	let db: DB;

	beforeEach(() => {
		db = new DB(":memory:");
	});
	afterEach(() => {
		db.close();
	});

	test("bun:sqlite roundtrips a subscriber", () => {
		const r = db.upsertSubscribed({
			kind: "dm",
			discordId: "u1",
			guildId: null,
			now: "2026-05-02T00:00:00.000Z",
		});
		expect(r).toEqual({ created: true, reactivated: false });

		const sub = db.findSubscriber("dm", "u1");
		expect(sub?.status).toBe("active");
		expect(sub?.kind).toBe("dm");
	});

	test("recordEvent + recentEvents roundtrip with typed payload", () => {
		db.recordEvent({
			kind: "subscribe",
			userId: "u1",
			payload: { kind: "dm", via: "dm", reactivated: false },
		});
		const events = db.recentEvents(1);
		expect(events[0]?.kind).toBe("subscribe");
		expect(events[0]?.user_id).toBe("u1");
		expect(events[0]?.payload).toBe(JSON.stringify({ kind: "dm", via: "dm", reactivated: false }));
	});

	test("level_state migration (0003) ran", () => {
		const state = db.getLevelState();
		expect(state.id).toBe(1);
		expect(state.emergency_level).toBeNull();
	});

	test("seen_alerts dedup works", () => {
		db.recordSeenAlert({ guid: "g1", title: "t", link: "l", pub_date: "p" });
		expect(db.hasSeenAlert("g1")).toBe(true);
		expect(db.hasSeenAlert("g2")).toBe(false);
	});
});
