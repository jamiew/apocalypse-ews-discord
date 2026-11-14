// Tone: deadpan, technical, no emojis, no exclamation points. Wryness from framing.

export const SOURCE_URL = "https://ews.kylemcdonald.net";
export const INSTALL_URL = "https://jamiew.github.io/apocalypse-ews-discord/";

export const GUILD_WELCOME = [
	"APOCALYPSE EWS ONLINE.",
	"",
	`Tracked-aircraft anomaly monitoring. Source: ${SOURCE_URL}`,
	"Every emergency-level change and level 5 incident is announced here.",
	"",
	"`/subscribe` `/unsubscribe` `/status` `/help`. Or @-mention with the same word.",
	"Uninstall: Server Settings → Integrations → Apocalypse EWS → Remove.",
	"",
	"Standing by.",
].join("\n");

export const GUILD_SUBSCRIBE_OK =
	"SUBSCRIBED. Emergency-level changes and level 5 incidents appear here. `/unsubscribe` to stand down.";

export const GUILD_ALREADY_SUBSCRIBED = "Already subscribed.";

export const GUILD_UNSUBSCRIBE_OK =
	"Unsubscribed. Full removal: Server Settings → Integrations → Apocalypse EWS → Remove.";

export const GUILD_NOT_SUBSCRIBED = "Not subscribed.";

// User-installed commands run in servers the bot never joined; it cannot post there.
export const GUILD_BOT_ABSENT = [
	"NOT DEPLOYED. The bot is not a member of this server and cannot post here.",
	`Add it to the server: <${INSTALL_URL}>`,
	"Or run `/subscribe` in a DM with the bot to receive alerts by DM.",
].join("\n");

export function guildCannotPost(channelId: string): string {
	return `CANNOT TRANSMIT. The bot needs View Channel and Send Messages in <#${channelId}>. Grant both, then run \`/subscribe\` again.`;
}

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
	`Emergency-level changes and level 5 incidents. Source: ${SOURCE_URL}`,
	"Reply `subscribe` to opt in, `unsubscribe` to stand down.",
].join("\n");

export const DM_SUBSCRIBE_OK =
	"SUBSCRIBED. Emergency-level changes and level 5 incidents inbound by DM. `unsubscribe` to stop.";

export const DM_ALREADY_SUBSCRIBED = "Already subscribed.";

export const DM_UNSUBSCRIBE_OK =
	"Unsubscribed. Block the bot in Discord to stop further DMs. Past records are not deleted.";

export const DM_NOT_SUBSCRIBED = "Not subscribed.";

export function heartbeatPayload(currentLevel: number | null): string {
	return [
		"STANDING BY.",
		"Apocalypse EWS operational. Tracked-aircraft anomaly monitoring nominal.",
		`Current level: ${formatLevel(currentLevel)}. Nothing to report.`,
		`<${SOURCE_URL}>`,
	].join("\n");
}

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

// Upstream text is untrusted. Bound each field so one oversized value can't push a
// message past Discord's 2000-character limit and fail every send for that alert.
const MAX_FIELD = 256;
const MAX_LINK = 512;

function clip(s: string, max = MAX_FIELD): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function alertPayload(item: AlertItem): string {
	return [
		"ATTENTION. EMERGENCY LEVEL 5.",
		clip(item.title),
		clip(item.pubDate),
		clip(item.link, MAX_LINK),
	]
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

// Values land inside a ```text fence; backticks would let upstream text close it early.
function levelField(label: string, value: string): string {
	return `${label.padEnd(14, ".")} ${clip(value).replaceAll("`", "'")}`;
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
	return last ? `${clip(last.pubDate)} — ${clip(last.title)}` : "none";
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
