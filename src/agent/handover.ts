/**
 * Handing an agent over (spec §4 "One writer"). The holder that records a Claude Code or Codex session keeps a heartbeat
 * in <agent.dir>/claude/holder.json.
 * - Once its session has ended, the holder only finishes summaries. Whoever opens the agent next (a new Claude Code or
 *   Codex session, or pi) may then ask it to yield by writing yield.json, and it saves what it has and releases the agent
 *   within a tick.
 * - A holder still recording yields only to its own host process (the same Claude Code or Codex), which starts a new
 *   session on /clear or /resume.
 * Without a holder.json (an agent only pi uses), opening works exactly as before.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { RemoteStatus } from "../remote/types.ts";
import { AgentHeld } from "./memory-agent.ts";
import { writePrivate } from "./private-file.ts";
import { processAlive } from "./process.ts";
import { readStatus } from "./status-file.ts";

/** The tool whose session a holder records. */
export type HolderHost = "claude-code" | "codex";

/** A host's name as said to a person. */
export const HOST_LABELS: Record<HolderHost, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** holder.json: who records the agent, for which session and host process, and whether it only finishes. */
export interface HolderState {
	readonly pid: number;
	readonly session: string;
	/** The host's process: Claude Code's, or Codex's (the name is older than Codex, and kept for files already written). */
	readonly claudePid: number;
	/** "codex" for a Codex session's holder; absent for Claude Code's, as in every holder.json before Codex. */
	readonly host?: "codex";
	readonly state: "recording" | "finishing";
	readonly startedAt: number;
	readonly updatedAt: number;
	/** Public save/lock state from this recorder's RemoteSession. */
	readonly remote?: RemoteStatus;
	/** The Orrery version the holder runs (status-file.ts statusVersion); the hooks compare it with the installed one. */
	readonly version?: string;
}

/** yield.json: a newcomer asking the holder for the agent. */
export interface YieldRequest {
	readonly at: number;
	/** The asking host process (Claude Code's or Codex's); pi leaves it out. */
	readonly claudePid?: number;
}

/** A heartbeat older than this belongs to a holder that is gone (it beats every 5 s). */
export const FRESH_MS = 15_000;

/** The holder's heartbeat file. */
export const holderFile = (agentDir: string) => join(agentDir, "claude", "holder.json");
/** A newcomer's request to yield. */
export const yieldFile = (agentDir: string) => join(agentDir, "claude", "yield.json");

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** The agent's holder.json, or undefined when there is none or it is malformed. */
export function readHolder(agentDir: string): HolderState | undefined {
	const value = readJson(holderFile(agentDir));
	if (value === undefined) return undefined;
	const numbers = [value.pid, value.claudePid, value.startedAt, value.updatedAt].every((n) => typeof n === "number" && Number.isFinite(n));
	const ok = numbers && typeof value.session === "string" && (value.state === "recording" || value.state === "finishing");
	return ok ? (value as unknown as HolderState) : undefined;
}

/** Whether `holder` beat within FRESH_MS, so it still runs. */
export function holderFresh(holder: HolderState | undefined, now = Date.now()): holder is HolderState {
	return holder !== undefined && now - holder.updatedAt <= FRESH_MS;
}

/**
 * A tool an agent can be open in, as status.json's `model` names it for pi, OMP, OpenCode and the recorders
 * (memory-agent.ts).
 */
export type HoldingTool = "pi" | "omp" | "opencode" | HolderHost;

const HOLDING_LABELS: Record<HoldingTool, string> = { pi: "pi", omp: "OMP", opencode: "OpenCode", ...HOST_LABELS };

/** A status.json this fresh is from a running session (pi and OMP write it every 5 s; as overview.ts's STATUS_FRESH_MS). */
const STATUS_FRESH_MS = 30_000;

/**
 * The tool that has the agent open now: a recorder's host while its heartbeat is fresh (Claude Code or Codex), else the
 * tool a fresh status.json of a live process names (pi, OMP or OpenCode); undefined when neither says.
 */
