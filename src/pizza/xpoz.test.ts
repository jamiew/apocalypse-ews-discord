import { describe, expect, it } from "bun:test";
import { normalizePost, normalizePosts } from "./xpoz.js";

// Shape taken from a live getTwitterPostsByAuthor response. Every field in the
// SDK's type is optional and nullable, so the boundary has to do the work.
const RAW = {
	id: "2101423055645893111",
	text: "The closest Dominos to the Pentagon is reporting very high traffic.",
	authorUsername: "PenPizzaReport",
	createdAt: "2026-09-19T21:27:53.000Z",
	isRetweet: false,
	deleted: false,
	replyToUsername: null,
	likeCount: 59890,
};

describe("normalizePost", () => {
	it("keeps a well-formed post and normalizes the timestamp", () => {
		expect(normalizePost(RAW)).toEqual({
			id: "2101423055645893111",
			text: "The closest Dominos to the Pentagon is reporting very high traffic.",
			authorUsername: "PenPizzaReport",
			postedAt: "2026-09-19T21:27:53.000Z",
			isRetweet: false,
			replyToUsername: null,
		});
	});

	it("coerces a numeric id to a string", () => {
		expect(normalizePost({ ...RAW, id: 42 })?.id).toBe("42");
	});

	it("accepts an epoch-millis timestamp", () => {
		expect(normalizePost({ ...RAW, createdAt: 1789853273000 })?.postedAt).toBe(
			"2026-09-19T21:27:53.000Z",
		);
	});

	it("drops deleted posts", () => {
		expect(normalizePost({ ...RAW, deleted: true })).toBeNull();
	});

	it("rejects a post with no id or no text", () => {
		expect(normalizePost({ ...RAW, id: null })).toBeNull();
		expect(normalizePost({ ...RAW, text: null })).toBeNull();
		expect(normalizePost({})).toBeNull();
		expect(normalizePost(null)).toBeNull();
	});

	it("tolerates a missing timestamp rather than discarding the post", () => {
		const post = normalizePost({ ...RAW, createdAt: null });
		expect(post?.postedAt).toBeNull();
		expect(post?.id).toBe(RAW.id);
	});

	it("reports an unparseable timestamp as absent", () => {
		expect(normalizePost({ ...RAW, createdAt: "never" })?.postedAt).toBeNull();
	});

	it("normalizes absent optional flags to concrete values", () => {
		const post = normalizePost({ id: "1", text: "hi" });
		expect(post?.isRetweet).toBe(false);
		expect(post?.replyToUsername).toBeNull();
		expect(post?.authorUsername).toBeNull();
	});

	it("keeps unknown extra fields from breaking the parse", () => {
		expect(normalizePost({ ...RAW, somethingNew: { nested: true } })?.id).toBe(RAW.id);
	});
});

describe("normalizePosts", () => {
	it("filters out everything unusable and keeps the rest", () => {
		const posts = normalizePosts([RAW, { ...RAW, id: "2", deleted: true }, {}, null]);
		expect(posts.map((p) => p.id)).toEqual([RAW.id]);
	});

	it("returns an empty array for an empty response", () => {
		expect(normalizePosts([])).toEqual([]);
	});
});
