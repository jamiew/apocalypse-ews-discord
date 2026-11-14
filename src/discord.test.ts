import { describe, expect, it } from "bun:test";
import {
	ApplicationIntegrationType,
	ChannelType,
	InteractionContextType,
	PermissionFlagsBits,
	PermissionsBitField,
} from "discord.js";
import {
	botCanPost,
	canManageGuildSubscriptions,
	classifyDmText,
	classifyMentionText,
	classifyWelcomeError,
	commandDefinitions,
	pickWelcomeChannelFrom,
	pruneReasonFor,
	stripMention,
	type WelcomeChannelCandidate,
} from "./discord.js";

describe("classifyDmText", () => {
	it.each([
		["subscribe", "subscribe"],
		["SUBSCRIBE", "subscribe"],
		["  Subscribe  ", "subscribe"],
		["yes", "subscribe"],
		["y", "subscribe"],
		["start", "subscribe"],
		["sign me up", "subscribe"],
		["unsubscribe", "unsubscribe"],
		["STOP", "unsubscribe"],
		["cancel", "unsubscribe"],
		["quit", "unsubscribe"],
		["end", "unsubscribe"],
		["remove me", "unsubscribe"],
		["help", "help"],
		["commands", "help"],
		["status?", "status"],
		["what's my status", "status"],
		["hello", "other"],
		["when does this start", "other"],
		["", "other"],
		["unsub", "unsubscribe"],
	] as const)("classifies %j as %s", (input, expected) => {
		expect(classifyDmText(input)).toBe(expected);
	});
});

describe("classifyMentionText", () => {
	it.each([
		["subscribe", "subscribe"],
		["yes", "subscribe"],
		["unsubscribe", "unsubscribe"],
		["stop", "unsubscribe"],
		["please unsubscribe me", "unsubscribe"],
		["status", "status"],
		["state", "status"],
		["what's my status?", "status"],
		["help", "help"],
		["?", "help"],
		["help me", "help"],
		["commands", "help"],
		["sign me up", "subscribe"],
		["hello", "other"],
		["when does this start", "other"],
		["", "other"],
	] as const)("classifies %j as %s", (input, expected) => {
		expect(classifyMentionText(input)).toBe(expected);
	});
});

describe("stripMention", () => {
	it("strips both <@id> and <@!id> forms", () => {
		expect(stripMention("<@111> hi", "111")).toBe("hi");
		expect(stripMention("<@!111> hi", "111")).toBe("hi");
	});

	it("trims surrounding whitespace and leaves other text alone", () => {
		expect(stripMention("  <@111>   subscribe  ", "111")).toBe("subscribe");
		expect(stripMention("hi <@222>", "111")).toBe("hi <@222>");
	});

	it("removes multiple occurrences", () => {
		expect(stripMention("<@111> hello <@111>", "111")).toBe("hello");
	});
});

const text = (
	partial: Partial<WelcomeChannelCandidate> & { id: string },
): WelcomeChannelCandidate => ({
	type: ChannelType.GuildText,
	position: 0,
	canSend: true,
	...partial,
});

describe("pickWelcomeChannelFrom", () => {
	it("prefers the system channel when sendable", () => {
		const sys = text({ id: "sys", canSend: true });
		const others = [text({ id: "a", position: 0 })];
		expect(pickWelcomeChannelFrom(sys, others)?.id).toBe("sys");
	});

	it("falls back to the lowest-position sendable text channel when system is unsendable", () => {
		const sys = text({ id: "sys", canSend: false });
		const channels = [
			text({ id: "z", position: 5 }),
			text({ id: "a", position: 1 }),
			text({ id: "m", position: 3 }),
		];
		expect(pickWelcomeChannelFrom(sys, channels)?.id).toBe("a");
	});

	it("ignores non-text channels and ones the bot can't send to", () => {
		const channels = [
			text({ id: "voice", type: ChannelType.GuildVoice, position: 0 }),
			text({ id: "noperm", canSend: false, position: 1 }),
			text({ id: "ok", position: 2 }),
		];
		expect(pickWelcomeChannelFrom(null, channels)?.id).toBe("ok");
	});

	it("returns null when nothing is sendable", () => {
		const channels = [text({ id: "x", canSend: false })];
		expect(pickWelcomeChannelFrom(null, channels)).toBeNull();
	});
});

describe("canManageGuildSubscriptions", () => {
	it("allows ManageGuild and Administrator", () => {
		expect(
			canManageGuildSubscriptions(new PermissionsBitField(PermissionFlagsBits.ManageGuild)),
		).toBe(true);
		expect(
			canManageGuildSubscriptions(new PermissionsBitField(PermissionFlagsBits.Administrator)),
		).toBe(true);
	});

	it("denies members without ManageGuild and unknown permissions", () => {
		expect(
			canManageGuildSubscriptions(new PermissionsBitField(PermissionFlagsBits.SendMessages)),
		).toBe(false);
		expect(canManageGuildSubscriptions(null)).toBe(false);
	});
});

