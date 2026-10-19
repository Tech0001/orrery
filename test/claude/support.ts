/** Shared pieces of the Claude Code adapter's tests. Everything lives in temp folders, never ~/.orrery. */

import { execFileSync, type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";
import { gitEnv } from "../../src/claude/git.ts";
import { type SpoolEvent, spoolEvent } from "../../src/claude/spool.ts";
import { VIEW_IMPORT, writeSetupMarker } from "../../src/claude/view-file.ts";
import { type HarnessConfig, type AgentConfig, parseConfig } from "../../src/agent/config.ts";
import { type Kind, MemoryStore } from "../../src/memory/index.ts";
import { agentConfigToml, tempDir } from "../agent/support.ts";

/** The CLI entry point, run by process tests as `node MAIN …`. */
export const MAIN = new URL("../../src/cli/main.ts", import.meta.url).pathname;

/** The CLI under test: ORRERY_TEST_BIN (a built binary) when set, else `node MAIN`. */
export function cliCommand(args: readonly string[]): { cmd: string; args: string[] } {
	const bin = process.env.ORRERY_TEST_BIN;
	return bin ? { cmd: bin, args: [...args] } : { cmd: process.execPath, args: ["--disable-warning=ExperimentalWarning", MAIN, ...args] };
}

const dirs: string[] = [];

/** Removes every folder testAgent made (afterEach). */
export function cleanupDirs(): void {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A temp agent: its folder, folder, config file and parsed config. */
export interface TestAgent {
	readonly dir: string;
	readonly folder: string;
	readonly configPath: string;
	readonly config: HarnessConfig;
	/** Its folder is always set. */
	readonly agent: AgentConfig & { readonly folder: string };
}

/**
 * Agent "Test": folder, data folder and config file in one temp folder, the config in the data folder as ~/.orrery
 * keeps it (from inside an agent's session the CLI takes only the config that holds the session's memory:
 * src/cli/gate.ts). Its summary model (faux-compactor) is unknown to orrery's real registry, so a holder process runs
 * with summaries off. `setup` does what claude-setup does: a CLAUDE.md that imports the view, and the marker in the
 * agent's data folder.
 */
export function testAgent(options: { setup?: boolean } = {}): TestAgent {
	const dir = tempDir("orrery-claude-");
	dirs.push(dir);
	const folder = join(dir, "ws");
	mkdirSync(folder);
	mkdirSync(join(dir, "data"));
	const configPath = join(dir, "data", "config.toml");
	writeFileSync(configPath, agentConfigToml({ dataDir: join(dir, "data"), folder }));
	const config = parseConfig(readFileSync(configPath, "utf8"), dir);
	const agent = config.agents.get("Test") as AgentConfig & { readonly folder: string };
	if (options.setup === true) {
		writeFileSync(join(folder, "CLAUDE.md"), `${VIEW_IMPORT}\n`);
		writeSetupMarker(agent.dir, folder, "CLAUDE.md");
	}
	return { dir, folder, configPath, config, agent };
}

/** Puts messages (user, talk, user, …) into an agent's memory, as an earlier session would have. */
export function seed(agent: AgentConfig, texts: readonly string[]): void {
	const store = MemoryStore.open(join(agent.dir, "memory.sqlite"));
	try {
		store.appendBatch(texts.map((text, i) => ({ kind: (i % 2 === 0 ? "user" : "talk") as Kind, text, date: `2026-10-07T10:0${i}:00.000Z` })));
	} finally {
		store.close();
	}
}

/**
 * A status.json as a running `tool` (pi, OMP, or a recorder's MemoryAgent) writes it: this process's pid, written now,
 * unless `extra` says otherwise.
 */
export function statusOf(tool: string, extra: object = {}): object {
	return {
		agent: "Test", pid: process.pid, open: true, busy: false, model: tool, thinking: tool, memory: {},
		compactor: { stopped: false, failing: 0, model: "faux/faux-compactor", thinking: "low", source: "config" },
		trouble: null, lastError: null, updatedAt: new Date().toISOString(), ...extra,
	};
}

/** The agent's memory as "kind: text" lines, read-only. */
export function messages(agent: AgentConfig): string[] {
	const store = MemoryStore.openReadOnly(join(agent.dir, "memory.sqlite"));
	try {
		return store.root.map((m) => `${m.kind}: ${m.text}`);
	} finally {
		store.close();
	}
}

type Spooled =
	| { kind: "prompt"; text: string; promptId?: string }
	| { kind: "reply"; text: string }
	| { kind: "command" }
	| { kind: "end"; reason?: string }
	| { kind: "compactor"; args: string }
	| { kind: "transcript"; path: string; projects: string; offset: number };
let clock = 0;

/**
 * Spools an event as a hook would, a millisecond after the previous one so events sort as spooled. An explicit `at`
 * (an event from the past or the future) leaves that clock alone.
 */
export function spool(agent: AgentConfig, session: string, event: Spooled, claudePid: number, at?: number): string {
	if (at === undefined) clock = Math.max(clock + 1, Date.now());
	return spoolEvent(agent.dir, session, { ...event, at: at ?? clock, claudePid } as SpoolEvent);
}

/** Polls `check` (a throw counts as "not yet") until it holds, or fails after `ms`. */
export async function waitUntil(check: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	for (;;) {
		try {
			if (check()) return;
		} catch {
			// not yet
		}
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

let childHome: string | undefined;

/**
 * The HOME of the processes tests start, unless a test names its own: a scratch folder (one per test file, removed after
 * its tests), never the user's, so a child that reads or writes under ~ (a default config, a tool's files) touches nothing real.
 */
function scratchHome(): string {
	if (childHome === undefined || !existsSync(childHome)) childHome = tempDir("orrery-child-home-");
	return childHome;
}

// Imported at the top of a test file, this hook is that file's.
afterAll(() => {
	if (childHome !== undefined) rmSync(childHome, { recursive: true, force: true });
	childHome = undefined;
});

/**
 * The test process may run inside Claude Code: children get no CLAUDE_* or ORRERY_* variables but these, and a scratch
 * HOME unless these name one.
 */
export function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const kept = Object.entries(process.env).filter(([key]) => !key.startsWith("CLAUDE") && !key.startsWith("ORRERY_"));
	// A holder's daily update check asks a closed local port, never github.com.
	return { ...Object.fromEntries(kept), HOME: scratchHome(), ORRERY_RELEASES_URL: "http://127.0.0.1:9/releases", ...extra };
}

/** Runs `orrery claude-hook <event>` as Claude Code does: the input as JSON on stdin, only the given environment. */
export function hookCli(event: string, input: object, env: Record<string, string>): SpawnSyncReturns<string> {
	const c = cliCommand(["claude-hook", event]);
	return spawnSync(c.cmd, c.args, {
		input: JSON.stringify(input),
		env: cleanEnv(env),
		encoding: "utf8",
		timeout: 20_000,
	});
}

/** A stand-in for a Claude Code process, alive until killed, that runs hooks as its own children. */
export interface FakeClaude {
	readonly pid: number;
	/**
	 * `orrery claude-hook <event>` as Claude Code runs it: its child, with CLAUDE_PID its pid (unless `env` names one), the
	 * input on stdin (a socket pair whose peer is this stand-in, as Claude Code's is).
	 */
	hook(event: string, input: object, env: Record<string, string>): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>;
	kill(): void;
}

const FAKE_CLAUDE = `
const { spawnSync } = require("node:child_process");
let buffer = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => {
	buffer += chunk;
	for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
		const { id, cmd, args, env, input } = JSON.parse(buffer.slice(0, at));
		buffer = buffer.slice(at + 1);
		const run = spawnSync(cmd, args, { env, input, encoding: "utf8", timeout: 20000 });
		process.stdout.write(JSON.stringify({ id, status: run.status, stdout: run.stdout, stderr: run.stderr }) + "\\n");
	}
});
`;

/**
 * A stand-in for a Claude Code process: hooks are its children, as Claude Code's are, so their parent and their
 * CLAUDE_PID are its pid (src/claude/pick.ts claudeHookPid checks that). Kill it when done.
 */
export function fakeClaude(): FakeClaude {
	const child = spawn(process.execPath, ["-e", FAKE_CLAUDE], { env: cleanEnv({}), stdio: ["pipe", "pipe", "ignore"] });
	const pid = child.pid as number;
	const waiting = new Map<number, (answer: { status: number | null; stdout: string; stderr: string }) => void>();
	let next = 0;
	let buffer = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		buffer += chunk;
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			const answer = JSON.parse(buffer.slice(0, at)) as { id: number; status: number | null; stdout: string; stderr: string };
			buffer = buffer.slice(at + 1);
			waiting.get(answer.id)?.(answer);
			waiting.delete(answer.id);
		}
	});
	return {
		pid,
		hook: (event, input, env) =>
			new Promise((resolve) => {
				const id = next++;
				waiting.set(id, resolve);
				const c = cliCommand(["claude-hook", event]);
				// CLAUDE_PID is its own pid unless `env` names another (the shell of another Claude Code, forging a hook call).
				child.stdin.write(`${JSON.stringify({ id, cmd: c.cmd, args: c.args, env: cleanEnv({ CLAUDE_PID: String(pid), ...env }), input: JSON.stringify(input) })}\n`);
			}),
		kill: () => child.kill(),
	};
}

