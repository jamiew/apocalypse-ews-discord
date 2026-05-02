import { describe, expect, it } from "bun:test";
import {
	ApplicationIntegrationType,
	ChannelType,
	InteractionContextType,
	PermissionFlagsBits,
} from "discord.js";
import {
	classifyDmText,
	classifyMentionText,
	commandDefinitions,
	pickWelcomeChannelFrom,
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
		["unsubscribe", "unsubscribe"],
		["STOP", "unsubscribe"],
		["cancel", "unsubscribe"],
		["quit", "unsubscribe"],
		["end", "unsubscribe"],
		["hello", "other"],
		["", "other"],
		["unsub", "other"],
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
		["status", "status"],
		["state", "status"],
		["help", "help"],
		["?", "help"],
		["hello", "other"],
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

describe("commandDefinitions", () => {
	it("registers exactly the expected slash commands", () => {
		const names = commandDefinitions.map((c) => c.name).sort();
		expect(names).toEqual(["dev-fire", "help", "status", "subscribe", "unsubscribe"]);
	});

	it("supports both guild + user installs and runs in every context (except dev-fire which is guild-only)", () => {
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
		// dev-fire stays guild-only — admin testing happens in a server.
		expect(byName["dev-fire"]?.contexts).toEqual([InteractionContextType.Guild]);
		// Every command supports both install types.
		const both = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];
		for (const c of commandDefinitions) {
			expect(c.integration_types).toEqual(both);
		}
	});

	it("gates subscribe/unsubscribe behind ManageGuild and dev-fire behind Administrator", () => {
		const byName = Object.fromEntries(commandDefinitions.map((c) => [c.name, c]));
		expect(byName["subscribe"]?.default_member_permissions).toBe(
			String(PermissionFlagsBits.ManageGuild),
		);
		expect(byName["unsubscribe"]?.default_member_permissions).toBe(
			String(PermissionFlagsBits.ManageGuild),
		);
		expect(byName["dev-fire"]?.default_member_permissions).toBe(
			String(PermissionFlagsBits.Administrator),
		);
		// status and help carry no permission gate.
		expect(byName["status"]?.default_member_permissions).toBeUndefined();
		expect(byName["help"]?.default_member_permissions).toBeUndefined();
	});
});
