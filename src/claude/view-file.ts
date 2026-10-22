/**
 * The view file Claude Code loads (spec §4 "The view file and CLAUDE.md"): <folder>/.orrery/view.md.
 * - It holds the agent's instructions (fenced, under a heading naming it), then memorySection(view, "claude-code"); before
 *   the agent has memory, the instructions alone.
 * - It is written atomically, 0600 in a 0700 folder.
 * - The folder is untrusted, since a shared repo decides what is in it. So the view is written only where
 *   claude-setup put it:
 *   - the agent's own data folder holds claude-setup's marker (claude/setup.json), naming this folder;
 *   - and CLAUDE.md or CLAUDE.local.md still imports the view.
 *   A repo that merely commits the import line gets nothing.
 * - It never goes through a symlink: a .orrery that is a symlink, a file or someone else's folder counts as not set
 *   up.
 * - CLAUDE.md and CLAUDE.local.md are read only as regular files (never through a symlink), and only their first
 *   256 KB. Only the file the marker names counts.
 * - It never reaches a commit: in a git work tree, git must ignore .orrery/ and track nothing there (gitExposure).
 *   - Where git would see it, the view orrery wrote there is deleted, then the marker goes (withdrawView). If the
 *     delete fails, the marker stays and the next gate tries again.
 *   - Where git cannot say (or a check throws), the view is taken out until git answers again: it is deleted and not
 *     written, but the marker stays, so the next gate that passes writes it back with no setup to redo.
 * - In mod mode (marker `file: "mod"`) the gate is closed: nothing is written, and a stale view in the agent's own
 *   folder is deleted, unless git tracks it (then it is the repo's file) or cannot say (then a later gate asks
 *   again). Mod mode holds wherever the session runs; an agent with no folder has a mod marker naming none ("").
 * Every writer (claude-setup, SessionStart, the holder) goes through one gate, viewGate, in writeViewFile.
 */

import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentConfig } from "../agent/config.ts";
import { readInstructions } from "../agent/instructions.ts";
import { ownFolder, writePrivate } from "../agent/private-file.ts";
import { fenced, memorySection } from "../agent/view-text.ts";
import { MemoryStore, MemoryView } from "../memory/index.ts";
import { type Exposure, gitExposure, gitTracks } from "./git.ts";
import { samePath, setupMarker, viewFile } from "./paths.ts";

/** The CLAUDE.md line that loads the view. */
export const VIEW_IMPORT = "@.orrery/view.md";

/** How much of CLAUDE.md is searched for the import line (and the most claude-setup edits). */
export const READ_LIMIT = 256 * 1024;

/** The file claude-setup puts the import lines in: CLAUDE.md, or CLAUDE.local.md in a shared repo. */
export type SetupFile = "CLAUDE.md" | "CLAUDE.local.md";

/** What the marker names: the file holding the import lines, or "mod" (the Orrery mod gives the view; no file). */
export type MarkerFile = SetupFile | "mod";

/**
 * claude/setup.json: claude-setup ran for `folder` and put the import lines in `file`, at `at`. On disk the folder's key
 * is `workspace`, as builds before 0.6.0 wrote it, so their markers still read.
 */
export interface SetupMarker {
	readonly folder: string;
	readonly file: MarkerFile;
	readonly at: number;
}

