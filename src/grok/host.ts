/**
 * Grok Build's own process as its hooks find it: what "this Grok" means to Orrery (the owner of the agent's token claim,
 * the host of the agent's session, and the process whose end ends the recorder). Grok starts a hook given as a program
 * with arguments directly, so the hook's parent is the `grok` program (seen live: comm `grok`, whose own parent is npm's
 * `node` launcher, which is never reached); a shell that did not exec stands in between, and is passed over, as for
 * Codex (src/codex/host.ts).
 */

import { type ProcessInfo, processInfo } from "../agent/process.ts";
import { hostPid } from "../codex/host.ts";

/** Grok's pid from a process it started (default: this one's parent), passing over shells in between. */
export function grokPid(start: number = process.ppid, info: (pid: number) => ProcessInfo | undefined = processInfo): number {
	return hostPid(start, info);
}
