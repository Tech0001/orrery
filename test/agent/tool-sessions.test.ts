import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processEnv } from "../../src/agent/process.ts";
import {
	CODING_TOOLS,
	recordedCodexIds,
	recordSession,
	type SessionDeps,
	TOOL_MARKERS,
	TOOL_SESSION_NAMES,
	toolSession,
} from "../../src/agent/sessions.ts";

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "orrery-tool-sessions-"));
	dirs.push(dir);
	return dir;
}

/** A process as the fakes show it: its parent, its name (Linux's comm; macOS's comm, its argv[0]) and its argv. */
interface Row {
	readonly ppid: number;
	readonly comm: string;
	/** Default: [comm]. */
	readonly argv?: readonly string[];
	readonly start?: string;
}
type Table = Record<number, Row>;

const NS = "pid:[4026531836]";
const BOOT = "0b0b0b0b-boot";

/** A /proc/<pid>/stat line: field 2 the name, field 4 the parent, field 22 the start time. */
const statLine = (pid: number, row: Row) => `${pid} (${row.comm}) S ${row.ppid} ${Array(17).fill("0").join(" ")} ${row.start ?? "100"} 4096 0\n`;

/**
 * A fake Linux: the table through a fake /proc (stat and cmdline); each argv read kept, and any ps asked. Every process is
 * in NS, and was started with none of the tools' variables (startEnv) unless a test says otherwise.
 */
function linux(table: Table, from?: number): SessionDeps & { readonly argvRead: number[]; readonly psCalls: string[][] } {
	const argvRead: number[] = [];
	const psCalls: string[][] = [];
	return {
		argvRead,
		psCalls,
		platform: "linux",
		ps: (args) => {
			psCalls.push([...args]);
			return undefined;
		},
		proc: (pid) => (table[pid] === undefined ? undefined : statLine(pid, table[pid])),
		cmdline: (pid) => {
			argvRead.push(pid);
			const row = table[pid];
			return row === undefined ? undefined : (row.argv ?? [row.comm]);
		},
		alive: (pid) => table[pid] !== undefined,
		ns: (pid) => (pid === "self" || table[pid] !== undefined ? NS : undefined),
		boot: () => BOOT,
		startEnv: () => ({}),
		...(from === undefined ? {} : { from }),
	};
}

/** A fake macOS: the table through a fake ps (comm is the full argv[0], args argv joined by spaces); each call kept. */
function darwin(table: Table, from: number): SessionDeps & { readonly calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		platform: "darwin",
		from,
		ps: (args) => {
			calls.push([...args]);
			if (args.includes("-A")) return `${Object.entries(table).map(([pid, row]) => `${pid.padStart(5)} ${String(row.ppid).padStart(5)} ${row.comm}`).join("\n")}\n`;
			const row = table[Number(args.at(-1))];
			return row === undefined ? undefined : `${(row.argv ?? [row.comm]).join(" ")}\n`;
		},
	};
}

/**
 * A user's terminal: 60 (orrery) ← 50 (bash) ← 20 (foot) ← 10 (systemd --user) ← 1; `at` adds or replaces rows (a tool
 * at 40 between the shell and the terminal, say).
 */
function terminal(at: Table = {}): Table {
	return {
		1: { ppid: 0, comm: "systemd" },
		10: { ppid: 1, comm: "systemd", argv: ["/usr/lib/systemd/systemd", "--user"] },
		20: { ppid: 10, comm: "foot" },
		50: { ppid: at[40] === undefined ? 20 : 40, comm: "bash", argv: ["bash", "-c", "orrery status"] },
		60: { ppid: 50, comm: "orrery", argv: ["orrery", "status"] },
		...at,
	};
}

/** The tool at 40, under the terminal, as `row` shows it. */
const toolAt = (row: Omit<Row, "ppid">): Table => terminal({ 40: { ppid: 20, ...row } });

