/**
 * Exits with `code` once everything written to stdout and stderr has gone to the OS. `process.exit` drops what a pipe
 * has not taken yet: a reply over 64 KB read through a pipe (the Orrery mod reading `orrery claude-mod view`) came out
 * cut at 65,536 bytes. Ending each stream waits for every write before it, on Node and on Bun (Bun runs an empty
 * write's callback at once, before earlier writes are out), and its callback also runs when the reader has gone away
 * (EPIPE), so the process still exits.
 */
export function exitWhenFlushed(code: number): void {
	let pending = 2;
	const done = (): void => {
		pending -= 1;
		if (pending === 0) process.exit(code);
	};
	process.stdout.end(done);
	process.stderr.end(done);
}
