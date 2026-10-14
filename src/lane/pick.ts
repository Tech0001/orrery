/**
 * Which lane a session belongs to (spec 2026-10-13-orrery-agents-design §4), decided at session start by pi's and OMP's
 * extension (and, later, Claude Code's hooks, MCP server and mod view), in order:
 * 1. ORRERY_AGENT, when set: the lane it names (ignoring case), or "unknown" (a notice and no memory; no fallback).
 *    A launcher may also set ORRERY_AGENT_TOKEN, 32 lowercase hex digits; any other value is "bad-token" (a notice and no
 *    memory; no fallback). The first process that starts a session with that token owns it (claims/<token> in the lane's
 *    folder), so a tool the agent starts itself, which inherits both variables, is not the agent too: it falls through
 *    to 2. A dead owner's claim is taken over only at a session's start (`takeover`); a session's later picks (Claude
 *    Code asks at every hook) keep what its start decided, so it never changes lanes midway.
 * 2. The lane whose workspace holds the folder (laneForCwd).
 * 3. None.
 * Node built-ins and relative imports only: pi and OMP load this file.
 */

import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type HarnessConfig, inWorkspace, type LaneConfig, laneForCwd } from "./config.ts";
import { processAlive } from "./process.ts";
import { safeText } from "./source-labels.ts";

export const AGENT_ENV = "ORRERY_AGENT";
export const TOKEN_ENV = "ORRERY_AGENT_TOKEN";
/** What newToken makes; nothing else is taken (a token names a file). */
const TOKEN = /^[0-9a-f]{32}$/;

/** ORRERY_AGENT was set but cannot be honoured: a notice, no memory, and no fallback to the folder's lane. */
export type Refused = { readonly kind: "unknown"; readonly name: string } | { readonly kind: "bad-token"; readonly name: string };

export type Picked = { readonly kind: "lane"; readonly lane: LaneConfig; readonly by: "env" | "folder" } | Refused | { readonly kind: "none" };

export interface Where {
	readonly env: NodeJS.ProcessEnv;
	/** The session's folder: pi's cwd, Claude Code's project folder. */
	readonly cwd: string;
	/** The session's own tool process: pi's or OMP's pid; Claude Code's pid for its hooks, MCP server and mod view. */
	readonly owner: number;
	/** Whether a pid lives (default processAlive); tests pass their own. */
	readonly alive?: (pid: number) => boolean;
	/**
	 * Whether this pick may claim the token: make the claim, or take a dead owner's over (default true). False for a
	 * session's later events, which may only find the owner's own claim (claimToken).
	 */
	readonly takeover?: boolean;
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
		if (token !== undefined && !TOKEN.test(token)) return { kind: "bad-token", name: lane.name };
		if (token === undefined || claimToken(lane.dir, token, where.owner, where.alive, where.takeover !== false)) return { kind: "lane", lane, by: "env" };
	}
	const lane = laneForCwd(config, where.cwd);
	return lane === undefined ? { kind: "none" } : { kind: "lane", lane, by: "folder" };
}

/** The pid a claim file holds, or undefined when it holds none (unreadable, empty, or not a pid). */
function claimant(file: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The live process a claim file names, or undefined when the claim is dead: its process is gone, or the file names no
 * pid. One rule for pruning and for taking a token over. A claim is never half-written (claimToken writes it whole to a
 * temporary file first), so a file with no pid is a crash's leftover, or an older version's, and dead.
 */
function liveClaimant(file: string, alive: (pid: number) => boolean): number | undefined {
	const pid = claimant(file);
	return pid !== undefined && alive(pid) ? pid : undefined;
}

/** How old a stray temporary file must be before pruning removes it (its maker has long finished or died). */
const STRAY_MS = 60_000;

/**
 * Takes out dead claims (liveClaimant): files named by a token. A live owner's claim stays however old it is (an agent
 * may run for weeks). Temporary files are another process's claim being made: only stray ones, old enough, go.
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
			if (TOKEN.test(name) ? liveClaimant(file, alive) === undefined : Date.now() - statSync(file).mtimeMs > STRAY_MS) rmSync(file, { force: true });
		} catch {
			// gone already
		}
	}
}

/**
 * Whether `owner` may take ORRERY_AGENT with `token`: it claimed it before, or is the first to claim it, or the claim
 * is dead (liveClaimant). Without `takeover` (a session's later events) only the first: such an event never makes a
 * claim nor takes a dead one over, so a session that started as another process's tool stays one. False for a token
 * that is not 32 lowercase hex digits (it must never name a file elsewhere).
 *
 * The claim is written whole to a temporary file, then linked to its name, exclusively (EEXIST: someone holds it), so
 * no claim ever exists without its pid for a pruner to take for dead. A dead claim is taken over the same way, renamed
 * over it, then read back: of two takers at once, the one whose claim stands wins.
 */
export function claimToken(laneDir: string, token: string, owner: number, alive: (pid: number) => boolean = processAlive, takeover = true): boolean {
	if (!TOKEN.test(token)) return false;
	const dir = join(laneDir, "claims");
	const file = join(dir, token);
	// The owner's own claim, the common case (Claude Code asks at every hook): nothing to prune or write.
	if (claimant(file) === owner) return true;
	if (!takeover) return false;
	let temporary: string | undefined;
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		pruneClaims(dir, alive);
		temporary = join(dir, `${token}.${randomBytes(6).toString("hex")}`);
		writeFileSync(temporary, `${owner}\n`, { flag: "wx", mode: 0o600 });
		try {
			linkSync(temporary, file);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		// Made since the prune: the same rule decides.
		const held = liveClaimant(file, alive);
		if (held === owner) return true;
		if (held !== undefined) return false;
		renameSync(temporary, file);
		temporary = undefined;
		return claimant(file) === owner;
	} catch {
		// A claim that cannot be recorded never costs the session its agent.
		return true;
	} finally {
		try {
			if (temporary !== undefined) rmSync(temporary, { force: true });
		} catch {
			// a stray one: a later prune takes it
		}
	}
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

/** What a session whose ORRERY_AGENT was refused says, once. */
export function refusedNotice(pick: Refused): string {
	return pick.kind === "unknown"
		? `Orrery: ORRERY_AGENT names ${safeText(pick.name)}, which is not a configured agent; this session runs without memory.`
		: `Orrery: ORRERY_AGENT_TOKEN is not 32 lowercase hex digits, so this session is not ${safeText(pick.name)}; it runs without memory.`;
}
