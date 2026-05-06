// Tone: deadpan, technical, no emojis, no exclamation points. Wryness from framing.

export const SOURCE_URL = "https://ews.kylemcdonald.net";

export const GUILD_WELCOME = [
	"APOCALYPSE EWS ONLINE.",
	"",
	`Tracked-aircraft anomaly monitoring. Source: ${SOURCE_URL}`,
	"Emergency level 5 → announced here. Otherwise silent.",
	"",
	"`/subscribe` `/unsubscribe` `/status` `/help`. Or @-mention with the same word.",
	"Uninstall: Server Settings → Integrations → Apocalypse EWS → Remove.",
	"",
	"Standing by.",
].join("\n");

export const GUILD_SUBSCRIBE_OK =
	"SUBSCRIBED. This channel receives level 5 alerts. `/unsubscribe` to stand down.";

export const GUILD_ALREADY_SUBSCRIBED = "Already subscribed.";

export const GUILD_UNSUBSCRIBE_OK =
	"Unsubscribed. Full removal: Server Settings → Integrations → Apocalypse EWS → Remove.";

export const GUILD_NOT_SUBSCRIBED = "Not subscribed.";

export const HELP = [
	`APOCALYPSE EWS. Source: ${SOURCE_URL}`,
	"",
	"`/subscribe [channel]` `/unsubscribe` `/status` `/help`",
	"Or @-mention with `subscribe` / `unsubscribe` / `status` / `help`.",
	"In DM: send the same words. No slash needed.",
	"",
	"Uninstall: Server Settings → Integrations → Apocalypse EWS → Remove.",
].join("\n");

export const DM_OPT_IN_PROMPT = [
	"APOCALYPSE EWS.",
	`Level 5 alerts only — rare. Source: ${SOURCE_URL}`,
	"Reply `subscribe` to opt in, `unsubscribe` to stand down.",
].join("\n");

export const DM_SUBSCRIBE_OK = "SUBSCRIBED. Level 5 alerts inbound by DM. `unsubscribe` to stop.";

export const DM_ALREADY_SUBSCRIBED = "Already subscribed.";

export const DM_UNSUBSCRIBE_OK =
	"Unsubscribed. Block or remove the bot from Discord privacy settings if you want it gone entirely.";

export const DM_NOT_SUBSCRIBED = "Not subscribed.";

export const ANNUAL_REMINDER =
	"One year on. You are still subscribed to the Apocalypse EWS. Nothing has ended. Go outside. Reply `unsubscribe` to stop these.";

export interface AlertItem {
	title: string;
	link: string;
	pubDate: string;
}

export type LastAlert = { title: string; pubDate: string } | null;

export const MENTION_UNKNOWN =
	"COMMAND NOT RECOGNIZED. Valid: `subscribe`, `unsubscribe`, `status`, `help`.";

export const MENTION_INSUFFICIENT_PRIVILEGES =
	"INSUFFICIENT PRIVILEGES. `subscribe` and `unsubscribe` require ManageGuild on this server.";

export function alertPayload(item: AlertItem): string {
	return ["ATTENTION. EMERGENCY LEVEL 5.", item.title, item.pubDate, item.link]
		.filter(Boolean)
		.join("\n");
}

export interface LevelChange {
	level: number;
	prevLevel: number | null;
	alertLevel: string | null;
	asOf: string | null;
	zScore: number | null;
}

function levelHeader(level: number, rising: boolean): string {
	if (!rising) return "";
	switch (level) {
		case 5:
			return "ATTENTION: LEVEL 5";
		case 4:
			return "WARNING: LEVEL 4";
		case 3:
			return "ELEVATED: LEVEL 3";
		case 2:
			return "NOTICE: LEVEL 2";
		default:
			return `STATUS: LEVEL ${level}`;
	}
}

function levelEmoji(level: number, rising: boolean): string {
	if (!rising) return level === 1 ? "✅" : "↘️";
	switch (level) {
		case 5:
			return "🚨";
		case 4:
			return "🔴";
		case 3:
			return "🟠";
		case 2:
			return "🟡";
		default:
			return "🟢";
	}
}

function levelBanner(level: number, rising: boolean): string {
	const emoji = levelEmoji(level, rising);
	return rising
		? `${emoji} APOCALYPSE EWS // ALERT LEVEL INCREASE`
		: `${emoji} apocalypse ews // alert level downgraded`;
}

function levelField(label: string, value: string): string {
	return `${label.padEnd(14, ".")} ${value}`;
}

function formatRelativeUnit(value: number, unit: Intl.RelativeTimeFormatUnit): string {
	return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(value, unit);
}

function formatRelativeAge(asOf: string, now: Date): string {
	const then = new Date(asOf);
	if (Number.isNaN(then.getTime())) return "unknown";

	const diffMs = then.getTime() - now.getTime();
	const absMs = Math.abs(diffMs);
	if (absMs < 45_000) return "just now";

	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	const week = 7 * day;
	const month = 30 * day;
	const year = 365 * day;

	if (absMs < 45 * minute) return formatRelativeUnit(Math.round(diffMs / minute), "minute");
	if (absMs < 36 * hour) return formatRelativeUnit(Math.round(diffMs / hour), "hour");
	if (absMs < 10 * day) return formatRelativeUnit(Math.round(diffMs / day), "day");
	if (absMs < 8 * week) return formatRelativeUnit(Math.round(diffMs / week), "week");
	if (absMs < 18 * month) return formatRelativeUnit(Math.round(diffMs / month), "month");
	return formatRelativeUnit(Math.round(diffMs / year), "year");
}

export function levelChangePayload(c: LevelChange, opts?: { now?: Date }): string {
	const rising = c.prevLevel == null || c.level > c.prevLevel;
	const now = opts?.now ?? new Date();
	const summary = `Level ${c.prevLevel ?? "unknown"} -> level ${c.level}.`;
	const infoLines = [
		c.alertLevel ? levelField("LABEL", c.alertLevel) : null,
		c.zScore != null ? levelField("Z", c.zScore.toFixed(2)) : null,
		c.asOf ? levelField("TIMESTAMP", c.asOf) : null,
		c.asOf ? levelField("AGE", formatRelativeAge(c.asOf, now)) : null,
	].filter(Boolean);

	return [
		levelBanner(c.level, rising),
		rising ? levelHeader(c.level, rising) : null,
		summary,
		infoLines.length > 0 ? ["```text", ...infoLines, "```"].join("\n") : null,
		`<${SOURCE_URL}>`,
	]
		.filter(Boolean)
		.join("\n");
}

function formatLastAlert(last: LastAlert): string {
	return last ? `${last.pubDate} — ${last.title}` : "none";
}

function formatLevel(level: number | null): string {
	return level == null ? "unknown" : String(level);
}

export function statusLine(args: {
	subscribed: boolean;
	lastAlert: LastAlert;
	currentLevel: number | null;
}): string {
	return `${args.subscribed ? "SUBSCRIBED" : "NOT SUBSCRIBED"}. Level: ${formatLevel(args.currentLevel)}. Last level 5 alert: ${formatLastAlert(args.lastAlert)}.`;
}

export function pingPongLine(args: {
	subscribed: boolean;
	lastAlert: LastAlert;
	currentLevel: number | null;
}): string {
	return `Still here. Level: ${formatLevel(args.currentLevel)}. Last level 5 alert: ${formatLastAlert(args.lastAlert)}. Status: ${args.subscribed ? "subscribed" : "not subscribed"}.`;
}