/** The agent's setup marker, or undefined when there is none or it is malformed. */
export function readSetupMarker(agentDir: string): SetupMarker | undefined {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(setupMarker(agentDir), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { workspace, file, at } = value as Record<string, unknown>;
	if (typeof workspace !== "string" || (file !== "CLAUDE.md" && file !== "CLAUDE.local.md" && file !== "mod") || typeof at !== "number") return undefined;
	return { folder: workspace, file, at };
}

/** Records that claude-setup put the import lines in `file` of `folder` (private, atomic). claude-setup calls it. */
export function writeSetupMarker(agentDir: string, folder: string, file: MarkerFile): void {
	writePrivate(setupMarker(agentDir), JSON.stringify({ workspace: folder, file, at: Date.now() }));
}

/** Removes the agent's setup marker, so the view is written nowhere until claude-setup runs again. */
export function removeSetupMarker(agentDir: string): void {
	rmSync(setupMarker(agentDir), { force: true });
}

/**
 * The first `limit` bytes of `path` as text, and whether that is all of it. `path` must be a regular file and is never
 * opened through a symlink; anything else throws. A folder is untrusted: its CLAUDE.md could be a link to
 * /dev/zero.
 */
export function readHead(path: string, limit = READ_LIMIT): { readonly text: string; readonly whole: boolean } {
	// O_NOFOLLOW: a symlink fails to open. O_NONBLOCK: a pipe opens at once, and fstat then refuses it unread.
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
		// One byte past the limit tells whether the file goes on.
		const buffer = Buffer.alloc(limit + 1);
		let length = 0;
		while (length <= limit) {
			const read = readSync(fd, buffer, length, limit + 1 - length, null);
			if (read === 0) break;
			length += read;
		}
		return { text: buffer.toString("utf8", 0, Math.min(length, limit)), whole: length <= limit };
	} finally {
		closeSync(fd);
	}
}

/** Whether `path`, read as readHead reads it, has the import line among its whole lines in the first 256 KB. */
export function importsView(path: string): boolean {
	try {
		const { text, whole } = readHead(path);
		const lines = text.split("\n");
		// A line cut off at the limit is not a whole line.
		if (!whole) lines.pop();
		return lines.some((line) => line.trim() === VIEW_IMPORT);
	} catch {
		return false;
	}
}

/**
 * Whether CLAUDE.md or CLAUDE.local.md in the folder imports the view (the line claude-setup writes). Each is read
 * only as a regular file, and only its first 256 KB: a repo could commit CLAUDE.md as a symlink to /dev/zero.
 */
