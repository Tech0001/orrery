/**
 * Handing an agent over (spec §4 "One writer"). Claude Code's holder keeps a heartbeat in
 * <agent.dir>/claude/holder.json.
 * - Once its session has ended, the holder only finishes summaries. Whoever opens the agent next (a new Claude Code
 *   session, or pi) may then ask it to yield by writing yield.json, and it saves what it has and releases the agent
 *   within a tick.
 * - A holder still recording yields only to its own Claude Code process, which starts a new session on /clear or
 *   /resume.
 * Without a holder.json (an agent only pi uses), opening works exactly as before.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { RemoteStatus } from "../remote/types.ts";
import { AgentHeld } from "./memory-agent.ts";
import { writePrivate } from "./private-file.ts";

/** holder.json: who records the agent, for which session and Claude Code process, and whether it only finishes. */
export interface HolderState {
	readonly pid: number;
	readonly session: string;
	readonly claudePid: number;
	readonly state: "recording" | "finishing";
	readonly startedAt: number;
	readonly updatedAt: number;
	/** Public save/lock state from this recorder's RemoteSession. */
	readonly remote?: RemoteStatus;
}

/** yield.json: a newcomer asking the holder for the agent. */
export interface YieldRequest {
	readonly at: number;
	/** The asking Claude Code process; pi leaves it out. */
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
