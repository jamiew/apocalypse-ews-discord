// Turns one @PenPizzaReport post into a 1..5 signal level.
//
// The account posts prose, not numbers: "The closest Dominos to the Pentagon is
// reporting very high traffic. Freddies Beach Bar, the closest gay bar to the
// Pentagon, is reporting low traffic." The thesis it keeps restating is that
// busy pizza plus an empty bar means staff are working late — so we read a
// busyness score for each venue class and weight pizza against an inverted bar.
//
// This is a heuristic over someone else's wording. It is wrong sometimes, which
// is why every dispatch carries the verbatim post and a link to it.

export type SignalLevel = 1 | 2 | 3 | 4 | 5;

export type VenueClass = "pizza" | "bar";

/** Busyness, -3 (empty) .. +3 (slammed). Same scale for both venue classes. */
export type Busyness = -3 | -2 | -1 | 0 | 1 | 2 | 3;

export interface PizzaSignal {
	level: SignalLevel;
	/** Highest busyness seen at any pizzeria, or null when none was described. */
	pizza: Busyness | null;
	/** Lowest busyness seen at any bar, or null when none was described. */
	bar: Busyness | null;
	/** Weighted score behind `level`, -30..30. Surfaced for debugging. */
	score: number;
	/** False when no venue read at all — caller should not announce these. */
	readable: boolean;
}

// Ordered longest-first: alternation is tried left to right at each position,
// so "very high" must precede "high" and "above average" must precede "average".
// Each phrase is word-bounded at match time — without that, "low" fires inside
// "below" and every downgrade reads as a second, stronger downgrade.
const BUSYNESS_TERMS: ReadonlyArray<readonly [string, Busyness]> = [
	["essentially zero", -3],
	["abnormally low", -3],
	["unusually low", -3],
	["extremely low", -3],
	["substantially less", -3],
	["much less than usual", -3],
	["zero traffic", -3],
	["no traffic", -3],
	["very low", -3],
	["dead", -3],
	["empty", -3],
	["extremely high", 3],
	["much more than usual", 3],
	["much higher than usual", 3],
	["very high", 3],
	["surging", 3],
	["surged", 3],
	["surge", 3],
	["spiked", 3],
	["spike", 3],
	["slightly below average", -1],
	["below average", -1],
	["less traffic than usual", -1],
	["lower than usual", -1],
	["quieter than usual", -1],
	["slightly below", -1],
	["above average", 1],
	["higher than usual", 1],
	["busier than usual", 1],
	["more than usual", 1],
	["elevated", 1],
	["close to average", 0],
	["about average", 0],
	["average", 0],
	["normal", 0],
	["typical", 0],
	["high", 2],
	["low", -2],
];

// Venues carry hand-written patterns rather than plain terms: brand names need a
// loose tail ("domino", "dominos", "domino's") while the generic words need hard
// boundaries so "bar" does not fire inside "barely".
const VENUE_PATTERNS: ReadonlyArray<readonly [string, VenueClass]> = [
	// Bars first. "Freddie's Beach Bar" must resolve whole, before the bare "bar".
	["freddie'?s beach bar", "bar"],
	["freddie'?s", "bar"],
	["gay bar", "bar"],
	["sports bar", "bar"],
	["sports pub", "bar"],
	["nightlife", "bar"],
	["\\bbars?\\b", "bar"],
	["\\bpubs?\\b", "bar"],
	["district pizza palace", "pizza"],
	["extreme pizza", "pizza"],
	["wiseguy pizza", "pizza"],
	["pizzato pizza", "pizza"],
	["we the pizza", "pizza"],
	["papa john'?s?", "pizza"],
	["domino'?s?", "pizza"],
	["pizzerias?", "pizza"],
	["\\bpizzas?\\b", "pizza"],
];

