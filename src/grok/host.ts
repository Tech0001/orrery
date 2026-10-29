/**
 * Grok Build's own process as its hooks find it: what "this Grok" means to Orrery (the owner of the agent's token claim,
 * the host of the agent's session, and the process whose end ends the recorder). Grok starts a hook given as a program
 * with arguments directly, so the hook's parent is the `grok` program (seen live: comm `grok`, whose own parent is npm's
 * `node` launcher, which is never reached); a shell that did not exec stands in between, and is passed over, as for
 * Codex (src/codex/host.ts).
 */

import { type ProcessInfo, processInfo } from "../agent/process.ts";
import { hostPid } from "../codex/host.ts";
import { isGrokProcess } from "./names.ts";

/** Grok's pid from a process it started (default: this one's parent), passing over shells in between. */
export function grokPid(start: number = process.ppid, info: (pid: number) => ProcessInfo | undefined = processInfo): number {
	return hostPid(start, info);
}

/**
 * Whether the process that started this one (default: its parent), past shells, is Grok's program: the host of a hook or
 * MCP server of Orrery's Claude Code plugin, which Grok runs through its Claude Code compatibility. The plugin stands down
 * there (src/cli/main.ts), so Orrery's Grok hooks and Grok's own `orrery` server are the only ones. Judged by the
 * process's own host, never a variable: a Claude Code started from a Grok shell is its hooks' host, and keeps them.
 */
export function hostIsGrok(start: number = process.ppid, info: (pid: number) => ProcessInfo | undefined = processInfo): boolean {
	const name = info(hostPid(start, info))?.name;
	return name !== undefined && isGrokProcess(name);
}
