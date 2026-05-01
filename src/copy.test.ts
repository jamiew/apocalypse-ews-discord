import { describe, expect, it } from "vitest";
import { alertPayload, pingPongLine, statusLine } from "./copy.js";

describe("alertPayload", () => {
  it("formats the alert as 4 lines", () => {
    const out = alertPayload({
      title: "Emergency level 5.",
      link: "https://ews.kylemcdonald.net/",
      pubDate: "Thu, 30 Apr 2026 12:00:00 GMT",
    });
    expect(out.split("\n")).toEqual([
      "Apocalypse Early Warning System — emergency level 5.",
      "Emergency level 5.",
      "Thu, 30 Apr 2026 12:00:00 GMT",
      "https://ews.kylemcdonald.net/",
    ]);
  });

  it("drops empty fields without leaving blank lines", () => {
    const out = alertPayload({ title: "t", link: "", pubDate: "" });
    expect(out.split("\n")).toEqual(["Apocalypse Early Warning System — emergency level 5.", "t"]);
  });
});

describe("statusLine", () => {
  it("renders subscribed + last alert", () => {
    expect(
      statusLine({
        subscribed: true,
        lastAlert: { title: "Alert.", pubDate: "Thu, 30 Apr 2026 12:00:00 GMT" },
      }),
    ).toBe("Subscribed. Last alert: Thu, 30 Apr 2026 12:00:00 GMT — Alert..");
  });

  it("renders not-subscribed + no alert on record", () => {
    expect(statusLine({ subscribed: false, lastAlert: null })).toBe(
      "Not subscribed. Last alert: none on record.",
    );
  });
});

describe("pingPongLine", () => {
  it("uses lowercase 'subscribed' and 'still here' framing", () => {
    expect(pingPongLine({ subscribed: true, lastAlert: null })).toBe(
      "Still here. Last alert: none on record. Status: subscribed.",
    );
    expect(pingPongLine({ subscribed: false, lastAlert: null })).toBe(
      "Still here. Last alert: none on record. Status: not subscribed.",
    );
  });
});
