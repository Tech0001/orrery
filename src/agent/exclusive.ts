/**
 * One exclusive step decides every contested write to a small shared file (a token claim, src/agent/pick.ts; a Claude
 * Code process's record, src/claude/pick.ts), between processes that share no lock:
 * - The content is written whole to a temporary name beside the file, then published by a hard link to the file's name
 *   (publish). The file appears whole or not at all, and of two publishers one gets EEXIST and loses.
 * - A stale file (a dead claim, a record of another identity) is taken down by first renaming it to a graveyard name
 *   beside it (removeStale). Only one rename of a name succeeds; the other gets ENOENT and loses. The file is judged
 *   again in the graveyard and removed only if it is still stale: a fresh file that took the name between the caller's
 *   judgment and the rename goes back. Nobody writes to a graveyard file, but a pruner may sweep it: it keeps the moved
 *   file's mtime, so one older than STRAY_MS is a stray to another process's prune (pruneClaims, src/claude/pick.ts
 *   prune) and can go between the move and the judgment. A missing file then counts as stale (it is gone either way),
 *   and a put-back that finds it gone is "removed".
 * - Where links fail otherwise (no hard links: FAT and exFAT, some network and FUSE mounts) publish falls back to an
 *   exclusive create of the name and a write into it. The file is empty for a moment; pruning and a claim's takeover
 *   treat an empty file younger than STRAY_MS as one being made (beingMade), never as dead.
 * Fail toward safety: a crash between the graveyard rename and the new link leaves no file at all. The next claim is
 * then made fresh, and until then a session's later events fall back to the folder, as they did on a dead claim; a
 * Claude Code event finds no record and refuses with the guard on. The graveyard file itself is a stray (stray) and
 * goes with the next prune.
 *
 * Known limit: three processes. Two claimers of one token, and a third claimer in the same agent whose pruneClaims takes
 * that token's dead claim down: if the first claimer's fresh claim takes the name between the pruner's judgment and
 * its rename, the pruner moves that live claim, and if the second claimer then links its own before the put-back, the
 * put-back replaces it. Both claimers believe they hold the token. With two processes exactly one wins.
 * Known limit: a crash between moving a live claim and putting it back leaves that live owner without its claim (the
 * graveyard file is swept as a stray after STRAY_MS), and so does a stall there past STRAY_MS: another process's prune
 * sweeps the graveyard file first, and the put-back finds it gone ("removed"). Either way a later claimer of its token
 * finds none and takes it over while the owner lives.
 * Known limit: without hard links, a second consumer of the same process (Claude Code's MCP server and its
 * SessionStart) that arrives in the fallback's empty moment finds a file being made: its record is unreadable
 * ("unrecorded"), or it loses the claim and falls back to the folder. That fails closed, and is accepted.
 * Node built-ins only: pi and OMP load this file.
 */

import { randomBytes } from "node:crypto";
import { closeSync, linkSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";

/** How old a stray temporary or graveyard file, or an empty file being made, must be before pruning removes it. */
export const STRAY_MS = 60_000;

/** A temporary name beside `file`, for content written whole before publish. */
export const temporaryOf = (file: string): string => `${file}.${randomBytes(6).toString("hex")}`;

/** A graveyard name beside `file`: where a stale file goes to be judged, and removed, by the one process that moved it. */
const graveOf = (file: string): string => `${file}.dead-${randomBytes(6).toString("hex")}`;

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/**
 * Puts `content`, already written whole in `temporary`, at `file` exclusively: "exists" when the name is taken. A hard
 * link first; where the link fails otherwise than EEXIST (no hard links), an exclusive create of `file` and a write.
 */
export function publish(temporary: string, file: string, content: string): true | "exists" {
	try {
		linkSync(temporary, file);
		return true;
	} catch (error) {
		if (code(error) === "EEXIST") return "exists";
	}
	let fd: number;
	try {
		fd = openSync(file, "wx", 0o600);
	} catch (error) {
		if (code(error) === "EEXIST") return "exists";
		throw error;
	}
	try {
		writeSync(fd, content);
	} finally {
		closeSync(fd);
	}
	return true;
}

/**
 * Takes `file` down exclusively when `stale` still says so of it in the graveyard (`stale` counts a missing file as
 * stale: a pruner may have swept the graveyard, module doc): "removed"; "lost" when another process renamed it away
 * first (or it was gone); "kept" when it was no longer the file the caller judged (a fresh one took the name between),
 * and is back in place: the same inode, so a writer still filling it lands its content there.
 */
export function removeStale(file: string, stale: (file: string) => boolean): "removed" | "lost" | "kept" {
	const grave = graveOf(file);
	try {
		renameSync(file, grave);
	} catch (error) {
		if (code(error) === "ENOENT") return "lost";
		throw error;
	}
	if (stale(grave)) {
		rmSync(grave, { force: true });
		return "removed";
	}
	try {
		renameSync(grave, file);
	} catch (error) {
		// Swept by a pruner between the judgment and the put-back: gone, as a stale file would be.
		if (code(error) === "ENOENT") return "removed";
		throw error;
	}
	return "kept";
}

/** Whether `file` is empty and younger than STRAY_MS: publish's fallback is still writing it. False when it is gone. */
export function beingMade(file: string): boolean {
	try {
		const stat = statSync(file);
		return stat.size === 0 && Date.now() - stat.mtimeMs <= STRAY_MS;
	} catch {
		return false;
	}
}

/** Whether a temporary or graveyard `file` is older than STRAY_MS: its maker has long finished, or died. */
export function stray(file: string): boolean {
	try {
		return Date.now() - statSync(file).mtimeMs > STRAY_MS;
	} catch {
		return false;
	}
}
