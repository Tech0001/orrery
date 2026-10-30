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
 * claims, so a nested Codex never claims its token, and every later event finds no claim of its own. With no agent's
 * session around it, so is one started from a coding tool's session that is no agent's (spec
 * 2026-10-19-no-agent-sessions §4c, src/agent/plain-nested.ts; npm's `node …/codex` launcher above it is its own): nested,
 * with that tool (`plain`), and its guard keeps the nested rules.
 *
 * One decision per Codex process: the first to ask decides whether this Codex is the agent's, refused, or nested. Only
 * an asker that may be a process's first may decide, and take a claim (`takeover`): the memory server's start, and a
 * SessionStart of a session's start or resume; a compaction or /clear never is, whether or not a decision is recorded.
 * The decision is recorded in <data>/codex-processes/<pid>.json (0600 in a 0700 folder, published whole and
 * exclusively): whose (ORRERY_AGENT and its token's sha256), when the process started, and what. Every later asker
 * reads it: a later SessionStart (a compaction, /clear, resume) neither judges again nor takes a claim over, so a Codex
 * started inside an agent's session stays without memory once that session ends. A record is this process's only when
 * it names the process's identity and start, both known; one of another start (a reused pid), or one that can't be read,
 * the first asker replaces. One of this very start but another identity is no stale one: an asker whose ORRERY_AGENT or
 * token isn't the one the process decided with (a hook the agent's own shell ran, naming another agent) is refused, and
 * claims and replaces nothing. A process whose start can't be read decides nothing and claims nothing: no memory (fail
 * closed).
 *
 * Whose an event is comes from the host's own start environment (launchedEnv, startEnvOf): a hook or memory server takes
 * ORRERY_AGENT and its token as the Codex (or Grok) process was started with them, never as its own environment has them,
 * which any shell may set; one whose own disagree is refused, and one with none there is no agent's.
 * A new decision prunes the records of processes that are gone. An agent whose decision can't be recorded stays the
 * agent (its claim of the token is durable) and SessionStart says so.
 * A nested or refused one whose decision can't be recorded claims nothing, and an asker that is no first one only finds
 * a claim: it stays without memory through a compaction or /clear. A resume, which may come in the same process (Codex's
 * /resume), judges it again then: the limit of a data folder where no decision can be written.
 *
 * A "Codex" that is a live recorded host of another tool's session (Claude Code, pi, …) is that tool, whose shell ran
 * the hook or the memory server: inside its session, before any decision or claim, with a launch's token or none.
 *
 * Codex's pid (src/codex/host.ts codexPid) passes over the processes above a hook that are named like shells. A process
 * is anyone's to name, so a pid reached past one must prove itself: a live session record there is this session's only
 * when it is a Codex's, of this very session (the hook's session_id); any other (another Codex session, another tool's,
 * or one the memory server, which has no session, can't tell) is the session this one was started inside (fail closed).
 * A Codex whose hook shell did not exec loses its memory that way at /clear, which starts a session its record doesn't
 * name yet: bash and zsh, which Codex picks for hooks, exec a lone command.
 *
 * Grok Build's sessions are picked the same way (grokAgent, grokNested): the grok process (src/grok/host.ts) is the
 * token's owner, its decision is in <data>/grok-processes/<pid>.json, a pid reached past shells proves itself by a live
 * record of a Grok of this very session (SessionRecord.grokSession), and its notices name Grok and `--tool grok`. Its
 * first askers are its SessionStarts (Grok fires one at a session's start, /new, /clear and a resume, never at a
 * compaction).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, HarnessConfig } from "../agent/config.ts";
import { beingMade, publish, removeStale, stray, temporaryOf } from "../agent/exclusive.ts";
import { AGENT_ENV, agentNamed, claimToken, refusedNotice, TOKEN_ENV, tokenForm, tokenHeld } from "../agent/pick.ts";
import { processAlive, processEnv } from "../agent/process.ts";
import { type PlainDeps, plainNested } from "../agent/plain-nested.ts";
import { insideSession, liveSession, type PlainFound, plainFields, processStart, recordedPlain, SESSION_TOOLS, type SessionRecord, type SessionTool } from "../agent/sessions.ts";
import { safeText } from "../agent/source-labels.ts";

/** A tool whose sessions are picked by ORRERY_AGENT and its token alone, for its own process (module doc). */
export type PickHost = "codex" | "grok";

