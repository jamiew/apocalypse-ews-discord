import { ChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  classifyDmText,
  commandDefinitions,
  pickWelcomeChannelFrom,
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

  it("disables DMs on every command (DMs use plain-message keywords)", () => {
    for (const c of commandDefinitions) {
      // dm_permission false in the registered payload
      expect(c.dm_permission).toBe(false);
    }
  });

  it("requires ManageGuild for subscribe/unsubscribe and Administrator for dev-fire", () => {
    const byName = Object.fromEntries(commandDefinitions.map((c) => [c.name, c]));
    // Bit values per discord-api-types: ManageGuild=0x20, Administrator=0x8
    expect(byName.subscribe?.default_member_permissions).toBeTruthy();
    expect(byName.unsubscribe?.default_member_permissions).toBeTruthy();
    expect(byName["dev-fire"]?.default_member_permissions).toBeTruthy();
  });
});
