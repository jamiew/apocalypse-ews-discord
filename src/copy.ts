// All user-facing strings. Tone: deadpan, technical, no emojis, no exclamation
// points. Wryness comes from the framing, never from the prose.

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

/** Snapshot of an upstream emergency-level transition. */
export interface LevelChange {
	level: number; // 1..5 (new value)
	prevLevel: number | null; // 1..5 or null if never observed
	alertLevel: string | null; // upstream's text label, e.g. "elevated", "alarm"
	asOf: string | null;
	zScore: number | null;
}

/**
 * Header for a level transition. Increasing urgency as the level rises;
 * "Stand-down" when it falls. The DEFCON-style alarm header is reserved
 * for level 5 — same string the RSS-driven {@link alertPayload} uses, so
 * the level-poller and the RSS poller don't say different things on the
 * same event.
 */
function levelHeader(level: number, rising: boolean): string {
	if (!rising) return `Stand-down. Emergency level returned to ${level}.`;
	switch (level) {
		case 5:
			return "ATTENTION. EMERGENCY LEVEL 5.";
		case 4:
			return "WARNING. Emergency level 4.";
		case 3:
			return "ELEVATED. Emergency level 3.";
		case 2:
			return "Notice. Emergency level 2.";
		default:
			return `Status. Emergency level ${level}.`;
	}
}

/** One-shot Discord-message body for a level transition. */
export function levelChangePayload(c: LevelChange): string {
	const rising = c.prevLevel == null || c.level > c.prevLevel;
	const fromTo =
		c.prevLevel == null
			? `New observation: level ${c.level}.`
			: `Was ${c.prevLevel}, now ${c.level}.`;
	const tail = [
		c.alertLevel ? `label: ${c.alertLevel}` : null,
		c.zScore != null ? `z=${c.zScore.toFixed(2)}` : null,
		c.asOf ? `as of ${c.asOf}` : null,
	].filter(Boolean);
	return [
		levelHeader(c.level, rising),
		fromTo,
		tail.length > 0 ? tail.join(" · ") : null,
		SOURCE_URL,
	]
		.filter(Boolean)
		.join("\n");
}

function formatLastAlert(last: LastAlert): string {
	return last ? `${last.pubDate} — ${last.title}` : "none";
}

export function statusLine(args: { subscribed: boolean; lastAlert: LastAlert }): string {
	return `${args.subscribed ? "SUBSCRIBED" : "NOT SUBSCRIBED"}. Last: ${formatLastAlert(args.lastAlert)}.`;
}

export function pingPongLine(args: { subscribed: boolean; lastAlert: LastAlert }): string {
	return `Still here. Last: ${formatLastAlert(args.lastAlert)}. Status: ${args.subscribed ? "subscribed" : "not subscribed"}.`;
}