describe("toolSession by ancestry", () => {
	it("finds a claude ancestor, with its pid", () => {
		expect(toolSession({}, linux(toolAt({ comm: "claude", argv: ["claude", "--resume"] }), 60))).toEqual({ tool: "claude", via: "ancestry", pid: 40 });
	});

	it("finds a node script named gemini, and every interpreter's script by its file name", () => {
		const scripts: [comm: string, argv: string[], tool: string][] = [
			["node", ["node", "/usr/local/bin/gemini", "--yolo"], "gemini"],
			// Node names its main thread, and so its process: `node-MainThread` (Node 26), `MainThread` (a bundled Node).
			["node-MainThread", ["node", "/usr/local/bin/gemini"], "gemini"],
			["MainThread", ["/opt/app/bin/node", "/usr/local/bin/cursor-agent"], "cursor-agent"],
			["node", ["/usr/bin/node", "/opt/qwen/bin/qwen.js"], "qwen"],
			["bun", ["bun", "/home/u/.bun/bin/amp.mjs"], "amp"],
			["deno", ["deno", "/home/u/.deno/bin/crush.cjs"], "crush"],
			["python3.12", ["/usr/bin/python3.12", "/home/u/.local/bin/aider"], "aider"],
			["python3", ["python3", "/opt/aider/aider.py"], "aider"],
			["bash", ["bash", "/home/u/.local/bin/goose"], "goose"],
			["sh", ["/bin/sh", "/usr/local/bin/droid"], "droid"],
			// A process that retitled itself: its argv[0] names the tool though its comm is still the interpreter's.
			["node", ["copilot", "--banner"], "copilot"],
			// Linux's comm is the kernel's name only: Node renames its main thread, so whatever it calls it, argv decides.
			["node-renamed", ["node", "/usr/local/bin/qwen"], "qwen"],
			// …and so does an `exec -a claude` launch.
			["launcher", ["claude", "--resume"], "claude"],
		];
		for (const [comm, argv, tool] of scripts) expect(toolSession({}, linux(toolAt({ comm, argv }), 60)), argv.join(" ")).toEqual({ tool, via: "ancestry", pid: 40 });
	});

	it("skips an interpreter's options to its script, and takes python's -m module", () => {
		const scripts: [argv: string[], tool: string][] = [
			[["node", "--max-old-space-size=4096", "/x/gemini.js"], "gemini"],
			[["node", "--no-warnings", "--enable-source-maps", "/x/qwen"], "qwen"],
			// Options whose value is the next argument.
			[["node", "-r", "/x/preload.js", "/x/gemini"], "gemini"],
			[["node", "--require", "ts-node/register", "--import", "tsx", "/x/copilot"], "copilot"],
			[["node", "--title", "claude", "/x/cursor-agent"], "cursor-agent"],
			[["node", "--", "/x/amp"], "amp"],
			// What `#!/usr/bin/env -S node --no-deprecation --experimental-vm-modules` leaves: env runs node with them.
			[["node", "--no-deprecation", "--experimental-vm-modules", "/usr/local/bin/gemini"], "gemini"],
			[["bun", "run", "/x/amp.js"], "amp"],
			[["bun", "--smol", "run", "/x/amp.js"], "amp"],
			[["bun", "--preload", "/x/setup.ts", "/x/crush"], "crush"],
			[["deno", "run", "--allow-all", "/x/crush"], "crush"],
			[["deno", "run", "-c", "deno.json", "/x/crush"], "crush"],
			[["python3", "-m", "aider"], "aider"],
			[["python3", "-um", "aider", "--model", "x"], "aider"],
			[["python3", "-Wignore", "-maider"], "aider"],
			[["python3.12", "-X", "utf8", "/x/aider"], "aider"],
			[["bash", "--norc", "/x/goose"], "goose"],
			[["bash", "-o", "pipefail", "/x/goose"], "goose"],
			[["bash", "+O", "extglob", "/x/goose"], "goose"],
			[["sh", "-e", "/x/droid"], "droid"],
		];
		for (const [argv, tool] of scripts) expect(toolSession({}, linux(toolAt({ comm: argv[0] as string, argv }), 60)), argv.join(" ")).toEqual({ tool, via: "ancestry", pid: 40 });
	});

	it("no script where the code is inline, read from stdin, or an option's value", () => {
		const plain: string[][] = [
			["node", "-e", "require('/x/gemini')"],
			["node", "--eval=1", "/x/gemini"],
			["node", "-p", "1"],
			["node", "-"],
			["node", "-r", "/x/gemini"],
			["node", "/usr/lib/node_modules/@google/gemini-cli/dist/index.js"],
			["bun", "-e", "1", "/x/amp"],
			["bash", "-c", "claude"],
			["bash", "-lc", "codex"],
			["bash", "-c", "-l", "pi"],
			["bash", "-s", "pi"],
			["bash", "--rcfile", "/x/claude"],
			["bash", "--init-file", "/x/claude-desktop.bash"],
			["-bash"],
			["python3", "-c", "import aider"],
			["python3", "-m", "aider.main"],
			["python3", "-W", "aider"],
			["python3", "-"],
			// Not an interpreter: its argument is no script.
			["less", "/home/u/notes/claude"],
			["vim", "codex.py"],
		];
		for (const argv of plain) expect(toolSession({}, linux(toolAt({ comm: argv[0] as string, argv }), 60)), argv.join(" ")).toBeUndefined();
	});

	it("finds OpenCode as Linux shows it, opencode.exe", () => {
		expect(toolSession({}, linux(toolAt({ comm: "opencode.exe", argv: ["/home/u/.npm/lib/node_modules/@opencode/cli/bin/opencode.exe", "-s", "x"] }), 60))).toEqual({ tool: "opencode", via: "ancestry", pid: 40 });
		// Its background service, a long-lived ancestor of the shells its TUIs ask it to run.
		expect(toolSession({}, linux(toolAt({ comm: "opencode.exe", argv: ["opencode.exe", "serve", "--service"] }), 60))).toMatchObject({ tool: "opencode" });
		// argv[0] carries the .exe too where the name can't be read from comm (a retitled node, say).
		expect(toolSession({}, linux(toolAt({ comm: "node", argv: ["/x/bin/opencode.exe"] }), 60))).toMatchObject({ tool: "opencode" });
	});

	it("Linux: an argv[0] holding whitespace is a process title, not a program: its last word names no tool", () => {
		// sshd and others retitle themselves; /proc/<pid>/cmdline then holds the title as argv[0].
		for (const title of ["sshd: u@pts/0 /srv/claude", "sshd: u [priv] /home/u/bin/codex", "postgres: u db /srv/pi"]) {
			expect(toolSession({}, linux(toolAt({ comm: "sshd", argv: [title] }), 60)), title).toBeUndefined();
		}
		// An interpreter in a folder whose name holds a space still runs the script its arguments name.
		expect(toolSession({}, linux(toolAt({ comm: "node", argv: ["/home/u/My Tools/node", "/x/gemini.js"] }), 60))).toEqual({ tool: "gemini", via: "ancestry", pid: 40 });
		// A tool's own name decides by comm, wherever its program is.
		expect(toolSession({}, linux(toolAt({ comm: "claude", argv: ["/opt/My Apps/claude"] }), 60))).toEqual({ tool: "claude", via: "ancestry", pid: 40 });
	});

	it("matches names exactly: helpers, the desktop app and look-alikes are no tools", () => {
		const helpers = ["claude-desktop", "disclaimer", "cowork-linux-he", "codex-code-mode", "MainThread", "node_repl", "omp daemon brok", "claudex", "xcodex", "pi-agent", "codex-linux-san", "Claude", "CODEX", "opencode.exe.bak"];
		for (const comm of helpers) expect(toolSession({}, linux(toolAt({ comm }), 60)), comm).toBeUndefined();
	});

	it("walks past a tool's helpers to the tool", () => {
		const table = terminal({ 40: { ppid: 20, comm: "codex", argv: ["codex", "resume"] }, 45: { ppid: 40, comm: "MainThread" }, 50: { ppid: 45, comm: "bash", argv: ["bash", "-lc", "orrery status"] } });
		expect(toolSession({}, linux(table, 60))).toEqual({ tool: "codex", via: "ancestry", pid: 40 });
		// A helper whose argv[0] is its tool's is that tool's process: OMP's broker (comm `omp daemon brok`).
		expect(toolSession({}, linux(toolAt({ comm: "omp daemon brok", argv: ["omp", "__omp_worker_daemon_broker"] }), 60))).toEqual({ tool: "omp", via: "ancestry", pid: 40 });
	});

	it("the nearest tool ancestor wins", () => {
		// 60 ← 50 bash ← 45 codex ← 42 bash ← 40 claude: Codex started from a Claude Code shell.
		const table = terminal({ 40: { ppid: 20, comm: "claude" }, 42: { ppid: 40, comm: "bash" }, 45: { ppid: 42, comm: "codex" }, 50: { ppid: 45, comm: "bash" } });
		expect(toolSession({}, linux(table, 60))).toEqual({ tool: "codex", via: "ancestry", pid: 45 });
	});

	it("pid 1 and the top of a pid namespace end the walk", () => {
		// pid 1 is never judged, whatever its name (a container whose first process is a tool).
		const init = terminal({ 1: { ppid: 0, comm: "claude" } });
		const deps = linux(init, 60);
		expect(toolSession({}, deps)).toBeUndefined();
		expect(deps.argvRead).not.toContain(1);
		// A sandboxed shell: 9 ← 8 (bash, whose parent is outside its namespace, so 0). Codex at 7 can't be reached.
		const sandbox: Table = { 7: { ppid: 1, comm: "codex" }, 8: { ppid: 0, comm: "bash" }, 9: { ppid: 8, comm: "orrery" } };
		expect(toolSession({}, linux(sandbox, 9))).toBeUndefined();
	});

	it("on Linux reads the argv of each ancestor whose comm names no tool: one small /proc file each, no process", () => {
		// The user's terminal: bash, foot and systemd --user, nearest first; pid 1 never.
		const user = linux(terminal(), 60);
		expect(toolSession({}, user)).toBeUndefined();
		expect(user.argvRead).toEqual([50, 20, 10]);
		expect(user.psCalls).toEqual([]);
		// A tool's comm decides at once: no argv above it is read.
		const claude = linux(toolAt({ comm: "claude" }), 60);
		expect(toolSession({}, claude)).toMatchObject({ tool: "claude" });
		expect(claude.argvRead).toEqual([50]);
		// An argv that can't be read is no tool.
		const gone: SessionDeps = { ...linux(toolAt({ comm: "node" }), 60), cmdline: () => undefined };
		expect(toolSession({}, gone)).toBeUndefined();
	});
});

