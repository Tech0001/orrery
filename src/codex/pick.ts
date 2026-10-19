/**
 * Which agent a Codex session belongs to: only the one ORRERY_AGENT names, with the token `orrery agent` gave it
 * (spec 2026-10-16-codex-design: no folder pick in Codex; Orrery's hooks and memory server come only with that launch).
 * The token is claimed for Codex's own process (src/codex/host.ts) by the first to ask, the memory server at Codex's
 * start or the first SessionStart (`takeover`); every later event only finds that claim (src/agent/pick.ts claimToken).
 * Anything else is refused, with a notice for SessionStart: no memory, nothing recorded. A tool the agent's Codex starts
 * inherits both variables, but not Orrery's hooks: one that asks finds the claim another's, as in pi and Claude Code.
 *
 * A Codex started inside an agent's session (spec 2026-10-18-agent-permissions §3b: a recorded ancestor, or markers
 * pointing at another live session, src/agent/sessions.ts) is no agent's either: the first to ask checks before it
 * claims, so a nested Codex never claims its token, and every later event finds no claim of its own.
 *
 * One decision per Codex process: the first to ask (`takeover`: the memory server's start or the first SessionStart)
 * decides whether this Codex is the agent's, refused, or nested, and records it in <data>/codex-processes/<pid>.json
 * (0600 in a 0700 folder, published whole and exclusively): whose (ORRERY_AGENT and its token's sha256), when the
 * process started, and what. Every later asker reads it: a later SessionStart (a compaction, /clear, resume) neither
 * judges again nor takes a claim over, so a Codex started inside an agent's session stays without memory once that
 * session ends. A record of another identity, or another start (a reused pid), is not this process's: the first asker
 * replaces it. A new decision prunes the records of processes that are gone. A decision that can't be recorded leaves
 * the session without memory (a later asker would judge again).
 *
 * Codex's pid (src/codex/host.ts codexPid) passes over the processes above a hook that are named like shells. A process
 * is anyone's to name, so a pid reached past one must prove itself: a live session record there is this session's only
 * when it is a Codex's, of this very session (the hook's session_id); any other (another Codex session, another tool's,
 * or one the memory server, which has no session, can't tell) is the session this one was started inside (fail closed).
 * A Codex whose hook shell did not exec loses its memory that way at /clear, which starts a session its record doesn't
 * name yet: bash and zsh, which Codex picks for hooks, exec a lone command.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, HarnessConfig } from "../agent/config.ts";
import { beingMade, publish, removeStale, stray, temporaryOf } from "../agent/exclusive.ts";
import { AGENT_ENV, agentNamed, claimToken, refusedNotice, TOKEN_ENV, tokenForm } from "../agent/pick.ts";
import { processAlive } from "../agent/process.ts";
import { insideSession, liveSession, processStart, type SessionTool } from "../agent/sessions.ts";
import { safeText } from "../agent/source-labels.ts";

export type CodexPicked =
	| { readonly kind: "agent"; readonly agent: AgentConfig }
	| { readonly kind: "refused"; readonly notice: string }
	/** Started inside `outer`'s session in `tool` (either undefined when nothing proves it): no memory, nothing recorded. */
	| { readonly kind: "nested"; readonly outer: string | undefined; readonly tool: SessionTool | undefined };

export interface CodexAsker {
	readonly env: NodeJS.ProcessEnv;
	/** Codex's pid: the token's owner. */
	readonly pid: number;
	/** Whether this asker may claim the token (the memory server's start, SessionStart), else only find its claim. */
	readonly takeover: boolean;
	/** Whether a pid lives (default processAlive); tests pass their own. */
	readonly alive?: (pid: number) => boolean;
	/**
	 * The process codexPid() started from (the hook's or the memory server's parent). When `pid` is another, codexPid()
	 * passed over processes by their names, and `pid` must prove itself by its record (module doc). Undefined: no check.
	 */
	readonly parent?: number;
	/** The Codex session the asker's event is of (the hook's session_id); the memory server has none. */
	readonly session?: string;
}

/** Started inside a session whose agent and tool nothing proves: what a check that can't judge says (fail closed). */
const UNKNOWN: CodexPicked = { kind: "nested", outer: undefined, tool: undefined };

/** Whether `asking.pid`, reached past processes named like shells, is not this session's Codex (module doc): the session it hosts. */
function passedOver(config: HarnessConfig, asking: CodexAsker): CodexPicked | undefined {
	if (asking.parent === undefined || asking.pid === asking.parent) return undefined;
	try {
		const record = liveSession(config.dataDir, asking.pid);
		if (record === undefined || (record.tool === "codex" && asking.session !== undefined && record.codexSession === asking.session)) return undefined;
		return { kind: "nested", outer: record.agent, tool: record.tool };
	} catch {
		return UNKNOWN;
	}
}

