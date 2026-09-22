import cron from "node-cron";
import { childLogger } from "../log.js";
import { PizzaDB } from "./db.js";
import { createClient, fanOutSignalChange } from "./discord.js";
import { loadPizzaEnv } from "./env.js";
import { pollPizzaOnce } from "./poller.js";
import { createXpozSource } from "./xpoz.js";

const log = childLogger("pizza-boot");

async function main() {
	const env = loadPizzaEnv();
	const db = new PizzaDB(env.DATABASE_PATH);
	const deps = {
		db,
		devAdminUserId: env.DEV_ADMIN_USER_ID,
		operatorUserId: env.OPERATOR_USER_ID,
	};
	const client = createClient(deps);
	const source = createXpozSource({
		apiKey: env.XPOZ_API_KEY,
		username: env.PIZZA_ACCOUNT,
		serverUrl: env.XPOZ_SERVER_URL,
	});

	await client.login(env.DISCORD_TOKEN);
	log.info("started", {
		account: env.PIZZA_ACCOUNT,
		poll: env.POLL_CRON,
		minAlertLevel: env.PIZZA_MIN_ALERT_LEVEL,
	});
	db.recordEvent({
		kind: "startup",
		payload: {
			account: env.PIZZA_ACCOUNT,
			poll: env.POLL_CRON,
			minAlertLevel: env.PIZZA_MIN_ALERT_LEVEL,
		},
	});

	const pollLog = childLogger("pizza-poll");
	const pollTask = cron.schedule(env.POLL_CRON, async () => {
		try {
			const result = await pollPizzaOnce({
				db,
				source,
				limit: env.PIZZA_FETCH_LIMIT,
				minAlertLevel: env.PIZZA_MIN_ALERT_LEVEL,
				onSignalChange: async (change) => {
					const fanout = await fanOutSignalChange(client, deps, change);
					pollLog.info("signal dispatched", {
						level: change.level,
						prevLevel: change.prevLevel,
						postId: change.postId,
						...fanout,
					});
				},
			});
			if (result.fresh === 0) pollLog.debug("poll: no new posts");
		} catch (err) {
			pollLog.error("poll error", { err });
			db.recordEvent({ kind: "poll_fail", payload: { err } });
		}
	});

	const shutdown = async (signal: string) => {
		log.info("shutting down", { signal });
		db.recordEvent({ kind: "shutdown", payload: { signal } });
		pollTask.stop();
		await source.close().catch(() => {});
		await client.destroy().catch(() => {});
		db.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
	childLogger("pizza-boot").error("fatal", { err });
	process.exit(1);
});