/**
 * Runs `run` in-process with `vars` set in process.env (the code under test reads git's variables and PATH from it),
 * and puts them back after, once a returned promise settles.
 */
export function withEnv<T>(vars: Record<string, string>, run: () => T): T {
	const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
	Object.assign(process.env, vars);
	const restore = () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	try {
		const result = run();
		if (result instanceof Promise) return result.finally(restore) as T;
		restore();
		return result;
	} catch (error) {
		restore();
		throw error;
	}
}

/** Runs `run` with `bin` first on PATH, so the code under test runs that folder's git. */
export function withGit<T>(bin: string, run: () => T): T {
	return withEnv({ PATH: `${bin}:${process.env.PATH ?? ""}` }, run);
}

/**
 * A folder holding a git that fails as no real check should be trusted to: exit 128, and not "not a git repository".
 * With `only`, it fails just that subcommand (say "check-ignore", as a timeout would) and runs the real git otherwise.
 */
export function brokenGit(t: TestAgent, only?: string): string {
	const bin = join(t.dir, `broken-git-${only ?? "all"}`);
	mkdirSync(bin, { recursive: true });
	const fail = "echo 'fatal: something else went wrong' >&2; exit 128";
	const real = (process.env.PATH ?? "").split(":").map((dir) => join(dir, "git")).find((path) => path !== join(bin, "git") && existsSync(path));
	const body = only === undefined ? fail : `for a in "$@"; do [ "$a" = ${only} ] && { ${fail}; }; done\nexec ${real} "$@"`;
	writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return bin;
}

/**
 * Runs git in `dir` (argv, never a shell string) with the test's clean environment, less git's local variables (an
 * inherited GIT_DIR would aim it at another repo); a failure throws.
 */
export function gitIn(dir: string): (...args: string[]) => string {
	return (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv(cleanEnv({})), stdio: ["ignore", "pipe", "pipe"] });
}
