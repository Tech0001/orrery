/**
 * Processes, asked about once for the whole agent code: whether one lives (status files, the CLI, Claude Code's holder),
 * its parent and name (Codex's own process, src/codex/host.ts), when it started, and on Linux the pid namespace it is
 * numbered in and this boot's id (session records, src/agent/sessions.ts; token claims, src/agent/pick.ts). Node
 * built-ins only: pi and OMP load this file.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
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

/**
 * macOS's ps output for `args`, or undefined when it fails (a gone pid makes it exit 1). By its path, so a `ps` first on
 * PATH isn't the one asked; in UTC and the C locale, so what it prints (lstart) reads alike in every process whatever its
 * TZ or LANG.
 */
export function psOutput(args: readonly string[]): string | undefined {
	const ps = spawnSync("/bin/ps", args, { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
	return ps.status === 0 ? ps.stdout : undefined;
}

/**
 * Linux: the pid namespace process `pid` (or this one, "self") is in, as its /proc/<pid>/ns/pid link reads
 * ("pid:[4026531836]"). Undefined elsewhere, or when it can't be read. A pid means a process only within the namespace it
 * is numbered in: from another one, kill(0) finds it gone and /proc shows another process, or none.
 */
export function pidNamespace(pid: number | "self"): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		return readlinkSync(`/proc/${pid}/ns/pid`);
	} catch {
		return undefined;
	}
}

/** Linux: this boot's id, so a pid and start time recorded before a reboot never match after it. Undefined elsewhere. */
export function bootId(): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
	} catch {
		return undefined;
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

/** /proc/<pid>/stat's start time field (proc(5)). */
const START_FIELD = 22;

/** Linux: process `pid`'s /proc/<pid>/stat line, or undefined when it can't be read (gone). */
export function readProcStat(pid: number): string | undefined {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
}

/** How processStart reads a process: each defaults to this system's own way (tests give fakes). */
export interface StartDeps {
	/** Linux: a process's /proc/<pid>/stat line (default readProcStat). */
	readonly proc?: (pid: number) => string | undefined;
	/** macOS: ps's output for `args` (default psOutput). */
	readonly ps?: (args: readonly string[]) => string | undefined;
	/** Which system's way to ask (default this one's). */
	readonly platform?: NodeJS.Platform;
}

/**
 * When process `pid` started, or undefined when that can't be read (gone, or no way to ask on this system): Linux's
 * /proc/<pid>/stat field 22 (clock ticks since boot), macOS's `ps -o lstart=` (to the second, in UTC and the C locale:
 * psOutput). Session records (src/agent/sessions.ts) and token claims (src/agent/pick.ts) hold it, so a reused pid is
 * never taken for the process that recorded or claimed.
 */
export function processStart(pid: number, deps: StartDeps = {}): string | undefined {
	if (!Number.isInteger(pid) || pid < 1) return undefined;
	const platform = deps.platform ?? process.platform;
	if (platform === "linux") {
		const stat = (deps.proc ?? readProcStat)(pid);
		const start = stat === undefined ? undefined : procStat(stat)?.fields[START_FIELD - 3];
		return start !== undefined && /^\d+$/.test(start) ? start : undefined;
	}
	if (platform === "darwin") {
		const start = (deps.ps ?? psOutput)(["-o", "lstart=", "-p", String(pid)])?.trim();
		return start === undefined || start === "" ? undefined : start;
	}
	return undefined;
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
			const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(psOutput(["-o", "ppid=", "-o", "comm=", "-p", String(pid)]) ?? "");
			return match === null ? undefined : { ppid: Number(match[1]), name: basename(match[2] as string).replace(/^-/, "") };
		}
	} catch {
		// unreadable: the caller keeps what it has
	}
	return undefined;
}
