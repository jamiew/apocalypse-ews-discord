import { type Logger, pino } from "pino";

/**
 * Process-wide structured logger. JSON to stdout in production; pino-pretty in
 * dev. Use {@link childLogger} to namespace by module — that way operators can
 * grep `module=poller` etc.
 */
export const log: Logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: "apocalypse-ews-bot" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(process.env.NODE_ENV === "production"
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", singleLine: false },
        },
      }),
});

/** Returns a child logger with `module` bound on every record. */
export function childLogger(module: string): Logger {
  return log.child({ module });
}