/** Each host's name in notices, its decisions' folder in the data folder, and the session a host record of it names. */
const HOSTS: Readonly<Record<PickHost, { readonly label: string; readonly decisions: string; readonly session: (record: SessionRecord) => string | undefined }>> = {
	codex: { label: "Codex", decisions: "codex-processes", session: (record) => record.codexSession },
	grok: { label: "Grok", decisions: "grok-processes", session: (record) => record.grokSession },
};

export type CodexPicked =
	/** `notRecorded`: why the process's decision could not be recorded (its own claim keeps it the agent's). */
	| { readonly kind: "agent"; readonly agent: AgentConfig; readonly notRecorded?: string }
	/**
	 * `undecided`: the process made no decision of its own (a Codex started before this version), so whether it runs
	 * inside an agent's session is not known yet; only the guard looks that up, for its rules.
	 */
	| { readonly kind: "refused"; readonly notice: string; readonly undecided?: true }
	/**
	 * Started inside `outer`'s session in `tool` (either undefined when nothing proves it), or `plain`, inside that coding
	 * tool's session that is no agent's (src/agent/plain-nested.ts), found by `variable` when not by a process: no memory,
	 * nothing recorded.
	 */
	| ({ readonly kind: "nested"; readonly outer: string | undefined; readonly tool: SessionTool | undefined } & PlainFound);

/** A Grok session's pick: as a Codex session's. */
export type GrokPicked = CodexPicked;

export interface CodexAsker {
	readonly env: NodeJS.ProcessEnv;
	/** Codex's pid (or Grok's): the token's owner. */
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
	/** How a coding tool's session that is no agent's is looked for (src/agent/plain-nested.ts); tests pass their own. */
	readonly plain?: PlainDeps;
}

/** The variables of a host's start environment that say whose session it is: ORRERY_AGENT and its token. */
export const LAUNCH_VARIABLES: readonly string[] = [AGENT_ENV, TOKEN_ENV];

/**
 * The variables `names` of the environment the host process `pid` was started with (src/agent/process.ts processEnv):
 * Linux's /proc/<pid>/environ; on macOS ps's words after the process's arguments (Grok's --rules hold the agent's memory),
 * and only when they can't be read two ways (a variable standing twice, or a value a space cut). Undefined when it can't
 * be read so.
 */
export function startEnvOf(pid: number, names: readonly string[]): Readonly<Record<string, string>> | undefined {
	return processEnv(pid, names, { withoutArgs: true, unambiguous: true });
}

/**
 * The environment an event of `host`'s process is judged by (module doc): the event's own, `env`, with ORRERY_AGENT and
 * its token as `started` (the process's start environment, startEnvOf) has them, set or not. Or why not: that
 * environment couldn't be read, or the event's own names another agent or token than it (a hook the agent's own shell
 * ran, as another agent): nothing such an event says is taken.
 */
export function launchedEnv(host: PickHost, env: NodeJS.ProcessEnv, started: Readonly<Record<string, string>> | undefined): { readonly env: NodeJS.ProcessEnv } | { readonly refused: string } {
	const label = HOSTS[host].label;
	if (started === undefined) return { refused: `the environment this ${label} was started with can't be read` };
	const agent = (from: Readonly<Record<string, string | undefined>>) => from[AGENT_ENV]?.trim() ?? "";
	const token = (from: Readonly<Record<string, string | undefined>>) => from[TOKEN_ENV] ?? "";
	if (agent(env) !== agent(started) || token(env) !== token(started)) return { refused: `ORRERY_AGENT or its token isn't the one this ${label} was started with` };
	const { [AGENT_ENV]: _agent, [TOKEN_ENV]: _token, ...rest } = env;
	const own = (name: string) => (started[name] === undefined ? {} : { [name]: started[name] });
	return { env: { ...rest, ...own(AGENT_ENV), ...own(TOKEN_ENV) } };
}

/** Started inside a session whose agent and tool nothing proves: what a check that can't judge says (fail closed). */
const UNKNOWN: CodexPicked = { kind: "nested", outer: undefined, tool: undefined };