function escapeTerm(term: string): string {
	return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const BUSYNESS_RE = new RegExp(
	BUSYNESS_TERMS.map(([t]) => `\\b${escapeTerm(t)}\\b`).join("|"),
	"g",
);
const VENUE_RE = new RegExp(VENUE_PATTERNS.map(([p]) => `(${p})`).join("|"), "g");

const BUSYNESS_BY_TERM = new Map<string, Busyness>(BUSYNESS_TERMS);
// Which capture group fired tells us the venue class, so overlapping spellings
// ("dominos" vs "domino's") do not each need their own map entry.
const VENUE_CLASS_BY_GROUP: readonly VenueClass[] = VENUE_PATTERNS.map(([, c]) => c);

export function normalizePostText(raw: string): string {
	return raw
		.toLowerCase()
		.replaceAll("’", "'")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

interface BusynessHit {
	index: number;
	value: Busyness;
}

interface VenueHit {
	index: number;
	venue: VenueClass;
}

function scanBusyness(text: string): BusynessHit[] {
	const hits: BusynessHit[] = [];
	BUSYNESS_RE.lastIndex = 0;
	let match = BUSYNESS_RE.exec(text);
	while (match !== null) {
		const value = BUSYNESS_BY_TERM.get(match[0]);
		if (value !== undefined) hits.push({ index: match.index, value });
		match = BUSYNESS_RE.exec(text);
	}
	return hits;
}

function scanVenues(text: string): VenueHit[] {
	const hits: VenueHit[] = [];
	VENUE_RE.lastIndex = 0;
	let match = VENUE_RE.exec(text);
	while (match !== null) {
		const group = match.findIndex((g, i) => i > 0 && g !== undefined);
		const venue = group > 0 ? VENUE_CLASS_BY_GROUP[group - 1] : undefined;
		if (venue !== undefined) hits.push({ index: match.index, venue });
		match = VENUE_RE.exec(text);
	}
	return hits;
}

/**
 * Attribute a busyness phrase to the venue it describes: the nearest venue
 * mentioned before it, falling back to the nearest one after. "Dominos being
 * high and the bar being low" resolves both ways round correctly, and so does a
 * leading phrase like "HIGH activity ... at the closest Papa Johns".
 */
function nearestVenue(venues: readonly VenueHit[], at: number): VenueClass | null {
	let before: VenueHit | null = null;
	let after: VenueHit | null = null;
	for (const v of venues) {
		if (v.index < at) {
			if (before == null || v.index > before.index) before = v;
		} else if (after == null || v.index < after.index) {
			after = v;
		}
	}
	return (before ?? after)?.venue ?? null;
}

const PIZZA_WEIGHT = 7;
const BAR_WEIGHT = 3;

// Score bands, tuned against the account's own posts. A busy pizzeria alone
// tops out at level 4; reaching 5 needs the pizza-up-bar-down pairing the
// account itself calls the classic indicator.
const BANDS: ReadonlyArray<readonly [number, SignalLevel]> = [
	[22, 5],
	[13, 4],
	[6, 3],
	[-5, 2],
];

export function levelForScore(score: number): SignalLevel {
	for (const [floor, level] of BANDS) {
		if (score >= floor) return level;
	}
	return 1;
}

export function classifyPost(raw: string): PizzaSignal {
	const text = normalizePostText(raw);
	const venues = scanVenues(text);
	const busyness = scanBusyness(text);

	let pizza: Busyness | null = null;
	let bar: Busyness | null = null;

	for (const { index, value } of busyness) {
		const venue = nearestVenue(venues, index);
		if (venue === "pizza") {
			// Busiest pizzeria wins: the account flags the outlier, not the mean.
			pizza = pizza == null || value > pizza ? value : pizza;
		} else if (venue === "bar") {
			// Emptiest bar wins, for the same reason inverted.
			bar = bar == null || value < bar ? value : bar;
		}
	}

	const score = (pizza ?? 0) * PIZZA_WEIGHT + (bar == null ? 0 : -bar * BAR_WEIGHT);
	return {
		level: levelForScore(score),
		pizza,
		bar,
		score,
		readable: pizza != null || bar != null,
	};
}

/**
 * Posts that should never reach the classifier: retweets, and replies aimed at
 * other accounts. Self-threaded "Update: ..." posts are kept — they carry fresh
 * readings and reply to the account's own earlier post.
 */
export function isReportablePost(post: {
	text: string;
	isRetweet?: boolean | null;
	replyToUsername?: string | null;
	authorUsername?: string | null;
}): boolean {
	if (post.isRetweet === true) return false;
	if (post.text.trim().startsWith("@")) return false;
	const replyTo = post.replyToUsername?.toLowerCase();
	const author = post.authorUsername?.toLowerCase();
	if (replyTo && replyTo !== author) return false;
	return true;
}
