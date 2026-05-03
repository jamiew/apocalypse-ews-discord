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
				currentLevel: 2,
			}),
		).toBe("SUBSCRIBED. Level: 2. Last level 5 alert: Thu, 30 Apr 2026 12:00:00 GMT — Alert..");
	});

	it("renders not-subscribed + no alert on record", () => {
		expect(statusLine({ subscribed: false, lastAlert: null, currentLevel: null })).toBe(
			"NOT SUBSCRIBED. Level: unknown. Last level 5 alert: none.",
		);
	});
});

describe("pingPongLine", () => {
	it("uses lowercase 'subscribed' and 'still here' framing", () => {
		expect(pingPongLine({ subscribed: true, lastAlert: null, currentLevel: 2 })).toBe(
			"Still here. Level: 2. Last level 5 alert: none. Status: subscribed.",
		);
		expect(pingPongLine({ subscribed: false, lastAlert: null, currentLevel: null })).toBe(
			"Still here. Level: unknown. Last level 5 alert: none. Status: not subscribed.",
		);
	});
});

describe("levelChangePayload", () => {
	const base: Omit<LevelChange, "level" | "prevLevel"> = {
		alertLevel: "elevated",
		zScore: 4.7,
		asOf: "2026-05-02T01:29:50+00:00",
	};
	const now = new Date("2026-05-02T02:09:50+00:00");

	it("uses ATTENTION header for level 5 rising", () => {
		const out = levelChangePayload({ ...base, level: 5, prevLevel: 4 }, { now });
		expect(out).toContain("🚨 APOCALYPSE EWS // ALERT LEVEL INCREASE");
		expect(out).toContain("ATTENTION: LEVEL 5");
		expect(out).toContain("Level 4 -> level 5.");
	});

	it("uses WARNING for level 4 rising", () => {
		const out = levelChangePayload({ ...base, level: 4, prevLevel: 3 }, { now });
		expect(out).toContain("🔴 APOCALYPSE EWS // ALERT LEVEL INCREASE");
		expect(out).toContain("WARNING: LEVEL 4");
	});

	it("uses ELEVATED for level 3 rising", () => {
		const out = levelChangePayload({ ...base, level: 3, prevLevel: 2 }, { now });
		expect(out).toContain("🟠 APOCALYPSE EWS // ALERT LEVEL INCREASE");
		expect(out).toContain("ELEVATED: LEVEL 3");
	});

	it("uses Notice for level 2 rising", () => {
		const out = levelChangePayload({ ...base, level: 2, prevLevel: 1 }, { now });
		expect(out).toContain("🟡 APOCALYPSE EWS // ALERT LEVEL INCREASE");
		expect(out).toContain("NOTICE: LEVEL 2");
	});

	it("renders a downgrade banner on a falling transition", () => {
		const out = levelChangePayload({ ...base, level: 1, prevLevel: 5 }, { now });
		expect(out).toContain("✅ apocalypse ews // alert level downgraded");
		expect(out).not.toContain("STAND-DOWN.");
		expect(out).toContain("Level 5 -> level 1.");
	});

	it("formats label, z-score, timestamp, age, and the source URL", () => {
		const out = levelChangePayload({ ...base, level: 4, prevLevel: 3 }, { now });
		expect(out).toContain("```text");
		expect(out).toContain("LABEL......... elevated");
		expect(out).toContain("Z............. 4.70");
		expect(out).toContain("TIMESTAMP..... 2026-05-02T01:29:50+00:00");
		expect(out).toContain("AGE........... 40 minutes ago");
		expect(out).toContain(`<${SOURCE_URL}>`);
	});

	it("omits absent metadata cleanly", () => {
		const out = levelChangePayload(
			{
				level: 2,
				prevLevel: 1,
				alertLevel: null,
				zScore: null,
				asOf: null,
			},
			{ now },
		);
		expect(out).toContain("Level 1 -> level 2.");
		expect(out).not.toContain("LABEL.........");
		expect(out).not.toContain("Z.............");
		expect(out).not.toContain("TIMESTAMP.....");
		expect(out).not.toContain("AGE...........");
	});

	it("first observation formats an unknown previous level", () => {
		const out = levelChangePayload({ ...base, level: 3, prevLevel: null }, { now });
		expect(out).toContain("Level unknown -> level 3.");
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
