import type { Client } from "discord.js";
import { ANNUAL_REMINDER } from "./copy.js";
import { type DB, type PruneReason, subscriberAddress } from "./db.js";
import { pruneIfDead, reportPruned, sendToSubscriber } from "./discord.js";
import { childLogger } from "./log.js";

const log = childLogger("reminders");

// Per-subscriber failures are recorded and swallowed — never throws.
export async function sendDueReminders(args: {
	db: DB;
	client: Client;
	now?: Date;
}): Promise<{ sent: number; failed: number }> {
	const now = args.now ?? new Date();
	const due = args.db.selectDueForReminder(now);
	const pruned: PruneReason[] = [];
	let sent = 0;
	let failed = 0;
	for (const sub of due) {
		const where = subscriberAddress(sub);
		try {
			await sendToSubscriber(args.client, sub, ANNUAL_REMINDER);
			args.db.stampReminded(sub.id, now.toISOString());
			args.db.recordEvent({
				kind: "reminder_ok",
				...where,
				payload: { kind: sub.kind, subscribedAt: sub.subscribed_at },
			});
			sent++;
		} catch (err) {
			failed++;
			args.db.recordEvent({
				kind: "reminder_fail",
				...where,
				payload: { kind: sub.kind, err },
			});
			const reason = pruneIfDead(args.client, args.db, sub, err);
			if (reason) pruned.push(reason);
			else log.error("reminder failed", { err, kind: sub.kind, address: sub.discord_id });
		}
	}
	reportPruned("reminder", pruned);
	return { sent, failed };
}
