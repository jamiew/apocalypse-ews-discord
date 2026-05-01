import { createHash } from "node:crypto";
import RSSParser from "rss-parser";
import type { AlertItem } from "./copy.js";
import type { DB } from "./db.js";

export interface NewAlert extends AlertItem {
	guid: string;
}

const parser = new RSSParser({ timeout: 15_000 });

// Falls back to a hash if the feed item omits <guid>.
function deriveGuid(item: {
	guid?: string;
	link?: string;
	pubDate?: string;
	title?: string;
}): string {
	if (item.guid?.trim()) return item.guid.trim();
	const basis = `${item.link ?? ""}|${item.pubDate ?? ""}|${item.title ?? ""}`;
	return createHash("sha1").update(basis).digest("hex");
}

export async function fetchFeed(url: string): Promise<NewAlert[]> {
	const feed = await parser.parseURL(url);
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
	// Iterate oldest → newest so multiple new items dispatch in chronological order.
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
		fresh.push(item);
		await args.onNewAlert(item);
	}
	return fresh;
}
