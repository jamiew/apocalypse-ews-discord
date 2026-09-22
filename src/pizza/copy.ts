// Tone: deadpan, technical, no emojis, no exclamation points. Same register as
// the EWS bot — the joke lands because the console plays it straight.

import type { Busyness, SignalLevel } from "./signal.js";

export const ACCOUNT = "PenPizzaReport";
export const SOURCE_URL = `https://x.com/${ACCOUNT}`;

export function postUrl(postId: string): string {
	return `${SOURCE_URL}/status/${postId}`;
}

export const LEVEL_NAMES: Readonly<Record<SignalLevel, string>> = {
	1: "QUIET",
	2: "NOMINAL",
	3: "ELEVATED",
	4: "HIGH",
	5: "CLASSIC INDICATOR",
};

export const GUILD_WELCOME = [
	"PENTAGON PIZZA WATCH ONLINE.",
	"",
	`Pizza and bar traffic near the Pentagon, as reported by @${ACCOUNT}. Source: ${SOURCE_URL}`,
	"Signal level changes are announced here. Otherwise silent.",
	"",
	"`/subscribe` `/unsubscribe` `/status` `/latest` `/help`. Or @-mention with the same word.",
	"Uninstall: Server Settings → Integrations → Pentagon Pizza Watch → Remove.",
	"",
	"Standing by.",
].join("\n");

export const GUILD_SUBSCRIBE_OK =
	"SUBSCRIBED. This channel receives signal level changes. `/unsubscribe` to stand down.";

export const GUILD_ALREADY_SUBSCRIBED = "Already subscribed.";

export const GUILD_UNSUBSCRIBE_OK =
	"Unsubscribed. Full removal: Server Settings → Integrations → Pentagon Pizza Watch → Remove.";

export const GUILD_NOT_SUBSCRIBED = "Not subscribed.";

export const HELP = [
	`PENTAGON PIZZA WATCH. Source: ${SOURCE_URL}`,
	"",
	"`/subscribe [channel]` `/unsubscribe` `/status` `/latest` `/help`",
	"Or @-mention with `subscribe` / `unsubscribe` / `status` / `latest` / `help`.",
	"In DM: send the same words. No slash needed.",
	"",
	"Levels: 1 QUIET, 2 NOMINAL, 3 ELEVATED, 4 HIGH, 5 CLASSIC INDICATOR.",
	"Busy pizzerias plus an empty bar is the pairing the source account calls the classic indicator.",
	"",
	"Uninstall: Server Settings → Integrations → Pentagon Pizza Watch → Remove.",
].join("\n");

export const DM_OPT_IN_PROMPT = [
	"PENTAGON PIZZA WATCH.",
	`Signal level changes only. Source: ${SOURCE_URL}`,
	"Reply `subscribe` to opt in, `unsubscribe` to stand down.",
].join("\n");

export const DM_SUBSCRIBE_OK =
	"SUBSCRIBED. Signal level changes inbound by DM. `unsubscribe` to stop.";

export const DM_ALREADY_SUBSCRIBED = "Already subscribed.";

export const DM_UNSUBSCRIBE_OK =
	"Unsubscribed. Block or remove the bot from Discord privacy settings if you want it gone entirely.";

export const DM_NOT_SUBSCRIBED = "Not subscribed.";

export const NO_READING_YET = "No reading on record yet. The source account posts in bursts.";

export const MENTION_UNKNOWN =
	"COMMAND NOT RECOGNIZED. Valid: `subscribe`, `unsubscribe`, `status`, `latest`, `help`.";

export const MENTION_INSUFFICIENT_PRIVILEGES =
	"INSUFFICIENT PRIVILEGES. `subscribe` and `unsubscribe` require ManageGuild on this server.";

export const DISCLAIMER =
	"Derived from public foot-traffic estimates, not orders. The Pentagon has dismissed the theory. Treat accordingly.";

export function formatLevel(level: SignalLevel | null): string {
	return level == null ? "unknown" : `${level} ${LEVEL_NAMES[level]}`;
}

/** Reads a -3..3 busyness back as the kind of phrase the source account uses. */
export function describeBusyness(value: Busyness | null): string {
	if (value == null) return "no reading";
	switch (value) {
		case 3:
			return "very high";
		case 2:
			return "high";
		case 1:
			return "above average";
		case 0:
			return "average";
		case -1:
			return "below average";
		case -2:
			return "low";
		default:
			return "very low";
	}
}

function field(label: string, value: string): string {
	return `${label.padEnd(14, ".")} ${value}`;
}

function formatRelativeUnit(value: number, unit: Intl.RelativeTimeFormatUnit): string {
	return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(value, unit);
}