/** Whether `asking.pid`, reached past processes named like shells, is not this session's `host` (module doc): the session it hosts. */
function passedOver(host: PickHost, config: HarnessConfig, asking: CodexAsker): CodexPicked | undefined {
	if (asking.parent === undefined || asking.pid === asking.parent) return undefined;
	try {
		const record = liveSession(config.dataDir, asking.pid);
		if (record === undefined || (record.tool === host && asking.session !== undefined && HOSTS[host].session(record) === asking.session)) return undefined;
		return { kind: "nested", outer: record.agent, tool: record.tool };
	} catch {
		return UNKNOWN;
	}
}

/**
 * The session another tool's process `pid` hosts, when it does: a Codex hook or memory server that process ran is no
 * Codex's but that tool's shell's (Claude Code's Bash inherits a launch's ORRERY_AGENT and token, and is the hook's
 * parent when it execs one), so it is inside that session, token or none (fail closed). So for Grok's.
 */
function anotherTool(host: PickHost, config: HarnessConfig, pid: number): CodexPicked | undefined {
	try {
		const record = liveSession(config.dataDir, pid);
		return record === undefined || record.tool === host ? undefined : { kind: "nested", outer: record.agent, tool: record.tool };
	} catch {
		return UNKNOWN;
	}
}

/** The session `host`'s process `pid` was started inside: an agent's, or a coding tool's that is no agent's (codexNested). */
function hostNested(host: PickHost, config: HarnessConfig, env: NodeJS.ProcessEnv, pid: number, plain?: PlainDeps): CodexPicked | undefined {
	try {
		const inside = insideSession([config.dataDir], env, config, { self: pid }) ?? plainNested(config, env, { pid, tool: host }, plain);
		return inside === undefined ? undefined : { kind: "nested", outer: inside.agent, tool: inside.tool, ...plainFields(inside) };
	} catch {
		return UNKNOWN;
	}
}

/**
 * The agent session this Codex was started inside (src/agent/sessions.ts, the Codex as `self`), or with none the coding
 * tool's session that is no agent's it was started from (src/agent/plain-nested.ts); else undefined.
 */
export function codexNested(config: HarnessConfig, env: NodeJS.ProcessEnv, pid: number, plain?: PlainDeps): CodexPicked | undefined {
	return hostNested("codex", config, env, pid, plain);
}

/** The agent session this Grok was started inside, or the coding tool's session that is no agent's (as codexNested). */
export function grokNested(config: HarnessConfig, env: NodeJS.ProcessEnv, pid: number, plain?: PlainDeps): GrokPicked | undefined {
	return hostNested("grok", config, env, pid, plain);
}

/** A Codex process's decision, as recorded (module doc): names only. */
type Decision = { readonly kind: "agent" } | { readonly kind: "refused" } | ({ readonly kind: "nested"; readonly outer?: string; readonly tool?: SessionTool } & PlainFound);

/** Whose decision it is: ORRERY_AGENT (trimmed), its token's sha256 ("" for none), and when the process started. */
interface Identity {
	readonly agent: string;
	readonly token: string;
	readonly start: string;
}

const decisionsDir = (host: PickHost, config: HarnessConfig) => join(config.dataDir, HOSTS[host].decisions);
const decisionFile = (host: PickHost, config: HarnessConfig, pid: number) => join(decisionsDir(host, config), `${pid}.json`);

/** Process `pid`'s identity, or undefined when its start can't be read. */
function identityOf(env: NodeJS.ProcessEnv, pid: number): Identity | undefined {
	const start = processStart(pid);
	if (start === undefined) return undefined;
	const token = env[TOKEN_ENV];
	return { agent: env[AGENT_ENV]?.trim() ?? "", token: token === undefined ? "" : createHash("sha256").update(token).digest("hex"), start };
}

/** The same agent, token and start. */
const sameIdentity = (recorded: Identity, asker: Identity) => recorded.agent === asker.agent && recorded.token === asker.token && recorded.start === asker.start;

/** A decision this very process made (the same start) under another identity than the asker's (module doc). */
const anotherIdentity = (found: ReturnType<typeof readDecision>, asker: Identity) => found !== undefined && found !== "unreadable" && found.identity.start === asker.start && !sameIdentity(found.identity, asker);

/** What an asker gets whose ORRERY_AGENT or token isn't the one its process decided with: no memory, no claim. */
const otherIdentity = (host: PickHost): CodexPicked => ({
	kind: "refused",
	notice: `Orrery: this ${HOSTS[host].label} already decided which agent it is under another ORRERY_AGENT or token, so this session runs without memory.`,
});

