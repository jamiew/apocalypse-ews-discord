import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
	const original = process.env;

	beforeEach(() => {
		process.env = { ...original };
	});

	afterEach(() => {
		process.env = original;
	});

	it("returns parsed values with defaults filled", () => {
		process.env["DISCORD_TOKEN"] = "tok";
		process.env["DISCORD_CLIENT_ID"] = "cid";
		delete process.env["EWS_RSS_URL"];
		delete process.env["POLL_CRON"];
		delete process.env["REMINDER_CRON"];
		delete process.env["DATABASE_PATH"];

		const env = loadEnv();
		expect(env.DISCORD_TOKEN).toBe("tok");
		expect(env.DISCORD_CLIENT_ID).toBe("cid");
		expect(env.EWS_RSS_URL).toBe("https://ews.kylemcdonald.net/rss.xml");
		expect(env.POLL_CRON).toBe("*/30 * * * *");
		expect(env.REMINDER_CRON).toBe("0 13 * * *");
		expect(env.DATABASE_PATH).toBe("./data/ews.db");
	});

	it("respects overrides", () => {
		process.env["DISCORD_TOKEN"] = "tok";
		process.env["DISCORD_CLIENT_ID"] = "cid";
		process.env["EWS_RSS_URL"] = "https://example.com/rss.xml";
		process.env["POLL_CRON"] = "0 * * * *";
		process.env["DATABASE_PATH"] = "/tmp/test.db";

		const env = loadEnv();
		expect(env.EWS_RSS_URL).toBe("https://example.com/rss.xml");
		expect(env.POLL_CRON).toBe("0 * * * *");
		expect(env.DATABASE_PATH).toBe("/tmp/test.db");
	});

	it("throws when DISCORD_TOKEN is missing", () => {
		delete process.env["DISCORD_TOKEN"];
		process.env["DISCORD_CLIENT_ID"] = "cid";
		expect(() => loadEnv()).toThrow(/DISCORD_TOKEN/);
	});

	it("throws when EWS_RSS_URL is not a url", () => {
		process.env["DISCORD_TOKEN"] = "tok";
		process.env["DISCORD_CLIENT_ID"] = "cid";
		process.env["EWS_RSS_URL"] = "not-a-url";
		expect(() => loadEnv()).toThrow(/EWS_RSS_URL/);
	});
});