export function viewImported(folder: string): boolean {
	return ["CLAUDE.md", "CLAUDE.local.md"].some((name) => importsView(join(folder, name)));
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Deletes the view orrery wrote into `folder`: only a regular file, in a real .orrery folder of the user's.
 * unlink never follows a symlink, and one at view.md is not orrery's view, so it stays. Returns whether it deleted
 * one; a failing unlink throws.
 */
function deleteView(folder: string): boolean {
	if (ownFolder(dirname(viewFile(folder))) !== true) return false;
	if (!lstatSync(viewFile(folder), { throwIfNoEntry: false })?.isFile()) return false;
	unlinkSync(viewFile(folder));
	return true;
}

/**
 * deleteView for mod mode, which needs no view file: only one git does not track. One git tracks is the repo's file, not
 * a view orrery wrote, and stays; so does one git cannot say about this time (a later call asks again). Git is asked
 * only when there is a view file.
 */
function deleteUntrackedView(folder: string): boolean {
	if (ownFolder(dirname(viewFile(folder))) !== true || !lstatSync(viewFile(folder), { throwIfNoEntry: false })?.isFile()) return false;
	if (gitTracks(folder, ".orrery/view.md") !== false) return false;
	return deleteView(folder);
}

/**
 * For claude-setup --mod: deleteUntrackedView, then .orrery/ too when that leaves it empty (and it is a real folder of
 * the user's).
 */
export function deleteViewFile(folder: string): boolean {
	const deleted = deleteUntrackedView(folder);
	const orreryDir = dirname(viewFile(folder));
	if (ownFolder(orreryDir) === true) {
		try {
			rmdirSync(orreryDir);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOTEMPTY" && code !== "ENOENT" && code !== "EEXIST") throw error;
		}
	}
	return deleted;
}

/** How the agent gets its memory into Claude Code: the Orrery mod (in any folder), or the view file claude-setup set up. */
export type AgentMode = "mod" | "file";

/**
 * Whether the marker names `folder`, the folder claude-setup set up. An agent switched to the mod with no folder has
 * a marker naming none (""), which must never pass for the folder a process runs in.
 */
function names(marker: SetupMarker, folder: string | undefined): folder is string {
	return folder !== undefined && marker.folder !== "" && samePath(marker.folder, folder);
}

/**
 * "file" when claude-setup set up the view file in the agent's folder (a file-mode marker naming it); else "mod",
 * wherever the session runs: the mod needs no setup and no file in any folder (no marker, a mod marker, a malformed
 * one, or a file-mode marker for another folder).
 */
export function agentMode(agent: AgentConfig): AgentMode {
	const marker = readSetupMarker(agent.dir);
	return marker !== undefined && marker.file !== "mod" && names(marker, agent.folder) ? "file" : "mod";
}

/** The agent's message count, read-only; undefined when it has no memory yet. */
export function messageCount(agent: AgentConfig): number | undefined {
	const file = join(agent.dir, "memory.sqlite");
	if (!existsSync(file)) return undefined;
	const store = MemoryStore.openReadOnly(file);
	try {
		return store.root.length;
	} finally {
		store.close();
	}
}

/**
 * Takes the view out of the agent's folder while git cannot say whether it would see it, keeping the marker: the
 * next gate that passes writes it back. Only in file mode for this folder (so orrery wrote the view there). Returns
 * whether it deleted one.
 */
export function takeOutView(agent: AgentConfig): boolean {
	return agentMode(agent) === "file" && deleteView(agent.folder as string);
}

/**
 * Takes the view back from the agent's folder, where git would see it. First the view file, when the marker named
 * this folder (so orrery wrote it); then the marker, so nothing writes the view any more. A delete that fails
 * throws and leaves the marker, so the next gate tries again. Without a marker it does nothing: a .orrery/view.md
 * there is the repo's own.
 */
export function withdrawView(agent: AgentConfig): void {
	const marker = readSetupMarker(agent.dir);
	if (marker === undefined) return;
	if (names(marker, agent.folder)) deleteView(agent.folder);
	removeSetupMarker(agent.dir);
}

/** The marker's file still imports the view, and nothing planted at .orrery would misdirect the write. */
function viewWanted(agent: AgentConfig, file: SetupFile): boolean {
	const folder = agent.folder;
	if (folder === undefined || !importsView(join(folder, file))) return false;
	return ownFolder(dirname(viewFile(folder))) !== false;
}

/** Whether the view may be written now, and when not because of git, what happened to it. */
export interface ViewGate {
	readonly open: boolean;
	/**
	 * Git would see the view (a definite answer). It was withdrawn, the view file and then the marker, unless `failed`
	 * says why the view could not be deleted: then the marker stays, and the next gate tries again.
	 */
	readonly exposed?: Exposure;
	/**
	 * Why the view file could not be deleted: a failed withdrawal (with `exposed`), or in mod mode a stale view that
	 * stays until a later gate deletes it. Never set when git could not answer.
	 */
	readonly failed?: string;
	/**
	 * Git could not say this time, or a check threw: the view is taken out until git answers again (deleted, not
	 * written), and the marker stays, so the next gate that passes writes it back.
	 */
	readonly unchecked?: string;
	/** The gate is closed because the agent is in mod mode. */
	readonly mod?: true;
	/** Whether this gate, unchecked, took a view out (the holder logs it). */
	readonly removed?: boolean;
}

/**
 * The one gate in front of the view file, for every writer (through writeViewFile) and for SessionStart's warnings:
 * - claude-setup's marker must name this folder, which must exist (else nothing of orrery's is there to guard);
 * - git must not see the view (gitExposure). When it would, the view is withdrawn (withdrawView) and `exposed` says
 *   why. When git cannot say, the view is taken out until it can (takeOutView) and `unchecked` says why;
 * - the marker's file must still import the view, and nothing may be planted at .orrery.
 * In mod mode (a "mod" marker, or no file setup for this folder) none of that applies: the gate is closed (`mod`), and
 * with a mod marker a stale view file in the folder it names is deleted (deleteUntrackedView: not one git tracks), and `failed` says why when it could not be.
 * A check that throws counts as unchecked: the view is taken out as far as it can be, and nothing is written.
 */
export function viewGate(agent: AgentConfig): ViewGate {
	try {
		const marker = readSetupMarker(agent.dir);
		const folder = agent.folder;
		// Mod mode (spec 2026-10-08-claude-code-mod §4.6), wherever the session runs: the Orrery mod puts the view in the
		// system prompt, so no view file is written, and one left from file mode in the agent's own folder is deleted.
		if (marker?.file === "mod") {
			if (!names(marker, folder) || !existsSync(folder)) return { open: false, mod: true };
			try {
				return { open: false, mod: true, removed: deleteUntrackedView(folder) };
			} catch (error) {
				// A view that cannot be deleted now is tried again at the next gate.
				return { open: false, mod: true, failed: errorText(error) };
			}
		}
		// No setup, or a file setup for another folder: the mod, with no view file (one there without a marker is the repo's own).
		if (marker === undefined || !names(marker, folder)) return { open: false, mod: true };
		if (!existsSync(folder)) return { open: false };
		const exposure = gitExposure(folder);
		if (exposure?.kind === "unchecked") return { open: false, unchecked: exposure.reason, removed: takeOutView(agent) };
		if (exposure !== undefined) {
			try {
				withdrawView(agent);
			} catch (error) {
				return { open: false, exposed: exposure, failed: errorText(error) };
			}
			return { open: false, exposed: exposure };
		}
		return { open: viewWanted(agent, marker.file) };
	} catch (error) {
		let removed = false;
		try {
			removed = takeOutView(agent);
		} catch {
			// As far as it can: the view could not be deleted either, and nothing is written.
		}
		return { open: false, unchecked: `a check failed: ${errorText(error)}`, removed };
	}
}

/**
 * Writes the view into the agent's folder if its gate (viewGate) lets it; false otherwise. `onGate` hears what the
 * gate said (the holder logs a withdrawal, SessionStart warns). The agent's instructions come first; `view` undefined
 * (no memory yet) leaves the memory section out.
 */
export function writeViewFile(agent: AgentConfig, view: MemoryView | undefined, onGate?: (gate: ViewGate) => void): boolean {
	const gate = viewGate(agent);
	onGate?.(gate);
	if (!gate.open || agent.folder === undefined) return false;
	const found = readInstructions(agent.dir);
	// Fenced like the view: Claude Code evaluates no @path import inside a code block.
	const parts = [...(found === undefined ? [] : [`# Agent: ${agent.name}\n\n${fenced(found.text.trimEnd())}`]), ...(view === undefined ? [] : [memorySection(view, "claude-code")])];
	writePrivate(viewFile(agent.folder), parts.join("\n\n"));
	return true;
}

/**
 * Writes the view from a read-only snapshot of the agent's memory (SessionStart, claude-setup), where writeViewFile
 * would; `onGate` as there. Returns the message count, or undefined when the agent has no memory yet: then the view
 * file holds the agent's instructions alone when it has some, and otherwise no gate runs and nothing is written.
 */
export function refreshViewFile(agent: AgentConfig, onGate?: (gate: ViewGate) => void): number | undefined {
	const file = join(agent.dir, "memory.sqlite");
	if (!existsSync(file)) {
		if (readInstructions(agent.dir) !== undefined) writeViewFile(agent, undefined, onGate);
		return undefined;
	}
	const store = MemoryStore.openReadOnly(file);
	try {
		writeViewFile(agent, new MemoryView(store, agent.memory.viewBytes), onGate);
		return store.root.length;
	} finally {
		store.close();
	}
}
