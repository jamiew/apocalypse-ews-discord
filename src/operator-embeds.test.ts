import { describe, expect, it } from "bun:test";
import type { APIEmbed } from "discord.js";
import { embedSize, MAX_EMBED_CHARS, webhookMessage } from "./operator-embeds.js";

const TS = "2026-11-14T15:00:00.000Z";

function fieldMap(embed: APIEmbed): Record<string, string> {
	return Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
}

describe("webhookMessage", () => {
	it("lays out a server install with identity first and empty details hidden", () => {
		const embed = webhookMessage(
			"guild install",
			"info",
			{
				guildId: "100000000000000001",
				name: "Example *Guild*",
				memberCount: "1234",
				ownerId: "100000000000000002",
				ownerTag: "example_owner",
				channelCount: "8",
				preferredLocale: "en-US",
				guildCreatedAt: "2016-01-24T03:27:49.774Z",
				features: "None",
				large: "false",
				premiumTier: "0",
			},
			TS,
			"discord",
		);
		expect(embed.title).toBe("SERVER INSTALLED");
		expect(embed.description).toBe("**Example \\*Guild\\***");
		const fields = fieldMap(embed);
		expect(fields).toEqual({
			Members: "1,234",
			Channels: "8",
			Locale: "en-US",
			Owner: "example\\_owner `100000000000000002`",
			"Server created": "<t:1453606069:D>",
			"Server ID": "`100000000000000001`",
		});
		expect(embed.footer?.text).toBe("INFO · discord");
		expect(embed.timestamp).toBe(TS);
	});

	it("titles a level change with direction, delivery counts, and failure share", () => {
		const embed = webhookMessage(
			"level dispatched",
			"info",
			{ level: "2", prevLevel: "1", sent: "130", failed: "87" },
			TS,
			"level",
		);
		expect(embed.title).toBe("LEVEL 1 → 2");
		expect(embed.description).toBe("Emergency level rose from 1 to 2.");
		expect(fieldMap(embed)).toEqual({ Delivered: "130", Failed: "87 (40%)" });

		const falling = webhookMessage(
			"level dispatched",
			"warn",
			{ level: "4", prevLevel: "5" },
			TS,
			"level",
		);
		expect(falling.description).toBe("Emergency level fell from 5 to 4.");
		expect(falling.color).not.toBe(embed.color);
	});

	it("links an alert title only when the upstream link is plain https", () => {
		const safe = webhookMessage(
			"alert dispatched",
			"warn",
			{ title: "Level 5", link: "https://ews.kylemcdonald.net/" },
			TS,
			"poller",
		);
		expect(safe.description).toBe("[Level 5](https://ews.kylemcdonald.net/)");

		const hostile = webhookMessage(
			"alert dispatched",
			"warn",
			{ title: "Level 5", link: "javascript:alert(1)" },
			TS,
			"poller",
		);
		expect(hostile.description).toBe("Level 5");
	});

	it("puts the error in a code block and keeps other details as fields", () => {
		const embed = webhookMessage(
			"deliver failed",
			"error",
			{
				err: "DiscordAPIError[50001]: Missing Access ```",
				kind: "guild_channel",
				address: "100000000000000003",
			},
			TS,
			"discord",
		);
		expect(embed.title).toBe("DELIVER FAILED");
		expect(embed.description).toBe("```\nDiscordAPIError[50001]: Missing Access '''\n```");
		expect(fieldMap(embed)).toEqual({ Kind: "guild\\_channel", Address: "100000000000000003" });
	});

	it("labels prune reasons and omits reasons with no count", () => {
		const embed = webhookMessage(
			"dead subscriptions pruned",
			"info",
			{ source: "startup", count: "77", not_in_guild: "77" },
			TS,
			"discord",
		);
		expect(embed.description).toBe("Removed 77 subscriptions that can never deliver (startup).");
		expect(fieldMap(embed)).toEqual({ "Bot not in server": "77" });
	});

	it("stays inside Discord's embed limits for oversized input", () => {
		const huge = "x".repeat(5000);
		const details = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`detail${i}`, huge]));
		const embed = webhookMessage(huge, "error", { err: huge, ...details }, TS, huge);
		expect(embed.title?.length).toBeLessThanOrEqual(256);
		expect(embed.fields?.length).toBeLessThanOrEqual(25);
		for (const f of embed.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
		expect(embedSize(embed)).toBeLessThanOrEqual(MAX_EMBED_CHARS);
	});
});
