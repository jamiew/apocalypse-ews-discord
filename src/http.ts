// The dashboard JSON is ~1 MB and growing; the RSS feed is under 1 KB. Cap bodies well
// above that so a broken or hostile endpoint can't balloon memory, and abort slow responses.
export const MAX_UPSTREAM_BYTES = 16 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;

export async function fetchTextCapped(
	url: string,
	opts: { label: string; maxBytes?: number },
): Promise<string> {
	const maxBytes = opts.maxBytes ?? MAX_UPSTREAM_BYTES;
	const res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`${opts.label} fetch ${res.status} ${res.statusText}`);
	const tooBig = new Error(`${opts.label} body exceeds ${maxBytes} bytes`);
	if (Number(res.headers.get("content-length")) > maxBytes) {
		await res.body?.cancel();
		throw tooBig;
	}
	if (!res.body) return "";
	// Count decoded bytes as they stream: content-length is absent or compressed-size
	// for chunked / encoded responses.
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw tooBig;
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}