describe("commandDefinitions", () => {
	it("registers exactly the expected slash commands", () => {
		const names = commandDefinitions.map((c) => c.name).sort();
		expect(names).toEqual(["help", "status", "subscribe", "unsubscribe"]);
	});

	it("supports both guild + user installs and runs in every context", () => {
		const byName = Object.fromEntries(commandDefinitions.map((c) => [c.name, c]));
		const allCtx = [
			InteractionContextType.Guild,
			InteractionContextType.BotDM,
			InteractionContextType.PrivateChannel,
		];
		expect(byName["subscribe"]?.contexts).toEqual(allCtx);
		expect(byName["unsubscribe"]?.contexts).toEqual(allCtx);
		expect(byName["status"]?.contexts).toEqual(allCtx);
		expect(byName["help"]?.contexts).toEqual(allCtx);
		// Every command supports both install types.
		const both = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];
		for (const c of commandDefinitions) {
			expect(c.integration_types).toEqual(both);
		}
	});

	it("gates subscribe/unsubscribe behind ManageGuild", () => {
		const byName = Object.fromEntries(commandDefinitions.map((c) => [c.name, c]));
		expect(byName["subscribe"]?.default_member_permissions).toBe(
			String(PermissionFlagsBits.ManageGuild),
		);
		expect(byName["unsubscribe"]?.default_member_permissions).toBe(
			String(PermissionFlagsBits.ManageGuild),
		);
		// status and help carry no permission gate.
		expect(byName["status"]?.default_member_permissions).toBeUndefined();
		expect(byName["help"]?.default_member_permissions).toBeUndefined();
	});
});

describe("classifyWelcomeError", () => {
	it("classifies DiscordAPIError code 50001 as missing_access", () => {
		expect(classifyWelcomeError({ code: 50001, message: "Missing Access" })).toBe("missing_access");
	});

	it("classifies other errors as other", () => {
		expect(classifyWelcomeError(new Error("boom"))).toBe("other");
		expect(classifyWelcomeError({ code: 50013 })).toBe("other");
		expect(classifyWelcomeError(null)).toBe("other");
		expect(classifyWelcomeError(undefined)).toBe("other");
	});
});

describe("pruneReasonFor", () => {
	const channel = { kind: "guild_channel", guild_id: "guild-1" } as const;
	const dm = { kind: "dm", guild_id: null } as const;
	const inGuild = () => true;
	const notInGuild = () => false;

	it("prunes channels that no longer exist", () => {
		expect(pruneReasonFor({ code: 10003 }, channel, inGuild)).toBe("unknown_channel");
	});

	it("prunes Missing Access only when the bot is not in the server", () => {
		expect(pruneReasonFor({ code: 50001 }, channel, notInGuild)).toBe("not_in_guild");
		expect(pruneReasonFor({ code: 50001 }, channel, inGuild)).toBeNull();
		expect(pruneReasonFor({ code: 50001 }, { ...channel, guild_id: null }, notInGuild)).toBeNull();
	});

	it("keeps channels with fixable permissions", () => {
		expect(pruneReasonFor({ code: 50013 }, channel, notInGuild)).toBeNull();
	});

	it("prunes DMs to unknown or unreachable users, but not closed DMs", () => {
		expect(pruneReasonFor({ code: 10013 }, dm, inGuild)).toBe("unknown_user");
		expect(pruneReasonFor({ code: 50278 }, dm, inGuild)).toBe("no_mutual_guild");
		expect(pruneReasonFor({ code: 50007 }, dm, inGuild)).toBeNull();
		expect(pruneReasonFor({ code: 10003 }, dm, inGuild)).toBeNull();
	});

	it("keeps subscribers on transient errors", () => {
		expect(pruneReasonFor(new Error("socket hang up"), channel, notInGuild)).toBeNull();
		expect(pruneReasonFor({ status: 500 }, dm, inGuild)).toBeNull();
	});
});

describe("botCanPost", () => {
	const { ViewChannel, SendMessages, SendMessagesInThreads } = PermissionFlagsBits;

	it("requires View Channel and Send Messages", () => {
		expect(botCanPost(new PermissionsBitField([ViewChannel, SendMessages]), false)).toBe(true);
		expect(botCanPost(new PermissionsBitField([SendMessages]), false)).toBe(false);
		expect(botCanPost(new PermissionsBitField([ViewChannel]), false)).toBe(false);
		expect(botCanPost(null, false)).toBe(false);
	});

	it("uses Send Messages in Threads for threads", () => {
		expect(botCanPost(new PermissionsBitField([ViewChannel, SendMessages]), true)).toBe(false);
		expect(botCanPost(new PermissionsBitField([ViewChannel, SendMessagesInThreads]), true)).toBe(
			true,
		);
	});
});
