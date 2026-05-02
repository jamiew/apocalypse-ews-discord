import { describe, expect, it } from "vitest";
import {
	ANNUAL_REMINDER,
	alertPayload,
	DM_OPT_IN_PROMPT,
	GUILD_WELCOME,
	HELP,
	MENTION_INSUFFICIENT_PRIVILEGES,
	MENTION_UNKNOWN,
	pingPongLine,
	SOURCE_URL,
	statusLine,
} from "./copy.js";

describe("alertPayload", () => {
	const HEADER = "ATTENTION. APOCALYPSE EARLY WARNING SYSTEM HAS REACHED EMERGENCY LEVEL 5.";

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
		).toBe("Subscribed. Last alert: Thu, 30 Apr 2026 12:00:00 GMT — Alert..");
	});

	it("renders not-subscribed + no alert on record", () => {
		expect(statusLine({ subscribed: false, lastAlert: null })).toBe(
			"Not subscribed. Last alert: none on record.",
		);
	});
});

describe("pingPongLine", () => {
	it("uses lowercase 'subscribed' and 'still here' framing", () => {
		expect(pingPongLine({ subscribed: true, lastAlert: null })).toBe(
			"Still here. Last alert: none on record. Status: subscribed.",
		);
		expect(pingPongLine({ subscribed: false, lastAlert: null })).toBe(
			"Still here. Last alert: none on record. Status: not subscribed.",
		);
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
