import { describe, expect, it } from "bun:test";
import {
	classifyPost,
	isReportablePost,
	levelForScore,
	normalizePostText,
	type SignalLevel,
} from "./signal.js";

/**
 * The corpus below is verbatim @PenPizzaReport output, pulled from the account
 * in Sep 2026. Tuning the bands against paraphrases would prove nothing — the
 * classifier only has to survive the wording the account actually uses.
 */
const REAL_POSTS = {
	dominosVeryHighBarLow:
		"The closest Dominos to the Pentagon is reporting very high traffic.\n\nFreddies Beach Bar, the closest gay bar to the Pentagon, is reporting low traffic.\n\nAs of 5:25pm ET https://t.co/XJcgEtH8Mp",
	wiseguyHighBarBelow:
		"The Wiseguy Pizza, across from the Pentagon, is reporting high traffic. \n\nFreddie's Beach Bar, the closest gay bar to the Pentagon, is reporting below average traffic. \n\nAs of 5:15pm ET",
	mostlyBelowTwoAbove:
		"Nearly every pizzeria nearby the Pentagon is reporting below average traffic.\n\nExcept for the 2nd closest Dominos and District Pizza Palace, which both report above average traffic.\n\nNothing seems to be close to average atm.\n\nAs of 3:50pm ET",
	barVeryLowOnly:
		"Freddies Beach Bar, the closest gay bar to the Pentagon, continues to report very low traffic.\n\nAs of 7:32pm ET",
	twoAboveBarBelow:
		"Extreme Pizza and District Pizza Palace, both pizzerias located nearby the Pentagon, are reporting above average traffic.\n\nFreddie's Beach Bar, the closest gay bar to the Pentagon, is reporting below average traffic.\n\nAs of 5:45pm ET",
	severalAboveBarVeryLow:
		"Several pizzerias nearby the Pentagon, including the closest Dominos, are reporting above average / high traffic.\n\nFreddies Beach Bar, the closest gay bar to the Pentagon, is reporting very low traffic.\n\nAs of 9:28pm ET",
	papaAndDominosVeryHigh:
		"The closest Papa Johns and closest Dominos to the Pentagon are both reporting very high traffic, much more than usual.\n\nAs of 12:47pm ET",
	papaJohnsHighBarAbnormallyLow:
		"HIGH activity is being reported at the closest Papa Johns to the Pentagon. Freddies Beach Bar is reporting abnormally low activity levels for a Saturday at 7:11pm ET. Classic indicator for potential overtime at the Pentagon.",
	barZeroDominosAbove:
		"Freddie's Beach Bar is currently reported as having essentially zero traffic, abnormally low for a Sunday evening at 10:35pm ET The Dominos closest to the Pentagon is reported as having above average levels of activity. This indicates a potentially busy night at the Pentagon.",
	classicIndicatorSentence:
		"The closest gay bar to the Pentagon, Freddie's Beach Bar, is currently reporting below average activity. Dominos being high and the bar being low is the classic indicator that something is indeed afoot at the Pentagon.",
	surgeAllPizzerias:
		"SURGE in pizza traffic across nearly all pizzerias nearby the Pentagon.\n\nAs of 2:24pm ET",
	lateNightSurge:
		"Pizzato Pizza, a late night pizzeria nearby the Pentagon, has suddenly surged in traffic.\n\nAs of 2:04am ET",
	replyToAnotherAccount:
		"@AutismCapital Freddies is about average at the moment, but the nearby sports bar has substantially less traffic than usual. As of 7:20pm ET",
} as const;

const level = (text: string): SignalLevel => classifyPost(text).level;