/** The agent session this Codex was started inside (src/agent/sessions.ts, the Codex as `self`), or undefined. */
export function codexNested(config: HarnessConfig, env: NodeJS.ProcessEnv, pid: number): CodexPicked | undefined {
	try {
		const inside = insideSession([config.dataDir], env, config, { self: pid });
		return inside === undefined ? undefined : { kind: "nested", outer: inside.agent, tool: inside.tool };
	} catch {
		return UNKNOWN;
	}
}

/** A Codex process's decision, as recorded (module doc): names only. */
type Decision = { readonly kind: "agent" } | { readonly kind: "refused" } | { readonly kind: "nested"; readonly outer?: string; readonly tool?: SessionTool };

/** Whose decision it is: ORRERY_AGENT (trimmed), its token's sha256 ("" for none), and when the process started. */
interface Identity {
	readonly agent: string;
	readonly token: string;
	readonly start?: string;
}

const TOOLS: ReadonlySet<string> = new Set<SessionTool>(["pi", "omp", "claude-code", "codex", "opencode", "run"]);
const decisionsDir = (config: HarnessConfig) => join(config.dataDir, "codex-processes");
const decisionFile = (config: HarnessConfig, pid: number) => join(decisionsDir(config), `${pid}.json`);

function identityOf(env: NodeJS.ProcessEnv, pid: number): Identity {
	const token = env[TOKEN_ENV];
	const start = processStart(pid);
	return { agent: env[AGENT_ENV]?.trim() ?? "", token: token === undefined ? "" : createHash("sha256").update(token).digest("hex"), ...(start === undefined ? {} : { start }) };
}

/** The same agent and token, and the same start where both are known. */
const sameIdentity = (recorded: Identity, asker: Identity) =>
	recorded.agent === asker.agent && recorded.token === asker.token && (recorded.start === undefined || asker.start === undefined || recorded.start === asker.start);

/** A decision file's record: undefined when there is none; "unreadable" when there is one that is no record. */
function readDecision(file: string): { readonly identity: Identity; readonly decision: Decision } | "unreadable" | undefined {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unreadable";
	}
	if (typeof value !== "object" || value === null || typeof value.agent !== "string" || typeof value.token !== "string") return "unreadable";
	const identity: Identity = { agent: value.agent, token: value.token, ...(typeof value.start === "string" ? { start: value.start } : {}) };
	if (value.kind === "agent" || value.kind === "refused") return { identity, decision: { kind: value.kind } };
	if (value.kind === "nested" && (value.outer === undefined || typeof value.outer === "string") && (value.tool === undefined || (typeof value.tool === "string" && TOOLS.has(value.tool)))) {
		return { identity, decision: { kind: "nested", ...(value.outer === undefined ? {} : { outer: value.outer }), ...(value.tool === undefined ? {} : { tool: value.tool as SessionTool }) } };
	}
	return "unreadable";
}

/** This process's own decision (its identity's), or undefined. */
function ownDecision(config: HarnessConfig, pid: number, identity: Identity): Decision | undefined {
	const found = readDecision(decisionFile(config, pid));
	return found !== undefined && found !== "unreadable" && sameIdentity(found.identity, identity) ? found.decision : undefined;
}

/** Whether Codex process `pid` (with `env`) has made its decision: then nothing judges it again. */
export function codexDecided(config: HarnessConfig, env: NodeJS.ProcessEnv, pid: number): boolean {
	return ownDecision(config, pid, identityOf(env, pid)) !== undefined;
}

/**
 * Records a decision whole, published exclusively (src/agent/exclusive.ts): true, "exists" when another asker of the
 * process recorded first, or the error's text. A stale record (`replace`: another identity's) is taken down first.
 */
function recordDecision(config: HarnessConfig, pid: number, identity: Identity, decision: Decision, replace: boolean): true | "exists" | string {
	const file = decisionFile(config, pid);
	const temporary = temporaryOf(file);
	try {
		mkdirSync(decisionsDir(config), { recursive: true, mode: 0o700 });
		const content = `${JSON.stringify({ ...identity, ...decision })}\n`;
		writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
		if (replace) {
			removeStale(file, (moved) => {
				const found = readDecision(moved);
				return found === undefined || (found !== "unreadable" && !sameIdentity(found.identity, identity));
			});
		}
		return publish(temporary, file, content);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	} finally {
		try {
			rmSync(temporary, { force: true });
		} catch {
			// left for a later prune
		}
	}
}

