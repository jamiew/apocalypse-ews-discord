import cron from "node-cron";
import { DB } from "./db.js";
import { createClient, fanOutAlert, fanOutLevelChange } from "./discord.js";
import { loadEnv } from "./env.js";
import { sendHeartbeat } from "./heartbeat.js";
import { pollLevelOnce } from "./level-poller.js";
import { childLogger } from "./log.js";
import { pollOnce } from "./poller.js";
import { sendDueReminders } from "./reminders.js";

const log = childLogger("boot");

async function main() {
	const env = loadEnv();
	const db = new DB(env.DATABASE_PATH);
	const deps = {
		db,
		devAdminUserId: env.DEV_ADMIN_USER_ID,
		operatorUserId: env.OPERATOR_USER_ID,
	};
	const client = createClient(deps);

	await client.login(env.DISCORD_TOKEN);
	log.info("started", {
		rss: env.EWS_RSS_URL,
		dashboard: env.EWS_DASHBOARD_URL,
		poll: env.POLL_CRON,
	});
	db.recordEvent({
		kind: "startup",
		payload: { rss: env.EWS_RSS_URL, dashboard: env.EWS_DASHBOARD_URL },
	});

	const pollLog = childLogger("poller");
	const pollTask = cron.schedule(env.POLL_CRON, async () => {
		try {
			const fresh = await pollOnce({
				db,
				url: env.EWS_RSS_URL,
				onNewAlert: async (alert) => {
					const result = await fanOutAlert(client, deps, alert);
					pollLog.info("alert dispatched", { guid: alert.guid, ...result });
				},
			});
			if (fresh.length === 0) pollLog.debug("rss poll: no new items");
		} catch (err) {
			pollLog.error("rss poll error", { err });
		}
	});

	const levelLog = childLogger("level");
	const levelTask = cron.schedule(env.POLL_CRON, async () => {
		try {
			const change = await pollLevelOnce({
				db,
				url: env.EWS_DASHBOARD_URL,
				onLevelChange: async (c) => {
					const result = await fanOutLevelChange(client, deps, c);
					levelLog.info("level dispatched", {
						level: c.level,
						prevLevel: c.prevLevel,
						...result,
					});
				},
			});
			if (!change) levelLog.debug("level poll: no change");
		} catch (err) {
			levelLog.error("level poll error", { err });
		}
	});

	const reminderLog = childLogger("reminders");
	const reminderTask = cron.schedule(env.REMINDER_CRON, async () => {
		try {
			const result = await sendDueReminders({ db, client });
			if (result.sent || result.failed) reminderLog.info("reminder sweep", result);
		} catch (err) {
			reminderLog.error("reminder error", { err });
		}
	});

	const heartbeatLog = childLogger("heartbeat");
	const heartbeatTask = cron.schedule(env.HEARTBEAT_CRON, async () => {
		try {
			const result = await sendHeartbeat({ db, client });
			if (result.fired) {
				heartbeatLog.info("heartbeat dispatched", { sent: result.sent, failed: result.failed });
			} else {
				heartbeatLog.info("heartbeat skipped", { reason: result.reason });
			}
		} catch (err) {
			heartbeatLog.error("heartbeat error", { err });
		}
	});

	const shutdown = async (signal: string) => {
		log.info("shutting down", { signal });
		db.recordEvent({ kind: "shutdown", payload: { signal } });
		pollTask.stop();
		levelTask.stop();
		reminderTask.stop();
		heartbeatTask.stop();
		await client.destroy().catch(() => {});
		db.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
	childLogger("boot").error("fatal", { err });
	process.exit(1);
});