describe("toolSession on macOS", () => {
	it("takes the program from comm's full path, with one ps for the whole chain", () => {
		const paths: [comm: string, tool: string | undefined][] = [
			["/Applications/Codex.app/Contents/Resources/codex", "codex"],
			["/Users/u/Library/Application Support/Claude/claude-code/2.1.299/claude", "claude"],
			["/opt/homebrew/bin/opencode", "opencode"],
			// The desktop apps themselves and their helpers: not tools.
			["/Applications/Claude.app/Contents/MacOS/Claude", undefined],
			["/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)", undefined],
			["/Applications/Codex.app/Contents/MacOS/Codex", undefined],
		];
		for (const [comm, tool] of paths) {
			const mac = darwin(toolAt({ comm }), 60);
			expect(toolSession({}, mac), comm).toEqual(tool === undefined ? undefined : { tool, via: "ancestry", pid: 40 });
			// The shell is an interpreter, so its args are asked for; a tool's comm or a helper's decides without.
			expect(mac.calls, comm).toEqual([
				["-A", "-ww", "-o", "pid=,ppid=,comm="],
				["-ww", "-o", "args=", "-p", "50"],
			]);
		}
	});

	it("finds a node script by its args, even when node's path has a space", () => {
		for (const node of ["/opt/homebrew/bin/node", "/Users/u/Library/Application Support/fnm/node"]) {
			const mac = darwin(toolAt({ comm: node, argv: [node, "/Users/u/.local/bin/gemini.js", "--yolo"] }), 60);
			expect(toolSession({}, mac), node).toEqual({ tool: "gemini", via: "ancestry", pid: 40 });
			expect(mac.calls.at(-1)).toEqual(["-ww", "-o", "args=", "-p", "40"]);
		}
	});

	it("a script whose path has spaces: the longest run of words from its place that is a file", () => {
		const bin = join(temp(), "Application Support", "x", "bin");
		mkdirSync(bin, { recursive: true });
		const script = join(bin, "gemini");
		writeFileSync(script, "");
		const node = "/opt/homebrew/bin/node";
		expect(toolSession({}, darwin(toolAt({ comm: node, argv: [node, script, "--yolo"] }), 60))).toEqual({ tool: "gemini", via: "ancestry", pid: 40 });
		// A later argument that ends in a tool's name is no script: no longer run of words is a file, so the first word is.
		for (const argv of [
			[node, "/opt/server.js", "/home/u/code/claude"],
			[node, "/opt/server.js", "--root", "/home/u/code/pi"],
		]) {
			expect(toolSession({}, darwin(toolAt({ comm: node, argv }), 60)), argv.join(" ")).toBeUndefined();
		}
	});

	it("args that don't start with comm: argv[0] ends at the first word with comm's file name", () => {
		// comm the program's short name, argv[0] a path with a space.
		const short = darwin(toolAt({ comm: "node", argv: ["/Users/u/Library/Application Support/fnm/node", "/Users/u/bin/gemini.js"] }), 60);
		expect(toolSession({}, short)).toEqual({ tool: "gemini", via: "ancestry", pid: 40 });
		// comm a full path, argv[0] the bare name.
		expect(toolSession({}, darwin(toolAt({ comm: "/usr/local/bin/node", argv: ["node", "/x/qwen"] }), 60))).toEqual({ tool: "qwen", via: "ancestry", pid: 40 });
	});

	it("the user's terminal under zsh: one ps, nothing else", () => {
		const table: Table = {
			1: { ppid: 0, comm: "/sbin/launchd" },
			20: { ppid: 1, comm: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" },
			30: { ppid: 20, comm: "login" },
			50: { ppid: 30, comm: "-zsh" },
			60: { ppid: 50, comm: "orrery" },
		};
		const mac = darwin(table, 60);
		expect(toolSession({}, mac)).toBeUndefined();
		expect(mac.calls).toEqual([["-A", "-ww", "-o", "pid=,ppid=,comm="]]);
	});
});

describe("toolSession by markers", () => {
	it("finds CLAUDECODE without ancestry, naming the variable", () => {
		expect(toolSession({ CLAUDECODE: "1" }, linux(terminal(), 60))).toEqual({ tool: "claude", via: "marker", variable: "CLAUDECODE" });
	});

	it("each tool's own markers, in order", () => {
		const cases: [env: NodeJS.ProcessEnv, tool: string, variable: string][] = [
			[{ CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, "claude", "CLAUDE_CODE_ENTRYPOINT"],
			[{ CODEX_THREAD_ID: "019a-thread" }, "codex", "CODEX_THREAD_ID"],
			[{ CODEX_SESSION_ID: "019a-thread" }, "codex", "CODEX_SESSION_ID"],
			[{ CODEX_SANDBOX: "seatbelt" }, "codex", "CODEX_SANDBOX"],
			[{ OPENCODE: "1" }, "opencode", "OPENCODE"],
			[{ OPENCODE_SESSION_ID: "ses_1" }, "opencode", "OPENCODE_SESSION_ID"],
			[{ PI_CODING_AGENT: "true" }, "pi", "PI_CODING_AGENT"],
			// A nested tool carries its parents' markers: the first in TOOL_MARKERS' order is named.
			[{ PI_CODING_AGENT: "true", OPENCODE: "1", CLAUDECODE: "1" }, "claude", "CLAUDECODE"],
			[{ OPENCODE: "1", CODEX_THREAD_ID: "019a-thread" }, "codex", "CODEX_THREAD_ID"],
		];
		for (const [env, tool, variable] of cases) expect(toolSession(env, linux(terminal(), 60)), JSON.stringify(env)).toEqual({ tool, via: "marker", variable });
		expect(TOOL_MARKERS.map((marker) => marker.variable)).toEqual(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_SANDBOX", "OPENCODE", "OPENCODE_SESSION_ID", "PI_CODING_AGENT"]);
	});

	it("generic, empty and other variables are no markers", () => {
		const none: NodeJS.ProcessEnv[] = [
			{},
			{ CLAUDECODE: "", CODEX_THREAD_ID: "", PI_CODING_AGENT: "" },
			{ AGENT: "1", AI_AGENT: "opencode", CI: "true" },
			{ CODEX_HOME: "/home/u/.codex", CLAUDE_PID: "77", CLAUDE_CODE_SESSION_ID: "x", PI_CODING_AGENT_DIR: "/x", GEMINI_CLI: "1" },
		];
		for (const env of none) expect(toolSession(env, linux(terminal(), 60)), JSON.stringify(env)).toBeUndefined();
	});

	it("a Codex id a record names is not a marker", () => {
		const recordedCodexIds = new Set(["019a-thread"]);
		const deps = { ...linux(terminal(), 60), recordedCodexIds };
		expect(toolSession({ CODEX_THREAD_ID: "019a-thread" }, deps)).toBeUndefined();
		expect(toolSession({ CODEX_SESSION_ID: "019a-thread" }, deps)).toBeUndefined();
		expect(toolSession({ CODEX_THREAD_ID: "019a-thread", CODEX_SESSION_ID: "019a-thread" }, deps)).toBeUndefined();
		// The tool's other markers still count.
		expect(toolSession({ CODEX_THREAD_ID: "019a-thread", CLAUDECODE: "1" }, deps)).toEqual({ tool: "claude", via: "marker", variable: "CLAUDECODE" });
	});

	it("a Codex id no record names is", () => {
		const deps = { ...linux(terminal(), 60), recordedCodexIds: new Set(["019a-thread"]) };
		expect(toolSession({ CODEX_THREAD_ID: "019b-other" }, deps)).toEqual({ tool: "codex", via: "marker", variable: "CODEX_THREAD_ID" });
		expect(toolSession({ CODEX_THREAD_ID: "019a-thread", CODEX_SESSION_ID: "019b-other" }, deps)).toEqual({ tool: "codex", via: "marker", variable: "CODEX_SESSION_ID" });
		// No records given: any Codex id counts.
		expect(toolSession({ CODEX_THREAD_ID: "019a-thread" }, linux(terminal(), 60))).toEqual({ tool: "codex", via: "marker", variable: "CODEX_THREAD_ID" });
	});

	it("a sandboxed shell whose ancestry is cut is found by its marker", () => {
		const sandbox: Table = { 8: { ppid: 0, comm: "bash" }, 9: { ppid: 8, comm: "orrery" } };
		expect(toolSession({ CODEX_THREAD_ID: "019b-other" }, linux(sandbox, 9))).toEqual({ tool: "codex", via: "marker", variable: "CODEX_THREAD_ID" });
	});

	it("ancestry comes before markers", () => {
		expect(toolSession({ CLAUDECODE: "1" }, linux(toolAt({ comm: "codex" }), 60))).toEqual({ tool: "codex", via: "ancestry", pid: 40 });
	});
});

describe("toolSession asked by a tool about its own host (own, spec 2026-10-19-no-agent-sessions §4c)", () => {
	/**
	 * The user's terminal, with the host at 60 (the tool asking: `host`) and, between it and the shell at 50, the rows
	 * `between` (nearest first, from 59 down): a launcher, an outer tool.
	 */
	function hostUnder(host: Omit<Row, "ppid">, between: Omit<Row, "ppid">[] = []): Table {
		const table = terminal({ 60: { ppid: between.length === 0 ? 50 : 59, ...host } });
		between.forEach((row, i) => (table[59 - i] = { ppid: i === between.length - 1 ? 50 : 58 - i, ...row }));
		return table;
	}
	/** Another pid namespace than the first one: a sandbox's, a container's. */
	const SANDBOX_NS = "pid:[4026533000]";
	/** The walk from 60 cut short: the shell's parent can't be read (gone, or hidden). */
	const cut = (table: Table): Table => ({ ...table, 50: { ...(table[50] as Row), ppid: 45 } });
	const DESKTOP = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" };

	// npm's Codex, as @openai/codex 0.163.0's bin/codex.js starts it: the package's binary, with the launcher's arguments.
	const NPM_BINARY = "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
	const npmCodex = { comm: "node", argv: ["node", "/usr/local/bin/codex", "--no-daemon", "-c", "x=1"] };
	const codexBinary = { comm: "codex", argv: [NPM_BINARY, "--no-daemon", "-c", "x=1"] };
	// OpenCode 2.0.32 as seen here: `run --standalone` (or its TUI) starts its private server as `serve --stdio --port 0`.
	const tui = { comm: "opencode.exe", argv: ["/x/bin/opencode.exe", "run", "--standalone", "--format", "json", "hi"] };
	const server = { comm: "opencode.exe", argv: ["/x/bin/opencode.exe", "serve", "--stdio", "--port", "0"] };

	describe("its own tool's markers", () => {
		it("are no evidence where the walk reached the top with every parent read, in the first pid namespace, and the host was started without them; another tool's still are", () => {
			const deps = linux(hostUnder({ comm: "claude" }), 60);
			// Variables the host set for its own shell and hooks, or that its hook was given.
			expect(toolSession(DESKTOP, { ...deps, own: "claude" })).toBeUndefined();
			expect(toolSession({ PI_CODING_AGENT: "true" }, { ...deps, own: "pi" })).toBeUndefined();
			expect(toolSession({ CODEX_THREAD_ID: "019a-thread", CODEX_SANDBOX: "seatbelt" }, { ...deps, own: "codex" })).toBeUndefined();
			// Behind its own, another tool's marker is found.
			expect(toolSession({ ...DESKTOP, CODEX_THREAD_ID: "019a-thread" }, { ...deps, own: "claude" })).toEqual({ tool: "codex", via: "marker", variable: "CODEX_THREAD_ID" });
			expect(toolSession(DESKTOP, { ...deps, own: "pi" })).toEqual({ tool: "claude", via: "marker", variable: "CLAUDECODE" });
			// OMP sets none of its own: pi's marker is another tool's.
			expect(toolSession({ PI_CODING_AGENT: "true" }, { ...deps, own: "omp" })).toEqual({ tool: "pi", via: "marker", variable: "PI_CODING_AGENT" });
		});

		it("on Linux, CLAUDECODE, PI_CODING_AGENT or CODEX_THREAD_ID the host was started with nest it where the walk is whole too: the same tool started detached or in the background", () => {
			// A plain Claude Code's `setsid claude -p …` (or `claude -p … &` from a subshell that exits): reparented to the
			// user's systemd, a whole walk with no tool above, and Claude Code's variable in what it was started with.
			const detached = (startEnv: Readonly<Record<string, string>> | undefined) => ({ ...linux(terminal({ 60: { ppid: 10, comm: "host" } }), 60), startEnv: () => startEnv });
			expect(toolSession(DESKTOP, { ...detached({ CLAUDECODE: "1" }), own: "claude" })).toEqual({ tool: "claude", via: "marker", variable: "CLAUDECODE" });
			// Asked of what it was started with, not of what its hook was given.
			expect(toolSession({}, { ...detached({ CLAUDECODE: "1" }), own: "claude" })).toEqual({ tool: "claude", via: "marker", variable: "CLAUDECODE" });
			expect(toolSession({ PI_CODING_AGENT: "true" }, { ...detached({ PI_CODING_AGENT: "true" }), own: "pi" })).toEqual({ tool: "pi", via: "marker", variable: "PI_CODING_AGENT" });
			expect(toolSession({}, { ...detached({ CODEX_THREAD_ID: "019b-outer" }), own: "codex" })).toEqual({ tool: "codex", via: "marker", variable: "CODEX_THREAD_ID" });
			// A Codex id a record names is an agent's Codex session, no marker.
			expect(toolSession({}, { ...detached({ CODEX_THREAD_ID: "019a-atlas" }), recordedCodexIds: new Set(["019a-atlas"]), own: "codex" })).toBeUndefined();
			// The user's terminal with a leftover CLAUDECODE (a tmux server first started from a Claude Code shell): the same.
			expect(toolSession(DESKTOP, { ...linux(hostUnder({ comm: "claude" }), 60), startEnv: () => ({ CLAUDECODE: "1" }), own: "claude" })).toEqual({ tool: "claude", via: "marker", variable: "CLAUDECODE" });
		});

		it("where the walk is whole, never by CLAUDE_CODE_ENTRYPOINT (VS Code and SDK launches set it) or the other tools' own variables, nor by a start environment that can't be read", () => {
			const whole = (startEnv: Readonly<Record<string, string>> | undefined) => ({ ...linux(hostUnder({ comm: "host" }), 60), startEnv: () => startEnv });
			expect(toolSession(DESKTOP, { ...whole({ CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }), own: "claude" })).toBeUndefined();
			expect(toolSession({ CODEX_SESSION_ID: "x", CODEX_SANDBOX: "seatbelt" }, { ...whole({ CODEX_SESSION_ID: "x", CODEX_SANDBOX: "seatbelt" }), own: "codex" })).toBeUndefined();
			expect(toolSession({ OPENCODE: "1" }, { ...whole({ OPENCODE: "1", OPENCODE_SESSION_ID: "ses_outer" }), own: "opencode" })).toBeUndefined();
			expect(toolSession(DESKTOP, { ...whole(undefined), own: "claude" })).toBeUndefined();
			expect(toolSession({ PI_CODING_AGENT: "true" }, { ...whole(undefined), own: "pi" })).toBeUndefined();
		});

		it("macOS: where the walk is whole the start environment is not asked (a known gap)", () => {
			const table: Table = {
				1: { ppid: 0, comm: "/sbin/launchd" },
				20: { ppid: 1, comm: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" },
				50: { ppid: 20, comm: "-zsh" },
				60: { ppid: 50, comm: "/usr/local/bin/claude" },
			};
			const asked: string[][] = [];
			const mac = { ...darwin(table, 60), startEnv: (_pid: number, names: readonly string[]) => (asked.push([...names]), { CLAUDECODE: "1" }), own: "claude" };
			expect(toolSession({ CLAUDECODE: "1" }, mac)).toBeUndefined();
			expect(asked).toEqual([]);
		});

		it("count where the walk is cut short (another pid namespace, a parent that can't be read) and the host was started with them", () => {
			const inherited = { startEnv: () => ({ CLAUDECODE: "1" }) };
			const sandbox = { ...linux(hostUnder({ comm: "claude" }), 60), ns: () => SANDBOX_NS, ...inherited };
			expect(toolSession({ CLAUDECODE: "1" }, { ...sandbox, own: "claude" })).toEqual({ tool: "claude", via: "marker", variable: "CLAUDECODE" });
			const unread = { ...linux(cut(hostUnder({ comm: "claude" })), 60), ...inherited };
			expect(toolSession({ CLAUDECODE: "1" }, { ...unread, own: "claude" })).toEqual({ tool: "claude", via: "marker", variable: "CLAUDECODE" });
			// A start environment that can't be read counts them (fail closed).
			expect(toolSession({ PI_CODING_AGENT: "true" }, { ...unread, startEnv: () => undefined, own: "pi" })).toEqual({ tool: "pi", via: "marker", variable: "PI_CODING_AGENT" });
		});

		it("set by the host itself (not in its start environment) say nothing of a session above it, cut walk or not", () => {
			// pi sets PI_CODING_AGENT in its own process; Claude Code gives its hooks CLAUDECODE.
			const self = { ...linux(cut(hostUnder({ comm: "pi" })), 60), startEnv: () => ({}) };
			expect(toolSession({ PI_CODING_AGENT: "true" }, { ...self, own: "pi" })).toBeUndefined();
			expect(toolSession({ CLAUDECODE: "1" }, { ...self, ns: () => SANDBOX_NS, own: "claude" })).toBeUndefined();
			// The start environment is asked once, for its own tool's variables only: where the walk is cut, and (Linux) where
			// it is whole for a tool with a variable that counts there.
			const asked: string[][] = [];
			const watched = { ...linux(cut(hostUnder({ comm: "claude" })), 60), startEnv: (_pid: number, names: readonly string[]) => (asked.push([...names]), {}) };
			toolSession(DESKTOP, { ...watched, own: "claude" });
			expect(asked).toEqual([["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]]);
			const whole: string[][] = [];
			const wholeWatched = { ...linux(hostUnder({ comm: "claude" }), 60), startEnv: (_pid: number, names: readonly string[]) => (whole.push([...names]), {}) };
			toolSession(DESKTOP, { ...wholeWatched, own: "claude" });
			expect(whole).toEqual([["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]]);
			// OpenCode and OMP have none that counts there: not asked.
			toolSession({ OPENCODE: "1" }, { ...wholeWatched, own: "opencode" });
			toolSession({}, { ...wholeWatched, own: "omp" });
			expect(whole).toHaveLength(1);
		});

		it("npm's Codex launcher and OpenCode's TUI vouch for nothing: in a cut walk an inherited marker of the tool's nests it; in a whole walk only Codex's thread id does", () => {
			const cases = [
				["codex", codexBinary, npmCodex, { CODEX_THREAD_ID: "019b-outer" }, "CODEX_THREAD_ID", true],
				["opencode", server, tui, { OPENCODE: "1", OPENCODE_SESSION_ID: "ses_outer" }, "OPENCODE", false],
			] as const;
			for (const [own, host, launcher, inherited, variable, whole] of cases) {
				const table = hostUnder(host, [launcher]);
				const startEnv = () => inherited;
				// Passed over in the walk: no outer session by ancestry, whole walk or cut.
				expect(toolSession({}, { ...linux(cut(table), 60), startEnv, own }), own).toBeUndefined();
				expect(toolSession(inherited, { ...linux(cut(table), 60), startEnv, own }), own).toEqual({ tool: own, via: "marker", variable });
				expect(toolSession(inherited, { ...linux(table, 60), ns: () => SANDBOX_NS, startEnv, own }), own).toEqual({ tool: own, via: "marker", variable });
				expect(toolSession(inherited, { ...linux(table, 60), startEnv, own }), own).toEqual(whole ? { tool: own, via: "marker", variable } : undefined);
			}
		});

		it("are no evidence under the Claude Code desktop app (claude ← disclaimer ← claude-desktop), its known launcher, cut walk or not", () => {
			const table: Table = {
				1: { ppid: 0, comm: "systemd" },
				10: { ppid: 1, comm: "systemd", argv: ["/usr/lib/systemd/systemd", "--user"] },
				20: { ppid: 10, comm: "claude-desktop", argv: ["/usr/lib/claude-desktop/claude-desktop", "--ozone-platform=wayland"] },
				30: { ppid: 20, comm: "disclaimer", argv: ["/usr/lib/claude-desktop/resources/disclaimer", "--pgroup", "--", "/home/u/.config/Claude/claude-code/2.1.299/x/claude"] },
				40: { ppid: 30, comm: "claude", argv: ["/home/u/.config/Claude/claude-code/2.1.299/x/claude", "--output-format", "stream-json"] },
			};
			const inherited = { startEnv: () => DESKTOP };
			expect(toolSession(DESKTOP, { ...linux(table, 40), ...inherited, own: "claude" })).toBeUndefined();
			// In a sandbox of its own (a packaged app), or with its parents unreadable past the wrapper.
			expect(toolSession(DESKTOP, { ...linux(table, 40), ...inherited, ns: () => SANDBOX_NS, own: "claude" })).toBeUndefined();
			expect(toolSession(DESKTOP, { ...linux({ ...table, 30: { ...(table[30] as Row), ppid: 25 } }, 40), ...inherited, own: "claude" })).toBeUndefined();
			// The app itself right above it.
			expect(toolSession(DESKTOP, { ...linux({ ...table, 40: { ...(table[40] as Row), ppid: 20 } }, 40), ...inherited, ns: () => SANDBOX_NS, own: "claude" })).toBeUndefined();
			// Only right above it: a disclaimer further up is no launcher of this claude's.
			const below = { ...table, 35: { ppid: 30, comm: "bash" }, 40: { ...(table[40] as Row), ppid: 35 } };
			expect(toolSession(DESKTOP, { ...linux(below, 40), ...inherited, ns: () => SANDBOX_NS, own: "claude" })).toEqual({ tool: "claude", via: "marker", variable: "CLAUDECODE" });
		});
	});

	describe("its own launcher right above it", () => {
		it("npm's Codex: the script launcher right above the package's binary, which it runs with its own arguments, is passed over", () => {
			expect(toolSession({}, { ...linux(hostUnder(codexBinary, [npmCodex]), 60), own: "codex" })).toBeUndefined();
			// Run by Bun, or by the script's own path.
			expect(toolSession({}, { ...linux(hostUnder(codexBinary, [{ comm: "bun", argv: ["bun", "/x/lib/node_modules/@openai/codex/bin/codex.js", "--no-daemon", "-c", "x=1"] }]), 60), own: "codex" })).toBeUndefined();
			// Without `own` it is a Codex like any other.
			expect(toolSession({}, linux(hostUnder(codexBinary, [npmCodex]), 60))).toEqual({ tool: "codex", via: "ancestry", pid: 59 });
		});

		it("npm's Codex: any other shape is nesting", () => {
			const nested = (host: Omit<Row, "ppid">, between: Omit<Row, "ppid">[]) => toolSession({}, { ...linux(hostUnder(host, between), 60), own: "codex" });
			// A host that is no binary of the package's (a Codex elsewhere, or itself a script of Codex's).
			expect(nested({ comm: "codex", argv: ["/usr/local/bin/codex", "--no-daemon", "-c", "x=1"] }, [npmCodex])).toEqual({ tool: "codex", via: "ancestry", pid: 59 });
			expect(nested({ comm: "node", argv: ["node", "/usr/local/bin/codex", "--no-daemon", "-c", "x=1"] }, [npmCodex])).toEqual({ tool: "codex", via: "ancestry", pid: 59 });
			// Arguments that aren't the launcher's.
			expect(nested({ comm: "codex", argv: [NPM_BINARY, "exec", "hi"] }, [npmCodex])).toEqual({ tool: "codex", via: "ancestry", pid: 59 });
			// Not right above it: past a shell, and the second of two launchers.
			expect(nested(codexBinary, [{ comm: "bash" }, npmCodex])).toEqual({ tool: "codex", via: "ancestry", pid: 58 });
			expect(nested(codexBinary, [npmCodex, npmCodex])).toEqual({ tool: "codex", via: "ancestry", pid: 58 });
			// Past its own launcher, an outer Codex.
			expect(nested(codexBinary, [npmCodex, { comm: "codex" }])).toEqual({ tool: "codex", via: "ancestry", pid: 58 });
		});

		it("OpenCode: its --standalone TUI right above the `serve --stdio` server it starts is passed over", () => {
			expect(toolSession({}, { ...linux(hostUnder(server, [tui]), 60), own: "opencode" })).toBeUndefined();
			expect(toolSession({}, { ...linux(hostUnder(server, [{ comm: "opencode.exe", argv: ["/x/bin/opencode.exe", "--standalone", "/x/ws"] }]), 60), own: "opencode" })).toBeUndefined();
			// Without `own` it is an OpenCode like any other.
			expect(toolSession({}, linux(hostUnder(server, [tui]), 60))).toEqual({ tool: "opencode", via: "ancestry", pid: 59 });
		});

		it("OpenCode: any other shape is nesting, by the server's own arguments, never by the name alone", () => {
			const nested = (host: Omit<Row, "ppid">, between: Omit<Row, "ppid">[]) => toolSession({}, { ...linux(hostUnder(host, between), 60), own: "opencode" });
			// A host that is no private server, or a parent that started none.
			expect(nested({ comm: "opencode.exe", argv: ["/x/bin/opencode.exe", "-s", "ses_1"] }, [tui])).toEqual({ tool: "opencode", via: "ancestry", pid: 59 });
			expect(nested({ comm: "opencode.exe", argv: ["/x/bin/opencode.exe", "serve", "--port", "4096"] }, [tui])).toEqual({ tool: "opencode", via: "ancestry", pid: 59 });
			expect(nested(server, [{ comm: "opencode.exe", argv: ["/x/bin/opencode.exe", "serve", "--stdio"] }])).toEqual({ tool: "opencode", via: "ancestry", pid: 59 });
			// An npm launcher above its TUI is not right above the server.
			expect(nested(server, [tui, { comm: "node", argv: ["node", "/usr/local/bin/opencode"] }])).toEqual({ tool: "opencode", via: "ancestry", pid: 58 });
			// Its TUI started from an outer OpenCode's shell (sh -c exec'd it): the outer server is next.
			expect(nested(server, [tui, server, tui])).toEqual({ tool: "opencode", via: "ancestry", pid: 58 });
			// Another tool right above it is that tool's session.
			expect(nested(server, [{ comm: "claude" }])).toEqual({ tool: "claude", via: "ancestry", pid: 59 });
		});

		it("any other same-tool process above the host is nesting: native under native, script under script, further up", () => {
			const nested = (tool: string, host: Omit<Row, "ppid">, between: Omit<Row, "ppid">[]) => toolSession({}, { ...linux(hostUnder(host, between), 60), own: tool });
			// A shell that exec'd it (bash -lc with one command): the outer tool is its parent.
			expect(nested("codex", { comm: "codex" }, [{ comm: "codex", argv: ["codex", "resume"] }])).toEqual({ tool: "codex", via: "ancestry", pid: 59 });
			expect(nested("pi", { comm: "pi" }, [{ comm: "pi" }])).toEqual({ tool: "pi", via: "ancestry", pid: 59 });
			expect(nested("claude", { comm: "claude" }, [{ comm: "claude" }])).toEqual({ tool: "claude", via: "ancestry", pid: 59 });
			// A script of a tool under a script of the same tool.
			expect(nested("pi", { comm: "node", argv: ["node", "/x/bin/pi"] }, [{ comm: "node", argv: ["node", "/x/bin/pi"] }])).toEqual({ tool: "pi", via: "ancestry", pid: 59 });
			// Further up, past a shell.
			expect(nested("pi", { comm: "pi" }, [{ comm: "bash" }, { comm: "pi" }])).toEqual({ tool: "pi", via: "ancestry", pid: 58 });
			// Another tool's script right above is that tool.
			expect(nested("codex", codexBinary, [{ comm: "node", argv: ["node", "/x/gemini"] }])).toEqual({ tool: "gemini", via: "ancestry", pid: 59 });
		});

		it("macOS: npm's Codex launcher is passed over the same way, by its args", () => {
			const binary = "/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";
			const table = hostUnder({ comm: binary, argv: [binary, "--no-daemon"] }, [{ comm: "/opt/homebrew/bin/node", argv: ["/opt/homebrew/bin/node", "/opt/homebrew/bin/codex", "--no-daemon"] }]);
			expect(toolSession({}, { ...darwin(table, 60), own: "codex" })).toBeUndefined();
			expect(toolSession({}, darwin(table, 60))).toEqual({ tool: "codex", via: "ancestry", pid: 59 });
		});
	});
});

describe("processEnv: a host's start environment, which toolSession asks in a cut walk", () => {
	it("macOS: ps's environment after the arguments; one that shows none (neither PATH nor HOME) can't be read, so the marker counts", () => {
		const mac = (out: string | undefined) => ({ platform: "darwin" as const, ps: () => out });
		expect(processEnv(4242, ["CLAUDECODE"], mac("/usr/local/bin/claude --resume PATH=/usr/bin:/bin HOME=/Users/u CLAUDECODE=1\n"))).toEqual({ CLAUDECODE: "1" });
		expect(processEnv(4242, ["CLAUDECODE"], mac("/usr/local/bin/claude --resume HOME=/Users/u\n"))).toEqual({});
		// ps exited 0 but withheld the environment: unreadable, never "started without it".
		expect(processEnv(4242, ["CLAUDECODE"], mac("/usr/local/bin/claude --resume\n"))).toBeUndefined();
		expect(processEnv(4242, ["CLAUDECODE"], mac(undefined))).toBeUndefined();
		const asked: string[][] = [];
		processEnv(4242, ["CLAUDECODE"], { platform: "darwin", ps: (args) => (asked.push([...args]), undefined) });
		expect(asked).toEqual([["-wwE", "-o", "command=", "-p", "4242"]]);
		// In toolSession: a cut walk, and an environment ps withholds: the marker counts.
		const table: Table = { 20: { ppid: 15, comm: "/bin/zsh" }, 60: { ppid: 20, comm: "/usr/local/bin/claude" } };
		const deps = { ...darwin(table, 60), startEnv: (pid: number, names: readonly string[]) => processEnv(pid, names, mac("/usr/local/bin/claude\n")), own: "claude" };
		expect(toolSession({ CLAUDECODE: "1" }, deps)).toEqual({ tool: "claude", via: "marker", variable: "CLAUDECODE" });
	});

	it("Linux: /proc/<pid>/environ; one that can't be read is undefined", () => {
		const linuxEnv = (text: string | undefined) => ({
			platform: "linux" as const,
			read: () => {
				if (text === undefined) throw new Error("EACCES");
				return text;
			},
		});
		expect(processEnv(4242, ["PI_CODING_AGENT"], linuxEnv("PATH=/usr/bin\0PI_CODING_AGENT=true\0"))).toEqual({ PI_CODING_AGENT: "true" });
		expect(processEnv(4242, ["PI_CODING_AGENT"], linuxEnv("PATH=/usr/bin\0"))).toEqual({});
		expect(processEnv(4242, ["PI_CODING_AGENT"], linuxEnv(undefined))).toBeUndefined();
	});
});

describe("no tool", () => {
	it("no tool and no marker is undefined", () => {
		expect(toolSession({ HOME: "/home/u", TERM: "foot" }, linux(terminal(), 60))).toBeUndefined();
	});

	it("a system with no way to read processes: markers only", () => {
		expect(toolSession({}, { platform: "win32" })).toBeUndefined();
		expect(toolSession({ OPENCODE: "1" }, { platform: "win32" })).toEqual({ tool: "opencode", via: "marker", variable: "OPENCODE" });
	});
});

describe("the tool lists", () => {
	it("are the planned program names, each with a name to show", () => {
		expect([...CODING_TOOLS].sort()).toEqual(["aider", "amp", "claude", "codex", "copilot", "crush", "cursor-agent", "droid", "gemini", "goose", "omp", "opencode", "pi", "qwen"]);
		for (const tool of [...CODING_TOOLS, ...TOOL_MARKERS.map((marker) => marker.tool)]) expect(TOOL_SESSION_NAMES[tool], tool).toMatch(/\S/);
		expect(TOOL_SESSION_NAMES).toMatchObject({ claude: "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "pi", omp: "OMP", gemini: "Gemini", "cursor-agent": "Cursor Agent", copilot: "Copilot" });
	});
});

describe("recordedCodexIds", () => {
	/** 30 a Codex session, 31 pi, 32 another Codex session, 77 gone by the time it's asked. */
	const table = (): Table => ({ 1: { ppid: 0, comm: "systemd" }, 30: { ppid: 1, comm: "codex", start: "300" }, 31: { ppid: 1, comm: "pi", start: "310" }, 32: { ppid: 1, comm: "codex", start: "320" }, 77: { ppid: 1, comm: "codex", start: "770" } });

	it("the Codex sessions of live records, in the folders given and the folders above them that hold records", () => {
		const outer = temp();
		const inner = join(outer, "scratch", "data");
		mkdirSync(inner, { recursive: true });
		const rows = table();
		const deps = linux(rows);
		expect(recordSession(inner, { agent: "Atlas", tool: "codex", pid: 30, codexSession: "019a-atlas" }, deps)).toBe(true);
		expect(recordSession(inner, { agent: "Birch", tool: "pi", pid: 31 }, deps)).toBe(true);
		expect(recordSession(outer, { agent: "Cedar", tool: "codex", pid: 32, codexSession: "019c-cedar" }, deps)).toBe(true);
		expect(recordSession(inner, { agent: "Dune", tool: "codex", pid: 77, codexSession: "019d-dune" }, deps)).toBe(true);
		const gone = linux({ ...rows, 77: undefined as unknown as Row });
		expect([...recordedCodexIds([inner], gone)].sort()).toEqual(["019a-atlas", "019c-cedar"]);
		// The stale record is taken down, as insideSession's look would.
		expect(existsSync(join(inner, "session-hosts", "77.json"))).toBe(false);
	});

	it("an unsure record's Codex session counts (one read from another pid namespace)", () => {
		const dir = temp();
		const rows = table();
		expect(recordSession(dir, { agent: "Atlas", tool: "codex", pid: 30, codexSession: "019a-atlas" }, linux(rows))).toBe(true);
		const elsewhere: SessionDeps = { ...linux(rows), ns: (pid) => (pid === "self" ? "pid:[4026533000]" : NS), alive: () => false };
		expect([...recordedCodexIds([dir], elsewhere)]).toEqual(["019a-atlas"]);
	});

	it("none when no folder holds records", () => {
		const dir = temp();
		writeFileSync(join(dir, "note"), "");
		expect(recordedCodexIds([dir, join(dir, "missing")], linux(table())).size).toBe(0);
	});
});

const real = process.platform === "linux" || process.platform === "darwin";

describe("toolSession on this system", () => {
	it.skipIf(!real)("finds a real script named gemini, run by this runtime, above the process it started", async () => {
		const dir = temp();
		const script = join(dir, "gemini.mjs");
		writeFileSync(script, 'import { spawn } from "node:child_process";\nconst child = spawn("sleep", ["30"], { stdio: "ignore" });\nprocess.stdout.write(`${child.pid}\\n`);\n');
		const gemini = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
		children.push(gemini);
		const sleeper = await new Promise<number>((resolve, reject) => {
			let out = "";
			gemini.stdout?.on("data", (chunk: Buffer) => {
				out += chunk.toString();
				if (out.includes("\n")) resolve(Number(out.trim()));
			});
			gemini.on("exit", () => reject(new Error(`exited: ${out}`)));
		});
		try {
			expect(toolSession({}, { from: sleeper })).toEqual({ tool: "gemini", via: "ancestry", pid: gemini.pid });
		} finally {
			process.kill(sleeper, "SIGKILL");
		}
	});
});
