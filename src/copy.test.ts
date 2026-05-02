import { describe, expect, it } from "bun:test";
import {
	ANNUAL_REMINDER,
	alertPayload,
	DM_OPT_IN_PROMPT,
	GUILD_WELCOME,
	HELP,
	type LevelChange,
	levelChangePayload,
	MENTION_INSUFFICIENT_PRIVILEGES,
	MENTION_UNKNOWN,
	pingPongLine,
	SOURCE_URL,
	statusLine,
} from "./copy.js";

describe("alertPayload", () => {
	const HEADER = "ATTENTION. EMERGENCY LEVEL 5.";

	it("formats the alert as 4 lines", () => {
		const out = alertPayload({
			title: "Emergency level 5.",
			link: "https://ews.kylemcdonald.net/",
			pubDate: "Thu, 30 Apr 2026 12:00:00 GMT",
		});
		expect(out.split("\n")).toEqual([
			HEADER,
			"Emergency level 5.",
			"Thu, 30 Apr 2026 12:00:00 GMT",
			"https://ews.kylemcdonald.net/",
		]);
	});

	it("drops empty fields without leaving blank lines", () => {
		const out = alertPayload({ title: "t", link: "", pubDate: "" });
		expect(out.split("\n")).toEqual([HEADER, "t"]);
	});
});

describe("statusLine", () => {
	it("renders subscribed + last alert", () => {
		expect(
			statusLine({
				subscribed: true,
				lastAlert: { title: "Alert.", pubDate: "Thu, 30 Apr 2026 12:00:00 GMT" },
			}),
		).toBe("SUBSCRIBED. Last: Thu, 30 Apr 2026 12:00:00 GMT — Alert..");
	});

	it("renders not-subscribed + no alert on record", () => {
		expect(statusLine({ subscribed: false, lastAlert: null })).toBe("NOT SUBSCRIBED. Last: none.");
	});
});

describe("pingPongLine", () => {
	it("uses lowercase 'subscribed' and 'still here' framing", () => {
		expect(pingPongLine({ subscribed: true, lastAlert: null })).toBe(
			"Still here. Last: none. Status: subscribed.",
		);
		expect(pingPongLine({ subscribed: false, lastAlert: null })).toBe(
			"Still here. Last: none. Status: not subscribed.",
		);
	});
});

describe("levelChangePayload", () => {
	const base: Omit<LevelChange, "level" | "prevLevel"> = {
		alertLevel: "elevated",
		zScore: 4.7,
		asOf: "2026-05-02T01:29:50+00:00",
	};

	it("uses ATTENTION header for level 5 rising", () => {
		const out = levelChangePayload({ ...base, level: 5, prevLevel: 4 });
		expect(out).toMatch(/^ATTENTION\. EMERGENCY LEVEL 5\.$/m);
		expect(out).toContain("Was 4, now 5.");
	});

	it("uses WARNING for level 4 rising", () => {
		const out = levelChangePayload({ ...base, level: 4, prevLevel: 3 });
		expect(out).toMatch(/^WARNING\. Emergency level 4\.$/m);
	});

	it("uses ELEVATED for level 3 rising", () => {
		const out = levelChangePayload({ ...base, level: 3, prevLevel: 2 });
		expect(out).toMatch(/^ELEVATED\. Emergency level 3\.$/m);
	});

	it("uses Notice for level 2 rising", () => {
		const out = levelChangePayload({ ...base, level: 2, prevLevel: 1 });
		expect(out).toMatch(/^Notice\. Emergency level 2\.$/m);
	});

	it("renders Stand-down on a falling transition", () => {
		const out = levelChangePayload({ ...base, level: 1, prevLevel: 5 });
		expect(out).toMatch(/^Stand-down\. Emergency level returned to 1\.$/m);
		expect(out).toContain("Was 5, now 1.");
	});

	it("formats the metadata tail with label, z-score, asOf", () => {
		const out = levelChangePayload({ ...base, level: 4, prevLevel: 3 });
		expect(out).toContain("label: elevated");
		expect(out).toContain("z=4.70");
		expect(out).toContain("as of 2026-05-02T01:29:50+00:00");
		expect(out).toContain(SOURCE_URL);
	});

	it("omits absent metadata cleanly", () => {
		const out = levelChangePayload({
			level: 2,
			prevLevel: 1,
			alertLevel: null,
			zScore: null,
			asOf: null,
		});
		// header + fromTo + source URL — no orphan metadata line
		expect(out.split("\n")).toEqual(["Notice. Emergency level 2.", "Was 1, now 2.", SOURCE_URL]);
	});

	it("first observation (prevLevel null) reads as a new observation", () => {
		const out = levelChangePayload({ ...base, level: 3, prevLevel: null });
		expect(out).toContain("New observation: level 3.");
	});
});

// Tone guard. These strings are user-facing; the source website is deadpan and
// no-emoji. Lock that in so a careless edit doesn't regress the voice.
describe("user-facing strings", () => {
	const allCopy = [
		GUILD_WELCOME,
		HELP,
		DM_OPT_IN_PROMPT,
		ANNUAL_REMINDER,
		MENTION_UNKNOWN,
		MENTION_INSUFFICIENT_PRIVILEGES,
		alertPayload({ title: "x", link: "y", pubDate: "z" }),
	].join("\n\n");

	it("contains no exclamation points", () => {
		expect(allCopy).not.toMatch(/!/);
	});

	it("contains no emoji", () => {
		// Rough emoji probe: anything in the supplemental pictographs / symbols ranges.
		expect(allCopy).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
	});

	it("welcome and opt-in mention the source URL", () => {
		expect(GUILD_WELCOME).toContain(SOURCE_URL);
		expect(DM_OPT_IN_PROMPT).toContain(SOURCE_URL);
	});

	it("welcome explains how to subscribe and how to remove the bot", () => {
		expect(GUILD_WELCOME).toContain("/subscribe");
		expect(GUILD_WELCOME).toMatch(/Server Settings.*Integrations.*Remove/);
	});

	it("welcome advertises the @-mention surface", () => {
		expect(GUILD_WELCOME).toMatch(/@-mention/);
	});

	it("mention-error strings name the operator commands they're rejecting", () => {
		expect(MENTION_UNKNOWN).toContain("subscribe");
		expect(MENTION_UNKNOWN).toContain("unsubscribe");
		expect(MENTION_INSUFFICIENT_PRIVILEGES).toContain("ManageGuild");
	});

	it("annual reminder offers a way out", () => {
		expect(ANNUAL_REMINDER.toLowerCase()).toContain("unsubscribe");
	});
});
