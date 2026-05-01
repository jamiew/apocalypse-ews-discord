import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Log severities. Lower number = noisier. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const NODE_ENV = process.env.NODE_ENV ?? "development";
const IS_TEST = NODE_ENV === "test";
const IS_PROD = NODE_ENV === "production";

const MIN_LEVEL: LogLevel = isLevel(process.env.LOG_LEVEL)
	? process.env.LOG_LEVEL
	: IS_TEST
		? "error"
		: "info";

// In tests we never write a file. Otherwise default to ./data/ews.log so
// `LOG_FILE` is opt-out, not opt-in. Set LOG_FILE="" to disable.
const LOG_FILE: string | undefined = IS_TEST
	? undefined
	: process.env.LOG_FILE !== undefined
		? process.env.LOG_FILE || undefined
		: "./data/ews.log";

if (LOG_FILE) {
	try {
		mkdirSync(dirname(LOG_FILE), { recursive: true });
	} catch {
		// best-effort; if we can't create it, we'll just log to stdout
	}
}

const ANSI = {
	debug: "\x1b[90m", // grey
	info: "\x1b[36m", // cyan
	warn: "\x1b[33m", // yellow
	error: "\x1b[31m", // red
	reset: "\x1b[0m",
} as const;

function isLevel(value: unknown): value is LogLevel {
	return typeof value === "string" && value in ORDER;
}

function safeStringify(value: unknown): string {
	return JSON.stringify(value, (_key, v) => {
		if (v instanceof Error) {
			return { name: v.name, message: v.message, stack: v.stack };
		}
		return v;
	});
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
	if (ORDER[level] < ORDER[MIN_LEVEL]) return;

	const ts = new Date().toISOString();
	const record = { ts, level, message, ...context };
	const json = safeStringify(record);

	if (LOG_FILE) {
		try {
			appendFileSync(LOG_FILE, `${json}\n`);
		} catch {
			// never let logging take the process down
		}
	}

	if (IS_TEST) return;

	if (IS_PROD) {
		process.stdout.write(`${json}\n`);
		return;
	}

	// Dev: pretty single-line with ANSI color.
	const ctxStr = context && Object.keys(context).length > 0 ? ` ${safeStringify(context)}` : "";
	const tag = level.toUpperCase().padEnd(5);
	process.stdout.write(`${ANSI[level]}${ts} ${tag}${ANSI.reset} ${message}${ctxStr}\n`);
}

/** Logger surface — call sites stay tiny. */
export interface Logger {
	debug(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
	/** Returns a new logger that prepends the given bindings to every record. */
	child(bindings: Record<string, unknown>): Logger;
}

function makeLogger(bindings: Record<string, unknown> = {}): Logger {
	const merge = (ctx?: Record<string, unknown>) =>
		Object.keys(bindings).length === 0 ? ctx : { ...bindings, ...(ctx ?? {}) };
	return {
		debug: (m, c) => emit("debug", m, merge(c)),
		info: (m, c) => emit("info", m, merge(c)),
		warn: (m, c) => emit("warn", m, merge(c)),
		error: (m, c) => emit("error", m, merge(c)),
		child: (extra) => makeLogger({ ...bindings, ...extra }),
	};
}

/** Root application logger. Prefer {@link childLogger} for callers in modules. */
export const log: Logger = makeLogger();

/** Module-scoped logger. Records carry `module=<name>`. */
export function childLogger(module: string): Logger {
	return log.child({ module });
}

/** Best-effort string for an unknown error value. Falls back to `String(err)`. */
export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.stack ?? err.message;
	if (typeof err === "string") return err;
	try {
		return safeStringify(err);
	} catch {
		return String(err);
	}
}
