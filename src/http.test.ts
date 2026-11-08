import { afterEach, describe, expect, it } from "bun:test";
import { fetchTextCapped } from "./http.js";

const ORIGINAL_FETCH = globalThis.fetch;

function serve(res: () => Response) {
	globalThis.fetch = (async () => res()) as unknown as typeof fetch;
}

function chunked(parts: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const p of parts) controller.enqueue(enc.encode(p));
			controller.close();
		},
	});
}

describe("fetchTextCapped", () => {
	afterEach(() => {
		globalThis.fetch = ORIGINAL_FETCH;
	});

	it("returns a body exactly at the cap", async () => {
		serve(() => new Response(chunked(["abcd", "efgh"])));
		expect(await fetchTextCapped("u", { label: "t", maxBytes: 8 })).toBe("abcdefgh");
	});

	it("rejects a streamed body that crosses the cap without a content-length", async () => {
		serve(() => new Response(chunked(["abcd", "efgh", "i"])));
		await expect(fetchTextCapped("u", { label: "t", maxBytes: 8 })).rejects.toThrow(
			"t body exceeds 8 bytes",
		);
	});

	it("rejects up front when content-length declares an oversized body", async () => {
		serve(() => new Response("small", { headers: { "content-length": "9999" } }));
		await expect(fetchTextCapped("u", { label: "t", maxBytes: 8 })).rejects.toThrow(
			"t body exceeds 8 bytes",
		);
	});
});
