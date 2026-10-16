/**
 * The last line of Orrery's Codex guard (`orrery codex-hook pre-tool-use`, src/codex/guard.ts). Codex 0.162.1 lets a tool
 * call through when its PreToolUse hook crashes, exits with any code but 2, exits 2 with nothing on stderr, or runs past
 * its timeout (codex-rs hooks/src/engine/command_runner.rs; the timeout is the hook's `timeout`, which Orrery's launch
 * sets to 10 s, src/codex/launch.ts CODEX_HOOKS, and which is 600 s when unset, discovery.rs normalize_command_hook). So
 * whatever goes wrong in that process becomes a refusal: exit 2 with the reason on stderr.
 * - The guard judges within CODEX_GUARD_DEADLINE_MS of the process's start and refuses what it has not judged by then
 *   (src/codex/guard.ts runCodexGuard): no part of a judgment runs long (the slowest, a 64 KB command line read every
 *   way, takes about 0.2 s on a recent Linux machine), so it answers well inside Codex's timeout on a slower machine too.
 * - A watchdog refuses at CODEX_GUARD_WATCHDOG_MS if the process is still waiting then (its input, a module).
 * - An uncaught exception or rejection refuses at once.
 * The reason is written to stderr synchronously before the exit: a pipe write that has not gone out when the process
 * exits is lost (on macOS pipes are asynchronous), and exit 2 with nothing on stderr lets the call through. This module
 * loads nothing else, so it is armed before the guard's modules are. What fails before it is armed (the runtime, or a
 * module main.ts loads first) is Codex's to let through: a documented limit.
 */

import { writeSync } from "node:fs";

/** How long after the hook process starts the guard may judge a call (ms); past it, it refuses. */
export const CODEX_GUARD_DEADLINE_MS = 4000;

/** When a guard process still waiting (for its input, a module) refuses (ms after it starts). */
export const CODEX_GUARD_WATCHDOG_MS = 6000;

/** Whether a command line is the guard's: `codex-hook pre-tool-use`, whatever options come with it. */
export function isCodexGuard(argv: readonly string[]): boolean {
	return argv.some((word, at) => word === "codex-hook" && argv[at + 1] === "pre-tool-use");
}

/** What arming needs from the process; tests pass their own. */
export interface GuardExitIo {
	readonly on: (event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void) => void;
	readonly writeSync: (fd: number, text: string) => void;
	readonly exit: (code: number) => void;
	readonly setTimeout: (run: () => void, ms: number) => unknown;
	readonly clearTimeout: (timer: unknown) => void;
	/** Milliseconds since the process started. */
	readonly now: () => number;
}

const processIo: GuardExitIo = {
	on: (event, listener) => process.on(event, listener),
	writeSync: (fd, text) => writeSync(fd, text),
	exit: (code) => process.exit(code),
	setTimeout: (run, ms) => setTimeout(run, ms),
	clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
	now: () => performance.now(),
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\.+$/, "");

/**
 * Arms the guard process's last line (module doc). `refuse` writes a refusal and exits 2 at once, once; `disarm` stands
 * it down when the guard's own answer is out.
 */
export function armCodexGuard(io: GuardExitIo = processIo): { readonly refuse: (reason: string) => void; readonly disarm: () => void } {
	let settled = false;
	const refuse = (reason: string) => {
		if (settled) return;
		settled = true;
		try {
			io.writeSync(2, `Orrery guard: ${reason}`);
		} catch {
			// nothing more to say it with
		}
		io.exit(2);
	};
	const crashed = (error: unknown) => refuse(`this call could not be checked (${errorText(error)}); nothing was run`);
	io.on("uncaughtException", crashed);
	io.on("unhandledRejection", crashed);
	const timer = io.setTimeout(() => refuse("this call could not be checked in time; nothing was run"), Math.max(0, CODEX_GUARD_WATCHDOG_MS - io.now()));
	return {
		refuse,
		disarm: () => {
			settled = true;
			io.clearTimeout(timer);
		},
	};
}
