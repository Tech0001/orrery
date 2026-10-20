/**
 * For tests of a tool session started from a coding tool's session that is no agent's (spec 2026-10-19-no-agent-sessions
 * §4c, src/agent/plain-nested.ts): made-up ancestors for a real host process, and a real home that counts a scratch
 * data folder as the user's real Orrery data.
 */

import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PlainDeps } from "../../src/agent/plain-nested.ts";
import { pidNamespace, readProcStat } from "../../src/agent/process.ts";
import type { SessionDeps } from "../../src/agent/sessions.ts";

/** A process as a fake Linux shows it to toolSession's walk: its name (comm) and argv (default [comm]). */
export interface Proc {
	readonly comm: string;
	readonly argv?: readonly string[];
}

/** The first made-up pid; the rest follow. */
const FIRST = 900_001;

/** A /proc/<pid>/stat line: field 2 the name, field 4 the parent. */
const statLine = (pid: number, comm: string, ppid: number) => `${pid} (${comm}) S ${ppid} ${Array(17).fill("0").join(" ")} 100 4096 0\n`;

/** The first pid namespace, as /proc/<pid>/ns/pid names it. */
export const INIT_NAMESPACE = "pid:[4026531836]";

/** How `above` shows the host and the top of its walk. */
export interface Shown {
	/** The host itself, as its argv shows it (npm's Codex binary, OpenCode's server); default a process named "host". */
	readonly host?: Proc;
	/** The host's pid namespace (default the first one). */
	readonly namespace?: string;
	/** The walk is cut short above the last process: its parent can't be read (default: it is pid 1). */
	readonly cut?: boolean;
	/** The values the host was started with of the variables asked (default none); undefined: they can't be read. */
	readonly startEnv?: Readonly<Record<string, string>> | undefined;
}

/**
 * Process reading for toolSession (src/agent/sessions.ts): `host`, a real pid (the tool asking), has the made-up
 * ancestors `chain`, nearest first (pids 900001, 900002, …), the last one's parent pid 1 (`shown.cut`: one that can't be
 * read). Every other process is read as it is (a session record's host, judged by its start).
 */
export function above(host: number, chain: readonly Proc[], shown: Shown = {}): SessionDeps {
	const pidAt = (i: number) => FIRST + i;
	const top = shown.cut === true ? FIRST + 999 : 1;
	const started = "startEnv" in shown ? shown.startEnv : {};
	return {
		platform: "linux",
		proc: (pid) => {
			if (pid === host) return statLine(pid, shown.host?.comm ?? "host", chain.length === 0 ? top : pidAt(0));
			const i = pid - FIRST;
			const row = chain[i];
			if (row === undefined) return i >= 0 && i < 1000 ? undefined : readProcStat(pid);
			return statLine(pid, row.comm, i === chain.length - 1 ? top : pidAt(i + 1));
		},
		cmdline: (pid) => {
			if (pid === host) return shown.host === undefined ? ["host"] : (shown.host.argv ?? [shown.host.comm]);
			const row = chain[pid - FIRST];
			return row === undefined ? undefined : (row.argv ?? [row.comm]);
		},
		ns: (pid) => (pid === host ? (shown.namespace ?? INIT_NAMESPACE) : pidNamespace(pid)),
		startEnv: () => started,
	};
}

/** The user's own terminal: a shell, the terminal, the user's systemd. */
const TERMINAL: readonly Proc[] = [{ comm: "bash", argv: ["/usr/bin/bash"] }, { comm: "foot" }, { comm: "systemd", argv: ["/usr/lib/systemd/systemd", "--user"] }];

/** Where a tool session is started from, as its ancestors show it (nearest first). */
export const STARTS = {
	/** Typed in the user's terminal. */
	terminal: TERMINAL,
	/** Orrery's TUI, in the user's terminal. */
	tui: [{ comm: "orrery", argv: ["orrery"] }, ...TERMINAL],
	/** `orrery agent <Name>`. */
	agent: [{ comm: "orrery", argv: ["orrery", "agent", "Atlas"] }, ...TERMINAL],
	/**
	 * `ori pi`, from `orrery agent` with Ori as the launcher. Ori 0.15.7 execs the tool (seen: its parent is what ran Ori),
	 * so this is the case where an Ori that stayed is its parent: Ori is no coding tool.
	 */
	ori: [{ comm: "ori", argv: ["/home/u/.local/bin/ori", "pi", "--model", "x"] }, { comm: "orrery", argv: ["orrery", "agent", "Atlas"] }, ...TERMINAL],
	/** The Claude Code desktop app: its session's claude under its disclaimer wrapper. */
	desktop: [
		{ comm: "disclaimer", argv: ["/usr/lib/claude-desktop/resources/disclaimer", "--pgroup", "--", "/home/u/.config/Claude/claude-code/2.1.299/x/claude"] },
		{ comm: "claude-desktop", argv: ["/usr/lib/claude-desktop/claude-desktop", "--ozone-platform=wayland"] },
		{ comm: "systemd", argv: ["/usr/lib/systemd/systemd", "--user"] },
	],
	/** A plain Claude Code's shell (no agent's), in the user's terminal. */
	claude: [{ comm: "bash", argv: ["/bin/bash", "-c", "source snapshot && eval 'claude -p hi'"] }, { comm: "claude", argv: ["claude"] }, ...TERMINAL],
	/** A plain Codex's shell, which exec'd the command (bash -lc with one command). */
	codex: [{ comm: "codex", argv: ["codex"] }, ...TERMINAL],
	/** A plain pi's shell. */
	pi: [{ comm: "bash", argv: ["/bin/bash", "-c", "x"] }, { comm: "pi", argv: ["pi"] }, ...TERMINAL],
} as const satisfies Record<string, readonly Proc[]>;

/**
 * A real home (PlainDeps.realHome) whose Orrery home is `dataDir`, by a link beside it: realOrreryData counts the data
 * folder as the user's real data. `dataDir` is made if it isn't there.
 */
export function realHomeOf(dataDir: string): string {
	mkdirSync(dataDir, { recursive: true });
	const home = join(dirname(dataDir), `real-home-${Math.random().toString(36).slice(2)}`);
	mkdirSync(home);
	symlinkSync(dataDir, join(home, ".orrery"));
	return home;
}

/** PlainDeps for a host process `host` under `chain` (as `shown`), with `dataDir` counted as the real data. */
export const plainDeps = (host: number, chain: readonly Proc[], dataDir: string, shown: Shown = {}): PlainDeps => ({ sessions: above(host, chain, shown), realHome: realHomeOf(dataDir) });

/** npm's Codex binary, as @openai/codex 0.163.0's bin/codex.js spawns it, and that launcher, with `args`. */
export const npmCodex = (args: readonly string[] = ["--no-daemon"]): { readonly binary: Proc; readonly launcher: Proc } => ({
	binary: { comm: "codex", argv: ["/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex", ...args] },
	launcher: { comm: "node", argv: ["node", "/usr/local/bin/codex", ...args] },
});

/** OpenCode 2.0.32 with --standalone, as seen here: its TUI (or `run`) and the private server it starts. */
export const OPENCODE = {
	tui: { comm: "opencode.exe", argv: ["/x/bin/opencode.exe", "--standalone", "/x/ws"] },
	server: { comm: "opencode.exe", argv: ["/x/bin/opencode.exe", "serve", "--stdio", "--port", "0"] },
} as const satisfies Record<string, Proc>;
