import type { Client } from "discord.js";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { ANNUAL_REMINDER } from "./copy.js";
import { DB } from "./db.js";
import { sendDueReminders } from "./reminders.js";

interface MockClient {
  client: Client;
  sentToUsers: Array<{ id: string; body: string }>;
  sentToChannels: Array<{ id: string; body: string }>;
  failOn: (kind: "user" | "channel", id: string) => void;
}

function makeMockClient(): MockClient {
  const sentToUsers: MockClient["sentToUsers"] = [];
  const sentToChannels: MockClient["sentToChannels"] = [];
  const failures = new Set<string>();

  const userSend = vi.fn(async (id: string, body: string) => {
    if (failures.has(`user:${id}`)) throw new Error("user send failed");
    sentToUsers.push({ id, body });
  });
  const channelSend = vi.fn(async (id: string, body: string) => {
    if (failures.has(`channel:${id}`)) throw new Error("channel send failed");
    sentToChannels.push({ id, body });
  });

  const client = {
    users: {
      fetch: async (id: string) => ({
        send: (body: string) => userSend(id, body),
      }),
    },
    channels: {
      fetch: async (id: string) => ({
        send: (body: string) => channelSend(id, body),
      }),
    },
  } as unknown as Client;

  return {
    client,
    sentToUsers,
    sentToChannels,
    failOn: (kind, id) => failures.add(`${kind}:${id}`),
  };
}

describe("sendDueReminders", () => {
  let db: DB;
  const NOW = new Date("2026-04-30T13:00:00.000Z");

  beforeEach(() => {
    db = new DB(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("sends to DM and guild_channel subscribers and stamps last_reminded", async () => {
    db.upsertSubscribed({
      kind: "dm",
      discordId: "user-1",
      guildId: null,
      now: "2024-01-01T00:00:00.000Z",
    });
    db.upsertSubscribed({
      kind: "guild_channel",
      discordId: "channel-1",
      guildId: "guild-1",
      now: "2024-01-01T00:00:00.000Z",
    });

    const mock = makeMockClient();
    const result = await sendDueReminders({ db, client: mock.client, now: NOW });

    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(mock.sentToUsers).toEqual([{ id: "user-1", body: ANNUAL_REMINDER }]);
    expect(mock.sentToChannels).toEqual([{ id: "channel-1", body: ANNUAL_REMINDER }]);

    const dm = db.findSubscriber("dm", "user-1");
    const ch = db.findSubscriber("guild_channel", "channel-1");
    assert(dm && ch);
    expect(dm.last_reminded).toBe(NOW.toISOString());
    expect(ch.last_reminded).toBe(NOW.toISOString());
  });

  it("does NOT stamp last_reminded when the send fails", async () => {
    db.upsertSubscribed({
      kind: "dm",
      discordId: "user-broken",
      guildId: null,
      now: "2024-01-01T00:00:00.000Z",
    });

    const mock = makeMockClient();
    mock.failOn("user", "user-broken");

    const result = await sendDueReminders({ db, client: mock.client, now: NOW });
    expect(result).toEqual({ sent: 0, failed: 1 });

    const dm = db.findSubscriber("dm", "user-broken");
    assert(dm);
    expect(dm.last_reminded).toBeNull();
  });

  it("skips subscribers under 1 year old", async () => {
    db.upsertSubscribed({
      kind: "dm",
      discordId: "young",
      guildId: null,
      now: "2026-01-01T00:00:00.000Z",
    });

    const mock = makeMockClient();
    const result = await sendDueReminders({ db, client: mock.client, now: NOW });
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(mock.sentToUsers).toEqual([]);
  });
});
