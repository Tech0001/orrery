/**
 * Handing a lane over (spec §4 "One writer"). Claude Code's holder keeps a heartbeat in
 * <lane.dir>/claude/holder.json.
 * - Once its session has ended, the holder only finishes summaries. Whoever opens the lane next (a new Claude Code
 *   session, or pi) may then ask it to yield by writing yield.json, and it saves what it has and releases the lane
 *   within a tick.
 * - A holder still recording yields only to its own Claude Code process, which starts a new session on /clear or
 *   /resume.
 * Without a holder.json (a lane only pi uses), opening works exactly as before.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { RemoteStatus } from "../remote/types.ts";
import { LaneHeld } from "./memory-lane.ts";
import { writePrivate } from "./private-file.ts";

/** holder.json: who records the lane, for which session and Claude Code process, and whether it only finishes. */
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

/** yield.json: a newcomer asking the holder for the lane. */
export interface YieldRequest {
	readonly at: number;
	/** The asking Claude Code process; pi leaves it out. */
	readonly claudePid?: number;
}

/** A heartbeat older than this belongs to a holder that is gone (it beats every 5 s). */
export const FRESH_MS = 15_000;

/** The holder's heartbeat file. */
export const holderFile = (laneDir: string) => join(laneDir, "claude", "holder.json");
/** A newcomer's request to yield. */
export const yieldFile = (laneDir: string) => join(laneDir, "claude", "yield.json");

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** The lane's holder.json, or undefined when there is none or it is malformed. */
export function readHolder(laneDir: string): HolderState | undefined {
	const value = readJson(holderFile(laneDir));
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
export function writeHolder(laneDir: string, holder: HolderState): void {
	writePrivate(holderFile(laneDir), JSON.stringify(holder));
}

/** Removes holder.json if it still names this holder; another may have taken over since. */
export function removeHolder(laneDir: string, pid: number, session: string): void {
	const holder = readHolder(laneDir);
	if (holder !== undefined && holder.pid === pid && holder.session === session) rmSync(holderFile(laneDir), { force: true });
}

/** A yield request made in the last FRESH_MS (an opener waits for the lane much less than that). */
export function readYield(laneDir: string, now = Date.now()): YieldRequest | undefined {
	const value = readJson(yieldFile(laneDir));
	if (value === undefined || typeof value.at !== "number" || now - value.at > FRESH_MS) return undefined;
	return { at: value.at, ...(typeof value.claudePid === "number" ? { claudePid: value.claudePid } : {}) };
}

/** Removes the yield request, once spent. */
export function clearYield(laneDir: string): void {
	rmSync(yieldFile(laneDir), { force: true });
}

/** Asks the lane's holder to yield if it would: it is only finishing, or it records for this same Claude Code. */
export function requestYield(laneDir: string, claudePid?: number): boolean {
	const holder = readHolder(laneDir);
	if (!holderFresh(holder)) return false;
	if (holder.state !== "finishing" && (claudePid === undefined || holder.claudePid !== claudePid)) return false;
	writePrivate(yieldFile(laneDir), JSON.stringify({ at: Date.now(), ...(claudePid === undefined ? {} : { claudePid }) }));
	return true;
}

/**
 * Opens a lane with `open`, which throws LaneHeld while another writer holds it. If that writer is a holder that
 * would yield (requestYield), it waits up to `waitMs` for the lane. Otherwise LaneHeld stands at once.
 */
export async function openYielding<T>(open: () => T, laneDir: string, options: { claudePid?: number; waitMs?: number } = {}): Promise<T> {
	const deadline = Date.now() + (options.waitMs ?? 5000);
	let asked = false;
	for (;;) {
		try {
			const opened = open();
			// The request is spent: a new holder must never read it as a request to yield itself.
			if (asked) clearYield(laneDir);
			return opened;
		} catch (error) {
			if (!(error instanceof LaneHeld)) throw error;
			asked ||= requestYield(laneDir, options.claudePid);
			if (!asked || Date.now() >= deadline) throw error;
		}
		await sleep(100);
	}
}
