import { type APIEmbed, type APIEmbedField, escapeMarkdown } from "discord.js";

// Operator webhook embeds. `details` arrive redacted and stringified by webhooks.ts; anything
// that came from Discord or upstream is untrusted text and goes through escapeMarkdown.
// Layouts are keyed by log message, so renaming a log line falls back to the generic layout.

type Details = Readonly<Record<string, string>>;

interface Layout {
	title: string;
	description?: string | undefined;
	color?: number | undefined;
	fields?: ReadonlyArray<APIEmbedField | null>;
}

const LEVEL_COLORS: Readonly<Record<string, number>> = {
	debug: 0x747f8d,
	info: 0x3498db,
	warn: 0xf1c40f,
	error: 0xe74c3c,
};
const BLUE = 0x3498db;
const GRAY = 0x747f8d;
const GREEN = 0x2ecc71;
const ORANGE = 0xe67e22;
// Emergency levels 1..5, calm to severe.
const EMERGENCY_COLORS = [0x2ecc71, 0xf1c40f, 0xe67e22, 0xe74c3c, 0x992d22];

const PRUNE_LABELS: Record<string, string> = {
	not_in_guild: "Bot not in server",
	unknown_channel: "Channel deleted",
	unknown_user: "User deleted",
	no_mutual_guild: "No shared server",
};

// Discord embed limits.
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 4096;
const MAX_FIELDS = 25;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
export const MAX_EMBED_CHARS = 6000;

