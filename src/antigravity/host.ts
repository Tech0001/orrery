/**
 * The Antigravity CLI's own process as its hooks find it, and which of its conversations is its own (spec
 * 2026-11-20-antigravity-design, "Identity").
 * - agy starts a hook through a shell (`sh -c`, seen live in 1.5.13: the hook's parent is the agy program itself when the
 *   shell execs), so the hook's parent, past shells, is agy (src/codex/host.ts toolPid). An orphaned shell was started
 *   by no agy.
 * - A conversation is this agy's own when it holds `presence/<conversation>.lock` open for writing under the Antigravity
 *   folder it was started with (its start environment's HOME, as it really is): seen live, agy holds that lock and the
 *   conversation's database (`conversations/<id>.db`) open while the conversation runs, and the transcript only while it
 *   writes. Never from the hook's own HOME or input (`transcriptPath`).
 */

import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { type OpenFile, openFiles } from "../agent/open-files.ts";
import { type ProcessInfo, processExecutable, processInfo } from "../agent/process.ts";
import { validSession } from "../claude/paths.ts";
import { toolPid } from "../codex/host.ts";
import { agyFolder, agyTranscript, isAgyProcess } from "./names.ts";

/** agy's pid from a process it started (default: this one's parent), passing over shells in between. */
export function agyPid(start: number = process.ppid, info: (pid: number) => ProcessInfo | undefined = processInfo): number | undefined {
	return toolPid(start, info);
}

/** Whether `pid` runs Antigravity's program, by the file it runs (links followed), never by a name it was given. */
export function isAgy(pid: number, exeOf: (pid: number) => string | undefined = processExecutable): boolean {
	const exe = exeOf(pid);
	return exe !== undefined && isAgyProcess(basename(exe));
}

/** A conversation id agy uses: a UUID, which the spool takes as a session id. */
export const validConversation = (id: unknown): id is string => validSession(id) && /^[0-9a-f-]{36}$/.test(id);

function realOf(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** Whether `path` and every folder on the way to it from `top` is no link. */
function noLinks(top: string, path: string): boolean {
	let at = path;
	for (;;) {
		try {
			if (lstatSync(at).isSymbolicLink()) return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
		}
		if (at === top) return true;
		const up = dirname(at);
		if (up === at) return false;
		at = up;
	}
}

/** A conversation as agy's own: its transcript, and Antigravity's folder, as they really are. */
export interface OwnConversation {
	readonly folder: string;
	readonly transcript: string;
}

/**
 * Conversation `conversation` as agy process `pid`'s own (module doc), or why it can't be confirmed. `home`: the HOME of
 * agy's start environment; `open`: its open files (default openFiles).
 */
export function ownConversation(pid: number, conversation: string, home: string | undefined, open: (pid: number) => readonly OpenFile[] | undefined = openFiles): OwnConversation | string {
	if (!validConversation(conversation)) return "the conversation id is no Antigravity id";
	const named = agyFolder(home);
	if (named === undefined) return "Antigravity's environment names no HOME";
	const folder = realOf(named);
	if (folder === undefined) return "Antigravity's folder can't be read";
	const files = open(pid);
	if (files === undefined) return "this system can't tell which files Antigravity has open";
	const lock = join(folder, "presence", `${conversation}.lock`);
	const held = files.filter((file) => isAbsolute(file.path) && normalize(file.path) === file.path && (file.path === lock || realOf(file.path) === lock));
	if (held.length === 0) return "Antigravity doesn't have it open";
	if (held.length > 1) return "Antigravity has it open more than once";
	const [one] = held as [OpenFile];
	if (one.writes === undefined) return "this system can't tell whether Antigravity has it open for writing";
	if (!one.writes) return "Antigravity doesn't have it open for writing";
	const transcript = agyTranscript(folder, conversation);
	if (!noLinks(folder, transcript)) return "its record is a link, or has one on the way";
	return { folder, transcript };
}
