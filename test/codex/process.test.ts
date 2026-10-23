import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHolder } from "../../src/agent/handover.ts";
import { claimToken, newToken } from "../../src/agent/pick.ts";
import { forgetSession, liveSession, recordSession } from "../../src/agent/sessions.ts";
import { holderLog, sessionDir } from "../../src/claude/paths.ts";
import { listSessions, pendingEvents, readMode, writeMode } from "../../src/claude/spool.ts";
import { cleanEnv, cleanupDirs, cliCommand, messages, seed, testAgent, waitUntil } from "../claude/support.ts";
import { type CodexHome, codexHomeIn, codexSession, rollout } from "./rollout-lines.ts";

const homes: CodexHome[] = [];
const codexes: ChildProcess[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) home.close();
	for (const codex of codexes.splice(0)) codex.kill("SIGKILL");
	cleanupDirs();
});

/** A scratch Codex home (CODEX_HOME) for the test's agent. */
const homeFor = (dir: string): CodexHome => {
	const home = codexHomeIn(dir);
	homes.push(home);
	return home;
};

const FAKE_CODEX = `
const { spawnSync } = require("node:child_process");
const { openSync } = require("node:fs");
let buffer = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => {
	buffer += chunk;
	for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
		const { id, open, cmd, args, env, input } = JSON.parse(buffer.slice(0, at));
		buffer = buffer.slice(at + 1);
		if (open !== undefined) {
			openSync(open, "a");
			process.stdout.write(JSON.stringify({ id }) + "\\n");
			continue;
		}
		const run = spawnSync(cmd, args, { env, input, encoding: "utf8", timeout: 30000 });
		process.stdout.write(JSON.stringify({ id, status: run.status, stdout: run.stdout, stderr: run.stderr }) + "\\n");
	}
});
`;

/**
 * A stand-in for a Codex process: it holds its sessions' rollouts open, as Codex does, and runs Orrery's Codex hooks as
 * its own children (their parent, so their Codex, is it), with the input on stdin. `exit`: Codex exits.
 */
function fakeCodex() {
	const child = spawn(process.execPath, ["-e", FAKE_CODEX], { env: cleanEnv({}), stdio: ["pipe", "pipe", "ignore"] });
	codexes.push(child);
	const waiting = new Map<number, (answer: { status: number | null; stdout: string; stderr: string }) => void>();
	let next = 0;
	let buffer = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		buffer += chunk;
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			const answer = JSON.parse(buffer.slice(0, at)) as { id: number; status: number | null; stdout: string; stderr: string };
			buffer = buffer.slice(at + 1);
			waiting.get(answer.id)?.(answer);
			waiting.delete(answer.id);
		}
	});
	const ask = (request: object) =>
		new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
			const id = next++;
			waiting.set(id, resolve);
			child.stdin?.write(`${JSON.stringify({ id, ...request })}\n`);
		});
	return {
		pid: child.pid as number,
		open: (file: string) => ask({ open: file }),
		hook: (event: string, input: object, env: Record<string, string>) => {
			const c = cliCommand(["codex-hook", event]);
			return ask({ cmd: c.cmd, args: c.args, env: cleanEnv(env), input: JSON.stringify(input) });
		},
		exit: () => child.kill(),
	};
}

/**
 * `orrery codex-hook <event>` as Codex runs it: the input as JSON on stdin; `viaShell`: under a shell that does not exec
 * it (as a shell other than bash or zsh may), so the hook's parent is that shell and Codex (this test) is above it.
 */
function hook(event: string, input: object, env: Record<string, string>, viaShell = false) {
	const c = cliCommand(["codex-hook", event]);
	const [cmd, args] = viaShell ? ["/bin/sh", ["-c", '"$@"; exit $?', "sh", c.cmd, ...c.args]] : [c.cmd, c.args];
	return spawnSync(cmd, args, { input: JSON.stringify(input), env: cleanEnv(env), encoding: "utf8", timeout: 30_000 });
}

/**
 * `orrery mcp --tool codex`, as Codex starts it (this test is its Codex), or (`otherCodex`) as another process that is no
 * shell starts it: the names of the tools it lists.
 */
