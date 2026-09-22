import { describe, expect, it } from "bun:test";
import {
	DISCLAIMER,
	DM_OPT_IN_PROMPT,
	describeBusyness,
	formatLevel,
	formatRelativeAge,
	GUILD_WELCOME,
	HELP,
	latestPayload,
	MENTION_INSUFFICIENT_PRIVILEGES,
	MENTION_UNKNOWN,
	NO_READING_YET,
	pingPongLine,
	postUrl,
	quotePost,
	type SignalChangeView,
	SOURCE_URL,
	signalChangePayload,
	statusLine,
} from "./copy.js";

const NOW = new Date("2026-09-19T23:27:53.000Z");

const VIEW: SignalChangeView = {
	level: 5,
	prevLevel: 3,
	pizza: 3,
	bar: -2,
	postText:
		"The closest Dominos to the Pentagon is reporting very high traffic.\n\nFreddies Beach Bar, the closest gay bar to the Pentagon, is reporting low traffic.\n\nAs of 5:25pm ET",
	postedAt: "2026-09-19T21:27:53.000Z",
	url: "https://x.com/PenPizzaReport/status/2101423055645893111",
};

describe("signalChangePayload", () => {
	it("leads with the increase banner and the level name", () => {
		const out = signalChangePayload(VIEW, { now: NOW });
		expect(out).toContain("PENTAGON PIZZA WATCH // SIGNAL LEVEL INCREASE");
		expect(out).toContain("ATTENTION: LEVEL 5 — CLASSIC INDICATOR.");
		expect(out).toContain("Level ELEVATED -> level 5 CLASSIC INDICATOR.");
	});

	it("renders both venue readings and the post age", () => {
		const out = signalChangePayload(VIEW, { now: NOW });
		expect(out).toContain("PIZZA......... very high");
		expect(out).toContain("BAR........... low");
		expect(out).toContain("AGE........... 2 hours ago");
	});

	it("quotes the source post and links to it", () => {
		const out = signalChangePayload(VIEW, { now: NOW });
		expect(out).toContain("> The closest Dominos to the Pentagon is reporting very high traffic.");
		expect(out).toContain(`<${VIEW.url}>`);
	});

	it("uses the lowercase decrease banner on a downgrade", () => {
		const out = signalChangePayload(
			{ ...VIEW, level: 1, prevLevel: 5, pizza: -1, bar: null },
			{ now: NOW },
		);
		expect(out).toContain("pentagon pizza watch // signal level decrease");
		expect(out).not.toContain("ATTENTION");
		expect(out).toContain("BAR........... no reading");
	});

	it("names an unknown previous level on a first announcement", () => {
		const out = signalChangePayload({ ...VIEW, prevLevel: null }, { now: NOW });
		expect(out).toContain("Level unknown -> level 5 CLASSIC INDICATOR.");
	});

	it("omits timestamp rows when the post carried no date", () => {
		const out = signalChangePayload({ ...VIEW, postedAt: null }, { now: NOW });
		expect(out).not.toContain("POSTED........");
		expect(out).not.toContain("AGE...........");
	});
});

describe("quotePost", () => {
	it("prefixes every non-empty line and drops links", () => {
		expect(quotePost("one\n\ntwo https://t.co/abc")).toBe("> one\n> two");
	});

	it("truncates a long post with an ellipsis", () => {
		const out = quotePost("x".repeat(600));
		expect(out.length).toBeLessThan(340);
		expect(out.endsWith("…")).toBe(true);
	});
});

describe("latestPayload", () => {
	it("falls back to a standing message with no reading on record", () => {
		expect(latestPayload(null)).toBe(NO_READING_YET);
	});

	it("renders the stored reading with its age", () => {
		const out = latestPayload(VIEW, { now: NOW });
		expect(out).toContain("LAST READING: LEVEL 5 CLASSIC INDICATOR (2 hours ago).");
		expect(out).toContain("Pizza: very high. Bar: low.");
		expect(out).toContain(`<${VIEW.url}>`);
	});
});

