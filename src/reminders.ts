import type { Client } from "discord.js";
import { ANNUAL_REMINDER } from "./copy.js";
import type { DB } from "./db.js";
import { sendToSubscriber } from "./discord.js";

export async function sendDueReminders(args: {
  db: DB;
  client: Client;
  now?: Date;
}): Promise<{ sent: number; failed: number }> {
  const now = args.now ?? new Date();
  const due = args.db.selectDueForReminder(now);
  let sent = 0;
  let failed = 0;
  for (const sub of due) {
    try {
      await sendToSubscriber(args.client, sub, ANNUAL_REMINDER);
      args.db.stampReminded(sub.id, now.toISOString());
      sent++;
    } catch (err) {
      failed++;
      console.error(`reminder failed: kind=${sub.kind} id=${sub.discord_id}`, err);
    }
  }
  return { sent, failed };
}