export function formatRelativeAge(postedAt: string, now: Date): string {
	const then = new Date(postedAt);
	if (Number.isNaN(then.getTime())) return "unknown";

	const diffMs = then.getTime() - now.getTime();
	const absMs = Math.abs(diffMs);
	if (absMs < 45_000) return "just now";

	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	const week = 7 * day;

	if (absMs < 45 * minute) return formatRelativeUnit(Math.round(diffMs / minute), "minute");
	if (absMs < 36 * hour) return formatRelativeUnit(Math.round(diffMs / hour), "hour");
	if (absMs < 10 * day) return formatRelativeUnit(Math.round(diffMs / day), "day");
	return formatRelativeUnit(Math.round(diffMs / week), "week");
}

const EXCERPT_LIMIT = 320;

/**
 * The level is a guess made by pattern-matching someone else's prose, so the
 * prose travels with it. Every dispatch quotes the post and links to it.
 */
export function quotePost(text: string): string {
	const trimmed = text.replace(/https?:\/\/\S+/g, "").trim();
	const excerpt =
		trimmed.length > EXCERPT_LIMIT ? `${trimmed.slice(0, EXCERPT_LIMIT - 1).trimEnd()}…` : trimmed;
	return excerpt
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => `> ${line.trim()}`)
		.join("\n");
}

export interface SignalChangeView {
	level: SignalLevel;
	prevLevel: SignalLevel | null;
	pizza: Busyness | null;
	bar: Busyness | null;
	postText: string;
	postedAt: string | null;
	url: string;
}

function banner(rising: boolean): string {
	return rising
		? "PENTAGON PIZZA WATCH // SIGNAL LEVEL INCREASE"
		: "pentagon pizza watch // signal level decrease";
}

function header(level: SignalLevel, rising: boolean): string | null {
	if (!rising) return null;
	switch (level) {
		case 5:
			return `ATTENTION: LEVEL 5 — ${LEVEL_NAMES[5]}.`;
		case 4:
			return `WARNING: LEVEL 4 — ${LEVEL_NAMES[4]}.`;
		case 3:
			return `NOTICE: LEVEL 3 — ${LEVEL_NAMES[3]}.`;
		default:
			return `STATUS: LEVEL ${level} — ${LEVEL_NAMES[level]}.`;
	}
}

export function signalChangePayload(view: SignalChangeView, opts?: { now?: Date }): string {
	const rising = view.prevLevel == null || view.level > view.prevLevel;
	const now = opts?.now ?? new Date();
	const fields = [
		field("PIZZA", describeBusyness(view.pizza)),
		field("BAR", describeBusyness(view.bar)),
		view.postedAt ? field("POSTED", view.postedAt) : null,
		view.postedAt ? field("AGE", formatRelativeAge(view.postedAt, now)) : null,
	].filter(Boolean);

	return [
		banner(rising),
		header(view.level, rising),
		`Level ${view.prevLevel == null ? "unknown" : LEVEL_NAMES[view.prevLevel]} -> level ${view.level} ${LEVEL_NAMES[view.level]}.`,
		["```text", ...fields, "```"].join("\n"),
		quotePost(view.postText),
		`<${view.url}>`,
	]
		.filter(Boolean)
		.join("\n");
}

export interface LatestView {
	level: SignalLevel;
	pizza: Busyness | null;
	bar: Busyness | null;
	postText: string;
	postedAt: string | null;
	url: string;
}

export function latestPayload(view: LatestView | null, opts?: { now?: Date }): string {
	if (!view) return NO_READING_YET;
	const now = opts?.now ?? new Date();
	const age = view.postedAt ? ` (${formatRelativeAge(view.postedAt, now)})` : "";
	return [
		`LAST READING: LEVEL ${formatLevel(view.level)}${age}.`,
		`Pizza: ${describeBusyness(view.pizza)}. Bar: ${describeBusyness(view.bar)}.`,
		quotePost(view.postText),
		`<${view.url}>`,
	].join("\n");
}

export function statusLine(args: {
	subscribed: boolean;
	level: SignalLevel | null;
	postedAt: string | null;
	now?: Date;
}): string {
	const age = args.postedAt
		? formatRelativeAge(args.postedAt, args.now ?? new Date())
		: "no reading yet";
	return `${args.subscribed ? "SUBSCRIBED" : "NOT SUBSCRIBED"}. Signal: ${formatLevel(args.level)}. Last reading: ${age}.`;
}

export function pingPongLine(args: {
	subscribed: boolean;
	level: SignalLevel | null;
	postedAt: string | null;
	now?: Date;
}): string {
	const age = args.postedAt
		? formatRelativeAge(args.postedAt, args.now ?? new Date())
		: "no reading yet";
	return `Still here. Signal: ${formatLevel(args.level)}. Last reading: ${age}. Status: ${args.subscribed ? "subscribed" : "not subscribed"}.`;
}
