import { childLogger } from "../log.js";
import { postUrl, signalChangePayload } from "./copy.js";
import type { PizzaDB, SignalChange, SignalSnapshot } from "./db.js";
import { classifyPost, isReportablePost, type SignalLevel } from "./signal.js";
import type { PostSource, SourcePost } from "./xpoz.js";

const log = childLogger("pizza-poller");

export type SuppressReason = "below_floor" | "first_observation" | "unchanged";

export type AnnounceDecision = { announce: true } | { announce: false; reason: SuppressReason };

/**
 * The source account posts in bursts and most posts are routine. Announcing
 * every one would train people to mute the channel, so a transition only goes
 * out when it crosses, moves within, or falls out of the alert band.
 *
 * The first observation is deliberately silent, matching the EWS bot: a booting
 * process is not a change in the world. `/status` and `/latest` cover it.
 */
export function shouldAnnounce(args: {
	prevLevel: SignalLevel | null;
	nextLevel: SignalLevel;
	minAlertLevel: number;
}): AnnounceDecision {
	if (args.prevLevel == null) return { announce: false, reason: "first_observation" };
	if (args.prevLevel === args.nextLevel) return { announce: false, reason: "unchanged" };
	if (args.nextLevel >= args.minAlertLevel) return { announce: true };
	// Falling out of the alert band is worth saying once — it is the stand-down.
	if (args.prevLevel >= args.minAlertLevel) return { announce: true };
	return { announce: false, reason: "below_floor" };
}

function asLevel(value: number | null): SignalLevel | null {
	if (value == null) return null;
	return value >= 1 && value <= 5 ? (value as SignalLevel) : null;
}

/** Oldest first, so a burst of new posts is ingested in the order it happened. */
export function orderOldestFirst(posts: readonly SourcePost[]): SourcePost[] {
	return [...posts].sort((a, b) => {
		const at = a.postedAt ? Date.parse(a.postedAt) : Number.NaN;
		const bt = b.postedAt ? Date.parse(b.postedAt) : Number.NaN;
		if (Number.isNaN(at) || Number.isNaN(bt)) return a.id.localeCompare(b.id);
		if (at !== bt) return at - bt;
		return a.id.localeCompare(b.id);
	});
}

export interface PollResult {
	fetched: number;
	fresh: number;
	change: SignalChange | null;
}

/**
 * One tick: fetch, record every unseen post, then let the newest readable one
 * set the signal. Intermediate posts inside a single burst update state but do
 * not each fire a dispatch — subscribers get the conclusion, not the thread.
 */
export async function pollPizzaOnce(args: {
	db: PizzaDB;
	source: PostSource;
	limit?: number;
	minAlertLevel: number;
	onSignalChange: (change: SignalChange) => Promise<void> | void;
}): Promise<PollResult> {
	const posts = await args.source.recentPosts(args.limit ?? 25);
	const fresh = orderOldestFirst(posts).filter((p) => !args.db.hasSeenPost(p.id));

	let latest: SignalSnapshot | null = null;

	for (const post of fresh) {
		if (!isReportablePost(post)) {
			args.db.recordSeenPost({
				postId: post.id,
				text: post.text,
				postedAt: post.postedAt,
				level: null,
				pizza: null,
				bar: null,
			});
			args.db.recordEvent({
				kind: "post_skipped",
				payload: { postId: post.id, reason: "not_reportable" },
			});
			continue;
		}

		const signal = classifyPost(post.text);
		const level = signal.readable ? signal.level : null;

		args.db.recordSeenPost({
			postId: post.id,
			text: post.text,
			postedAt: post.postedAt,
			level,
			pizza: signal.pizza,
			bar: signal.bar,
		});
		args.db.recordEvent({
			kind: "post_seen",
			payload: {
				postId: post.id,
				text: post.text,
				postedAt: post.postedAt,
				level,
				pizza: signal.pizza,
				bar: signal.bar,
			},
		});
		log.info("post seen", { postId: post.id, level, pizza: signal.pizza, bar: signal.bar });

		if (!signal.readable) {
			args.db.recordEvent({
				kind: "post_skipped",
				payload: { postId: post.id, reason: "unreadable" },
			});
			continue;
		}

		latest = {
			level: signal.level,
			pizza: signal.pizza,
			bar: signal.bar,
			postId: post.id,
			postText: post.text,
			postedAt: post.postedAt,
			url: postUrl(post.id),
		};
	}

	if (!latest) return { fetched: posts.length, fresh: fresh.length, change: null };

	const prevLevel = asLevel(args.db.getSignalState().level);
	args.db.setSignalState(latest);

	const decision = shouldAnnounce({
		prevLevel,
		nextLevel: latest.level,
		minAlertLevel: args.minAlertLevel,
	});
	if (!decision.announce) {
		args.db.recordEvent({
			kind: "signal_suppressed",
			payload: {
				level: latest.level,
				prevLevel,
				postId: latest.postId,
				reason: decision.reason,
			},
		});
		log.info("signal suppressed", { level: latest.level, prevLevel, reason: decision.reason });
		return { fetched: posts.length, fresh: fresh.length, change: null };
	}

	const change: SignalChange = { ...latest, prevLevel };
	args.db.recordEvent({
		kind: "signal_change",
		payload: {
			level: change.level,
			prevLevel,
			pizza: change.pizza,
			bar: change.bar,
			postId: change.postId,
			body: signalChangePayload(change),
		},
	});
	await args.onSignalChange(change);
	return { fetched: posts.length, fresh: fresh.length, change };
}