/** Removes the decisions of processes that are gone (but one being made), and stray temporary or graveyard files. */
function prune(config: HarnessConfig, alive: (pid: number) => boolean): void {
	let names: string[];
	try {
		names = readdirSync(decisionsDir(config));
	} catch {
		return;
	}
	for (const name of names) {
		const file = join(decisionsDir(config), name);
		const pid = Number.parseInt(name, 10);
		if (/^\d+\.json$/.test(name) ? (Number.isInteger(pid) && pid > 0 && alive(pid)) || beingMade(file) : !stray(file)) continue;
		try {
			rmSync(file, { force: true });
		} catch {
			// gone already
		}
	}
}

const toDecision = (pick: CodexPicked): Decision =>
	pick.kind === "nested" ? { kind: "nested", ...(pick.outer === undefined ? {} : { outer: pick.outer }), ...(pick.tool === undefined ? {} : { tool: pick.tool }) } : { kind: pick.kind };

const nestedPick = (decision: Extract<Decision, { kind: "nested" }>): CodexPicked => ({ kind: "nested", outer: decision.outer, tool: decision.tool });

/**
 * The session's agent, or why there is none, as the notice says it. The first asker of a Codex process decides (and may
 * take a dead claim over); every later one reads that decision (module doc).
 */
export function codexAgent(config: HarnessConfig, asking: CodexAsker): CodexPicked {
	const unproven = passedOver(config, asking);
	if (unproven !== undefined) return unproven;
	if (!asking.takeover) {
		// An event: its own claim, the common case, needs nothing more. Without one, a process decided nested stays so.
		const pick = claimed(config, asking, false);
		if (pick.kind === "agent") return pick;
		const decided = ownDecision(config, asking.pid, identityOf(asking.env, asking.pid));
		return decided?.kind === "nested" ? nestedPick(decided) : pick;
	}
	const identity = identityOf(asking.env, asking.pid);
	const recorded = readDecision(decisionFile(config, asking.pid));
	const read = (found: typeof recorded) => (found !== undefined && found !== "unreadable" && sameIdentity(found.identity, identity) ? found.decision : undefined);
	const settled = (decision: Decision) => (decision.kind === "nested" ? nestedPick(decision) : claimed(config, asking, false));
	const own = read(recorded);
	if (own !== undefined) return settled(own);
	// The process's first decision: before its claim, whether this Codex was started inside an agent's session.
	prune(config, asking.alive ?? processAlive);
	const pick = codexNested(config, asking.env, asking.pid) ?? claimed(config, asking, true);
	const written = recordDecision(config, asking.pid, identity, toDecision(pick), recorded !== undefined);
	if (written === true) return pick;
	if (written === "exists") {
		// Another asker of this process decided first: its decision holds.
		const theirs = read(readDecision(decisionFile(config, asking.pid)));
		if (theirs !== undefined) return settled(theirs);
	}
	// Not recorded, a later asker would judge again: no memory now (fail closed).
	const why = written === "exists" ? "its record is another's, or unreadable" : written;
	return pick.kind === "agent" ? { kind: "refused", notice: `Orrery: which agent this Codex is could not be recorded (${safeText(why)}); this session runs without memory.` } : pick;
}

/** ORRERY_AGENT's agent, with its token claimed for this Codex (`takeover`: taking a dead process's claim over). */
function claimed(config: HarnessConfig, asking: CodexAsker, takeover: boolean): CodexPicked {
	const name = asking.env[AGENT_ENV]?.trim();
	if (!name) return { kind: "refused", notice: "Orrery: ORRERY_AGENT is not set in this Codex, so it is no agent's; this session runs without memory. Open an agent with orrery agent <Name> --tool codex." };
	const agent = agentNamed(config, name);
	if (agent === undefined) return { kind: "refused", notice: refusedNotice({ kind: "unknown", name }) };
	const token = asking.env[TOKEN_ENV];
	if (token === undefined || token === "") {
		return { kind: "refused", notice: `Orrery: ORRERY_AGENT_TOKEN is not set, so this Codex is not ${safeText(agent.name)}; it runs without memory. Open it with orrery agent ${safeText(agent.name)} --tool codex.` };
	}
	if (!tokenForm(token)) return { kind: "refused", notice: refusedNotice({ kind: "bad-token", name: agent.name }) };
	if (!claimToken(agent.dir, token, asking.pid, asking.alive ?? processAlive, takeover)) {
		return { kind: "refused", notice: `Orrery: ${safeText(agent.name)}'s token belongs to another process, so this Codex is not ${safeText(agent.name)}; it runs without memory.` };
	}
	return { kind: "agent", agent };
}
