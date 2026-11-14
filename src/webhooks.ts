import type { APIEmbed } from "discord.js";
import { childLogger, type LogRecord } from "./log.js";
import { embedSize, MAX_EMBED_CHARS, webhookMessage } from "./operator-embeds.js";

type Destination = "info" | "error";

const log = childLogger("webhooks");

// Bursts (startup, a fan-out with many failures) share messages instead of tripping
// Discord's per-webhook rate limit: wait briefly, then pack up to 10 embeds per message.
const BATCH_DELAY_MS = 1_000;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 10_000;

function takeBatch(queue: APIEmbed[]): APIEmbed[] {
	const batch: APIEmbed[] = [];
	let size = 0;
	for (const embed of queue) {
		const next = embedSize(embed);
		if (batch.length === MAX_EMBEDS_PER_MESSAGE) break;
		if (batch.length > 0 && size + next > MAX_EMBED_CHARS) break;
		batch.push(embed);
		size += next;
	}
	queue.splice(0, batch.length);
	return batch;
}

function retryAfterMs(response: Response): number {
	const seconds = Number(response.headers.get("retry-after"));
	return Number.isFinite(seconds) && seconds >= 0
		? Math.min(seconds * 1000, MAX_RETRY_WAIT_MS)
		: 1_000;
}

export class OperatorWebhooks {
	private readonly urls: Record<Destination, string | undefined>;
	private readonly secrets: readonly string[];
	private readonly queues: Record<Destination, APIEmbed[]> = { info: [], error: [] };
	private readonly timers: Partial<Record<Destination, Timer>> = {};
	private readonly draining: Partial<Record<Destination, Promise<void>>> = {};
	private closed = false;

	constructor(options: {
		infoUrl?: string | undefined;
		errorUrl?: string | undefined;
		secrets?: readonly string[];
	}) {
		this.urls = { info: options.infoUrl, error: options.errorUrl };
		this.secrets = [
			...(options.secrets ?? []),
			options.infoUrl ?? "",
			options.errorUrl ?? "",
		].filter(Boolean);
	}

	onLog(record: LogRecord): void {
		if (record.level === "debug") return;
		if (record.context?.["module"] === "webhooks" && record.context["destination"] === "error")
			return;
		const destination = record.level === "warn" || record.level === "error" ? "error" : "info";
		this.send(destination, record);
	}

	async flush(): Promise<void> {
		const destinations: Destination[] = ["info", "error"];
		for (;;) {
			const busy = destinations.filter(
				(d) => this.queues[d].length > 0 || this.draining[d] !== undefined,
			);
			if (busy.length === 0) return;
			await Promise.all(busy.map((d) => this.drain(d)));
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.flush();
	}

	private send(destination: Destination, record: LogRecord): void {
		if (!this.urls[destination] || this.closed) return;
		this.queues[destination].push(
			webhookMessage(
				this.redact(record.message),
				record.level,
				this.serialize(record.context ?? {}),
				record.ts,
				this.redact(
					typeof record.context?.["module"] === "string" ? record.context["module"] : "bot",
				),
			),
		);
		this.schedule(destination);
	}

	private schedule(destination: Destination): void {
		if (this.timers[destination] || this.draining[destination]) return;
		this.timers[destination] = setTimeout(() => {
			void this.drain(destination);
		}, BATCH_DELAY_MS);
	}

	private drain(destination: Destination): Promise<void> {
		clearTimeout(this.timers[destination]);
		delete this.timers[destination];
		const running = this.draining[destination];
		if (running) return running;
		const url = this.urls[destination];
		const queue = this.queues[destination];
		const run = (async () => {
			while (url && queue.length > 0) await this.deliver(destination, url, takeBatch(queue));
		})().finally(() => {
			delete this.draining[destination];
			// Anything queued after the loop's last check waits for the next batch window.
			if (queue.length > 0) this.schedule(destination);
		});
		this.draining[destination] = run;
		return run;
	}

	private serialize(details: Record<string, unknown>): Record<string, string> {
		const seen = new WeakSet<object>();
		const format = (value: unknown, key: string): string => {
			if (/token|secret|password|authorization/i.test(key)) return "[redacted]";
			if (/^(content|stripped|body|requestBody)$/.test(key)) return "[omitted]";
			if (value == null) return "Not available";
			if (value instanceof Error)
				return value.name === "Error" ? value.message : `${value.name}: ${value.message}`;
			if (typeof value !== "object") return String(value);
			if (seen.has(value)) return "[circular]";
			seen.add(value);
			if (Array.isArray(value)) return value.map((item) => format(item, "")).join(", ") || "None";
			return (
				Object.entries(value)
					.map(([childKey, childValue]) => `${childKey}: ${format(childValue, childKey)}`)
					.join("; ") || "None"
			);
		};
		const fields: Record<string, string> = {};
		for (const [key, value] of Object.entries(details)) {
			if (value == null || /^(module|content|stripped|body|requestBody)$/.test(key)) continue;
			fields[this.redact(key)] = this.redact(format(value, key));
		}
		return fields;
	}

	private redact(text: string): string {
		for (const secret of this.secrets) text = text.replaceAll(secret, "[redacted]");
		return text.replace(
			/https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/[^\s"\\]+/g,
			"[redacted webhook]",
		);
	}

	private async deliver(destination: Destination, url: string, embeds: APIEmbed[]): Promise<void> {
		const endpoint = new URL(url);
		endpoint.searchParams.set("wait", "true");
		for (let attempt = 1; ; attempt++) {
			let response: Response;
			try {
				response = await fetch(endpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ embeds, allowed_mentions: { parse: [] } }),
					signal: AbortSignal.timeout(5_000),
					redirect: "error",
				});
			} catch {
				// Fetch errors can contain the secret webhook URL. Never log the raw error.
				log.warn("webhook delivery failed", { destination, reason: "network_or_timeout" });
				return;
			}
			await response.body?.cancel();
			if (response.status === 429 && attempt < MAX_ATTEMPTS) {
				await Bun.sleep(retryAfterMs(response));
				continue;
			}
			if (!response.ok) {
				log.warn("webhook delivery failed", { destination, status: response.status });
			}
			return;
		}
	}
}
