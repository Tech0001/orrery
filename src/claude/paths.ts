/**
 * Where Claude Code's side of an agent lives.
 * - In the agent's data folder:
 *   - claude/sessions/<session>/ is the spool: one folder per Claude Code session, with its events and the mode its
 *     holder chose;
 *   - claude/holder.json and claude/yield.json (src/agent/handover.ts);
 *   - claude/holder.log, which never holds message contents;
 *   - claude/setup.json, claude-setup's marker: the view is written into the folder it names, and nowhere else;
 *   - claude/unconfirmed.json, how many prompts the transcript never confirmed (a count, no words).
 * - In the folder: .orrery/view.md, which CLAUDE.md imports.
 * Folders are 0700 and files 0600, because they hold the user's words.
 */

import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/** The spool: one folder per Claude Code session. */
export const sessionsDir = (agentDir: string) => join(agentDir, "claude", "sessions");
/** One session's spool folder (check the id with validSession first). */
export const sessionDir = (agentDir: string, session: string) => join(sessionsDir(agentDir), session);
/** The holders' log: lifecycle and errors only. */
export const holderLog = (agentDir: string) => join(agentDir, "claude", "holder.log");
/** claude-setup's marker (src/claude/view-file.ts): trusted, since it lives in the agent's data folder, not the folder. */
export const setupMarker = (agentDir: string) => join(agentDir, "claude", "setup.json");
/** How many prompts Claude Code's transcript never confirmed, dropped by holders (src/claude/transcript.ts). */
export const unconfirmedFile = (agentDir: string) => join(agentDir, "claude", "unconfirmed.json");
/** The view file Claude Code loads through CLAUDE.md. */
export const viewFile = (folder: string) => join(folder, ".orrery", "view.md");

/** Claude Code's session ids are UUIDs. Anything else could name a folder outside the spool, so it is refused. */
export function validSession(id: unknown): id is string {
	return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** Whether two paths name the same folder, symlinks followed. */
export function samePath(a: string, b: string): boolean {
	return real(a) === real(b);
}
