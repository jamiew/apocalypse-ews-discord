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
		const embed = webhookMessage(
			this.redact(record.message),
			record.level,
			this.serialize(record.context ?? {}),
			record.ts,
			this.redact(
				typeof record.context?.["module"] === "string" ? record.context["module"] : "bot",
			),
		);
		const delivery = this.deliver(destination, url, embed).finally(() => {
			this.pending.delete(delivery);
		});
		this.pending.add(delivery);
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
			if (/^(module|content|stripped|body|requestBody)$/.test(key)) continue;
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

	private async deliver(
		destination: Destination,
		url: string,
		embed: ReturnType<typeof webhookMessage>,
	): Promise<void> {
		try {
			const endpoint = new URL(url);
			endpoint.searchParams.set("wait", "true");
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
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
