import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DB } from "./db.js";
import { pollOnce } from "./poller.js";

const ORIGINAL_FETCH = globalThis.fetch;

function serveFeed(items: Array<{ guid?: string; title: string; link: string; pubDate: string }>) {
	const xml = [
		'<?xml version="1.0"?><rss version="2.0"><channel><title>Apocalypse Early Warning System</title>',
		...items.map(
			(i) =>
				`<item>${i.guid ? `<guid>${i.guid}</guid>` : ""}<title>${i.title}</title><link>${i.link}</link><pubDate>${i.pubDate}</pubDate></item>`,
		),
		"</channel></rss>",
	].join("");
	globalThis.fetch = (async () => new Response(xml)) as unknown as typeof fetch;
}

describe("pollOnce", () => {
	let db: DB;

	beforeEach(() => {
		db = new DB(":memory:");
	});

	afterEach(() => {
		db.close();
		globalThis.fetch = ORIGINAL_FETCH;
	});

	it("emits new items once and skips them on the next poll", async () => {
		const item = {
			guid: "https://example.com/alert/1",
			title: "Emergency level 5.",
			link: "https://example.com/alert/1",
			pubDate: "Thu, 30 Apr 2026 12:00:00 GMT",
		};
		serveFeed([item]);

		const seen: string[] = [];
		const first = await pollOnce({
			db,
			url: "https://example.com/rss.xml",
			onNewAlert: (a) => void seen.push(a.guid),
		});
		expect(first).toHaveLength(1);
		expect(seen).toEqual([item.guid]);

		const second = await pollOnce({
			db,
			url: "https://example.com/rss.xml",
			onNewAlert: (a) => void seen.push(a.guid),
		});
		expect(second).toHaveLength(0);
		expect(seen).toEqual([item.guid]);
	});

	it("dispatches multiple new items oldest-first", async () => {
		const newer = {
			guid: "g-newer",
			title: "Newer alert.",
			link: "https://example.com/2",
			pubDate: "Thu, 30 Apr 2026 13:00:00 GMT",
		};
		const older = {
			guid: "g-older",
			title: "Older alert.",
			link: "https://example.com/1",
			pubDate: "Thu, 30 Apr 2026 12:00:00 GMT",
		};
		// RSS feeds list newest-first; poller should deliver oldest-first.
		serveFeed([newer, older]);

		const seen: string[] = [];
		await pollOnce({
			db,
			url: "https://example.com/rss.xml",
			onNewAlert: (a) => void seen.push(a.guid),
		});
		expect(seen).toEqual(["g-older", "g-newer"]);
	});

	it("derives a stable guid when the feed omits one", async () => {
		const item = {
			title: "Alert without guid.",
			link: "https://example.com/x",
			pubDate: "Thu, 30 Apr 2026 12:00:00 GMT",
		};
		serveFeed([item]);

		const seen: string[] = [];
		await pollOnce({
			db,
			url: "https://example.com/rss.xml",
			onNewAlert: (a) => void seen.push(a.guid),
		});
		await pollOnce({
			db,
			url: "https://example.com/rss.xml",
			onNewAlert: (a) => void seen.push(a.guid),
		});
		expect(seen).toHaveLength(1);
	});
});
