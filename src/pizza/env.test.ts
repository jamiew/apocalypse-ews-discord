import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadPizzaEnv } from "./env.js";

describe("loadPizzaEnv", () => {
	const original = process.env;

	beforeEach(() => {
		process.env = { ...original };
		process.env["DISCORD_TOKEN"] = "tok";
		process.env["DISCORD_CLIENT_ID"] = "cid";
		process.env["XPOZ_API_KEY"] = "key";
		for (const k of [
			"DATABASE_PATH",
			"PIZZA_ACCOUNT",
			"PIZZA_FETCH_LIMIT",
			"PIZZA_MIN_ALERT_LEVEL",
			"POLL_CRON",
			"XPOZ_SERVER_URL",
		]) {
			delete process.env[k];
		}
	});

	afterEach(() => {
		process.env = original;
	});

	it("fills defaults", () => {
		const env = loadPizzaEnv();
		expect(env.DATABASE_PATH).toBe("./data/pizza.db");
		expect(env.PIZZA_ACCOUNT).toBe("PenPizzaReport");
		expect(env.PIZZA_FETCH_LIMIT).toBe(25);
		expect(env.PIZZA_MIN_ALERT_LEVEL).toBe(3);
		expect(env.POLL_CRON).toBe("*/15 * * * *");
	});

	it("coerces numeric overrides from strings", () => {
		process.env["PIZZA_MIN_ALERT_LEVEL"] = "5";
		process.env["PIZZA_FETCH_LIMIT"] = "100";
		const env = loadPizzaEnv();
		expect(env.PIZZA_MIN_ALERT_LEVEL).toBe(5);
		expect(env.PIZZA_FETCH_LIMIT).toBe(100);
	});

	it("requires the Xpoz key", () => {
		delete process.env["XPOZ_API_KEY"];
		expect(() => loadPizzaEnv()).toThrow(/XPOZ_API_KEY/);
	});

	it("requires the Discord token", () => {
		delete process.env["DISCORD_TOKEN"];
		expect(() => loadPizzaEnv()).toThrow(/DISCORD_TOKEN/);
	});

	it("rejects an alert floor outside 1..5", () => {
		process.env["PIZZA_MIN_ALERT_LEVEL"] = "9";
		expect(() => loadPizzaEnv()).toThrow(/PIZZA_MIN_ALERT_LEVEL/);
	});

	it("rejects a non-url Xpoz server override", () => {
		process.env["XPOZ_SERVER_URL"] = "not-a-url";
		expect(() => loadPizzaEnv()).toThrow(/XPOZ_SERVER_URL/);
	});
});
