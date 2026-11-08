import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ok as assert } from "node:assert/strict";
import type { Server } from "bun";
import { z } from "zod";
import { childLogger, type LogRecord, setLogSink } from "./log.js";
import { OperatorWebhooks } from "./webhooks.js";

const webhookBody = z.object({
	embeds: z
		.array(
			z.object({
				title: z.string().min(1).max(256),
				description: z.string().max(4096).optional(),
				color: z.number().int(),
				footer: z.object({ text: z.string().max(2048) }),
				timestamp: z.iso.datetime(),
			}),
		)
		.length(1),
	allowed_mentions: z.object({ parse: z.array(z.string()) }),
});

describe("OperatorWebhooks", () => {
	let server: Server<undefined>;
	let webhooks: OperatorWebhooks;
	let requests: Array<{ path: string; body: z.infer<typeof webhookBody> }>;
	let logs: LogRecord[];
	let infoStatus: number;
	let errorStatus: number;

	beforeEach(() => {
		requests = [];
		logs = [];
		infoStatus = 204;
		errorStatus = 204;
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				const body = webhookBody.parse(await request.json());
				requests.push({ path, body });
				return new Response(null, { status: path === "/info" ? infoStatus : errorStatus });
			},
		});
		webhooks = new OperatorWebhooks({
			infoUrl: new URL("/info", server.url).href,
			errorUrl: new URL("/error", server.url).href,
			secrets: ["private-bot-token"],
		});
		setLogSink((record) => {
			logs.push(record);
			webhooks.onLog(record);
		});
	});

	afterEach(async () => {
		await webhooks.close();
		setLogSink(undefined);
		await server.stop(true);
	});

	it.each<[LogRecord["level"], string]>([
		["debug", "/info"],
		["info", "/info"],
		["warn", "/error"],
		["error", "/error"],
	])("routes %s to %s", async (level, path) => {
		childLogger("smoke")[level]("notification");
		await webhooks.flush();
		expect(requests.map((request) => request.path)).toEqual([path]);
	});

	it.each([
		{ responseStatus: 204, errorFailures: 0 },
		{ responseStatus: 500, errorFailures: 2 },
	])(
		"isolates info failures without recursion when errors return $responseStatus",
		async ({ responseStatus, errorFailures }) => {
			errorStatus = responseStatus;
			infoStatus = 429;
			childLogger("discord").info("install");
			childLogger("poller").error("upstream unavailable");
			await webhooks.flush();
			expect(requests.map((request) => request.path).sort()).toEqual(["/error", "/error", "/info"]);
			expect(logs.filter((record) => record.context?.["destination"] === "info")).toEqual([
				expect.objectContaining({
					level: "warn",
					message: "webhook delivery failed",
					context: { module: "webhooks", destination: "info", status: 429 },
				}),
			]);
			expect(logs.filter((record) => record.context?.["destination"] === "error")).toHaveLength(
				errorFailures,
			);
		},
	);

	it("redacts credentials, suppresses mentions, and bounds untrusted details", async () => {
		childLogger("poller").error("request failed private-bot-token ```", {
			err: new Error("private-bot-token https://discord.com/api/webhooks/123/secret-value"),
			authorization: "hidden-authorization",
			details: "``` @everyone [click](https://example.com) ".repeat(100),
		});
		await webhooks.flush();
		expect(requests).toHaveLength(1);
		const body = requests[0]?.body;
		assert(body);
		const embed = body.embeds[0];
		assert(embed);
		const text = [embed.title, embed.description, embed.footer.text]
			.join("\n")
			.replaceAll("\\", "");
		expect(body.allowed_mentions.parse).toEqual([]);
		expect(text.length).toBeLessThanOrEqual(6000);
		expect(text).not.toContain("private-bot-token");
		expect(text).not.toContain("secret-value");
		expect(text).not.toContain("hidden-authorization");
	});

	it("keeps nested error details readable without leaking private values", async () => {
		const circular: Record<string, unknown> = { reason: "upstream unavailable" };
		circular["self"] = circular;
		webhooks.onLog({
			ts: "2026-11-08T12:00:00.000Z",
			level: "error",
			message: "request failed",
			context: {
				module: "poller",
				details: {
					error: new TypeError("Invalid dashboard"),
					token: "nested-credential",
					body: "nested-private-message",
				},
				circular,
				bytes: 9007199254740993n,
			},
		});
		await webhooks.flush();
		const description = requests[0]?.body.embeds[0]?.description;
		assert(description);
		const text = description.replaceAll("\\", "");
		expect(text).toContain("TypeError: Invalid dashboard");
		expect(text).toContain("upstream unavailable");
		expect(text).toContain("9007199254740993");
		expect(text).not.toContain("nested-credential");
		expect(text).not.toContain("nested-private-message");
	});

	it("omits private message bodies while keeping diagnostic metadata", async () => {
		childLogger("discord").info("dm in", {
			userId: "200",
			intent: "subscribe",
			content: "private message",
			stripped: "private mention",
			body: "private response",
			requestBody: "private request",
		});
		await webhooks.flush();
		expect(requests[0]?.path).toBe("/info");
		const description = requests[0]?.body.embeds[0]?.description;
		expect(description).not.toContain("private");
		expect(description).toContain("subscribe");
		expect(description).toContain("200");
	});

	it("drains shutdown delivery and ignores subsequent logs", async () => {
		childLogger("boot").info("shutting down", { signal: "SIGTERM" });
		await webhooks.close();
		childLogger("discord").info("install");
		await webhooks.flush();
		expect(requests.map((request) => request.path)).toEqual(["/info"]);
		expect(requests[0]?.body.embeds[0]?.description).toContain("SIGTERM");
	});

	it("disables an unconfigured destination without falling back to the other one", async () => {
		await webhooks.close();
		webhooks = new OperatorWebhooks({ errorUrl: new URL("/error", server.url).href });
		childLogger("discord").info("install");
		childLogger("boot").error("fatal");
		await webhooks.flush();
		expect(requests.map((request) => request.path)).toEqual(["/error"]);
	});
});