/** A decision file's record: undefined when there is none; "unreadable" when there is one that is no record. */
function readDecision(file: string): { readonly identity: Identity; readonly decision: Decision } | "unreadable" | undefined {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unreadable";
	}
	if (typeof value !== "object" || value === null || typeof value.agent !== "string" || typeof value.token !== "string" || typeof value.start !== "string") return "unreadable";
	const identity: Identity = { agent: value.agent, token: value.token, start: value.start };
	if (value.kind === "agent" || value.kind === "refused") return { identity, decision: { kind: value.kind } };
	const plain = recordedPlain(value);
	if (
		value.kind === "nested" &&
		(value.outer === undefined || typeof value.outer === "string") &&
		(value.tool === undefined || (typeof value.tool === "string" && SESSION_TOOLS.has(value.tool))) &&
		plain !== "unreadable"
	) {
		const decision: Decision = { kind: "nested", ...(value.outer === undefined ? {} : { outer: value.outer }), ...(value.tool === undefined ? {} : { tool: value.tool as SessionTool }), ...plain };
		return { identity, decision };
	}
	return "unreadable";
}

/** This process's own decision (its identity's), or undefined. */
function ownDecision(host: PickHost, config: HarnessConfig, pid: number, identity: Identity): Decision | undefined {
	const found = readDecision(decisionFile(host, config, pid));
	return found !== undefined && found !== "unreadable" && sameIdentity(found.identity, identity) ? found.decision : undefined;
}

/**
 * Records a decision whole, published exclusively (src/agent/exclusive.ts): true, "exists" when another asker of the
 * process recorded first, or the error's text. A stale record (`replace`: another start's, a reused pid's, or one that
 * can't be read) is taken down first; one of this very start, whoever's, never is.
 */
