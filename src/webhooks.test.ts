import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { z } from "zod";
import { childLogger, type LogRecord, setLogSink } from "./log.js";
import { OperatorWebhooks } from "./webhooks.js";

const webhookBody = z.object({
	content: z.string(),
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

	it("routes every severity to exactly one destination", async () => {
		const log = childLogger("smoke");
		log.debug("poll unchanged");
		log.info("install");
		log.info("uninstall");
		log.info("started");
		log.warn("alert");
		log.error("poll failed");
		await webhooks.flush();

		expect(
			requests.map((request) => `${request.path} ${request.body.content.split("\n")[0]}`).sort(),
		).toEqual([
			"/error [ERROR] POLL FAILED",
			"/error [WARN] ALERT",
			"/info [DEBUG] POLL UNCHANGED",
			"/info [INFO] INSTALL",
			"/info [INFO] STARTED",
			"/info [INFO] UNINSTALL",
		]);
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
		expect(body?.allowed_mentions.parse).toEqual([]);
		expect(body?.content.length).toBeLessThanOrEqual(2000);
		expect(body?.content).not.toContain("private-bot-token");
		expect(body?.content).not.toContain("secret-value");
		expect(body?.content).not.toContain("hidden-authorization");
		expect(body?.content.match(/```/g)).toHaveLength(2);
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
		expect(requests[0]?.body.content).not.toContain("private");
		expect(requests[0]?.body.content).toContain('"intent": "subscribe"');
		expect(requests[0]?.body.content).toContain('"userId": "200"');
	});

	it("drains shutdown delivery and ignores subsequent logs", async () => {
		childLogger("boot").info("shutting down", { signal: "SIGTERM" });
		await webhooks.close();
		childLogger("discord").info("install");
		await webhooks.flush();
		expect(requests.map((request) => request.path)).toEqual(["/info"]);
		expect(requests[0]?.body.content).toContain("SIGTERM");
	});

	it("disables an unconfigured destination without falling back to the other one", async () => {
		await webhooks.close();
		webhooks = new OperatorWebhooks({ errorUrl: new URL("/error", server.url).href });
		childLogger("discord").info("install");
		childLogger("boot").error("fatal");
		await webhooks.flush();
		expect(requests.map((request) => request.path)).toEqual(["/error"]);
		expect(requests[0]?.body.content).toContain("fatal");
	});
});
