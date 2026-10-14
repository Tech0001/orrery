/**
 * Which lane a session belongs to (spec 2026-10-13-orrery-agents-design §4), decided at session start by pi's and OMP's
 * extension (and, later, Claude Code's hooks, MCP server and mod view), in order:
 * 1. ORRERY_AGENT, when set: the lane it names (ignoring case), or "unknown" (a notice and no memory; no fallback).
 *    A launcher may also set ORRERY_AGENT_TOKEN. The first process that starts a session with that token owns it
 *    (claims/<token> in the lane's folder), so a tool the agent starts itself, which inherits both variables, is not the
 *    agent too: it falls through to 2.
 * 2. The lane whose workspace holds the folder (laneForCwd).
 * 3. None.
 * Node built-ins and relative imports only: pi and OMP load this file.
 */

import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { type HarnessConfig, inWorkspace, type LaneConfig, laneForCwd } from "./config.ts";
import { processAlive } from "./process.ts";
import { safeText } from "./source-labels.ts";

export const AGENT_ENV = "ORRERY_AGENT";
export const TOKEN_ENV = "ORRERY_AGENT_TOKEN";
const TOKEN = /^[0-9a-f]{16,64}$/;
/** A claim file with no pid in it this long after it was made was left by a process that died while making it. */
const UNWRITTEN_CLAIM_MS = 60_000;

export type Picked =
	| { readonly kind: "lane"; readonly lane: LaneConfig; readonly by: "env" | "folder" }
	| { readonly kind: "unknown"; readonly name: string }
	| { readonly kind: "none" };

export interface Where {
	readonly env: NodeJS.ProcessEnv;
	/** The session's folder: pi's cwd, Claude Code's project folder. */
	readonly cwd: string;
	/** The session's own tool process: pi's or OMP's pid; Claude Code's pid for its hooks, MCP server and mod view. */
	readonly owner: number;
	/** Whether a pid lives (default processAlive); tests pass their own. */
	readonly alive?: (pid: number) => boolean;
}

/** The lane `name` names: an exact match, else the one match ignoring case. */
function laneNamed(config: HarnessConfig, name: string): LaneConfig | undefined {
	const exact = config.lanes.get(name);
	if (exact !== undefined) return exact;
	const matches = [...config.lanes.values()].filter((lane) => lane.name.toLowerCase() === name.toLowerCase());
	return matches.length === 1 ? matches[0] : undefined;
}

export function pickLane(config: HarnessConfig, where: Where): Picked {
	const name = where.env[AGENT_ENV]?.trim();
	if (name) {
		const lane = laneNamed(config, name);
		if (lane === undefined) return { kind: "unknown", name };
		const token = where.env[TOKEN_ENV];
		if (token === undefined || token === "" || claimToken(lane.dir, token, where.owner, where.alive)) return { kind: "lane", lane, by: "env" };
	}
	const lane = laneForCwd(config, where.cwd);
	return lane === undefined ? { kind: "none" } : { kind: "lane", lane, by: "folder" };
}

/** The pid a claim file holds, or undefined when it holds none (unreadable, or not written yet). */
function claimant(file: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Takes out claims whose process is gone: left by tools that crashed, or ended before their launcher released the
 * claim. A live owner's claim stays however old it is (an agent may run for weeks).
 */
function pruneClaims(dir: string, alive: (pid: number) => boolean): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const file = join(dir, name);
		try {
			const pid = claimant(file);
			if (pid === undefined ? Date.now() - statSync(file).mtimeMs > UNWRITTEN_CLAIM_MS : !alive(pid)) rmSync(file, { force: true });
		} catch {
			// gone already
		}
	}
}

/**
 * Whether `owner` may take ORRERY_AGENT with `token`: it claimed it before, or is the first to claim it, or the process
 * that claimed it is gone. False for a token that is not hex (it must never name a file elsewhere).
 */
export function claimToken(laneDir: string, token: string, owner: number, alive: (pid: number) => boolean = processAlive): boolean {
	if (!TOKEN.test(token)) return false;
	const dir = join(laneDir, "claims");
	const file = join(dir, token);
	// The owner's own claim, the common case (Claude Code asks at every hook): nothing to prune or write.
	if (claimant(file) === owner) return true;
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		pruneClaims(dir, alive);
		const fd = openSync(file, "wx", 0o600);
		try {
			writeSync(fd, `${owner}\n`);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (error) {
		// A claim that cannot be recorded never costs the session its agent.
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return true;
	}
	const held = claimant(file);
	if (held === owner) return true;
	if (held !== undefined && alive(held)) return false;
	// Its owner died since the prune, or it holds no pid: the claim is this owner's now.
	try {
		writeFileSync(file, `${owner}\n`, { mode: 0o600 });
	} catch {
		// the session keeps its agent
	}
	return true;
}

/** Removes a claim its launcher made, once its tool has exited. */
export function releaseClaim(laneDir: string, token: string): void {
	if (TOKEN.test(token)) rmSync(join(laneDir, "claims", token), { force: true });
}

export function newToken(): string {
	return randomBytes(16).toString("hex");
}

/** Where a session of `lane` works: its workspace when the session runs in it or below it, else the session's folder. */
export function workArea(lane: Pick<LaneConfig, "workspace">, cwd: string): string {
	return lane.workspace !== undefined && inWorkspace(lane, cwd) ? lane.workspace : resolve(cwd);
}

export function unknownAgentNotice(name: string): string {
	return `Orrery: ORRERY_AGENT names ${safeText(name)}, which is not a configured agent; this session runs without memory.`;
}
