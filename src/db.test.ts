import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import { DB } from "./db.js";

describe("DB", () => {
  let db: DB;

  beforeEach(() => {
    db = new DB(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("upsertSubscribed", () => {
    it("creates an active subscriber on first call", () => {
      const r = db.upsertSubscribed({
        kind: "dm",
        discordId: "u1",
        guildId: null,
        now: "2026-04-30T00:00:00.000Z",
      });
      expect(r).toEqual({ created: true, reactivated: false });
      const sub = db.findSubscriber("dm", "u1");
      assert(sub, "subscriber should exist");
      expect(sub.status).toBe("active");
    });

    it("is idempotent for an already-active subscriber", () => {
      db.upsertSubscribed({
        kind: "dm",
        discordId: "u1",
        guildId: null,
        now: "2026-04-30T00:00:00.000Z",
      });
      const r = db.upsertSubscribed({
        kind: "dm",
        discordId: "u1",
        guildId: null,
        now: "2026-04-30T01:00:00.000Z",
      });
      expect(r).toEqual({ created: false, reactivated: false });
    });

    it("reactivates an unsubscribed subscriber and clears last_reminded", () => {
      db.upsertSubscribed({
        kind: "dm",
        discordId: "u1",
        guildId: null,
        now: "2025-04-30T00:00:00.000Z",
      });
      db.stampReminded(db.findSubscriber("dm", "u1")!.id, "2025-05-01T00:00:00.000Z");
      db.markUnsubscribed("dm", "u1");

      const r = db.upsertSubscribed({
        kind: "dm",
        discordId: "u1",
        guildId: null,
        now: "2026-04-30T00:00:00.000Z",
      });
      expect(r).toEqual({ created: false, reactivated: true });
      const sub = db.findSubscriber("dm", "u1");
      assert(sub);
      expect(sub.status).toBe("active");
      expect(sub.last_reminded).toBeNull();
      expect(sub.subscribed_at).toBe("2026-04-30T00:00:00.000Z");
    });
  });

  describe("selectDueForReminder", () => {
    it("includes subscribers ≥ 1 year old never reminded, excludes recent or recently-reminded", () => {
      db.upsertSubscribed({
        kind: "dm",
        discordId: "old-never",
        guildId: null,
        now: "2024-04-29T00:00:00.000Z",
      });
      db.upsertSubscribed({
        kind: "dm",
        discordId: "old-recently-reminded",
        guildId: null,
        now: "2024-04-29T00:00:00.000Z",
      });
      db.stampReminded(
        db.findSubscriber("dm", "old-recently-reminded")!.id,
        "2026-03-01T00:00:00.000Z",
      );
      db.upsertSubscribed({
        kind: "dm",
        discordId: "young",
        guildId: null,
        now: "2026-01-01T00:00:00.000Z",
      });
      db.upsertSubscribed({
        kind: "dm",
        discordId: "old-stale-reminder",
        guildId: null,
        now: "2024-01-01T00:00:00.000Z",
      });
      db.stampReminded(
        db.findSubscriber("dm", "old-stale-reminder")!.id,
        "2025-01-01T00:00:00.000Z",
      );
      // unsubscribed should never appear
      db.upsertSubscribed({
        kind: "dm",
        discordId: "unsub",
        guildId: null,
        now: "2024-04-29T00:00:00.000Z",
      });
      db.markUnsubscribed("dm", "unsub");

      const due = db.selectDueForReminder(new Date("2026-04-30T13:00:00.000Z"));
      const ids = due.map((s) => s.discord_id).sort();
      expect(ids).toEqual(["old-never", "old-stale-reminder"]);
    });
  });

  describe("markUnsubscribed", () => {
    it("returns false when the row doesn't exist", () => {
      expect(db.markUnsubscribed("dm", "ghost")).toBe(false);
    });

    it("returns false on a second call (already unsubscribed)", () => {
      db.upsertSubscribed({
        kind: "dm",
        discordId: "u1",
        guildId: null,
        now: "2026-04-30T00:00:00.000Z",
      });
      expect(db.markUnsubscribed("dm", "u1")).toBe(true);
      expect(db.markUnsubscribed("dm", "u1")).toBe(false);
    });
  });

  describe("listActive", () => {
    it("filters by kind when given and excludes unsubscribed", () => {
      db.upsertSubscribed({
        kind: "dm",
        discordId: "u1",
        guildId: null,
        now: "2026-04-30T00:00:00.000Z",
      });
      db.upsertSubscribed({
        kind: "guild_channel",
        discordId: "c1",
        guildId: "g1",
        now: "2026-04-30T00:00:00.000Z",
      });
      db.upsertSubscribed({
        kind: "dm",
        discordId: "gone",
        guildId: null,
        now: "2026-04-30T00:00:00.000Z",
      });
      db.markUnsubscribed("dm", "gone");

      expect(db.listActive("dm").map((s) => s.discord_id)).toEqual(["u1"]);
      expect(db.listActive("guild_channel").map((s) => s.discord_id)).toEqual(["c1"]);
      expect(
        db
          .listActive()
          .map((s) => s.discord_id)
          .sort(),
      ).toEqual(["c1", "u1"]);
    });
  });

  describe("seen_alerts", () => {
    it("hasSeenAlert reflects insertion", () => {
      expect(db.hasSeenAlert("g1")).toBe(false);
      db.recordSeenAlert({ guid: "g1", title: "t", link: "l", pub_date: "p" });
      expect(db.hasSeenAlert("g1")).toBe(true);
    });

    it("recordSeenAlert is idempotent on duplicate guid", () => {
      db.recordSeenAlert({ guid: "g1", title: "first", link: "l", pub_date: "p" });
      db.recordSeenAlert({ guid: "g1", title: "second", link: "l", pub_date: "p" });
      const last = db.lastSeenAlert();
      assert(last);
      expect(last.title).toBe("first");
    });

    it("recordSeenAlert defaults ingested_at to now when omitted", () => {
      const before = Date.now();
      db.recordSeenAlert({ guid: "g1", title: "t", link: "l", pub_date: "p" });
      const after = Date.now();
      const last = db.lastSeenAlert();
      assert(last);
      const ingestedMs = Date.parse(last.ingested_at);
      expect(ingestedMs).toBeGreaterThanOrEqual(before);
      expect(ingestedMs).toBeLessThanOrEqual(after);
    });

    it("lastSeenAlert returns undefined when empty", () => {
      expect(db.lastSeenAlert()).toBeUndefined();
    });
  });

  describe("lastAlertForDisplay", () => {
    it("returns null when there is no alert", () => {
      expect(db.lastAlertForDisplay()).toBeNull();
    });

    it("returns null when the row has no title", () => {
      db.recordSeenAlert({ guid: "g1", title: null, link: null, pub_date: null });
      expect(db.lastAlertForDisplay()).toBeNull();
    });

    it("projects title and pubDate (defaulting empty pub_date to '')", () => {
      db.recordSeenAlert({ guid: "g1", title: "Alert.", link: "l", pub_date: null });
      expect(db.lastAlertForDisplay()).toEqual({ title: "Alert.", pubDate: "" });
    });
  });
});
