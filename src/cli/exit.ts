/**
 * Exits with `code` once everything written to stdout and stderr has gone to the OS. `process.exit` drops what a pipe
 * has not taken yet: a reply over 64 KB read through a pipe (the Orrery mod reading `orrery claude-mod view`) came out
 * cut at 65,536 bytes. Ending each stream waits for every write before it, on Node and on Bun (Bun runs an empty
 * write's callback at once, before earlier writes are out), and its callback also runs when the reader has gone away
 * (EPIPE), so the process still exits. A write after that is dropped (see dropWrite).
 */
export function exitWhenFlushed(code: number): void {
	let pending = 2;
	const done = (): void => {
		pending -= 1;
		if (pending === 0) process.exit(code);
	};
	for (const stream of [process.stdout, process.stderr]) {
		stream.end(done);
		stream.write = dropWrite;
	}
}

/**
 * write() once the streams are ending: a late write (a signal handler, say) is dropped, and its callback still runs. A
 * real write after end() fails with ERR_STREAM_WRITE_AFTER_END, which crashes the exit on Node and Bun. Ignoring that
 * error in an 'error' listener is no cure: end()'s callback then never runs, and the process ends with code 0.
 */
function dropWrite(_chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
	const done = typeof encoding === "function" ? encoding : callback;
	if (typeof done === "function") process.nextTick(done as () => void);
	return true;
}
