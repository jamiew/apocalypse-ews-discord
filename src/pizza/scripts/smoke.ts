// Live read against the Xpoz API. Proves the ingest path end to end without
// touching Discord: connect, fetch, validate, classify. Prints what the bot
// would have made of each post.
//
//   XPOZ_API_KEY=... bun run pizza:smoke
//
// Reads only. Never writes to the database and never dispatches.

import { describeBusyness, postUrl } from "../copy.js";
import { classifyPost, isReportablePost } from "../signal.js";
import { createXpozSource } from "../xpoz.js";

const apiKey = process.env["XPOZ_API_KEY"];
const account = process.env["PIZZA_ACCOUNT"] ?? "PenPizzaReport";
const limit = Number(process.env["PIZZA_FETCH_LIMIT"] ?? 10);

if (!apiKey) {
	process.stderr.write("XPOZ_API_KEY is required\n");
	process.exit(1);
}

const source = createXpozSource({ apiKey, username: account });

try {
	const posts = await source.recentPosts(limit);
	process.stdout.write(`fetched ${posts.length} posts from @${account}\n\n`);

	for (const post of posts) {
		const reportable = isReportablePost(post);
		const signal = classifyPost(post.text);
		const verdict = !reportable
			? "skipped (retweet or outward reply)"
			: signal.readable
				? `level ${signal.level} — pizza ${describeBusyness(signal.pizza)}, bar ${describeBusyness(signal.bar)}, score ${signal.score}`
				: "skipped (no venue reading)";

		process.stdout.write(`${post.postedAt ?? "undated"}  ${verdict}\n`);
		process.stdout.write(`  ${post.text.replace(/\s+/g, " ").slice(0, 150)}\n`);
		process.stdout.write(`  ${postUrl(post.id)}\n\n`);
	}
} finally {
	await source.close();
}