describe("classifyPost", () => {
	it("reads both venue classes out of one post", () => {
		const signal = classifyPost(REAL_POSTS.dominosVeryHighBarLow);
		expect(signal.pizza).toBe(3);
		expect(signal.bar).toBe(-2);
		expect(signal.readable).toBe(true);
	});

	it("rates very high pizza against a low bar as the top level", () => {
		expect(level(REAL_POSTS.dominosVeryHighBarLow)).toBe(5);
	});

	it("rates high pizza against an abnormally quiet bar as the top level", () => {
		// The account calls this pairing the classic indicator in the post itself.
		expect(level(REAL_POSTS.papaJohnsHighBarAbnormallyLow)).toBe(5);
	});

	it("rates several busy pizzerias against an empty bar as the top level", () => {
		expect(level(REAL_POSTS.severalAboveBarVeryLow)).toBe(5);
	});

	it("holds busy pizza with no bar reading below the top level", () => {
		// Half the indicator is not the indicator.
		const signal = classifyPost(REAL_POSTS.papaAndDominosVeryHigh);
		expect(signal.bar).toBeNull();
		expect(signal.level).toBe(4);
	});

	it("rates a surge with no bar reading as high", () => {
		expect(level(REAL_POSTS.surgeAllPizzerias)).toBe(4);
		expect(level(REAL_POSTS.lateNightSurge)).toBe(4);
	});

	it("rates high pizza with a mildly quiet bar as high", () => {
		expect(level(REAL_POSTS.wiseguyHighBarBelow)).toBe(4);
	});

	it("rates an empty bar against merely above-average pizza as high", () => {
		expect(level(REAL_POSTS.barZeroDominosAbove)).toBe(4);
	});

	it("rates above-average pizza with a mildly quiet bar as elevated", () => {
		expect(level(REAL_POSTS.twoAboveBarBelow)).toBe(3);
	});

	it("rates an empty bar on its own as elevated", () => {
		const signal = classifyPost(REAL_POSTS.barVeryLowOnly);
		expect(signal.pizza).toBeNull();
		expect(signal.bar).toBe(-3);
		expect(signal.level).toBe(3);
	});

	it("takes the busiest pizzeria when a post describes several at once", () => {
		// "nearly every pizzeria below average, except two above average" — the
		// account is flagging the outliers, so the outliers set the reading.
		const signal = classifyPost(REAL_POSTS.mostlyBelowTwoAbove);
		expect(signal.pizza).toBe(1);
		expect(signal.level).toBe(3);
	});

	it("attributes busyness to the venue named before it", () => {
		// "Dominos being high and the bar being low" — one clause, both venues.
		const signal = classifyPost(REAL_POSTS.classicIndicatorSentence);
		expect(signal.pizza).toBe(2);
		expect(signal.bar).toBe(-2);
	});

	it("attributes a leading busyness phrase to the venue named after it", () => {
		// "HIGH activity is being reported at the closest Papa Johns".
		expect(classifyPost(REAL_POSTS.papaJohnsHighBarAbnormallyLow).pizza).toBe(2);
	});

	it("does not read 'low' out of the word 'below'", () => {
		const signal = classifyPost("The closest Dominos is reporting below average traffic.");
		expect(signal.pizza).toBe(-1);
		expect(signal.level).toBe(1);
	});

	it("rates quiet pizzerias as quiet", () => {
		expect(level("Every pizzeria nearby the Pentagon is reporting below average traffic.")).toBe(1);
		expect(level("The closest Dominos to the Pentagon is reporting very low traffic.")).toBe(1);
	});

	it("rates a busy bar as quiet — everyone is out", () => {
		expect(level("Freddie's Beach Bar is reporting very high traffic.")).toBe(1);
	});

	it("rates an unremarkable post as nominal", () => {
		const signal = classifyPost("Pizza traffic near the Pentagon is about average.");
		expect(signal.pizza).toBe(0);
		expect(signal.level).toBe(2);
	});

	it("marks a post with no venue reading as unreadable", () => {
		const signal = classifyPost("Thanks for the follows. More updates soon.");
		expect(signal.readable).toBe(false);
		expect(signal.pizza).toBeNull();
		expect(signal.bar).toBeNull();
	});

	it("ignores trailing media links", () => {
		const withLink = classifyPost(`${REAL_POSTS.barVeryLowOnly} https://t.co/CR1gGAf4TD`);
		expect(withLink.level).toBe(classifyPost(REAL_POSTS.barVeryLowOnly).level);
	});

	it("handles the account's inconsistent apostrophes", () => {
		const bare = classifyPost("Freddies Beach Bar is reporting very low traffic.");
		const curly = classifyPost("Freddie’s Beach Bar is reporting very low traffic.");
		const straight = classifyPost("Freddie's Beach Bar is reporting very low traffic.");
		expect(bare.bar).toBe(-3);
		expect(curly.bar).toBe(-3);
		expect(straight.bar).toBe(-3);
	});
});

describe("levelForScore", () => {
	it.each([
		[30, 5],
		[22, 5],
		[21, 4],
		[13, 4],
		[12, 3],
		[6, 3],
		[5, 2],
		[-5, 2],
		[-6, 1],
		[-30, 1],
	] as const)("maps score %d to level %d", (score, expected) => {
		expect(levelForScore(score)).toBe(expected);
	});
});

describe("normalizePostText", () => {
	it("lowercases, strips urls, and collapses whitespace", () => {
		expect(normalizePostText("  HIGH   traffic.\n\nAs of 5pm https://t.co/abc  ")).toBe(
			"high traffic. as of 5pm",
		);
	});
});

describe("isReportablePost", () => {
	it("keeps a plain report", () => {
		expect(isReportablePost({ text: REAL_POSTS.dominosVeryHighBarLow })).toBe(true);
	});

	it("drops retweets", () => {
		expect(isReportablePost({ text: "anything", isRetweet: true })).toBe(false);
	});

	it("drops replies aimed at other accounts", () => {
		expect(isReportablePost({ text: REAL_POSTS.replyToAnotherAccount })).toBe(false);
		expect(
			isReportablePost({
				text: "Freddies is about average.",
				authorUsername: "PenPizzaReport",
				replyToUsername: "AutismCapital",
			}),
		).toBe(false);
	});

	it("keeps self-threaded updates", () => {
		expect(
			isReportablePost({
				text: "Update: The closest Papa Johns continues to report high traffic.",
				authorUsername: "PenPizzaReport",
				replyToUsername: "PenPizzaReport",
			}),
		).toBe(true);
	});
});
