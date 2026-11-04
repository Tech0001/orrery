/**
 * A log another program appends to, read as it grows: Codex's rollout (src/codex/rollout.ts) and Grok's session log
 * (src/grok/log.ts), which their recorders check prompts and replies against. Only bytes from a place on are read, a
 * whole line at a time, through no link at the log's own place and never once it leads out of the tool's folder (on
 * Linux, judged by the file opened). The tool only appends to the file it writes: another file at the path, or this one
 * shorter, is not read at all. A line longer than one read is passed over.
 */

import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

/** `path` with its longest existing part's links followed: where it is, or would be once made. */
export function realish(path: string): string {
	const rest: string[] = [];
	for (let at = path; ; at = dirname(at)) {
		try {
			return join(realpathSync(at), ...rest.reverse());
		} catch {
			if (dirname(at) === at) return path;
			rest.push(basename(at));
		}
	}
}

/** Whether `path` lies under `folder` (both as they really are). */
export const under = (path: string, folder: string): boolean => path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);

/** Where a log is read from: its path, the byte the next read starts at, and the file ("device:inode") it must be. */
export interface AppendedPlace {
	readonly path: string;
	readonly offset: number;
	readonly file?: string;
}

/** The most read in one go; a longer line is passed over. */
const CHUNK = 8 * 1024 * 1024;

/** One log, read as its tool appends to it (module doc). */
export class AppendedLines {
	readonly path: string;
	#offset: number;
	/** Mid-way through a line longer than CHUNK: the rest of it is passed over. */
	#skipping = false;
	/** The file the tool writes, "device:inode" (the first one read when the place didn't say). */
	#file: string | undefined;
	/** Whether the file opened (as it really is) lies in the tool's folder. */
	readonly #inside: (opened: string) => boolean;

	constructor(place: AppendedPlace, inside: (opened: string) => boolean) {
		this.path = place.path;
		this.#offset = place.offset;
		this.#file = place.file;
		this.#inside = inside;
	}

	/** The byte the next read starts at: a line's start. */
	get offset(): number {
		return this.#offset;
	}

	/** The file read ("device:inode"), once known. */
	get file(): string | undefined {
		return this.#file;
	}

	/**
	 * Reads what was appended since the last read, handing each whole line to `take` with where it starts in the file. A
	 * file that isn't there, or can't be read now, is read later.
	 */
	read(take: (text: string, at: number) => void): void {
		let fd: number;
		try {
			// Never through a link at the log's own place, and never waiting on a FIFO put there.
			fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch {
			return;
		}
		try {
			const stat = fstatSync(fd);
			// On Linux, the file this opened, whatever was swapped in on the way; elsewhere (macOS), the path as it is now.
			const opened = process.platform === "linux" ? readlinkSync(`/proc/self/fd/${fd}`) : realpathSync(this.path);
			if (!stat.isFile() || !this.#inside(opened)) return;
			// The tool only appends to the file it writes: another file at the path, or this one shorter, is not its log, and
			// nothing in it is read.
			const file = `${stat.dev}:${stat.ino}`;
			this.#file ??= file;
			if (this.#file !== file || stat.size < this.#offset) return;
			while (this.#offset < stat.size) {
				const want = Math.min(stat.size - this.#offset, CHUNK);
				const buffer = Buffer.alloc(want);
				const got = readSync(fd, buffer, 0, want, this.#offset);
				if (got <= 0) break;
				const end = buffer.lastIndexOf(10, got - 1);
				if (end < 0) {
					// No line ends here: wait for the rest, unless the line is longer than a read.
					if (got < CHUNK) break;
					this.#offset += got;
					this.#skipping = true;
					continue;
				}
				let start = 0;
				for (let newline = buffer.indexOf(10, start); newline >= 0 && newline <= end; newline = buffer.indexOf(10, start)) {
					if (this.#skipping) this.#skipping = false;
					else take(buffer.toString("utf8", start, newline), this.#offset + start);
					start = newline + 1;
				}
				this.#offset += end + 1;
			}
		} catch {
			// read again next time
		} finally {
			closeSync(fd);
		}
	}
}
