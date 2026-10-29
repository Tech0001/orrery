/**
 * The files a process has open, asked from outside it: what Codex's and Grok's SessionStart prove a session by. Codex
 * holds each session's rollout open (src/codex/hooks.ts); Grok holds each session's events.jsonl open, whose path names
 * the session's folder (src/grok/hooks.ts). Linux reads /proc/<pid>/fd, which also gives the very file behind each
 * descriptor; macOS asks lsof, which gives paths only.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";

/** lsof's names (`-Fn`: each open file's name on a line starting "n"). */
export function parseLsof(output: string): string[] {
	return output.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
}

/** lsof where macOS (and most Linux systems) keep it: never one found on a PATH the caller may have chosen. */
const LSOF = ["/usr/sbin/lsof", "/usr/bin/lsof"];

/** A file a process has open: its path, and on Linux the very file ("device:inode") behind the descriptor. */
export interface OpenFile {
	readonly path: string;
	readonly file?: string;
}

/** A file's "device:inode", or undefined when it can't be read. */
function fileId(path: string): string | undefined {
	try {
		const stat = statSync(path);
		return `${stat.dev}:${stat.ino}`;
	} catch {
		return undefined;
	}
}

/**
 * The files process `pid` has open: Linux reads /proc/<pid>/fd (none for a process that is gone), each with the file the
 * descriptor holds; macOS asks lsof for their paths. Undefined when this system can't tell.
 */
export function openFiles(pid: number, platform: NodeJS.Platform = process.platform): OpenFile[] | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return [];
	if (platform === "linux") {
		let fds: string[];
		try {
			fds = readdirSync(`/proc/${pid}/fd`);
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" && existsSync("/proc/self/fd") ? [] : undefined;
		}
		const files: OpenFile[] = [];
		for (const fd of fds) {
			try {
				const id = fileId(`/proc/${pid}/fd/${fd}`);
				files.push({ path: readlinkSync(`/proc/${pid}/fd/${fd}`), ...(id === undefined ? {} : { file: id }) });
			} catch {
				// closed meanwhile
			}
		}
		return files;
	}
	if (platform === "darwin") {
		const lsof = LSOF.find((path) => existsSync(path));
		if (lsof === undefined) return undefined;
		const run = spawnSync(lsof, ["-w", "-n", "-P", "-Fn", "-p", String(pid)], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
		// lsof says 1 for a process with nothing to list, and for one that is gone.
		if (run.error !== undefined || (run.status !== 0 && run.status !== 1)) return undefined;
		return parseLsof(run.stdout ?? "").map((path) => ({ path }));
	}
	return undefined;
}

/**
 * Whether process `pid` has the file at `path` open (Codex holds each of its sessions' rollouts open): that file's
 * "device:inode" when it does (on Linux the very file the descriptor holds, so one put at the path since is not it),
 * false when not, "unknown" when this system can't tell. `files` reads a process's open files (default openFiles).
 */
export function holdsOpen(pid: number, path: string, files: (pid: number) => readonly OpenFile[] | undefined = openFiles): string | false | "unknown" {
	const open = files(pid);
	if (open === undefined) return "unknown";
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		return false;
	}
	const id = fileId(real);
	if (id === undefined) return false;
	return open.some((held) => (held.file !== undefined ? held.file === id : held.path === real || held.path === path)) ? id : false;
}