function clip(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function field(name: string, value: string | undefined, inline = true): APIEmbedField | null {
	if (value === undefined || value === "") return null;
	return { name: clip(name, MAX_FIELD_NAME), value: clip(value, MAX_FIELD_VALUE), inline };
}

function count(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n.toLocaleString("en-US") : escapeMarkdown(value);
}

function idCode(id: string | undefined): string | undefined {
	return id === undefined ? undefined : `\`${id.replaceAll("`", "")}\``;
}

function who(tag: string | undefined, id: string | undefined): string | undefined {
	if (tag === undefined) return idCode(id);
	return id === undefined ? escapeMarkdown(tag) : `${escapeMarkdown(tag)} ${idCode(id)}`;
}

function discordTime(iso: string | undefined, style: "D" | "R"): string | undefined {
	const ms = iso === undefined ? Number.NaN : Date.parse(iso);
	return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:${style}>` : undefined;
}

function duration(msText: string | undefined): string | undefined {
	const ms = Number(msText);
	if (msText === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
	const days = Math.floor(ms / 86_400_000);
	if (days >= 1) return `${days.toLocaleString("en-US")} day${days === 1 ? "" : "s"}`;
	const hours = Math.floor(ms / 3_600_000);
	if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"}`;
	return `${Math.max(1, Math.floor(ms / 60_000))} min`;
}

function codeBlock(text: string): string {
	return `\`\`\`\n${clip(text.replaceAll("```", "'''"), MAX_FIELD_VALUE)}\n\`\`\``;
}

// Only plain https URLs become links; anything else renders as escaped text.
function link(text: string, url: string | undefined): string {
	if (url === undefined || !/^https:\/\/[^\s()<>]+$/.test(url)) return escapeMarkdown(text);
	return `[${escapeMarkdown(text)}](${url})`;
}

function percentFailed(sent: string | undefined, failed: string | undefined): string | undefined {
	const s = Number(sent);
	const f = Number(failed);
	if (!Number.isFinite(s) || !Number.isFinite(f) || s + f === 0) return count(failed);
	return `${f.toLocaleString("en-US")} (${Math.round((f / (s + f)) * 100)}%)`;
}

function deliveryFields(d: Details): Array<APIEmbedField | null> {
	return [
		field("Delivered", count(d["sent"])),
		field("Failed", percentFailed(d["sent"], d["failed"])),
	];
}

function label(key: string): string {
	return key
		.replace(/^guild/, "server")
		.replace(/^err$/, "error")
		.replace(/Tag$/, "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/_/g, " ")
		.toLowerCase()
		.replace(/\bid\b/gi, "ID")
		.replace(/\bdm\b/gi, "DM")
		.replace(/^./, (letter) => letter.toUpperCase());
}

const layouts: Record<string, (d: Details) => Layout> = {
	"guild install": (d) => ({
		title: "SERVER INSTALLED",
		color: GREEN,
		description: [
			d["name"] === undefined ? undefined : `**${escapeMarkdown(d["name"])}**`,
			d["description"] === undefined ? undefined : escapeMarkdown(d["description"]),
		]
			.filter((line) => line !== undefined)
			.join("\n"),
		fields: [
			field("Members", count(d["memberCount"])),
			field("Channels", count(d["channelCount"])),
			field("Locale", d["preferredLocale"] && escapeMarkdown(d["preferredLocale"])),
			field("Owner", who(d["ownerTag"], d["ownerId"])),
			field("Installed by", who(d["installedByTag"], d["installedById"])),
			field("Server created", discordTime(d["guildCreatedAt"], "D")),
			field("Boost tier", d["premiumTier"] === "0" ? undefined : count(d["premiumTier"])),
			field(
				"Features",
				d["features"] === undefined || d["features"] === "None"
					? undefined
					: escapeMarkdown(d["features"]),
				false,
			),
			field("Server ID", idCode(d["guildId"])),
		],
	}),
	"guild remove": (d) => ({
		title: "SERVER REMOVED",
		color: ORANGE,
		description: d["name"] === undefined ? undefined : `**${escapeMarkdown(d["name"])}**`,
		fields: [
			field("Members", count(d["memberCount"])),
			field("Installed for", duration(d["tenureMs"])),
			field("Subscriptions pruned", count(d["prunedSubscriptions"])),
			field("Server ID", idCode(d["guildId"])),
		],
	}),
	"level dispatched": (d) => {
		const level = Number(d["level"]);
		const prev = d["prevLevel"];
		const direction = prev !== undefined && level < Number(prev) ? "fell" : "rose";
		return {
			title: prev === undefined ? `LEVEL ${d["level"]}` : `LEVEL ${prev} → ${d["level"]}`,
			color: EMERGENCY_COLORS[level - 1] ?? BLUE,
			description:
				prev === undefined
					? undefined
					: `Emergency level ${direction} from ${prev} to ${d["level"]}.`,
			fields: deliveryFields(d),
		};
	},
	"alert dispatched": (d) => ({
		title: "LEVEL 5 ALERT DISPATCHED",
		color: EMERGENCY_COLORS[4],
		description: link(d["title"] ?? "Untitled alert", d["link"]),
		fields: deliveryFields(d),
	}),
	started: (d) => ({
		title: "ONLINE",
		color: GREEN,
		fields: [
			field("Poll schedule", d["poll"] && `\`${d["poll"]}\``),
			field("Sources", `${link("RSS feed", d["rss"])} · ${link("Dashboard", d["dashboard"])}`),
		],
	}),
	"shutting down": (d) => ({
		title: "SHUTTING DOWN",
		color: GRAY,
		fields: [field("Signal", d["signal"] && escapeMarkdown(d["signal"]))],
	}),
	"subscriptions audited": (d) => {
		const reachable = Number(d["reachable"]);
		const total = reachable + Number(d["cannotPost"]) + Number(d["unverified"]);
		return {
			title: "SUBSCRIPTION AUDIT",
			description: Number.isFinite(total)
				? `**${count(d["reachable"])}** of ${count(String(total))} subscribed channels can receive alerts.`
				: undefined,
			fields: [
				field("Servers", count(d["guilds"])),
				field("Cannot post", count(d["cannotPost"])),
				field("Unverified", count(d["unverified"])),
				field("DM subscribers", count(d["dm"])),
			],
		};
	},
	"dead subscriptions pruned": (d) => ({
		title: "SUBSCRIPTIONS PRUNED",
		color: ORANGE,
		description: `Removed ${count(d["count"])} subscriptions that can never deliver (${escapeMarkdown(d["source"] ?? "unknown")}).`,
		fields: Object.entries(PRUNE_LABELS).map(([key, name]) => field(name, count(d[key]))),
	}),
};

function genericLayout(event: string, d: Details): Layout {
	const { err, ...rest } = d;
	return {
		title: event.replace(/[\r\n]/g, " ").toUpperCase(),
		description: err === undefined ? undefined : codeBlock(err),
		fields: Object.entries(rest).map(([key, value]) =>
			field(label(key), escapeMarkdown(value), value.length <= 48),
		),
	};
}

export function embedSize(embed: APIEmbed): number {
	return (
		(embed.title?.length ?? 0) +
		(embed.description?.length ?? 0) +
		(embed.footer?.text.length ?? 0) +
		(embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
	);
}

export function webhookMessage(
	event: string,
	level: string,
	details: Details,
	timestamp: string,
	module: string,
): APIEmbed {
	const layout = layouts[event]?.(details) ?? genericLayout(event, details);
	const fields = (layout.fields ?? [])
		.filter((f): f is APIEmbedField => f !== null)
		.slice(0, MAX_FIELDS);
	const embed: APIEmbed = {
		title: clip(layout.title, MAX_TITLE),
		...(layout.description ? { description: clip(layout.description, MAX_DESCRIPTION) } : {}),
		color: layout.color ?? LEVEL_COLORS[level] ?? BLUE,
		fields,
		footer: { text: `${level.toUpperCase()} · ${clip(module, 64)}` },
		timestamp,
	};
	while (embedSize(embed) > MAX_EMBED_CHARS && fields.length > 0) fields.pop();
	if (embedSize(embed) > MAX_EMBED_CHARS && embed.description) {
		embed.description = clip(
			embed.description,
			MAX_EMBED_CHARS - embedSize({ ...embed, description: "" }),
		);
	}
	return embed;
}
