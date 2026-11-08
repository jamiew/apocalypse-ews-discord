import { z } from "zod";
import { type LevelChange, levelChangePayload } from "./copy.js";
import type { DB } from "./db.js";
import { fetchTextCapped } from "./http.js";
import { childLogger } from "./log.js";

const log = childLogger("level-poller");

// Loose schema — we only read `current.{emergencyLevel, alertLevel, zScore, asOf}`.
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

export async function fetchDashboard(url: string): Promise<DashboardSnapshot> {
	return Dashboard.parse(JSON.parse(await fetchTextCapped(url, { label: "dashboard" })));
}

// First observation is recorded silently — startup shouldn't blast every subscriber.
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
		log.debug("first observation — no announcement", { level: newLevel });
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
