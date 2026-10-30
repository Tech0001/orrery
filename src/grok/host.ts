/**
 * Grok Build's own process as its hooks find it: what "this Grok" means to Orrery (the owner of the agent's token claim,
 * the host of the agent's session, and the process whose end ends the recorder). Grok starts a hook given as a program
 * with arguments directly, so the hook's parent is the `grok` program (seen live: comm `grok`, whose own parent is npm's
 * `node` launcher, which is never reached); a shell that did not exec stands in between, and is passed over, as for
 * Codex (src/codex/host.ts).
 */

import { basename } from "node:path";
import { type ProcessInfo, processArgv, processExecutable, processInfo } from "../agent/process.ts";
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
 * process's own host, never a variable: a Claude Code started from a Grok shell is its hooks' host, and keeps them. And
 * by the file that host runs (`exeOf`, links followed: src/agent/process.ts processExecutable), never by its name alone:
 * a Claude Code started through a link named grok runs Claude Code's program, and keeps its plugin. A file that can't be
 * read is no Grok's. A copy of another program named like Grok's counts as Grok, as a script the agent writes does.
 */
export function hostIsGrok(start: number = process.ppid, info: (pid: number) => ProcessInfo | undefined = processInfo, exeOf: (pid: number) => string | undefined = processExecutable): boolean {
	const exe = exeOf(hostPid(start, info));
	return exe !== undefined && isGrokProcess(basename(exe));
}

/**
 * Whether `argv` is Grok's shared leader's (leader mode: `--leader`, or `[cli] use_leader = true`), which runs every
 * session's hooks and MCP servers in one process, with its first client's environment: `<grok> agent [options] leader …`.
 * Seen live in 1.0.70: started by the first session's grok from Grok's own binary as `<binary> agent leader
 * --no-exit-on-disconnect …`, and kept running, its parent gone, after that session ends. Read from its first argument
 * on, so a session's own (Orrery's flags first, its --rules value one argument, or on macOS many words) never reads as it.
 */
export function isGrokLeader(argv: readonly string[]): boolean {
	return argv[1] === "agent" && argv.indexOf("leader", 2) > 1;
}

/** Why a leader hosts no agent's session (isGrokLeader). */
export const GROK_LEADER_REFUSAL = "Grok runs this session's hooks and memory tools in its shared leader process (leader mode), where one session's agent can't be told from another's; Orrery opens its agents with --no-leader";

/**
 * Why Grok's process `pid` (grokPid's) can host no agent's session, or undefined: it is Grok's shared leader, or its
 * command line can't be read. Judged by its own command line only, never its parent, which a leader may have lost.
 */
export function grokHostRefusal(pid: number, argvOf: (pid: number) => readonly string[] | undefined = processArgv): string | undefined {
	const argv = argvOf(pid);
	if (argv === undefined) return "Grok's command line can't be read";
	return isGrokLeader(argv) ? GROK_LEADER_REFUSAL : undefined;
}

/** What a Grok hook or memory server says when it refuses its host (grokHostRefusal's `why`). */
export function grokHostNotice(why: string): string {
	return `Orrery: ${why}. This session records nothing and gets no memory tools.`;
}
