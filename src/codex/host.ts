/**
 * Codex's own process as its hooks and its memory server find it: what "this Codex" means to Orrery (the owner of the
 * agent's token claim, and the process whose end ends the recorder). Codex starts its MCP servers itself, and runs a hook
 * as `<the account's shell> -c <command>`: bash and zsh exec a lone command, so the hook's parent is Codex, but a shell
 * that did not exec stands in between, and is passed over. Reads /proc on Linux and asks ps on macOS; elsewhere the
 * parent is taken as it is.
 */

import { type ProcessInfo, processInfo } from "../agent/process.ts";

/** The shells a hook may run under (Codex picks bash, zsh or sh; the rest are passed over all the same). */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "tcsh", "csh", "pwsh"]);

/** At most this many shells are passed over: a hook is never that deep. */
const MAX_SHELLS = 4;

/** Codex's pid from a process it started (default: this one's parent), passing over shells in between. */
export function codexPid(start: number = process.ppid, info: (pid: number) => ProcessInfo | undefined = processInfo): number {
	let pid = start;
	for (let i = 0; i < MAX_SHELLS; i++) {
		const seen = info(pid);
		if (seen === undefined || !SHELLS.has(seen.name) || seen.ppid <= 1) return pid;
		pid = seen.ppid;
	}
	return pid;
}
