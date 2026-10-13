/** Private files: written whole or not at all, readable by the user only, never through a symlink. */

import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
 * real folder of this user's (ownFolder): a workspace is untrusted, and a symlink planted there would carry the file
 * (and the chmod) elsewhere, so it throws instead. `keepFolderMode` leaves an existing folder's mode alone, for a
 * folder that is the user's rather than orrery's (a workspace's root, a repo's .git/info).
 */
export function writePrivate(path: string, text: string, options: { keepFolderMode?: boolean } = {}): void {
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
