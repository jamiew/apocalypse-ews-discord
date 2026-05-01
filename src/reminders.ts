import type { Client } from "discord.js";
import { ANNUAL_REMINDER } from "./copy.js";
import type { DB, Subscriber } from "./db.js";

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
      await sendReminder(args.client, sub);
      args.db.stampReminded(sub.id, now.toISOString());
      sent++;
    } catch (err) {
      failed++;
      console.error(`reminder failed: kind=${sub.kind} id=${sub.discord_id}`, err);
    }
  }
  return { sent, failed };
}

async function sendReminder(client: Client, sub: Subscriber): Promise<void> {
  if (sub.kind === "dm") {
    const user = await client.users.fetch(sub.discord_id);
    await user.send(ANNUAL_REMINDER);
    return;
  }
  const channel = await client.channels.fetch(sub.discord_id);
  if (!channel || !("send" in channel) || typeof channel.send !== "function") {
    throw new Error("channel not sendable");
  }
  await (channel as { send: (s: string) => Promise<unknown> }).send(ANNUAL_REMINDER);
}