describe("statusLine", () => {
	it("renders subscribed with a level and reading age", () => {
		expect(
			statusLine({
				subscribed: true,
				level: 4,
				postedAt: "2026-09-19T21:27:53.000Z",
				now: NOW,
			}),
		).toBe("SUBSCRIBED. Signal: 4 HIGH. Last reading: 2 hours ago.");
	});

	it("renders not-subscribed with nothing on record", () => {
		expect(statusLine({ subscribed: false, level: null, postedAt: null, now: NOW })).toBe(
			"NOT SUBSCRIBED. Signal: unknown. Last reading: no reading yet.",
		);
	});
});

describe("pingPongLine", () => {
	it("uses lowercase status framing", () => {
		expect(pingPongLine({ subscribed: true, level: 2, postedAt: null, now: NOW })).toBe(
			"Still here. Signal: 2 NOMINAL. Last reading: no reading yet. Status: subscribed.",
		);
	});
});

describe("describeBusyness", () => {
	it.each([
		[3, "very high"],
		[2, "high"],
		[1, "above average"],
		[0, "average"],
		[-1, "below average"],
		[-2, "low"],
		[-3, "very low"],
	] as const)("reads %d back as %s", (value, expected) => {
		expect(describeBusyness(value)).toBe(expected);
	});

	it("reports a missing reading", () => {
		expect(describeBusyness(null)).toBe("no reading");
	});
});

describe("formatLevel", () => {
	it("pairs the number with its name", () => {
		expect(formatLevel(5)).toBe("5 CLASSIC INDICATOR");
		expect(formatLevel(null)).toBe("unknown");
	});
});

describe("formatRelativeAge", () => {
	it("handles minutes, hours and days", () => {
		expect(formatRelativeAge("2026-09-19T23:07:53.000Z", NOW)).toBe("20 minutes ago");
		expect(formatRelativeAge("2026-09-19T21:27:53.000Z", NOW)).toBe("2 hours ago");
		expect(formatRelativeAge("2026-09-16T23:27:53.000Z", NOW)).toBe("3 days ago");
	});

	it("reports an unparseable timestamp as unknown", () => {
		expect(formatRelativeAge("not-a-date", NOW)).toBe("unknown");
	});
});

describe("postUrl", () => {
	it("builds a link to the source post", () => {
		expect(postUrl("123")).toBe("https://x.com/PenPizzaReport/status/123");
	});
});

// Tone guard. The source account plays it straight and so does this bot; lock
// that in so a careless edit does not regress the voice.
describe("user-facing strings", () => {
	const allCopy = [
		GUILD_WELCOME,
		HELP,
		DM_OPT_IN_PROMPT,
		DISCLAIMER,
		MENTION_UNKNOWN,
		MENTION_INSUFFICIENT_PRIVILEGES,
		NO_READING_YET,
		signalChangePayload(VIEW, { now: NOW }),
		latestPayload(VIEW, { now: NOW }),
	].join("\n\n");

	it("contains no exclamation points", () => {
		expect(allCopy).not.toMatch(/!/);
	});

	it("contains no emoji", () => {
		expect(allCopy).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
	});

	it("welcome and opt-in credit the source account", () => {
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

	it("help explains the level ladder and the indicator", () => {
		expect(HELP).toContain("CLASSIC INDICATOR");
		expect(HELP).toContain("empty bar");
	});

	it("mention-error strings name the operator commands they are rejecting", () => {
		expect(MENTION_UNKNOWN).toContain("subscribe");
		expect(MENTION_UNKNOWN).toContain("unsubscribe");
		expect(MENTION_UNKNOWN).toContain("latest");
		expect(MENTION_INSUFFICIENT_PRIVILEGES).toContain("ManageGuild");
	});

	it("disclaimer states the method's limits", () => {
		expect(DISCLAIMER).toContain("not orders");
		expect(DISCLAIMER).toContain("dismissed");
	});
});
