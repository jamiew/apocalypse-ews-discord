// Mission-agnostic Discord plumbing shared by every bot in this repo: free-text
// intent classification, mention stripping, welcome-channel selection, and the
// operator DM format. Nothing here knows what is being monitored.

import { ChannelType, type Snowflake } from "discord.js";

export type Intent<K extends string> = K | "other";

export function normalizeFreeText(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replaceAll("’", "'")
		.replace(/[^a-z0-9?'\s]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Earliest match wins; ties break toward the key declared first in `patterns`.
 * Declaration order is therefore priority order — put the destructive intents
 * ("unsubscribe") ahead of the permissive ones so "please unsubscribe me, yes"
 * doesn't resolve to `subscribe`.
 */
export function classifyWith<K extends string>(
	patterns: Readonly<Record<K, readonly RegExp[]>>,
	raw: string,
): Intent<K> {
	const text = normalizeFreeText(raw);
	if (!text) return "other";

	let best: { intent: K; index: number; priority: number } | null = null;
	const entries = Object.entries(patterns) as [K, readonly RegExp[]][];

	for (const [priority, [intent, candidates]] of entries.entries()) {
		for (const pattern of candidates) {
			const index = pattern.exec(text)?.index;
			if (index == null) continue;
			if (
				best == null ||
				index < best.index ||
				(index === best.index && priority < best.priority)
			) {
				best = { intent, index, priority };
			}
		}
	}

	return best?.intent ?? "other";
}

export type BaseIntent = "unsubscribe" | "subscribe" | "status" | "help";

export const BASE_INTENT_PATTERNS: Readonly<Record<BaseIntent, readonly RegExp[]>> = {
	unsubscribe: [
		/^unsubscribe$/,
		/^unsub$/,
		/^stop$/,
		/^cancel$/,
		/^quit$/,
		/^end$/,
		/^remove$/,
		/\bunsubscribe\b/,
		/\bunsub\b/,
		/\bopt out\b/,
		/\bstand down\b/,
		/\bremove me\b/,
	],
	subscribe: [
		/^subscribe$/,
		/^sub$/,
		/^start$/,
		/^yes$/,
		/^y$/,
		/\bsubscribe\b/,
		/\bopt in\b/,
		/\bsign me up\b/,
		/\badd me\b/,
	],
	status: [
		/^status$/,
		/^state$/,
		/^level$/,
		/\bstatus\b/,
		/\bstate\b/,
		/\bcurrent level\b/,
		/\bwhat(?:'s| is) (?:the |my )?status\b/,
		/\bwhat(?:'s| is) (?:the |my )?level\b/,
	],
	help: [
		/^\?$/,
		/^help$/,
		/^commands?$/,
		/^options?$/,
		/^info$/,
		/\bhelp\b/,
		/\bcommands?\b/,
		/\boptions?\b/,
		/\bwhat can you do\b/,
		/\bhow does this work\b/,
	],
};

export function stripMention(content: string, botUserId: Snowflake): string {
	return content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
}

export interface WelcomeChannelCandidate {
	id: Snowflake;
	type: ChannelType;
	position: number;
	canSend: boolean;
}

export function pickWelcomeChannelFrom(
	systemChannel: WelcomeChannelCandidate | null,
	channels: readonly WelcomeChannelCandidate[],
): WelcomeChannelCandidate | null {
	if (systemChannel?.canSend) return systemChannel;
	const sendable = channels
		.filter((c) => c.type === ChannelType.GuildText && c.canSend)
		.sort((a, b) => a.position - b.position);
	return sendable[0] ?? null;
}

export function classifyWelcomeError(err: unknown): "missing_access" | "other" {
	if (
		err != null &&
		typeof err === "object" &&
		"code" in err &&
		(err as { code?: unknown }).code === 50001
	) {
		return "missing_access";
	}
	return "other";
}

// Multi-line bullet format, readable in the operator's Discord DM client.
// Names are best-effort — IDs are always present, names appear when known.
export function formatOperatorDm(args: {
	header: string;
	guildId?: Snowflake | null | undefined;
	guildName?: string | undefined;
	channelId?: Snowflake | null | undefined;
	channelName?: string | undefined;
	userId?: Snowflake | undefined;
	userTag?: string | undefined;
	extras?: ReadonlyArray<{ label: string; value: string }>;
}): string {
	const lines = [args.header];
	if (args.guildId) {
		lines.push(`• guild: ${args.guildName ? `"${args.guildName}" ` : ""}(${args.guildId})`);
	}
	if (args.channelId) {
		lines.push(`• channel: ${args.channelName ? `#${args.channelName} ` : ""}(${args.channelId})`);
	}
	if (args.userId) {
		lines.push(`• user: ${args.userTag ? `${args.userTag} ` : ""}(${args.userId})`);
	}
	for (const e of args.extras ?? []) {
		lines.push(`• ${e.label}: ${e.value}`);
	}
	return lines.join("\n");
}
