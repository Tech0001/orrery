/**
 * The files a process has open, asked from outside it: what Codex's and Grok's SessionStart prove a session by. Codex
 * holds each session's rollout open (src/codex/hooks.ts); Grok holds each session's events.jsonl open for writing, whose
 * path names the session's folder (src/grok/hooks.ts). Linux reads /proc/<pid>/fd, which also gives the very file behind
 * each descriptor, and /proc/<pid>/fdinfo, how it is open; macOS asks lsof, which gives paths and how each is open.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";

/**
 * lsof's files (`-Fan`): each open file's name, on a line starting "n", and how it is open, said before it on a line
 * starting "a" (`r` to read, `w` to write, `u` both). A new file ("f") or process ("p") line starts the next file's
 * fields, so a mode is never carried to another file; one not said, or not one of these, is left unknown.
 */
export function parseLsofFiles(output: string): OpenFile[] {
	const files: OpenFile[] = [];
	let access: string | undefined;
	for (const line of output.split("\n")) {
		if (line.startsWith("f") || line.startsWith("p")) access = undefined;
		else if (line.startsWith("a")) access = line.slice(1);
		else if (line.startsWith("n")) {
			const writes = access === "w" || access === "u" ? true : access === "r" ? false : undefined;
			files.push({ path: line.slice(1), ...(writes === undefined ? {} : { writes }) });
			access = undefined;
		}
	}
	return files;
}

/** lsof's names (each open file's name on a line starting "n"). */
export function parseLsof(output: string): string[] {
	return parseLsofFiles(output).map((file) => file.path);
}

/** lsof where macOS (and most Linux systems) keep it: never one found on a PATH the caller may have chosen. */
const LSOF = ["/usr/sbin/lsof", "/usr/bin/lsof"];

/**
 * A file a process has open: its path, on Linux the very file ("device:inode") behind the descriptor, and whether it is
 * open for writing (write-only or read-write; undefined when this system doesn't say).
 */
export interface OpenFile {
	readonly path: string;
	readonly file?: string;
	readonly writes?: boolean;
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
 * Linux: whether descriptor `fd` of process `pid` is open for writing, by its flags' access mode in
 * /proc/<pid>/fdinfo/<fd> (O_WRONLY or O_RDWR). Undefined when that can't be read, or when fdinfo names another file
 * than `id` (newer kernels say its inode there): the descriptor was closed and its number used again meanwhile.
 */
function descriptorWrites(pid: number, fd: string, id: string | undefined): boolean | undefined {
	let info: string;
	try {
		info = readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8");
	} catch {
		return undefined;
	}
	const flags = /^flags:\s*([0-7]+)$/m.exec(info)?.[1];
	const ino = /^ino:\s*(\d+)$/m.exec(info)?.[1];
	if (flags === undefined || (ino !== undefined && id !== undefined && id.slice(id.indexOf(":") + 1) !== String(Number(ino)))) return undefined;
	// O_ACCMODE: 0 O_RDONLY, 1 O_WRONLY, 2 O_RDWR.
	const access = Number.parseInt(flags, 8) & 0o3;
	return access === 1 || access === 2 ? true : access === 0 ? false : undefined;
}

/**
 * The files process `pid` has open: Linux reads /proc/<pid>/fd (none for a process that is gone), each with the file the
 * descriptor holds and how it is open; macOS asks lsof for their paths and how each is open. Undefined when this system
 * can't tell.
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
				const path = readlinkSync(`/proc/${pid}/fd/${fd}`);
				const writes = descriptorWrites(pid, fd, id);
				files.push({ path, ...(id === undefined ? {} : { file: id }), ...(writes === undefined ? {} : { writes }) });
			} catch {
				// closed meanwhile
			}
		}
		return files;
	}
	if (platform === "darwin") {
		const lsof = LSOF.find((path) => existsSync(path));
		if (lsof === undefined) return undefined;
		const run = spawnSync(lsof, ["-w", "-n", "-P", "-Fan", "-p", String(pid)], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
		// lsof says 1 for a process with nothing to list, and for one that is gone.
		if (run.error !== undefined || (run.status !== 0 && run.status !== 1)) return undefined;
		return parseLsofFiles(run.stdout ?? "");
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
