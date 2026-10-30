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
import { LAUNCH_VARIABLES } from "../codex/pick.ts";
import { GROK_COMMANDS, GROK_VALUE_OPTIONS, isGrokProcess } from "./names.ts";

/** Grok's pid from a process it started (default: this one's parent), passing over shells in between. */
export function grokPid(start: number = process.ppid, info: (pid: number) => ProcessInfo | undefined = processInfo): number {
	return hostPid(start, info);
}

/**
 * Whether the process that started this one (default: its parent), past shells, is Grok's program: the host of a hook or
 * MCP server of Orrery's Claude Code plugin, which Grok runs through its Claude Code compatibility. The plugin stands down
 * there (src/cli/main.ts), so Orrery's Grok hooks and Grok's own `orrery` server are the only ones. Judged by the
 * process's own host, never a variable: a Claude Code started from a Grok shell is its hooks' host, and keeps them. And
 * by the file that host runs (`exeOf`, links followed: src/agent/process.ts processExecutable), never by its name
 * alone: a Claude Code started through a link named grok runs Claude Code's program, and keeps its plugin. A file that
 * can't be read is no Grok's. A copy of another program named like Grok's counts as Grok, as a script the agent writes
 * does.
 */
export function hostIsGrok(start: number = process.ppid, info: (pid: number) => ProcessInfo | undefined = processInfo, exeOf: (pid: number) => string | undefined = processExecutable): boolean {
	const exe = exeOf(hostPid(start, info));
	return exe !== undefined && isGrokProcess(basename(exe));
}

/**
 * The options of Grok's agent and worker commands (grok agent --help, grok worker --help, 1.0.70) whose next word is
 * their value, beside Grok's own (GROK_VALUE_OPTIONS). worker's --pool takes one or none, so it is not among them: a
 * command's own is found by its name (isGrokLeader), past a value that isn't one.
 */
const COMMAND_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	...["--reasoning-effort", "--effort", "--agent-profile", "--plugin-dir", "--grok-ws-origin", "--grok-ws-url", "--cli-chat-proxy-base-url"],
	...["--xai-api-base-url", "--name", "--worker-dir", "--max-agents", "--pool-name", "--label", "--labels-file", "--api-key", "--auth-token-file"],
	...["--on-session-start", "--on-session-end", "--management-addr", "--idle-release-timeout", "--cursor-worker-name", "--cursor-worker-dir"],
	"--cursor-worker-max-agents",
]);

/**
 * The commands of Grok's agent, leader and worker (their --help, 1.0.70): agent's leader is leader mode's, worker's
 * start runs one in its own process, and leader's worker is worker's.
 */
const OWN_COMMANDS: Readonly<Record<string, readonly string[]>> = {
	agent: ["stdio", "headless", "serve", "leader", "help"],
	leader: ["list", "info", "kill", "worker", "help"],
	worker: ["start", "stop", "status", "list", "controller", "help"],
};

/**
 * The words of `args` (a process's arguments, its program's left out) that are no option nor an option's value (Grok's,
 * and its agent and worker commands'), before a "--", which ends Grok's own words.
 */
function positionals(args: readonly string[]): string[] {
	const found: string[] = [];
	let value = false;
	for (const word of args) {
		if (word === "--") break;
		if (value) {
			value = false;
			continue;
		}
		if (word.length > 1 && word.startsWith("-")) {
			value = !word.includes("=") && (GROK_VALUE_OPTIONS.has(word) || COMMAND_VALUE_OPTIONS.has(word));
			continue;
		}
		found.push(word);
	}
	return found;
}

/**
 * Whether `argv` is Grok's shared leader's, which runs every session's hooks and MCP servers in one process, with its
 * first client's environment. Leader mode (`--leader`, or `[cli] use_leader = true`) starts it as `<grok> agent
 * [options] leader …` (seen live in 1.0.70: started by the first session's grok from Grok's own binary as `<binary>
 * agent leader --no-exit-on-disconnect …`, and kept running, its parent gone, after that session ends); `grok worker
 * start` and `grok leader worker start` run one in their own process (1.0.70's help: "Run a leader in this terminal").
 * Read as Grok reads its command line, so it knows the leaders src/grok/launch.ts startsLeader refuses at launch: past
 * its options and their values (global ones before the command too: `grok --debug agent leader`), its command is its
 * first word that is no option nor value, or the next one when that first is its prompt (Grok runs `grok hi worker
 * start` as worker start); then that command's own is the first of its words that names one of its commands
 * (OWN_COMMANDS: an option's value Orrery doesn't know is passed over so). Nothing past those is read, so a session's
 * own (Orrery's flags first, its --rules value one argument, or on macOS many words, which start with its section's
 * heading) never reads as it.
 */
export function isGrokLeader(argv: readonly string[]): boolean {
	const words = positionals(argv.slice(1));
	const at = GROK_COMMANDS.has(words[0] ?? "") ? 0 : 1;
	/** The command after the one at `index` among the words: the first word after it that names one of that one's. */
	const next = (index: number): number => {
		const own = OWN_COMMANDS[words[index] ?? ""] ?? [];
		return words.findIndex((word, after) => after > index && own.includes(word));
	};
	const named = (index: number, name: string) => index >= 0 && words[index] === name;
	if (named(at, "agent")) return named(next(at), "leader");
	if (named(at, "worker")) return named(next(at), "start");
	return named(at, "leader") && named(next(at), "worker") && named(next(next(at)), "start");
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

/** The variables of the grok process's start environment that name Grok's folder. */
export const GROK_FOLDER_VARIABLES: readonly string[] = ["GROK_HOME", "HOME"];

/**
 * The variables of the grok process's start environment the hooks read (src/grok/hooks.ts), at once: whose session it
 * is, the Orrery config it runs with, and Grok's folder. The status row reads the same (src/grok/status.ts), so a start
 * environment the hooks can't read (on macOS, one of them holding a space) the row can't either, and says so.
 */
export const GROK_START_VARIABLES: readonly string[] = [...LAUNCH_VARIABLES, "ORRERY_CONFIG", "ORRERY_HOME", ...GROK_FOLDER_VARIABLES];
