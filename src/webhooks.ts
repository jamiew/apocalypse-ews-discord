import { webhookMessage } from "./copy.js";
import { childLogger, type LogRecord } from "./log.js";

type Destination = "info" | "error";

const log = childLogger("webhooks");

export class OperatorWebhooks {
	private readonly urls: Record<Destination, string | undefined>;
	private readonly secrets: readonly string[];
	private readonly pending = new Set<Promise<void>>();
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
		if (record.context?.["module"] === "webhooks" && record.context["destination"] === "error")
			return;
		const destination = record.level === "warn" || record.level === "error" ? "error" : "info";
		this.send(destination, record);
	}

	async flush(): Promise<void> {
		while (this.pending.size > 0) await Promise.all(this.pending);
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.flush();
	}

	private send(destination: Destination, record: LogRecord): void {
		const url = this.urls[destination];
		if (!url || this.closed) return;
		const content = webhookMessage(
			this.redact(record.message),
			record.level,
			this.serialize(record),
		);
		const delivery = this.deliver(destination, url, content).finally(() => {
			this.pending.delete(delivery);
		});
		this.pending.add(delivery);
	}

	private serialize(details: unknown): string {
		const seen = new WeakSet<object>();
		const text = JSON.stringify(
			details,
			(key, value: unknown) => {
				if (/token|secret|password|authorization/i.test(key)) return "[redacted]";
				if (/^(content|stripped|body|requestBody)$/.test(key)) return "[omitted]";
				if (typeof value === "bigint") return String(value);
				if (value && typeof value === "object") {
					if (seen.has(value)) return "[circular]";
					seen.add(value);
					if (value instanceof Error) return { name: value.name, message: value.message };
				}
				return value;
			},
			2,
		);
		return this.redact(text);
	}

	private redact(text: string): string {
		for (const secret of this.secrets) text = text.replaceAll(secret, "[redacted]");
		return text.replace(
			/https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/[^\s"\\]+/g,
			"[redacted webhook]",
		);
	}

	private async deliver(destination: Destination, url: string, content: string): Promise<void> {
		try {
			const endpoint = new URL(url);
			endpoint.searchParams.set("wait", "true");
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
				signal: AbortSignal.timeout(5_000),
				redirect: "error",
			});
			await response.body?.cancel();
			if (!response.ok) {
				log.warn("webhook delivery failed", { destination, status: response.status });
			}
		} catch {
			// Fetch errors can contain the secret webhook URL. Never log the raw error.
			log.warn("webhook delivery failed", { destination, reason: "network_or_timeout" });
		}
	}
}
