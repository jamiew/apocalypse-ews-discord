import { describe, expect, it } from "bun:test";
import {
	ANNUAL_REMINDER,
	alertPayload,
	blockedNotice,
	DM_OPT_IN_PROMPT,
	dmStatusReport,
	GUILD_BOT_ABSENT,
	GUILD_WELCOME,
	guildCannotPost,
	guildStatusReport,
	HELP,
	heartbeatPayload,
	type LevelChange,
	levelChangePayload,
	levelPresenceName,
	MENTION_INSUFFICIENT_PRIVILEGES,
	MENTION_UNKNOWN,
	pingPongLine,
	SOURCE_URL,
	SUBSCRIBE_COMMAND_DESCRIPTION,
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

	it("stays under Discord's 2000-character limit for oversized upstream fields", () => {
		const huge = "x".repeat(5000);
		const out = alertPayload({ title: huge, link: `https://e.com/${huge}`, pubDate: huge });
		expect(out.length).toBeLessThanOrEqual(2000);
		expect(out.split("\n")[1]).toBe(`${"x".repeat(255)}…`);
	});
});

describe("dmStatusReport", () => {
	it("leads with level and last alert, then the DM state and the way out", () => {
		expect(
			dmStatusReport({
				subscribed: true,
				lastAlert: { title: "Alert.", pubDate: "Thu, 30 Apr 2026 12:00:00 GMT" },
				currentLevel: 2,
			}),
		).toBe(
			[
				"STATUS REPORT.",
				"Level: 2. Last level 5 alert: Thu, 30 Apr 2026 12:00:00 GMT — Alert..",
				"DM alerts: SUBSCRIBED. Send `unsubscribe` to stop.",
			].join("\n"),
		);
	});

	it("tells an unsubscribed user how to opt in", () => {
		expect(dmStatusReport({ subscribed: false, lastAlert: null, currentLevel: null })).toContain(
			"DM alerts: NOT SUBSCRIBED. Send `subscribe` to opt in.",
		);
	});
});

describe("guildStatusReport", () => {
	const base = { lastAlert: null, currentLevel: 1 };

	it("confirms a working subscription here", () => {
		const out = guildStatusReport({
			...base,
			channelId: "c1",
			channels: [{ id: "c1", canPost: true }],
		});
		expect(out).toContain("This channel: SUBSCRIBED. `/unsubscribe` to stand down.");
		expect(out).not.toContain("Other alert channels");
	});

	it("flags a subscription here that the bot cannot post to", () => {
		const out = guildStatusReport({
			...base,
			channelId: "c1",
			channels: [{ id: "c1", canPost: false }],
		});
		expect(out).toContain(
			"This channel: SUBSCRIBED, BLOCKED. The bot needs View Channel and Send Messages here.",
		);
	});

	it("points to the server's other alert channels and marks blocked ones", () => {
		const out = guildStatusReport({
			...base,
			channelId: "here",
			channels: [
				{ id: "a", canPost: true },
				{ id: "b", canPost: false },
				{ id: "c", canPost: null },
			],
		});
		expect(out).toContain("This channel: NOT SUBSCRIBED. `/subscribe` here to receive alerts.");
		expect(out).toContain("Other alert channels here: <#a>, <#b> (BLOCKED), <#c>.");
		expect(out).toContain("The bot needs View Channel and Send Messages in blocked channels.");
	});

	it("says when nothing in the server receives alerts", () => {
		const out = guildStatusReport({ ...base, channelId: "here", channels: [] });
		expect(out).toContain("No channel in this server receives alerts.");
	});
});

describe("blockedNotice", () => {
	it("names the blocked channel, the fix, and both ways out", () => {
		const out = blockedNotice("100000000000000001");
		expect(out).toContain("Alerts for this server go to <#100000000000000001>");
		expect(out).toContain("View Channel and Send Messages");
		expect(out).toContain("`/subscribe`");
		expect(out).toContain("`/unsubscribe`");
		expect(out).toMatch(/Server Settings.*Integrations.*Remove/);
	});

	it("names the server, escaped, when sent to the owner by DM", () => {
		expect(blockedNotice("100000000000000001", "Example *Guild*")).toContain(
			"Alerts for **Example \\*Guild\\*** go to",
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

	it("keeps an oversized label under 2000 characters", () => {
		const out = levelChangePayload(
			{ ...base, alertLevel: "y".repeat(5000), level: 5, prevLevel: 4 },
			{ now },
		);
		expect(out.length).toBeLessThanOrEqual(2000);
	});

	it("does not let upstream backticks close the metadata fence", () => {
		const out = levelChangePayload(
			{ ...base, alertLevel: "```\n@everyone", level: 4, prevLevel: 3 },
			{ now },
		);
		expect(out.match(/```/g)).toHaveLength(2);
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
		GUILD_BOT_ABSENT,
		SUBSCRIBE_COMMAND_DESCRIPTION,
		guildCannotPost("100000000000000001"),
		blockedNotice("100000000000000001", "Example Guild"),
		dmStatusReport({ subscribed: true, lastAlert: null, currentLevel: 1 }),
		guildStatusReport({
			channelId: "a",
			channels: [
				{ id: "a", canPost: false },
				{ id: "b", canPost: true },
			],
			lastAlert: null,
			currentLevel: 1,
		}),
		alertPayload({ title: "x", link: "y", pubDate: "z" }),
		heartbeatPayload(2),
		heartbeatPayload(null),
		levelPresenceName(null, null, ""),
		levelPresenceName(2, null, ""),
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

describe("heartbeatPayload", () => {
	it("includes the current level and source URL", () => {
		const out = heartbeatPayload(2);
		expect(out).toContain("STANDING BY.");
		expect(out).toContain("Current level: 2");
		expect(out).toContain("Nothing to report.");
		expect(out).toContain(`<${SOURCE_URL}>`);
	});

	it("renders unknown when level is null", () => {
		expect(heartbeatPayload(null)).toContain("Current level: unknown");
	});
});

describe("levelPresenceName", () => {
	const now = Date.parse("2026-01-01T12:00:00.000Z");
	const recent = "2026-01-01T11:45:00.000Z";
	const expired = "2026-01-01T11:00:00.000Z";
	const future = "2026-01-01T12:01:00.000Z";

	it("does not invent a level before the first observation", () => {
		expect(levelPresenceName(null, null, recent, now)).toContain("AWAITING DATA");
	});

	it("expires upstream data at one hour even when the last poll was recent", () => {
		const fresh = levelPresenceName(2, expired, recent, now - 1);
		expect(fresh).toContain("LEVEL 2");
		expect(fresh).not.toContain("STALE DATA");
		expect(levelPresenceName(2, expired, recent, now)).toContain("LEVEL 2 (STALE DATA)");
	});

	it.each([
		{ asOf: null, checkedAt: recent },
		{ asOf: "not-a-timestamp", checkedAt: recent },
		{ asOf: future, checkedAt: recent },
		{ asOf: recent, checkedAt: "not-a-timestamp" },
		{ asOf: recent, checkedAt: expired },
		{ asOf: recent, checkedAt: future },
	])("marks untrustworthy or expired timestamps as stale: %j", ({ asOf, checkedAt }) => {
		expect(levelPresenceName(2, asOf, checkedAt, now)).toContain("STALE DATA");
	});
});
