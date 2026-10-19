/** Private files: written whole or not at all, readable by the user only, never through a symlink. */

import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A small private file's text: a regular file of this user's, never through a link at its own name, read up to `max`
 * bytes. Opened without blocking, so a FIFO put in its place is refused rather than waited on. Throws when it can't be
 * read (gone: ENOENT).
 */
export function readPrivate(path: string, max: number): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("not a file");
		if (process.getuid !== undefined && stat.uid !== process.getuid()) throw new Error("not this user's file");
		const buffer = Buffer.alloc(max);
		const read = readSync(fd, buffer, 0, max, 0);
		return buffer.toString("utf8", 0, read);
	} finally {
		closeSync(fd);
	}
}

/** Whether `dir` is a real folder (not a symlink) of this user's; undefined when nothing is there. */
export function ownFolder(dir: string): boolean | undefined {
	try {
		const stats = lstatSync(dir);
		return stats.isDirectory() && (process.getuid === undefined || stats.uid === process.getuid());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Writes `text` atomically (a temporary file, then rename), mode 0600, in a folder made 0700. The folder must be a
 * real folder of this user's (ownFolder): a folder is untrusted, and a symlink planted there would carry the file
 * (and the chmod) elsewhere, so it throws instead. `keepFolderMode` leaves an existing folder's mode alone, for a
 * folder that is the user's rather than orrery's (a folder's root, a repo's .git/info).
 */
export function writePrivate(path: string, text: string | Uint8Array, options: { keepFolderMode?: boolean } = {}): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (ownFolder(dir) !== true) throw new Error(`${dir} is not a real folder of this user's (a symlink, or someone else's); nothing was written`);
	if (options.keepFolderMode !== true) chmodSync(dir, 0o700);
	const temp = join(dir, `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
	// wx: a fresh file of our own, never one already there under that name.
	writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
	try {
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