function recordDecision(host: PickHost, config: HarnessConfig, pid: number, identity: Identity, decision: Decision, replace: boolean): true | "exists" | string {
	const file = decisionFile(host, config, pid);
	const temporary = temporaryOf(file);
	try {
		mkdirSync(decisionsDir(host, config), { recursive: true, mode: 0o700 });
		const content = `${JSON.stringify({ ...identity, ...decision })}\n`;
		writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
		if (replace) {
			// Another start's (a reused pid's), or one this version can't read (no start): stale.
			removeStale(file, (moved) => {
				const found = readDecision(moved);
				return found === undefined || found === "unreadable" || found.identity.start !== identity.start;
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
function prune(host: PickHost, config: HarnessConfig, alive: (pid: number) => boolean): void {
	let names: string[];
	try {
		names = readdirSync(decisionsDir(host, config));
	} catch {
		return;
	}
	for (const name of names) {
		const file = join(decisionsDir(host, config), name);
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
	pick.kind === "nested" ? { kind: "nested", ...(pick.outer === undefined ? {} : { outer: pick.outer }), ...(pick.tool === undefined ? {} : { tool: pick.tool }), ...plainFields(pick) } : { kind: pick.kind };

const nestedPick = (decision: Extract<Decision, { kind: "nested" }>): CodexPicked => ({ kind: "nested", outer: decision.outer, tool: decision.tool, ...plainFields(decision) });

/**
 * The session's agent, or why there is none, as the notice says it. The first asker of a Codex process decides (and may
 * take a dead claim over); every later one reads that decision (module doc).
 */
export function codexAgent(config: HarnessConfig, asking: CodexAsker): CodexPicked {
	return hostAgent("codex", config, asking);
}

/** A Grok session's agent, or why there is none, as codexAgent decides a Codex session's (module doc). */
export function grokAgent(config: HarnessConfig, asking: CodexAsker): GrokPicked {
	return hostAgent("grok", config, asking);
}

/** The agent of a session of `host`'s process (codexAgent). */
function hostAgent(host: PickHost, config: HarnessConfig, asking: CodexAsker): CodexPicked {
	const unproven = passedOver(host, config, asking) ?? anotherTool(host, config, asking.pid);
	if (unproven !== undefined) return unproven;
	if (!asking.takeover) {
		// An event: its own claim, the common case, needs nothing more. Without one, a process decided nested stays so;
		// one whose start can't be read is judged by nothing more (fail closed).
		const pick = claimed(host, config, asking, false);
		if (pick.kind === "agent") return pick;
		const asker = identityOf(asking.env, asking.pid);
		const decided = asker === undefined ? undefined : ownDecision(host, config, asking.pid, asker);
		if (decided?.kind === "nested") return nestedPick(decided);
		return asker !== undefined && decided === undefined && pick.kind === "refused" ? { ...pick, undecided: true } : pick;
	}
	const identity = identityOf(asking.env, asking.pid);
	// It could not tell its own decision from a dead process's under its pid, nor record one: no memory, and no claim.
	if (identity === undefined) return { kind: "refused", notice: `Orrery: this ${HOSTS[host].label}'s start time can't be read, so which agent it is can't be recorded; this session runs without memory.` };
	const recorded = readDecision(decisionFile(host, config, asking.pid));
	const read = (found: typeof recorded) => (found !== undefined && found !== "unreadable" && sameIdentity(found.identity, identity) ? found.decision : undefined);
	const settled = (decision: Decision) => (decision.kind === "nested" ? nestedPick(decision) : claimed(host, config, asking, false));
	const own = read(recorded);
	if (own !== undefined) return settled(own);
	// This very process decided under another identity (module doc): nothing is claimed or replaced.
	if (anotherIdentity(recorded, identity)) return otherIdentity(host);
	// The process's first decision: before its claim, whether this Codex was started inside an agent's session.
	prune(host, config, asking.alive ?? processAlive);
	const pick = hostNested(host, config, asking.env, asking.pid, asking.plain) ?? claimed(host, config, asking, true);
	const written = recordDecision(host, config, asking.pid, identity, toDecision(pick), recorded !== undefined);
	if (written === true) return pick;
	if (written === "exists") {
		// Another asker of this process decided first: its decision holds, and one under another identity refuses this one.
		const first = readDecision(decisionFile(host, config, asking.pid));
		const theirs = read(first);
		if (theirs !== undefined) return settled(theirs);
		if (anotherIdentity(first, identity)) return otherIdentity(host);
	}
	// Not recorded: an agent's own claim keeps it the agent's (SessionStart says so). A nested or refused one claimed
	// nothing; an asker that is no first one (a compaction, /clear) can only find a claim, so it stays without memory.
	const why = written === "exists" ? "its record is another's, or unreadable" : written;
	return pick.kind === "agent" ? { ...pick, notRecorded: why } : pick;
}

/** ORRERY_AGENT's agent, with its token claimed for this Codex (or Grok; `takeover`: taking a dead process's claim over). */
function claimed(host: PickHost, config: HarnessConfig, asking: CodexAsker, takeover: boolean): CodexPicked {
	const label = HOSTS[host].label;
	const name = asking.env[AGENT_ENV]?.trim();
	if (!name) return { kind: "refused", notice: `Orrery: ORRERY_AGENT is not set in this ${label}, so it is no agent's; this session runs without memory. Open an agent with orrery agent <Name> --tool ${host}.` };
	const agent = agentNamed(config, name);
	if (agent === undefined) return { kind: "refused", notice: refusedNotice({ kind: "unknown", name }) };
	const token = asking.env[TOKEN_ENV];
	if (token === undefined || token === "") {
		return { kind: "refused", notice: `Orrery: ORRERY_AGENT_TOKEN is not set, so this ${label} is not ${safeText(agent.name)}; it runs without memory. Open it with orrery agent ${safeText(agent.name)} --tool ${host}.` };
	}
	if (!tokenForm(token)) return { kind: "refused", notice: refusedNotice({ kind: "bad-token", name: agent.name }) };
	const alive = asking.alive ?? processAlive;
	if (!claimToken(agent.dir, token, asking.pid, alive, takeover)) {
		const shown = safeText(agent.name);
		// An asker that may not claim (a compaction, /clear, a fork) finds only its own claim: one nobody holds isn't another's.
		if (!takeover && !tokenHeld(agent.dir, token, alive)) {
			return { kind: "refused", notice: `Orrery: this ${label} hasn't started or resumed a session yet, and only those claim ${shown}'s token, so this session runs without memory. Resume it, or open ${shown} with orrery agent ${shown} --tool ${host}.` };
		}
		return { kind: "refused", notice: `Orrery: ${shown}'s token belongs to another process, so this ${label} is not ${shown}; it runs without memory.` };
	}
	return { kind: "agent", agent };
}
