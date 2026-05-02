import { z } from "zod";
import { type LevelChange, levelChangePayload } from "./copy.js";
import type { DB } from "./db.js";
import { childLogger } from "./log.js";

const log = childLogger("level-poller");

// The upstream R2 dashboard JSON. Schema is loose-on-purpose — we only read
// `current.{emergencyLevel, alertLevel, zScore, asOf}`. Anything else is
// allowed and ignored.
const Dashboard = z
	.object({
		current: z
			.object({
				emergencyLevel: z.number().int().min(1).max(5),
				alertLevel: z.string().nullable().optional(),
				zScore: z.number().nullable().optional(),
				asOf: z.string(),
			})
			.loose(),
	})
	.loose();

export type DashboardSnapshot = z.infer<typeof Dashboard>;

/** Fetch + Zod-validate the upstream dashboard JSON. Throws on bad shape. */
export async function fetchDashboard(url: string): Promise<DashboardSnapshot> {
	const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw new Error(`dashboard fetch ${res.status} ${res.statusText}`);
	return Dashboard.parse(await res.json());
}

/**
 * One poll of the upstream dashboard. Reads current emergency level,
 * compares to persisted state. If different, persists the new state and
 * fires `onLevelChange` with the transition. Returns the change (or null
 * if no change / first observation).
 *
 * First observation is recorded but does NOT trigger `onLevelChange` —
 * we don't have a "previous" to compare against, and the bot just
 * starting up shouldn't blast every subscriber.
 */
export async function pollLevelOnce(args: {
	db: DB;
	url: string;
	onLevelChange: (change: LevelChange) => Promise<void> | void;
}): Promise<LevelChange | null> {
	const snap = await fetchDashboard(args.url);
	const newLevel = snap.current.emergencyLevel;
	const prev = args.db.getLevelState();

	args.db.setLevelState({
		emergencyLevel: newLevel,
		alertLevel: snap.current.alertLevel ?? null,
		zScore: snap.current.zScore ?? null,
		asOf: snap.current.asOf,
	});

	if (prev.emergency_level == null) {
		log.info("first observation — no announcement", { level: newLevel });
		return null;
	}
	if (prev.emergency_level === newLevel) return null;

	const change: LevelChange = {
		level: newLevel,
		prevLevel: prev.emergency_level,
		alertLevel: snap.current.alertLevel ?? null,
		asOf: snap.current.asOf,
		zScore: snap.current.zScore ?? null,
	};
	args.db.recordEvent({
		kind: "level_change",
		payload: { ...change, body: levelChangePayload(change) },
	});
	await args.onLevelChange(change);
	return change;
}
