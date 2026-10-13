/** Streams a file's lines without loading it whole: one Codex rollout here is larger than Node's string limit. */

import { closeSync, openSync, readSync } from "node:fs";

/** Yielded in place of a line too long to decode. It is not valid JSON, so callers count it as unreadable. */
export const OVERSIZED_LINE = "\u0000";
const MAX_LINE_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 1 << 20;

export function* readLines(file: string): Generator<string> {
	const fd = openSync(file, "r");
	try {
		const chunk = Buffer.alloc(CHUNK_BYTES);
		let pending: Buffer[] = [];
		let pendingBytes = 0;
		const take = (): string => {
			const text = pendingBytes > MAX_LINE_BYTES ? OVERSIZED_LINE : Buffer.concat(pending).toString("utf8");
			pending = [];
			pendingBytes = 0;
			return text;
		};
		for (;;) {
			const read = readSync(fd, chunk, 0, CHUNK_BYTES, null);
			if (read === 0) break;
			const data = chunk.subarray(0, read);
			let start = 0;
			for (;;) {
				const newline = data.indexOf(10, start);
				const end = newline === -1 ? read : newline;
				if (pendingBytes + (end - start) <= MAX_LINE_BYTES) pending.push(Buffer.from(data.subarray(start, end)));
				pendingBytes += end - start;
				if (newline === -1) break;
				yield take();
				start = newline + 1;
			}
		}
		if (pendingBytes > 0) yield take();
	} finally {
		closeSync(fd);
	}
}
