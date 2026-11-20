/**
 * What the Antigravity CLI's process is called, its folder, and the hook events Orrery answers for it (spec
 * 2026-11-20-antigravity-design). Node built-ins only: src/agent/sessions.ts and the install use it, and must not load
 * the hooks.
 */

import { isAbsolute, join } from "node:path";

/** The events `orrery agy-hook` answers, as its command line names them (pre-tool-use is the guard). */
export const AGY_HOOK_EVENTS = ["session-start", "pre-invocation", "pre-tool-use", "stop"] as const;
export type AgyHookEvent = (typeof AGY_HOOK_EVENTS)[number];

/** Antigravity's own names for those events, in its hooks.json. */
export const AGY_EVENT_NAMES: Readonly<Record<AgyHookEvent, string>> = {
	"session-start": "SessionStart",
	"pre-invocation": "PreInvocation",
	"pre-tool-use": "PreToolUse",
	stop: "Stop",
};

/**
 * Is `name` (a program's file name) the Antigravity CLI's? mise installs it as `antigravity` (seen live, agy 1.5.13:
 * `~/.local/share/mise/installs/antigravity-cli/<version>/antigravity`, run through an `agy` shim); `agy` itself counts
 * too.
 */
export function isAgyProcess(name: string): boolean {
	return name === "agy" || name === "antigravity";
}

/** The variables of agy's start environment that name its folder: Antigravity reads none but HOME. */
export const AGY_FOLDER_VARIABLES: readonly string[] = ["HOME"];

/** The Antigravity CLI's folder under a HOME: `~/.gemini/antigravity-cli`. Undefined for a HOME that is no absolute path. */
export function agyFolder(home: string | undefined): string | undefined {
	return home !== undefined && home !== "" && isAbsolute(home) ? join(home, ".gemini", "antigravity-cli") : undefined;
}

/** Antigravity's global configuration folder under a HOME, shared with its App and IDE: `~/.gemini/config`. */
export function agyConfigFolder(home: string): string {
	return join(home, ".gemini", "config");
}

/** A conversation's transcript under Antigravity's folder `folder`. */
export function agyTranscript(folder: string, conversation: string): string {
	return join(folder, "brain", conversation, ".system_generated", "logs", "transcript_full.jsonl");
}

/** What Orrery calls Antigravity in what it says. */
export const AGY_LABEL = "Antigravity";
