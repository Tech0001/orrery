/**
 * Where a tool session started inside an agent's session may write (spec 2026-10-18-agent-permissions §3b): it opens no
 * memory, and its guard keeps the outer agent's rules, never looser than the folder's own guard (tighten only). Claude
 * Code's hooks, Codex's guard and the OpenCode plugin share it; pi's extension applies the same rules.
 * Node built-ins and relative imports only, like the guard's other modules.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type AgentConfig, agentForCwd, type HarnessConfig } from "./config.ts";
import { agentNamed, workArea } from "./pick.ts";

/** A write's limits: the work area and the allowed roots. */
export interface WriteRules {
	readonly workArea: string;
	readonly allowedRoots: readonly string[];
}

/**
 * The write rules of a session in `cwd` started inside `outer`'s session: the outer agent's (its work area from `cwd`,
 * its allowed roots), and in another agent's folder both agents' at once (bothRules). Undefined when whose session it is
 * can't be told, or the config has no such agent: the tool then uses its rules for a session that is no agent's.
 */
export function nestedRules(config: HarnessConfig, outer: string | undefined, cwd: string): WriteRules | undefined {
	const agent = outer === undefined ? undefined : agentNamed(config, outer);
	if (agent === undefined) return undefined;
	const here = agentForCwd(config, cwd);
	return here === undefined || here.name === agent.name ? { workArea: workArea(agent, cwd), allowedRoots: agent.allowedRoots } : bothRules(agent, here, cwd);
}

/** `path` where it really is (links followed), or as written when it can't be read. */
function realOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** Whether `path` is `root` or inside it, both where they really are. */
function holds(root: string, path: string): boolean {
	const [r, p] = [realOr(root), realOr(path)];
	return p === r || p.startsWith(`${r.replace(/\/+$/, "")}/`);
}

/**
 * Two agents' rules at once, for a session in `here`'s folder started inside `outer`'s session: a write goes only where
 * both allow it. The work area is the deeper of the two, which both hold `cwd`; the allowed roots are, for each root of
 * one inside a root of the other, the inner one. Two work areas neither holds (spelled through a link the other isn't)
 * leave the session's folder alone.
 */
export function bothRules(outer: AgentConfig, here: AgentConfig, cwd: string): WriteRules {
	const [a, b] = [workArea(outer, cwd), workArea(here, cwd)];
	const area = holds(b, a) ? a : holds(a, b) ? b : resolve(cwd);
	const roots = new Set<string>();
	for (const x of outer.allowedRoots) {
		for (const y of here.allowedRoots) {
			if (holds(y, x)) roots.add(x);
			else if (holds(x, y)) roots.add(y);
		}
	}
	return { workArea: area, allowedRoots: [...roots] };
}