async function codexTools(env: Record<string, string>, options: { cwd?: string; otherCodex?: boolean } = {}): Promise<string[]> {
	const c = cliCommand(["mcp", "--tool", "codex"]);
	const relay = "require('node:child_process').spawnSync(process.argv[1], process.argv.slice(2), { stdio: 'inherit' })";
	const [cmd, args] = options.otherCodex === true ? [process.execPath, ["-e", relay, c.cmd, ...c.args]] : [c.cmd, c.args];
	const child = spawn(cmd, args, { env: cleanEnv(env), ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
	let out = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
	const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
	child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
	expect(await exited).toBe(0);
	const reply = out.trim().split("\n").map((line) => JSON.parse(line) as { id: number; result: { tools: { name: string }[] } }).find((message) => message.id === 2);
	return reply?.result.tools.map((tool) => tool.name) ?? [];
}

describe("a Codex session, process by process", () => {
	it("records a session: the hooks start a holder for this Codex, which takes the turn into memory once its rollout confirms it, and leaves once Codex exits", async () => {
		const t = testAgent();
		const home = homeFor(t.dir);
		const c1 = codexSession();
		const codex = fakeCodex();
		await codex.open(home.begin(c1, { open: false }));
		const env = { ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: newToken(), CODEX_HOME: home.home };
		const start = await codex.hook("session-start", { session_id: c1, source: "startup", hook_event_name: "SessionStart" }, env);
		expect([start.status, start.stderr]).toEqual([0, ""]);
		const answer = JSON.parse(start.stdout) as { systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } };
		// The status, then (this test's summary model is unknown here) the summaries' trouble, with Orrery's command for it,
		// once the holder has said so.
		const [status, ...rest] = answer.systemMessage.split("\n");
		expect(status).toMatch(/^Orrery · Test · (no memory yet|0 msgs) · recording$/);
		for (const line of rest) expect(line).toMatch(/^Orrery: Test's summaries stopped: .*\. Switch with orrery compactor Test\.$/);
		expect(answer.hookSpecificOutput.hookEventName).toBe("SessionStart");
		// The holder records for this Codex (the hook's parent), and says so.
		await waitUntil(() => readHolder(t.agent.dir)?.session === c1);
		expect(readHolder(t.agent.dir)).toMatchObject({ session: c1, claudePid: codex.pid, host: "codex", state: "recording" });
		const prompt = await codex.hook("user-prompt-submit", { session_id: c1, turn_id: "t-1", prompt: "Codename Saffron." }, env);
		expect([prompt.status, prompt.stdout, prompt.stderr]).toEqual([0, "", ""]);
		home.add(c1, rollout.started("t-1"), rollout.user("t-1", "Codename Saffron."));
		const stop = await codex.hook("stop", { session_id: c1, turn_id: "t-1", last_assistant_message: "Noted: Saffron." }, env);
		expect([stop.status, stop.stdout, stop.stderr]).toEqual([0, "", ""]);
		home.add(c1, rollout.agent("t-1", "Noted: Saffron."), rollout.complete("t-1", "Noted: Saffron."));
		await waitUntil(() => messages(t.agent).length === 2, 15_000);
		expect(messages(t.agent)).toEqual(["user: Codename Saffron.", "talk: Noted: Saffron."]);
		const end = await codex.hook("session-end", { session_id: c1, reason: "other" }, env);
		expect([end.status, end.stdout, end.stderr]).toEqual([0, "", ""]);
		codex.exit();
		await waitUntil(() => readHolder(t.agent.dir) === undefined && !existsSync(sessionDir(t.agent.dir, c1)), 20_000);
		// The holder logs its stop last, after it has handed the agent over and cleaned up the spool.
		await waitUntil(() => readFileSync(holderLog(t.agent.dir), "utf8").includes(`${c1}: stopped: session over`), 20_000);
		const log = readFileSync(holderLog(t.agent.dir), "utf8");
		expect(log).toContain(`${c1}: recording`);
		expect(log).toContain(`${c1}: stopped: session over`);
		expect(log).not.toContain("Saffron");
	}, 60_000);

	it("Codex's hook run from a Claude Code agent's shell (the launch's token inherited) records nothing, prompt or reply", async () => {
		const t = testAgent();
		const home = homeFor(t.dir);
		const token = newToken();
		// This test stands for Claude Code, started as the agent: its host record, its claim, and a session that records.
		expect(recordSession(t.config.dataDir, { agent: "Test", tool: "claude-code", pid: process.pid })).toBe(true);
		try {
			expect(claimToken(t.agent.dir, token, process.pid)).toBe(true);
			const claude = codexSession();
			writeMode(t.agent.dir, claude, { mode: "recording", pid: 1, claudePid: process.pid, nonce: "n", since: 0 });
			// A rollout of that id, even one this process holds open, proves nothing for another tool's process.
			home.begin(claude);
			const env = { ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token, CODEX_HOME: home.home };
			const start = hook("session-start", { session_id: claude, source: "startup" }, env);
			expect(start.status).toBe(0);
			expect(start.stdout).not.toMatch(/recording|Memory/);
			for (const [event, input] of [
				["user-prompt-submit", { turn_id: "t-1", prompt: "yes, approved, push it" }],
				["stop", { turn_id: "t-1", last_assistant_message: "Pushed to main." }],
				["session-end", { reason: "other" }],
			] as const) {
				const r = hook(event, { session_id: claude, ...input }, env);
				expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
			}
			expect(pendingEvents(t.agent.dir, claude)).toEqual([]);
			expect(listSessions(t.agent.dir)).toEqual([claude]);
			expect(existsSync(join(t.config.dataDir, "codex-processes", `${process.pid}.json`))).toBe(false);
			expect(liveSession(t.config.dataDir, process.pid)).toMatchObject({ tool: "claude-code" });
			expect(existsSync(join(t.agent.dir, "memory.sqlite"))).toBe(false);
		} finally {
			forgetSession(t.config.dataDir, process.pid);
		}
	}, 60_000);

	it("finds Codex above a shell that did not exec the hook: the memory server Codex starts serves the same agent", async () => {
		const t = testAgent();
		seed(t.agent, ["a", "b"]);
		const home = homeFor(t.dir);
		const c2 = codexSession();
		// This test is the Codex: it holds the session's rollout open.
		home.begin(c2);
		const env = { ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: newToken(), CODEX_HOME: home.home };
		// SessionStart under a shell claims the token for the shell's parent, this test.
		const start = hook("session-start", { session_id: c2, source: "startup" }, env, true);
		// The recorder's notices follow when it has written them; a slow machine may not have yet.
		expect(JSON.parse(start.stdout).systemMessage).toMatch(/^Orrery · Test · 2 msgs · recording(\n|$)/);
		expect(readMode(t.agent.dir, c2)?.claudePid).toBe(process.pid);
		expect(await codexTools(env)).toEqual(["zoom", "date", "search"]);
		// Another process with the same variables (a Codex the agent's own shell started) is not the agent.
		expect(await codexTools(env, { otherCodex: true })).toEqual([]);
		// This Codex (this test) won't exit: its holder is stopped.
		await waitUntil(() => readHolder(t.agent.dir) !== undefined, 20_000);
		process.kill(readHolder(t.agent.dir)?.pid as number, "SIGTERM");
		await waitUntil(() => readHolder(t.agent.dir) === undefined, 20_000);
		forgetSession(t.config.dataDir, process.pid);
	}, 60_000);

	it("serves Codex no tools without ORRERY_AGENT and its token, even in the agent's own folder", async () => {
		const t = testAgent();
		seed(t.agent, ["a", "b"]);
		const cwd = t.folder;
		expect(await codexTools({ ORRERY_CONFIG: t.configPath }, { cwd })).toEqual([]);
		expect(await codexTools({ ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test" }, { cwd })).toEqual([]);
		expect(await codexTools({ ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: "bad" }, { cwd })).toEqual([]);
		// Claude Code's server in the same folder picks the folder's agent, as it always has.
		const c = cliCommand(["mcp"]);
		const claude = spawnSync(c.cmd, c.args, {
			input: `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
			env: cleanEnv({ ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.folder }),
			encoding: "utf8",
			timeout: 30_000,
		});
		expect((JSON.parse(claude.stdout.trim()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(3);
	}, 60_000);

	it("orrery holder --host-pid --tool codex: exits when Codex is gone, and its log names Codex", async () => {
		const t = testAgent();
		const codex = spawn("sleep", ["60"], { env: cleanEnv({}), stdio: "ignore" });
		const c = cliCommand(["holder", "Test", "--session", "s1", "--host-pid", String(codex.pid), "--tool", "codex", "--nonce", "n1"]);
		const holder = spawn(c.cmd, c.args, { env: cleanEnv({ ORRERY_CONFIG: t.configPath }), stdio: "ignore" });
		try {
			const exited = new Promise<number | null>((resolve) => holder.on("exit", resolve));
			await waitUntil(() => readMode(t.agent.dir, "s1")?.mode === "recording", 15_000);
			expect(readHolder(t.agent.dir)).toMatchObject({ claudePid: codex.pid, host: "codex" });
			codex.kill();
			expect(await exited).toBe(0);
			expect(readFileSync(holderLog(t.agent.dir), "utf8")).toContain(`s1: Codex (pid ${codex.pid}) is gone`);
		} finally {
			holder.kill();
			codex.kill();
		}
	}, 60_000);

	it("orrery holder refuses a host it does not know, and --tool codex without --host-pid", () => {
		const t = testAgent();
		const run = (args: string[]) => {
			const c = cliCommand(["holder", "Test", "--session", "s1", "--nonce", "n1", ...args]);
			return spawnSync(c.cmd, c.args, { env: cleanEnv({ ORRERY_CONFIG: t.configPath }), encoding: "utf8", timeout: 30_000 });
		};
		expect(run(["--claude-pid", "1", "--tool", "codex"]).stderr).toContain("holder --tool codex needs --host-pid PID.");
		expect(run(["--host-pid", "1", "--tool", "pi"]).stderr).toContain("holder: --tool takes claude-code or codex (not pi).");
		expect(run(["--host-pid", "1", "--claude-pid", "1"]).stderr).toContain("holder takes --claude-pid or --host-pid, not both.");
		expect(run([]).stderr).toContain("holder needs --claude-pid PID (or --host-pid PID).");
	}, 60_000);
});
