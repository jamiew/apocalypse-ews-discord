// Boundary with the Xpoz social-data API, which is where this bot gets the
// source account's posts. The SDK types every field as optional, nullable and
// index-signature'd — which is honest, since it is relaying a scrape — so
// nothing crosses into the rest of the bot without going through Zod first.

import { ResponseType, XpozClient } from "@xpoz/xpoz";
import { z } from "zod";
import { childLogger } from "../log.js";

const log = childLogger("xpoz");

const PostSchema = z
	.object({
		id: z.union([z.string(), z.number()]).transform(String),
		text: z.string(),
		authorUsername: z.string().nullish(),
		createdAt: z.union([z.string(), z.number()]).nullish(),
		isRetweet: z.boolean().nullish(),
		deleted: z.boolean().nullish(),
		replyToUsername: z.string().nullish(),
	})
	.loose();

export type XpozPost = z.infer<typeof PostSchema>;

export interface SourcePost {
	id: string;
	text: string;
	authorUsername: string | null;
	/** ISO-8601, or null when upstream gave us something unparseable. */
	postedAt: string | null;
	isRetweet: boolean;
	replyToUsername: string | null;
}

/** The only thing the poller needs. Tests supply their own implementation. */
export interface PostSource {
	recentPosts(limit: number): Promise<SourcePost[]>;
	close(): Promise<void>;
}

const FIELDS = [
	"id",
	"text",
	"authorUsername",
	"createdAt",
	"isRetweet",
	"deleted",
	"replyToUsername",
];

function toIso(value: string | number | null | undefined): string | null {
	if (value == null) return null;
	const date = new Date(typeof value === "number" ? value : value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizePost(raw: unknown): SourcePost | null {
	const parsed = PostSchema.safeParse(raw);
	if (!parsed.success) {
		log.warn("discarding unparseable post", { issues: parsed.error.issues });
		return null;
	}
	const post = parsed.data;
	if (post.deleted === true) return null;
	return {
		id: post.id,
		text: post.text,
		authorUsername: post.authorUsername ?? null,
		postedAt: toIso(post.createdAt),
		isRetweet: post.isRetweet === true,
		replyToUsername: post.replyToUsername ?? null,
	};
}

/** Newest first, matching how the API returns them. */
export function normalizePosts(raw: readonly unknown[]): SourcePost[] {
	return raw.map(normalizePost).filter((p): p is SourcePost => p !== null);
}

/**
 * Connects lazily and reconnects after a failed call: this runs inside a cron
 * tick in a process that stays up for weeks, so a dropped transport must not
 * wedge the poller permanently.
 */
export function createXpozSource(args: {
	apiKey: string;
	username: string;
	serverUrl?: string | undefined;
	timeoutMs?: number | undefined;
}): PostSource {
	let client: XpozClient | null = null;

	const connect = async (): Promise<XpozClient> => {
		if (client) return client;
		const fresh = new XpozClient({
			apiKey: args.apiKey,
			versionCheck: false,
			...(args.serverUrl ? { serverUrl: args.serverUrl } : {}),
			...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
		});
		await fresh.connect();
		client = fresh;
		log.info("connected", { username: args.username });
		return fresh;
	};

	const drop = async (): Promise<void> => {
		const stale = client;
		client = null;
		await stale?.close().catch(() => {});
	};

	return {
		async recentPosts(limit: number): Promise<SourcePost[]> {
			try {
				const connected = await connect();
				const page = await connected.twitter.getPostsByAuthor(args.username, {
					fields: FIELDS,
					limit,
					responseType: ResponseType.Fast,
					forceLatest: true,
				});
				return normalizePosts(page.data);
			} catch (err) {
				// Force a fresh transport on the next tick rather than reusing a
				// half-open one.
				await drop();
				throw err;
			}
		},
		close: drop,
	};
}
