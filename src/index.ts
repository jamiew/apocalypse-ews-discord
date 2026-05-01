import cron from "node-cron";
import { DB } from "./db.js";
import { createClient, fanOutAlert } from "./discord.js";
import { loadEnv } from "./env.js";
import { childLogger } from "./log.js";
import { pollOnce } from "./poller.js";
import { sendDueReminders } from "./reminders.js";

const log = childLogger("boot");

async function main() {
  const env = loadEnv();
  const db = new DB(env.DATABASE_PATH);
  const deps = { db, devAdminUserId: env.DEV_ADMIN_USER_ID };
  const client = createClient(deps);

  await client.login(env.DISCORD_TOKEN);
  log.info({ rss: env.EWS_RSS_URL, poll: env.POLL_CRON }, "started");

  const pollLog = childLogger("poller");
  const pollTask = cron.schedule(env.POLL_CRON, async () => {
    try {
      const fresh = await pollOnce({
        db,
        url: env.EWS_RSS_URL,
        onNewAlert: async (alert) => {
          const result = await fanOutAlert(client, deps, alert);
          pollLog.info({ guid: alert.guid, ...result }, "alert dispatched");
        },
      });
      if (fresh.length === 0) pollLog.debug("poll: no new items");
    } catch (err) {
      pollLog.error({ err }, "poll error");
    }
  });

  const reminderLog = childLogger("reminders");
  const reminderTask = cron.schedule(env.REMINDER_CRON, async () => {
    try {
      const result = await sendDueReminders({ db, client });
      if (result.sent || result.failed) reminderLog.info(result, "reminder sweep");
    } catch (err) {
      reminderLog.error({ err }, "reminder error");
    }
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    pollTask.stop();
    reminderTask.stop();
    await client.destroy().catch(() => {});
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  childLogger("boot").fatal({ err }, "fatal");
  process.exit(1);
});
