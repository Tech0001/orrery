/**
 * The spool between Claude Code's hooks and the agent's holder (spec §4 "Hooks"). A hook never writes the store. It
 * drops one small JSON file per event into its session's folder and returns.
 * - A name holds the time in milliseconds (15 digits), the writer's pid (10) and a per-process counter (6). Names sort
 *   in arrival order and never collide.
 * - The holder ingests events in that order. It stores the last name per session in memory meta, in the same
 *   transaction as the messages, so no event is ever recorded twice, even across a crash.
 */

import { readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RemoteStatus } from "../remote/types.ts";
import { writePrivate } from "../agent/private-file.ts";
import { sessionDir, sessionsDir, validSession } from "./paths.ts";

/**
 * One hook event: the user's prompt, the turn's final reply, one of orrery's own commands (text-less: its reply
 * stays out of memory), the session's end, a summary model switch, or the session's transcript or rollout.
 * - A Claude Code prompt carries the hook's `promptId` ("" when the hook got none): the holder records it only once
 *   Claude Code's transcript confirms it (src/claude/transcript.ts); one without a promptId never is.
 * - Codex's hook marks its prompts and replies `host: "codex"`, with the hook's `turnId` ("" when it got none): the
 *   holder records each only once Codex's rollout confirms it (src/codex/rollout.ts); one without a turnId never is.
 * - `transcript`: SessionStart's, once its caller was checked (src/claude/peer.ts): the session's transcript file under
 *   Claude Code's projects folder, and its size then, where the session's prompts are looked for.
 * - `rollout`: Codex's SessionStart's, once Codex was seen holding it open: the session's rollout under Codex's folder
 *   (`home`), and where to read it from.
 */
export type SpoolEvent =
	| { readonly kind: "prompt"; readonly at: number; readonly claudePid: number; readonly text: string; readonly promptId?: string; readonly host?: "codex"; readonly turnId?: string }
	| { readonly kind: "reply"; readonly at: number; readonly claudePid: number; readonly text: string; readonly host?: "codex"; readonly turnId?: string }
	| { readonly kind: "command"; readonly at: number; readonly claudePid: number }
	| { readonly kind: "end"; readonly at: number; readonly claudePid: number; readonly reason?: string }
	| { readonly kind: "compactor"; readonly at: number; readonly claudePid: number; readonly args: string }
	| { readonly kind: "transcript"; readonly at: number; readonly claudePid: number; readonly path: string; readonly projects: string; readonly offset: number }
	| { readonly kind: "rollout"; readonly at: number; readonly claudePid: number; readonly path: string; readonly home: string; readonly offset: number };

/**
 * What a session's holder chose, from `since` (its start) on. `nonce` comes from SessionStart, so the hook knows this
 * holder answered and not an older one.
 */
export interface SessionMode {
	readonly mode: "recording" | "read-only";
	readonly pid: number;
	readonly claudePid: number;
	readonly nonce: string;
	readonly since: number;
	readonly reason?: string;
	/** A terminal lock-loss notice, retained for this Claude session after its recorder exits. */
	readonly remote?: RemoteStatus;
}

/** A spooled event not yet ingested. */
export interface Pending {
	readonly session: string;
	readonly name: string;
	readonly path: string;
	/** When the event happened (the name's first part). */
	readonly at: number;
}

const EVENT_NAME = /^(\d{15})-\d{10}-\d{6}-(prompt|reply|command|end|compactor|transcript|rollout)\.json$/;
const MODE = "mode.json";
/** From here on a local date can have a five-digit year, which memory refuses: such an event would never go in. */
const LAST_AT = Date.UTC(9999, 11, 31);
let sequence = 0;

/** The meta key holding the last event name ingested from a session. */
export const spoolKey = (session: string) => `claude.spool.${session}`;

/** A fresh event file name: time, pid and counter, so names sort in arrival order and never collide. */
export function eventName(at: number, kind: SpoolEvent["kind"]): string {
	sequence = (sequence + 1) % 1_000_000;
	return `${String(Math.trunc(at)).padStart(15, "0")}-${String(process.pid).padStart(10, "0")}-${String(sequence).padStart(6, "0")}-${kind}.json`;
}