export function holdingTool(agentDir: string, now = Date.now(), alive: (pid: number) => boolean = processAlive): HoldingTool | undefined {
	const holder = readHolder(agentDir);
	if (holderFresh(holder, now)) return holder.host === "codex" ? "codex" : "claude-code";
	const status = readStatus(agentDir);
	if (status === undefined || status.open === false || !alive(status.pid) || !(now - Date.parse(status.updatedAt) < STATUS_FRESH_MS)) return undefined;
	return Object.hasOwn(HOLDING_LABELS, status.model) ? (status.model as HoldingTool) : undefined;
}

/**
 * Where the agent is open, said to a session of `self` that can't have it: "open in Codex", "open in another Claude Code
 * session", or, when nothing says which tool, the tools it could be (an open OpenCode always says, in its status.json).
 */
export function openElsewhere(agentDir: string, self: HoldingTool, now = Date.now()): string {
	const tool = holdingTool(agentDir, now);
	if (tool === self) return `open in another ${HOLDING_LABELS[self]} session`;
	if (tool !== undefined) return `open in ${HOLDING_LABELS[tool]}`;
	const others = (["pi", "omp", "claude-code", "codex"] as const).filter((other) => other !== self).map((other) => HOLDING_LABELS[other]);
	return `open elsewhere (${others.join(", ")}, or another ${HOLDING_LABELS[self]} session)`;
}

/** Writes the heartbeat (private, atomic). */
export function writeHolder(agentDir: string, holder: HolderState): void {
	writePrivate(holderFile(agentDir), JSON.stringify(holder));
}

/** Removes holder.json if it still names this holder; another may have taken over since. */
export function removeHolder(agentDir: string, pid: number, session: string): void {
	const holder = readHolder(agentDir);
	if (holder !== undefined && holder.pid === pid && holder.session === session) rmSync(holderFile(agentDir), { force: true });
}

/** A yield request made in the last FRESH_MS (an opener waits for the agent much less than that). */
export function readYield(agentDir: string, now = Date.now()): YieldRequest | undefined {
	const value = readJson(yieldFile(agentDir));
	if (value === undefined || typeof value.at !== "number" || now - value.at > FRESH_MS) return undefined;
	return { at: value.at, ...(typeof value.claudePid === "number" ? { claudePid: value.claudePid } : {}) };
}

/** Removes the yield request, once spent. */
export function clearYield(agentDir: string): void {
	rmSync(yieldFile(agentDir), { force: true });
}

/** Asks the agent's holder to yield if it would: it is only finishing, or it records for this same Claude Code. */
export function requestYield(agentDir: string, claudePid?: number): boolean {
	const holder = readHolder(agentDir);
	if (!holderFresh(holder)) return false;
	if (holder.state !== "finishing" && (claudePid === undefined || holder.claudePid !== claudePid)) return false;
	writePrivate(yieldFile(agentDir), JSON.stringify({ at: Date.now(), ...(claudePid === undefined ? {} : { claudePid }) }));
	return true;
}

/**
 * Opens an agent with `open`, which throws AgentHeld while another writer holds it. If that writer is a holder that
 * would yield (requestYield), it waits up to `waitMs` for the agent. Otherwise AgentHeld stands at once.
 */
export async function openYielding<T>(open: () => T, agentDir: string, options: { claudePid?: number; waitMs?: number } = {}): Promise<T> {
	const deadline = Date.now() + (options.waitMs ?? 5000);
	let asked = false;
	for (;;) {
		try {
			const opened = open();
			// The request is spent: a new holder must never read it as a request to yield itself.
			if (asked) clearYield(agentDir);
			return opened;
		} catch (error) {
			if (!(error instanceof AgentHeld)) throw error;
			asked ||= requestYield(agentDir, options.claudePid);
			if (!asked || Date.now() >= deadline) throw error;
		}
		await sleep(100);
	}
}
