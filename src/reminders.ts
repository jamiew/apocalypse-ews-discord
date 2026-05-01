import type { Client } from "discord.js";
import { ANNUAL_REMINDER } from "./copy.js";
import type { DB } from "./db.js";
import { sendToSubscriber } from "./discord.js";
import { childLogger } from "./log.js";

const log = childLogger("reminders");

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
		const eventBase = {
			guildId: sub.guild_id,
			channelId: sub.kind === "guild_channel" ? sub.discord_id : null,
			userId: sub.kind === "dm" ? sub.discord_id : null,
		};
		try {
			await sendToSubscriber(args.client, sub, ANNUAL_REMINDER);
			args.db.stampReminded(sub.id, now.toISOString());
			args.db.recordEvent({
				kind: "reminder_ok",
				...eventBase,
				payload: { kind: sub.kind, subscribedAt: sub.subscribed_at },
			});
			sent++;
		} catch (err) {
			failed++;
			log.error("reminder failed", { err, kind: sub.kind, address: sub.discord_id });
			args.db.recordEvent({
				kind: "reminder_fail",
				...eventBase,
				payload: { kind: sub.kind, err },
			});
		}
	}
	return { sent, failed };
}
