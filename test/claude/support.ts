/** Shared pieces of the Claude Code adapter's tests. Everything lives in temp folders, never ~/.orrery. */

import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv } from "../../src/claude/git.ts";
import { type SpoolEvent, spoolEvent } from "../../src/claude/spool.ts";
import { VIEW_IMPORT, writeSetupMarker } from "../../src/claude/view-file.ts";
import { type HarnessConfig, type LaneConfig, parseConfig } from "../../src/lane/config.ts";
import { type Kind, MemoryStore } from "../../src/memory/index.ts";
import { laneConfigToml, tempDir } from "../lane/support.ts";

/** The CLI entry point, run by process tests as `node MAIN …`. */
export const MAIN = new URL("../../src/cli/main.ts", import.meta.url).pathname;

/** The CLI under test: ORRERY_TEST_BIN (a built binary) when set, else `node MAIN`. */
export function cliCommand(args: readonly string[]): { cmd: string; args: string[] } {
	const bin = process.env.ORRERY_TEST_BIN;
	return bin ? { cmd: bin, args: [...args] } : { cmd: process.execPath, args: ["--disable-warning=ExperimentalWarning", MAIN, ...args] };
}

const dirs: string[] = [];

/** Removes every folder testLane made (afterEach). */
export function cleanupDirs(): void {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A temp lane: its folder, workspace, config file and parsed config. */
export interface TestLane {
	readonly dir: string;
	readonly workspace: string;
	readonly configPath: string;
	readonly config: HarnessConfig;
	readonly lane: LaneConfig;
}

/**
 * Lane "Test": workspace, data folder and config file in one temp folder. Its summary model (faux-compactor) is
 * unknown to orrery's real registry, so a holder process runs with summaries off. `setup` does what claude-setup does:
 * a CLAUDE.md that imports the view, and the marker in the lane's data folder.
 */
export function testLane(options: { setup?: boolean } = {}): TestLane {
	const dir = tempDir("orrery-claude-");
	dirs.push(dir);
	const workspace = join(dir, "ws");
	mkdirSync(workspace);
	const configPath = join(dir, "config.toml");
	writeFileSync(configPath, laneConfigToml({ dataDir: join(dir, "data"), workspace }));
	const config = parseConfig(readFileSync(configPath, "utf8"), dir);
	const lane = config.lanes.get("Test") as LaneConfig;
	if (options.setup === true) {
		writeFileSync(join(workspace, "CLAUDE.md"), `${VIEW_IMPORT}\n`);
		writeSetupMarker(lane.dir, workspace, "CLAUDE.md");
	}
	return { dir, workspace, configPath, config, lane };
}

/** Puts messages (user, talk, user, …) into a lane's memory, as an earlier session would have. */
export function seed(lane: LaneConfig, texts: readonly string[]): void {
	const store = MemoryStore.open(join(lane.dir, "memory.sqlite"));
	try {
		store.appendBatch(texts.map((text, i) => ({ kind: (i % 2 === 0 ? "user" : "talk") as Kind, text, date: `2026-10-07T10:0${i}:00.000Z` })));
	} finally {
		store.close();
	}
}

/** The lane's memory as "kind: text" lines, read-only. */
export function messages(lane: LaneConfig): string[] {
	const store = MemoryStore.openReadOnly(join(lane.dir, "memory.sqlite"));
	try {
		return store.root.map((m) => `${m.kind}: ${m.text}`);
	} finally {
		store.close();
	}
}

type Spooled = { kind: "prompt" | "reply"; text: string } | { kind: "command" } | { kind: "end"; reason?: string } | { kind: "compactor"; args: string };
let clock = 0;

/**
 * Spools an event as a hook would, a millisecond after the previous one so events sort as spooled. An explicit `at`
 * (an event from the past or the future) leaves that clock alone.
 */
export function spool(lane: LaneConfig, session: string, event: Spooled, claudePid: number, at?: number): string {
	if (at === undefined) clock = Math.max(clock + 1, Date.now());
	return spoolEvent(lane.dir, session, { ...event, at: at ?? clock, claudePid } as SpoolEvent);
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

/** The test process may run inside Claude Code: children get no CLAUDE_* or ORRERY_* variables but these. */
export function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const kept = Object.entries(process.env).filter(([key]) => !key.startsWith("CLAUDE") && !key.startsWith("ORRERY_"));
	return { ...Object.fromEntries(kept), ...extra };
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
export function brokenGit(t: TestLane, only?: string): string {
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
