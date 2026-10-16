/**
 * Codex's own process as its hooks and its memory server find it: what "this Codex" means to Orrery (the owner of the
 * agent's token claim, and the process whose end ends the recorder). Codex starts its MCP servers itself, and runs a hook
 * as `<the account's shell> -c <command>`: bash and zsh exec a lone command, so the hook's parent is Codex, but a shell
 * that did not exec stands in between, and is passed over. Reads /proc on Linux and asks ps on macOS; elsewhere the
 * parent is taken as it is.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** The shells a hook may run under (Codex picks bash, zsh or sh; the rest are passed over all the same). */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "tcsh", "csh", "pwsh"]);

/** At most this many shells are passed over: a hook is never that deep. */
const MAX_SHELLS = 4;

export interface ProcessInfo {
	readonly ppid: number;
	/** The executable's name ("bash"), without a login shell's leading "-". */
	readonly name: string;
}

/** A process's parent and name, or undefined when it cannot be read (gone, or no way to ask here). */
export function processInfo(pid: number): ProcessInfo | undefined {
	if (!Number.isInteger(pid) || pid < 1) return undefined;
	try {
		if (process.platform === "linux") {
			// "<pid> (<comm>) <state> <ppid> …": the name may hold spaces and parentheses, so it ends at the last ")".
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const end = stat.lastIndexOf(")");
			const ppid = Number(stat.slice(end + 2).split(" ")[1]);
			return end > 0 && Number.isInteger(ppid) ? { ppid, name: stat.slice(stat.indexOf("(") + 1, end) } : undefined;
		}
		if (process.platform === "darwin") {
			const ps = spawnSync("ps", ["-o", "ppid=", "-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
			const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(ps.stdout ?? "");
			return match === null ? undefined : { ppid: Number(match[1]), name: basename(match[2] as string).replace(/^-/, "") };
		}
	} catch {
		// unreadable: the caller keeps what it has
	}
	return undefined;
}

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
