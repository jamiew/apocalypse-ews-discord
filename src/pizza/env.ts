import { z } from "zod";

const schema = z.object({
	DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
	DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID is required"),
	XPOZ_API_KEY: z.string().min(1, "XPOZ_API_KEY is required"),
	// Override only to point at a non-default Xpoz deployment.
	XPOZ_SERVER_URL: z.url().optional(),
	DEV_ADMIN_USER_ID: z.string().optional(),
	// Falls back to DEV_ADMIN_USER_ID when unset.
	OPERATOR_USER_ID: z.string().optional(),
	// Set for instant slash-command propagation in dev; unset = global (~1h).
	TEST_GUILD_ID: z.string().optional(),
	DATABASE_PATH: z.string().default("./data/pizza.db"),
	PIZZA_ACCOUNT: z.string().min(1).default("PenPizzaReport"),
	// How many recent posts to pull per tick. The account posts in bursts, so
	// this needs headroom over the poll interval.
	PIZZA_FETCH_LIMIT: z.coerce.number().int().min(1).max(300).default(25),
	// Floor for fan-out. Below this, transitions are recorded but not announced.
	PIZZA_MIN_ALERT_LEVEL: z.coerce.number().int().min(1).max(5).default(3),
	POLL_CRON: z.string().default("*/15 * * * *"),
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
	LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
	// Empty string disables file output.
	LOG_FILE: z.string().optional(),
});

export type PizzaEnv = z.infer<typeof schema>;

export function loadPizzaEnv(): PizzaEnv {
	const parsed = schema.safeParse(process.env);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `  - ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		throw new Error(`invalid environment:\n${issues}`);
	}
	return parsed.data;
}
