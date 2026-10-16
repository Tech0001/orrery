/**
 * Which agent a Codex session belongs to: only the one ORRERY_AGENT names, with the token `orrery agent` gave it
 * (spec 2026-10-16-codex-design: no folder pick in Codex; Orrery's hooks and memory server come only with that launch).
 * The token is claimed for Codex's own process (src/codex/host.ts) by the first to ask, the memory server at Codex's
 * start or the first SessionStart (`takeover`); every later event only finds that claim (src/agent/pick.ts claimToken).
 * Anything else is refused, with a notice for SessionStart: no memory, nothing recorded. A tool the agent's Codex starts
 * inherits both variables, but not Orrery's hooks: one that asks finds the claim another's, as in pi and Claude Code.
 */

import type { AgentConfig, HarnessConfig } from "../agent/config.ts";
import { AGENT_ENV, agentNamed, claimToken, refusedNotice, TOKEN_ENV, tokenForm } from "../agent/pick.ts";
import { processAlive } from "../agent/process.ts";
import { safeText } from "../agent/source-labels.ts";

export type CodexPicked = { readonly kind: "agent"; readonly agent: AgentConfig } | { readonly kind: "refused"; readonly notice: string };

export interface CodexAsker {
	readonly env: NodeJS.ProcessEnv;
	/** Codex's pid: the token's owner. */
	readonly pid: number;
	/** Whether this asker may claim the token (the memory server's start, SessionStart), else only find its claim. */
	readonly takeover: boolean;
	/** Whether a pid lives (default processAlive); tests pass their own. */
	readonly alive?: (pid: number) => boolean;
}

/** The session's agent, or why there is none, as the notice says it. */
export function codexAgent(config: HarnessConfig, asking: CodexAsker): CodexPicked {
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