/** Drops `event` into the session's spool folder (private, atomic) and returns its file name. */
export function spoolEvent(agentDir: string, session: string, event: SpoolEvent): string {
	if (!validSession(session)) throw new Error("Orrery: not a Claude Code session id");
	const name = eventName(event.at, event.kind);
	writePrivate(join(sessionDir(agentDir, session), name), JSON.stringify(event));
	return name;
}

/** The event in `path`, or undefined when it is unreadable or malformed. */
export function readEvent(path: string): SpoolEvent | undefined {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || typeof value.claudePid !== "number") return undefined;
	if (typeof value.at !== "number" || !(value.at >= 0 && value.at < LAST_AT)) return undefined;
	const codex = (value.host === undefined || value.host === "codex") && (value.turnId === undefined || typeof value.turnId === "string");
	if (value.kind === "prompt" && typeof value.text === "string" && (value.promptId === undefined || typeof value.promptId === "string") && codex) {
		return value as unknown as SpoolEvent;
	}
	if (value.kind === "reply" && typeof value.text === "string" && codex) return value as unknown as SpoolEvent;
	const offset = Number.isSafeInteger(value.offset) && (value.offset as number) >= 0;
	if (value.kind === "transcript" && typeof value.path === "string" && typeof value.projects === "string" && offset) return value as unknown as SpoolEvent;
	if (value.kind === "rollout" && typeof value.path === "string" && typeof value.home === "string" && offset) return value as unknown as SpoolEvent;
	if (value.kind === "command") return { kind: "command", at: value.at, claudePid: value.claudePid };
	if (value.kind === "end" || (value.kind === "compactor" && typeof value.args === "string")) return value as unknown as SpoolEvent;
	return undefined;
}

/** The sessions that have a spool folder. */
export function listSessions(agentDir: string): string[] {
	try {
		return readdirSync(sessionsDir(agentDir)).filter(validSession).sort();
	} catch {
		return [];
	}
}

/**
 * A session's events after `after` (the last name ingested), oldest first. Files at or before it were ingested
 * before a crash and are removed here.
 */
export function pendingEvents(agentDir: string, session: string, after?: string): Pending[] {
	let names: string[];
	try {
		names = readdirSync(sessionDir(agentDir, session)).filter((name) => EVENT_NAME.test(name)).sort();
	} catch {
		return [];
	}
	const pending: Pending[] = [];
	for (const name of names) {
		const path = join(sessionDir(agentDir, session), name);
		if (after !== undefined && name <= after) rmSync(path, { force: true });
		else pending.push({ session, name, path, at: Number(name.slice(0, 15)) });
	}
	return pending;
}

/** The mode a session's holder chose, if any. */
export function readMode(agentDir: string, session: string): SessionMode | undefined {
	try {
		const value = JSON.parse(readFileSync(join(sessionDir(agentDir, session), MODE), "utf8")) as SessionMode;
		return value.mode === "recording" || value.mode === "read-only" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Records the mode a session's holder chose (private, atomic). */
export function writeMode(agentDir: string, session: string, mode: SessionMode): void {
	writePrivate(join(sessionDir(agentDir, session), MODE), JSON.stringify(mode));
}

/**
 * Removes a spent session folder, and only what the caller checked. A resumed session's new holder and its hooks
 * write into the same folder at any time, so:
 * - it unlinks the events in `checked`, and nothing else;
 * - it unlinks mode.json only while it still names `owner` (the holder whose mode was checked);
 * - it removes the folder only if nothing else is left in it.
 */
export function removeSession(agentDir: string, session: string, checked: readonly Pending[], owner: Pick<SessionMode, "pid" | "nonce"> | undefined): void {
	for (const event of checked) rmSync(event.path, { force: true });
	const mode = readMode(agentDir, session);
	if (owner !== undefined && mode !== undefined && mode.pid === owner.pid && mode.nonce === owner.nonce) {
		rmSync(join(sessionDir(agentDir, session), MODE), { force: true });
	}
	try {
		rmdirSync(sessionDir(agentDir, session));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// Not empty: someone wrote meanwhile, and what they wrote stays. Gone: someone else removed it.
		if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
	}
}

/** Removes a session's events from `since` on: they came while it was read-only (or undecided) and never enter memory. */
export function dropEventsSince(agentDir: string, session: string, since: number): void {
	for (const event of pendingEvents(agentDir, session)) if (event.at >= since) rmSync(event.path, { force: true });
}
