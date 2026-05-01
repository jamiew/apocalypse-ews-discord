// All user-facing strings. Tone: deadpan, technical, no emojis, no exclamation
// points. Wryness comes from the framing, never from the prose.

export const SOURCE_URL = "https://ews.kylemcdonald.net";

export const GUILD_WELCOME = [
	"Apocalypse Early Warning System.",
	`Automatic alerts when the system reaches emergency level 5 — unusual private-jet activity over a rolling 24-hour window. Source: ${SOURCE_URL}`,
	"Run `/subscribe` in the channel that should receive alerts. `/unsubscribe` to stop. `/help` for everything else.",
	"To remove this bot entirely: Server Settings → Integrations → Apocalypse EWS → Remove.",
].join("\n");

export const GUILD_SUBSCRIBE_OK =
	"Subscribed. This channel will receive a message if the system reaches emergency level 5. Run `/unsubscribe` to stop.";

export const GUILD_ALREADY_SUBSCRIBED = "This channel is already subscribed.";

export const GUILD_UNSUBSCRIBE_OK =
	"Unsubscribed. To remove the bot from this server entirely: Server Settings → Integrations → Apocalypse EWS → Remove.";

export const GUILD_NOT_SUBSCRIBED = "This channel is not subscribed.";

export const HELP = [
	"Apocalypse Early Warning System.",
	`Automatic alerts when the system reaches emergency level 5. Source: ${SOURCE_URL}`,
	"",
	"Commands:",
	"`/subscribe [channel]` — receive alerts in the chosen channel (defaults to current).",
	"`/unsubscribe` — stop alerts in this channel.",
	"`/status` — show subscription state and the last alert on record.",
	"`/help` — this message.",
	"",
	"To remove this bot entirely: Server Settings → Integrations → Apocalypse EWS → Remove.",
].join("\n");

export const DM_OPT_IN_PROMPT = [
	"Apocalypse Early Warning System.",
	`Automatic alerts when the system reaches emergency level 5 — unusual private-jet activity over a rolling 24-hour window. Source: ${SOURCE_URL}`,
	"Reply `subscribe` to receive a direct message if that happens. Reply `unsubscribe` at any time to stop.",
].join("\n");

export const DM_SUBSCRIBE_OK =
	"Subscribed. You will receive a direct message if the system reaches emergency level 5. Reply `unsubscribe` to stop.";

export const DM_ALREADY_SUBSCRIBED = "Already subscribed. Reply `unsubscribe` to stop.";

export const DM_UNSUBSCRIBE_OK =
	"Unsubscribed. You can also block this bot or remove it from your DMs from your Discord privacy settings.";

export const DM_NOT_SUBSCRIBED = "Not subscribed.";

export const ANNUAL_REMINDER =
	"A year on, you are still subscribed to the Apocalypse Early Warning System. Nothing has ended. Go enjoy your life. Reply `unsubscribe` to stop receiving these.";

export interface AlertItem {
	title: string;
	link: string;
	pubDate: string;
}

export type LastAlert = { title: string; pubDate: string } | null;

export function alertPayload(item: AlertItem): string {
	return [
		"Apocalypse Early Warning System — emergency level 5.",
		item.title,
		item.pubDate,
		item.link,
	]
		.filter(Boolean)
		.join("\n");
}

function formatLastAlert(last: LastAlert): string {
	return last ? `${last.pubDate} — ${last.title}` : "none on record";
}

export function statusLine(args: { subscribed: boolean; lastAlert: LastAlert }): string {
	const sub = args.subscribed ? "Subscribed" : "Not subscribed";
	return `${sub}. Last alert: ${formatLastAlert(args.lastAlert)}.`;
}

export function pingPongLine(args: { subscribed: boolean; lastAlert: LastAlert }): string {
	const sub = args.subscribed ? "subscribed" : "not subscribed";
	return `Still here. Last alert: ${formatLastAlert(args.lastAlert)}. Status: ${sub}.`;
}
