import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DB } from "./db.js";
import { pollLevelOnce } from "./level-poller.js";

const SAMPLE = (level: number, opts: Partial<{ alertLevel: string; zScore: number }> = {}) => ({
	current: {
		emergencyLevel: level,
		alertLevel: opts.alertLevel ?? "normal",
		zScore: opts.zScore ?? -1.5,
		asOf: "2026-05-02T01:29:50+00:00",
	},
	snapshotGeneratedAt: "2026-05-02T01:30:00+00:00",
});

function mockFetch(body: unknown, ok = true) {
	const fn = vi.fn().mockResolvedValue({
		ok,
		status: ok ? 200 : 500,
		statusText: ok ? "OK" : "Internal Server Error",
		json: async () => body,
	});
	vi.stubGlobal("fetch", fn);
	return fn;
}

describe("pollLevelOnce", () => {
	let db: DB;

	beforeEach(() => {
		db = new DB(":memory:");
	});

	afterEach(() => {
		db.close();
		vi.unstubAllGlobals();
	});

	it("records first observation but does NOT fire onLevelChange", async () => {
		mockFetch(SAMPLE(1));
		const seen: number[] = [];
		const change = await pollLevelOnce({
			db,
			url: "https://example.com/dashboard.json",
			onLevelChange: (c) => void seen.push(c.level),
		});
		expect(change).toBeNull();
		expect(seen).toEqual([]);
		expect(db.getLevelState().emergency_level).toBe(1);
	});

	it("ignores no-change polls", async () => {
		mockFetch(SAMPLE(2));
		await pollLevelOnce({
			db,
			url: "https://example.com/dashboard.json",
			onLevelChange: () => {},
		});
		// Second call with same level
		const seen: number[] = [];
		const change = await pollLevelOnce({
			db,
			url: "https://example.com/dashboard.json",
			onLevelChange: (c) => void seen.push(c.level),
		});
		expect(change).toBeNull();
		expect(seen).toEqual([]);
	});

	it("fires onLevelChange and records a level_change event when level rises", async () => {
		mockFetch(SAMPLE(2));
		await pollLevelOnce({ db, url: "url", onLevelChange: () => {} });

		mockFetch(SAMPLE(4, { alertLevel: "elevated", zScore: 4.7 }));
		const seen: Array<{ level: number; prev: number | null }> = [];
		const change = await pollLevelOnce({
			db,
			url: "url",
			onLevelChange: (c) => void seen.push({ level: c.level, prev: c.prevLevel }),
		});

		expect(change?.level).toBe(4);
		expect(change?.prevLevel).toBe(2);
		expect(seen).toEqual([{ level: 4, prev: 2 }]);
		expect(db.getLevelState().emergency_level).toBe(4);
		expect(db.countEvents("level_change")).toBe(1);
	});

	it("fires on a falling transition too", async () => {
		mockFetch(SAMPLE(5));
		await pollLevelOnce({ db, url: "url", onLevelChange: () => {} });

		mockFetch(SAMPLE(1));
		const seen: Array<{ level: number; prev: number | null }> = [];
		const change = await pollLevelOnce({
			db,
			url: "url",
			onLevelChange: (c) => void seen.push({ level: c.level, prev: c.prevLevel }),
		});
		expect(change?.level).toBe(1);
		expect(change?.prevLevel).toBe(5);
		expect(seen).toEqual([{ level: 1, prev: 5 }]);
	});

	it("rejects malformed dashboard JSON via Zod", async () => {
		mockFetch({ current: { emergencyLevel: "five", asOf: "x" } });
		await expect(pollLevelOnce({ db, url: "url", onLevelChange: () => {} })).rejects.toThrow();
	});

	it("rejects out-of-range emergencyLevel", async () => {
		mockFetch({ current: { emergencyLevel: 9, asOf: "x" } });
		await expect(pollLevelOnce({ db, url: "url", onLevelChange: () => {} })).rejects.toThrow();
	});

	it("propagates non-OK HTTP responses", async () => {
		mockFetch({}, false);
		await expect(pollLevelOnce({ db, url: "url", onLevelChange: () => {} })).rejects.toThrow(
			/dashboard fetch/,
		);
	});
});
