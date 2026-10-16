import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { readHolder } from "../../src/agent/handover.ts";
import { newToken } from "../../src/agent/pick.ts";
import { holderLog, sessionDir } from "../../src/claude/paths.ts";
import { readMode } from "../../src/claude/spool.ts";
import { cleanEnv, cleanupDirs, cliCommand, messages, seed, testAgent, waitUntil } from "../claude/support.ts";

afterEach(cleanupDirs);

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
	it("records a session: the hooks start a holder for this Codex, which takes the turn into memory and leaves at the end", async () => {
		const t = testAgent();
		const env = { ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: newToken() };
		const start = hook("session-start", { session_id: "c1", source: "startup", hook_event_name: "SessionStart" }, env);
		expect([start.status, start.stderr]).toEqual([0, ""]);
		const answer = JSON.parse(start.stdout) as { systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } };
		// The status, then (this test's summary model is unknown here) the summaries' trouble, with Orrery's command for it,
		// once the holder has said so.
		const [status, ...rest] = answer.systemMessage.split("\n");
		expect(status).toMatch(/^Orrery · Test · (no memory yet|0 msgs) · recording$/);
		for (const line of rest) expect(line).toMatch(/^Orrery: Test's summaries stopped: .*\. Switch with orrery compactor Test\.$/);
		expect(answer.hookSpecificOutput.hookEventName).toBe("SessionStart");
		// The holder records for this Codex (the hook's parent), and says so.
		await waitUntil(() => readHolder(t.agent.dir)?.session === "c1");
		expect(readHolder(t.agent.dir)).toMatchObject({ session: "c1", claudePid: process.pid, host: "codex", state: "recording" });
		for (const [event, input] of [
			["user-prompt-submit", { prompt: "Codename Saffron." }],
			["stop", { last_assistant_message: "Noted: Saffron." }],
		] as const) {
			const r = hook(event, { session_id: "c1", ...input }, env);
			expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		}
		await waitUntil(() => messages(t.agent).length === 2, 15_000);
		expect(messages(t.agent)).toEqual(["user: Codename Saffron.", "talk: Noted: Saffron."]);
		const end = hook("session-end", { session_id: "c1", reason: "other" }, env);
		expect([end.status, end.stdout, end.stderr]).toEqual([0, "", ""]);
		await waitUntil(() => readHolder(t.agent.dir) === undefined && !existsSync(sessionDir(t.agent.dir, "c1")), 20_000);
		const log = readFileSync(holderLog(t.agent.dir), "utf8");
		expect(log).toContain("c1: recording");
		expect(log).toContain("c1: stopped: session over");
		expect(log).not.toContain("Saffron");
	}, 60_000);

	it("finds Codex above a shell that did not exec the hook: the memory server Codex starts serves the same agent", async () => {
		const t = testAgent();
		seed(t.agent, ["a", "b"]);
		const env = { ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: newToken() };
		// SessionStart under a shell claims the token for the shell's parent, this test.
		const start = hook("session-start", { session_id: "c2", source: "startup" }, env, true);
		expect(JSON.parse(start.stdout).systemMessage).toMatch(/^Orrery · Test · 2 msgs · recording\n/);
		expect(readMode(t.agent.dir, "c2")?.claudePid).toBe(process.pid);
		expect(await codexTools(env)).toEqual(["zoom", "date", "search"]);
		// Another process with the same variables (a Codex the agent's own shell started) is not the agent.
		expect(await codexTools(env, { otherCodex: true })).toEqual([]);
		hook("session-end", { session_id: "c2", reason: "other" }, env);
		await waitUntil(() => readHolder(t.agent.dir) === undefined, 20_000);
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
