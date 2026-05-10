import { createHash } from "node:crypto";
import RSSParser from "rss-parser";
import { z } from "zod";
import type { AlertItem } from "./copy.js";
import type { DB } from "./db.js";
import { childLogger } from "./log.js";

const log = childLogger("poller");

export interface NewAlert extends AlertItem {
	guid: string;
}

const parser = new RSSParser({ timeout: 15_000 });

// rss-parser's types are compile-time only; validate the upstream XML at the boundary.
const RssItem = z
	.object({
		guid: z.string().optional(),
		link: z.string().optional(),
		title: z.string().optional(),
		pubDate: z.string().optional(),
		isoDate: z.string().optional(),
	})
	.loose();

const RssFeed = z
	.object({
		items: z.array(RssItem),
	})
	.loose();

type RssItemShape = z.infer<typeof RssItem>;

function deriveGuid(item: RssItemShape): string {
	if (item.guid?.trim()) return item.guid.trim();
	const basis = `${item.link ?? ""}|${item.pubDate ?? ""}|${item.title ?? ""}`;
	return createHash("sha1").update(basis).digest("hex");
}

async function fetchFeed(url: string): Promise<NewAlert[]> {
	const raw = await parser.parseURL(url);
	const feed = RssFeed.parse(raw);
	return feed.items.map((item) => ({
		guid: deriveGuid(item),
		title: item.title ?? "(untitled)",
		link: item.link ?? "",
		pubDate: item.pubDate ?? item.isoDate ?? "",
	}));
}

export async function pollOnce(args: {
	db: DB;
	url: string;
	onNewAlert: (alert: NewAlert) => Promise<void> | void;
}): Promise<NewAlert[]> {
	const items = await fetchFeed(args.url);
	const fresh: NewAlert[] = [];
	// Oldest → newest so multiple new items dispatch in chronological order.
	for (const item of [...items].reverse()) {
		if (args.db.hasSeenAlert(item.guid)) continue;
		args.db.recordSeenAlert({
			guid: item.guid,
			title: item.title,
			link: item.link,
			pub_date: item.pubDate,
		});
		args.db.recordEvent({
			kind: "alert_seen",
			payload: { guid: item.guid, title: item.title, link: item.link, pubDate: item.pubDate },
		});
		log.info("alert seen", {
			guid: item.guid,
			title: item.title,
			pubDate: item.pubDate,
		});
		fresh.push(item);
		await args.onNewAlert(item);
	}
	return fresh;
}
