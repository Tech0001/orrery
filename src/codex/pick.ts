/**
 * Which agent a Codex session belongs to: only the one ORRERY_AGENT names, with the token `orrery agent` gave it
 * (spec 2026-10-16-codex-design: no folder pick in Codex; Orrery's hooks and memory server come only with that launch).
 * The token is claimed for Codex's own process (src/codex/host.ts) by the first to ask, the memory server at Codex's
 * start or the first SessionStart (`takeover`); every later event only finds that claim (src/agent/pick.ts claimToken).
 * Anything else is refused, with a notice for SessionStart: no memory, nothing recorded. A tool the agent's Codex starts
 * inherits both variables, but not Orrery's hooks: one that asks finds the claim another's, as in pi and Claude Code.
 *
 * A Codex started inside an agent's session (spec 2026-10-18-agent-permissions §3b: a recorded ancestor, or markers
 * pointing at another live session, src/agent/sessions.ts) is no agent's either: the first to ask (`takeover`) checks
 * before it claims, so a nested Codex never claims its token, and every later event finds no claim of its own.
 *
 * Codex's pid (src/codex/host.ts codexPid) passes over the processes above a hook that are named like shells. A process
 * is anyone's to name, so a pid reached past one must prove itself: a live session record there is this session's only
 * when it is a Codex's, of this very session (the hook's session_id); any other (another Codex session, another tool's,
 * or one the memory server, which has no session, can't tell) is the session this one was started inside (fail closed).
 * A Codex whose hook shell did not exec loses its memory that way at /clear, which starts a session its record doesn't
 * name yet: bash and zsh, which Codex picks for hooks, exec a lone command.
 */

import type { AgentConfig, HarnessConfig } from "../agent/config.ts";
import { AGENT_ENV, agentNamed, claimToken, refusedNotice, TOKEN_ENV, tokenForm } from "../agent/pick.ts";
import { processAlive } from "../agent/process.ts";
import { insideSession, liveSession, type SessionTool } from "../agent/sessions.ts";
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

/** The session's agent, or why there is none, as the notice says it. */
export function codexAgent(config: HarnessConfig, asking: CodexAsker): CodexPicked {
	const unproven = passedOver(config, asking);
	if (unproven !== undefined) return unproven;
	// The first to ask checks, before its claim, whether this Codex was started inside an agent's session.
	const nested = asking.takeover ? codexNested(config, asking.env, asking.pid) : undefined;
	if (nested !== undefined) return nested;
	const name = asking.env[AGENT_ENV]?.trim();
	if (!name) return { kind: "refused", notice: "Orrery: ORRERY_AGENT is not set in this Codex, so it is no agent's; this session runs without memory. Open an agent with orrery agent <Name> --tool codex." };
	const agent = agentNamed(config, name);
	if (agent === undefined) return { kind: "refused", notice: refusedNotice({ kind: "unknown", name }) };
	const token = asking.env[TOKEN_ENV];
	if (token === undefined || token === "") {
		return { kind: "refused", notice: `Orrery: ORRERY_AGENT_TOKEN is not set, so this Codex is not ${safeText(agent.name)}; it runs without memory. Open it with orrery agent ${safeText(agent.name)} --tool codex.` };
	}
	if (!tokenForm(token)) return { kind: "refused", notice: refusedNotice({ kind: "bad-token", name: agent.name }) };
	if (!claimToken(agent.dir, token, asking.pid, asking.alive ?? processAlive, asking.takeover)) {
		return { kind: "refused", notice: `Orrery: ${safeText(agent.name)}'s token belongs to another process, so this Codex is not ${safeText(agent.name)}; it runs without memory.` };
	}
	return { kind: "agent", agent };
}
