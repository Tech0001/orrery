/**
 * Processes, asked about once for the whole agent code: whether one lives (status files, the CLI, Claude Code's holder),
 * and its parent and name (Codex's own process, src/codex/host.ts). Node built-ins only: pi and OMP load this file.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * True when `pid` is a live process (one we may not signal still counts as live). A pid that is no positive integer
 * (read from a file) is not: kill(0) and kill(-1) would signal a whole process group.
 */
export function processAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface ProcessInfo {
	readonly ppid: number;
	/** The executable's name ("bash"), without a login shell's leading "-". */
	readonly name: string;
}

/**
 * A /proc/<pid>/stat line taken apart: the name, and the fields after it from field 3 (the state) on, so field n is
 * `fields[n - 3]`. "<pid> (<comm>) <state> <ppid> …": the name may hold spaces and parentheses, so it ends at the last
 * ")". Undefined for a line that is none.
 */
export function procStat(stat: string): { readonly name: string; readonly fields: readonly string[] } | undefined {
	const end = stat.lastIndexOf(")");
	return end > 0 ? { name: stat.slice(stat.indexOf("(") + 1, end), fields: stat.slice(end + 2).split(" ") } : undefined;
}

/** A process's parent and name, or undefined when it cannot be read (gone, or no way to ask here). */
export function processInfo(pid: number): ProcessInfo | undefined {
	if (!Number.isInteger(pid) || pid < 1) return undefined;
	try {
		if (process.platform === "linux") {
			const stat = procStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
			const ppid = Number(stat?.fields[1]);
			return stat !== undefined && Number.isInteger(ppid) ? { ppid, name: stat.name } : undefined;
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
