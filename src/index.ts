import cron from "node-cron";
import { DB } from "./db.js";
import { createClient, fanOutAlert } from "./discord.js";
import { loadEnv } from "./env.js";
import { pollOnce } from "./poller.js";
import { sendDueReminders } from "./reminders.js";

async function main() {
  const env = loadEnv();
  const db = new DB(env.DATABASE_PATH);
  const deps = { db, devAdminUserId: env.DEV_ADMIN_USER_ID };
  const client = createClient(deps);

  await client.login(env.DISCORD_TOKEN);

  // RSS poll → fan out new items.
  const pollTask = cron.schedule(env.POLL_CRON, async () => {
    try {
      const fresh = await pollOnce({
        db,
        url: env.EWS_RSS_URL,
        onNewAlert: async (alert) => {
          const result = await fanOutAlert(client, deps, alert);
          console.log(`alert ${alert.guid}: sent=${result.sent} failed=${result.failed}`);
        },
      });
      if (fresh.length === 0) {
        console.log("poll: no new items");
      }
    } catch (err) {
      console.error("poll error", err);
    }
  });

  // Daily annual-reminder sweep.
  const reminderTask = cron.schedule(env.REMINDER_CRON, async () => {
    try {
      const result = await sendDueReminders({ db, client });
      if (result.sent || result.failed) {
        console.log(`reminders: sent=${result.sent} failed=${result.failed}`);
      }
    } catch (err) {
      console.error("reminder error", err);
    }
  });

  const shutdown = (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    pollTask.stop();
    reminderTask.stop();
    client.destroy().catch(() => {});
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
