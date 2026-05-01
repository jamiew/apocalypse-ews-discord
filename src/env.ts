import { z } from "zod";

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID is required"),
  DEV_ADMIN_USER_ID: z.string().optional(),
  DATABASE_PATH: z.string().default("./data/ews.db"),
  EWS_RSS_URL: z.url().default("https://ews.kylemcdonald.net/rss.xml"),
  POLL_CRON: z.string().default("*/30 * * * *"),
  REMINDER_CRON: z.string().default("0 13 * * *"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid environment:\n${issues}`);
  }
  return parsed.data;
}
