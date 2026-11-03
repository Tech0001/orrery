/**
 * Codex's own process as its hooks and its memory server find it: what "this Codex" means to Orrery (the owner of the
 * agent's token claim, and the process whose end ends the recorder). Codex starts its MCP servers itself, and runs a hook
 * as `<the account's shell> -c <command>`: bash and zsh exec a lone command, so the hook's parent is Codex, but a shell
 * that did not exec stands in between, and is passed over. A shell with no parent of its own (orphaned: its parent is
 * init, or 0 at the top of a pid namespace) was started by no Codex, and is never taken for one: there is no Codex.
 * Reads /proc on Linux and asks ps on macOS; elsewhere the parent is taken as it is. Grok's process is found the same way,
 * past shells, and an orphaned shell is no Grok either (src/grok/host.ts).
 */

import { type ProcessInfo, processInfo } from "../agent/process.ts";

/** The shells a hook may run under (Codex picks bash, zsh or sh; the rest are passed over all the same). */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "tcsh", "csh", "pwsh"]);

/** At most this many shells are passed over: a hook is never that deep. */
const MAX_SHELLS = 4;

/** The process reached from `start` past shells in between, and whether the walk stopped at a shell with no parent of its own. */
function pastShells(start: number, info: (pid: number) => ProcessInfo | undefined): { readonly pid: number; readonly orphaned: boolean } {
	let pid = start;
	for (let i = 0; i < MAX_SHELLS; i++) {
		const seen = info(pid);
		if (seen === undefined || !SHELLS.has(seen.name)) return { pid, orphaned: false };
		if (seen.ppid <= 1) return { pid, orphaned: true };
		pid = seen.ppid;
	}
	return { pid, orphaned: false };
}

/**
 * The tool's pid from a process it started (`start`), passing over shells in between; undefined when a shell on the way
 * has no parent of its own (module doc).
 */
export function toolPid(start: number, info: (pid: number) => ProcessInfo | undefined = processInfo): number | undefined {
	const found = pastShells(start, info);
	return found.orphaned ? undefined : found.pid;
}

/**
 * Codex's pid from a process it started (default: this one's parent), passing over shells in between; undefined when a
 * shell on the way has no parent of its own (module doc).
 */
export function codexPid(start: number = process.ppid, info: (pid: number) => ProcessInfo | undefined = processInfo): number | undefined {
	return toolPid(start, info);
}
