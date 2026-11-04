import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../../src/agent/config.ts";
import { newToken } from "../../src/agent/pick.ts";
import { processArgv } from "../../src/agent/process.ts";
import { forgetSession, liveSession, recordSession } from "../../src/agent/sessions.ts";
import { listSessions, pendingEvents, readEvent } from "../../src/claude/spool.ts";
import { grokFolder } from "../../src/grok/log.ts";
import { grokLog } from "../grok/log-lines.ts";
import { cleanEnv, cleanupDirs, cliCommand, grokLeaderFolder, grokLeaderLaunch, messages, testAgent } from "../claude/support.ts";

afterEach(cleanupDirs);

/**
 * Runs `orrery grok-hook <event>` as Grok does: its input as JSON on stdin, started by a process (the "grok") that runs in
 * `cwd`, which the hook takes as the folder Grok runs in.
 */
function hook(event: string, input: object | string, env: Record<string, string>, cwd: string) {
	const c = cliCommand(["grok-hook", event]);
	const script = `const r = require("node:child_process").spawnSync(${JSON.stringify(c.cmd)}, ${JSON.stringify(c.args)}, { input: process.env.HOOK_INPUT, encoding: "utf8", env: { ...process.env, HOOK_INPUT: "" } }); process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));`;
	const r = spawnSync(process.execPath, ["-e", script], { cwd, env: cleanEnv({ ...env, HOOK_INPUT: typeof input === "string" ? input : JSON.stringify(input) }), encoding: "utf8", timeout: 30_000 });
	return JSON.parse(r.stdout) as { status: number; stdout: string; stderr: string };
}

const input = (extra: object = {}) => ({ hookEventName: "x", sessionId: "01a188c0-06ae-78a2-b15c-bec4228c7070", cwd: "/tmp/anywhere", ...extra });

describe("orrery grok-hook pre-tool-use, the guard", () => {
	const SENSITIVE_COMMAND = "Orrery guard: This command touches sensitive files (keys, credentials or Orrery's private data)";
	const call = (cwd: string, toolName: string, toolInput: object) => input({ cwd, toolName, toolInput, toolInputTruncated: false });

	it("lets a call through with exit 0 and nothing on stdout or stderr; refuses with exit 2 and the reason on stderr", () => {
		const t = testAgent();
		// A Grok opened as an agent but refused (no token): no agent's rules, which keep ~/.ssh.
		expect(hook("pre-tool-use", call(t.folder, "run_terminal_command", { command: "cat ~/.ssh/id_rsa" }), { ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test" }, t.folder)).toEqual({ status: 2, stdout: "", stderr: SENSITIVE_COMMAND });
		// Then each, a plain grok's rules (Orrery's own) among them.
		const envs: Record<string, string>[] = [{ ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test" }, { ORRERY_CONFIG: t.configPath }];
		for (const env of envs) {
			expect(hook("pre-tool-use", call(t.folder, "run_terminal_command", { command: "ls" }), env, t.folder)).toEqual({ status: 0, stdout: "", stderr: "" });
			const memory = hook("pre-tool-use", call(t.folder, "read_file", { target_file: join(t.agent.dir, "memory.sqlite") }), env, t.folder);
			expect([memory.status, memory.stdout, memory.stderr]).toEqual([2, "", expect.stringMatching(/^Orrery guard: .*memory\.sqlite is a sensitive file \(keys, credentials or Orrery's private data\)$/)]);
			// Orrery's config, read-only to every session; Grok's folder too.
			const config = hook("pre-tool-use", call(t.folder, "write", { file_path: t.configPath, content: "[" }), env, t.folder);
			expect([config.status, config.stdout]).toEqual([2, ""]);
			expect(config.stderr).toMatch(/^Orrery guard: .*Orrery's config: (agents may read it, not change it|it may be read, not changed)$/);
			const hooks = hook("pre-tool-use", call(t.folder, "run_terminal_command", { command: "rm ~/.grok/hooks/orrery.json" }), env, t.folder);
			expect([hooks.status, hooks.stderr]).toEqual([2, expect.stringMatching(/^Orrery guard: This command names Grok's folder/)]);
		}
	});

	it("refuses every call while the config can't be read; with no config at all, there is nothing of Orrery's to keep", () => {
		const t = testAgent();
		const broken = join(t.dir, "broken.toml");
		writeFileSync(broken, "[");
		const r = hook("pre-tool-use", call(t.folder, "run_terminal_command", { command: "ls" }), { ORRERY_CONFIG: broken }, t.folder);
		expect([r.status, r.stdout]).toEqual([2, ""]);
		// One line: Grok takes the first line of stderr as the reason.
		expect(r.stderr).toMatch(/^Orrery guard: Orrery's config could not be read \(.+\), so no call can be checked; nothing was run\. Fix the config file$/);
		expect(r.stderr).not.toContain("\n");
		const home = join(t.dir, "home");
		mkdirSync(home);
		const none = cleanEnv({ ORRERY_HOME: join(home, ".orrery") });
		delete none.ORRERY_CONFIG;
		const c = cliCommand(["grok-hook", "pre-tool-use"]);
		const plain = spawnSync(c.cmd, c.args, { input: JSON.stringify(call(t.folder, "run_terminal_command", { command: "cat ~/.ssh/id_rsa" })), env: { ...none, HOME: home }, encoding: "utf8", timeout: 20_000 });
		expect([plain.status, plain.stdout, plain.stderr]).toEqual([0, "", ""]);
	});

	it("refuses input over 1 MB unread, and a failure of its own command line: exit 2, never Grok's fail-open", () => {
		const t = testAgent();
		const env = { ORRERY_CONFIG: t.configPath };
		const big = cliCommand(["grok-hook", "pre-tool-use"]);
		const huge = spawnSync(big.cmd, big.args, { input: JSON.stringify(call(t.folder, "write", { file_path: "notes.md", content: "x".repeat(1_100_000) })), env: cleanEnv(env), encoding: "utf8", timeout: 20_000 });
		expect([huge.status, huge.stdout, huge.stderr]).toEqual([2, "", "Orrery guard: this call's input is too large for Orrery's guard to check (over 1 MB); nothing was run"]);
		const c = cliCommand(["grok-hook", "pre-tool-use", "--no-such-option"]);
		const r = spawnSync(c.cmd, c.args, { input: JSON.stringify(call(t.folder, "run_terminal_command", { command: "ls" })), env: cleanEnv(env), encoding: "utf8", timeout: 20_000 });
		expect([r.status, r.stdout]).toEqual([2, ""]);
		expect(r.stderr).toMatch(/^Orrery guard: this call could not be checked \(.+\); nothing was run$/);
	});

	it("refuses when it is still waiting at its watchdog's time, 6 s (input that never ends), inside the 10 s Grok gives it", async () => {
		const t = testAgent();
		const c = cliCommand(["grok-hook", "pre-tool-use"]);
		const child = spawn(c.cmd, c.args, { env: cleanEnv({ ORRERY_CONFIG: t.configPath }), stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		// Part of a call, and the input left open.
		child.stdin.write(JSON.stringify(call(t.folder, "run_terminal_command", { command: "ls" })).slice(0, 40));
		const started = performance.now();
		const status = await new Promise<number | null>((done) => child.on("exit", done));
		child.stdin.destroy();
		expect([status, stdout, stderr]).toEqual([2, "", "Orrery guard: this call could not be checked in time; nothing was run"]);
		expect(performance.now() - started).toBeLessThan(9000);
	}, 30_000);
});

describe("orrery grok-hook", () => {
	it("in a plain grok (no ORRERY_AGENT) in an agent's folder, says at SessionStart how to open the agent, and nothing at any other event", () => {
		const t = testAgent();
		const env = { ORRERY_CONFIG: t.configPath };
		const start = hook("session-start", input({ source: "new" }), env, t.folder);
		expect([start.status, start.stderr]).toEqual([0, ""]);
		expect(JSON.parse(start.stdout)).toEqual({ systemMessage: expect.stringContaining("Open it with orrery agent Test --tool grok.") });
		for (const event of ["user-prompt-submit", "stop", "stop-cancelled", "session-end"]) {
			expect(hook(event, input({ prompt: "Codename Saffron.", promptId: "p-1", lastAssistantMessage: "Noted.", reason: "end_turn" }), env, t.folder), event).toEqual({ status: 0, stdout: "", stderr: "" });
		}
		// Elsewhere it says nothing at all.
		const elsewhere = join(t.dir, "elsewhere");
		mkdirSync(elsewhere);
		expect(hook("session-start", input({ source: "new" }), env, elsewhere)).toEqual({ status: 0, stdout: "", stderr: "" });
	});

	it("without a config, says so at SessionStart in a Grok opened as an agent, and nothing in a plain grok; never fails the session", () => {
		const env = { ORRERY_CONFIG: "/nonexistent/orrery/config.toml" };
		const t = testAgent();
		const opened = hook("session-start", input({ source: "new" }), { ...env, ORRERY_AGENT: "Test" }, t.folder);
		expect([opened.status, opened.stderr]).toEqual([0, ""]);
		expect(JSON.parse(opened.stdout)).toEqual({ systemMessage: expect.stringMatching(/^Orrery: the config could not be read \(.*\); this session runs without memory\.$/) });
		for (const event of ["session-start", "user-prompt-submit", "stop"]) {
			expect(hook(event, input({ source: "new", prompt: "Codename Saffron.", lastAssistantMessage: "Noted.", reason: "end_turn" }), env, t.folder), event).toEqual({ status: 0, stdout: "", stderr: "" });
		}
	});

	it("run by Grok's shared leader (leader mode), every event decides, claims and records nothing, whatever agent and token it has; SessionStart says why", () => {
		const t = testAgent();
		const token = newToken();
		const leaderHook = (event: string, given: object, env: Record<string, string>) => {
			const c = cliCommand(["grok-hook", event]);
			const [cmd, args] = grokLeaderLaunch(c.cmd, c.args);
			const r = spawnSync(cmd, args, { cwd: grokLeaderFolder(), env: cleanEnv(env), input: JSON.stringify(given), encoding: "utf8", timeout: 30_000 });
			return { status: r.status, stdout: r.stdout, stderr: r.stderr };
		};
		// The leader's environment is its first client's: here an agent's, with a token nobody has claimed.
		const env = { ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token };
		const start = leaderHook("session-start", input({ source: "new" }), env);
		expect([start.status, start.stderr]).toEqual([0, ""]);
		expect(JSON.parse(start.stdout)).toEqual({ systemMessage: "Orrery: Grok runs this session's hooks and memory tools in its shared leader process (leader mode), where one session's agent can't be told from another's; Orrery opens its agents with --no-leader. This session records nothing and gets no memory tools." });
		for (const event of ["user-prompt-submit", "pre-tool-use", "stop", "stop-cancelled", "session-end"]) {
			expect(leaderHook(event, input({ prompt: "Codename Saffron.", promptId: "p-1", lastAssistantMessage: "Noted.", reason: "end_turn", toolName: "run_terminal_command", toolInput: { command: "ls" } }), env), event).toEqual({ status: 0, stdout: "", stderr: "" });
		}
		// A plain window's leader: nothing said at all.
		expect(leaderHook("session-start", input({ source: "new" }), { ORRERY_CONFIG: t.configPath })).toEqual({ status: 0, stdout: "", stderr: "" });
		// The guard still judges there, by Orrery's own rules: Orrery's settings and every agent's memory are kept.
		const write = leaderHook("pre-tool-use", input({ cwd: t.folder, toolName: "write", toolInput: { file_path: t.configPath, content: "[" }, toolInputTruncated: false }), env);
		expect([write.status, write.stdout, write.stderr]).toEqual([2, "", expect.stringMatching(/^Orrery guard: .*Orrery's config: it may be read, not changed$/)]);
		const memory = leaderHook("pre-tool-use", input({ cwd: t.folder, toolName: "read_file", toolInput: { target_file: join(t.agent.dir, "memory.sqlite") }, toolInputTruncated: false }), env);
		expect([memory.status, memory.stderr]).toEqual([2, expect.stringMatching(/^Orrery guard: .* is a sensitive file/)]);
		// Nothing decided, claimed, hosted or spooled.
		expect(existsSync(join(t.config.dataDir, "grok-processes"))).toBe(false);
		expect(existsSync(join(t.config.dataDir, "session-hosts"))).toBe(false);
		expect(existsSync(join(t.agent.dir, "claims"))).toBe(false);
		expect(listSessions(t.agent.dir)).toEqual([]);
	});

	it("says an unknown event on stderr, never quoting the input, and still exits 0", () => {
		const t = testAgent();
		const r = hook("post-compact", input({ prompt: "Codename Saffron." }), { ORRERY_CONFIG: t.configPath }, t.folder);
		expect([r.status, r.stdout]).toEqual([0, ""]);
		expect(r.stderr).toContain("unknown hook event post-compact");
		expect(r.stderr).not.toContain("Saffron");
	});
});

describe("a Grok session another process hosts: a program the agent's shell started, detached, takes it as another agent (replayed)", () => {
	/** Processes the test started: killed after it. */
	const pids: number[] = [];
	/** Host records it made: forgotten after it. */
	const hosted: { dataDir: string; pid: number }[] = [];
	afterEach(() => {
		for (const pid of pids.splice(0)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// gone already
			}
		}
		for (const { dataDir, pid } of hosted.splice(0)) forgetSession(dataDir, pid);
	});

	/** A config of two agents, Atlas and Birch, in `dataDir`. */
	const twoAgents = (dataDir: string, folders: Readonly<Record<"Atlas" | "Birch", string>>) =>
		[`data_dir = ${JSON.stringify(dataDir)}`, ...Object.entries(folders).map(([name, folder]) => `\n[agents.${name}]\nfolder = ${JSON.stringify(folder)}\nmodel = "faux-agent/faux-1"\nthinking = "off"\ncompactor_model = "faux-compactor/faux-1"\ncompactor_thinking = "off"`)].join("\n");

	/**
	 * The program, run detached (its own session, its parent gone: no Grok above it): it holds the live session's
	 * events.jsonl open for writing and writes nothing to it, runs Orrery's session-start hook for that session as its own
	 * child, then, once told, the hooks of the person's turn with the person's words. It stays alive after.
	 */
	const PROGRAM = `
const { spawnSync } = require("node:child_process");
const { existsSync, openSync, renameSync, writeFileSync } = require("node:fs");
const { cmd, args, events, session, words, reply, dir } = JSON.parse(process.argv[1]);
openSync(events, "a");
const hook = (event, input) => {
	const run = spawnSync(cmd, [...args, "grok-hook", event], { input: JSON.stringify({ hookEventName: event, sessionId: session, ...input }), encoding: "utf8", timeout: 20000 });
	return { status: run.status, stdout: run.stdout, stderr: run.stderr };
};
const said = (name, value) => { writeFileSync(dir + "/" + name + ".part", JSON.stringify(value)); renameSync(dir + "/" + name + ".part", dir + "/" + name); };
said("start.json", hook("session-start", { source: "new" }));
while (!existsSync(dir + "/go")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
said("turn.json", [hook("user-prompt-submit", { prompt: words, promptId: "p-1" }), hook("stop", { lastAssistantMessage: reply, promptId: "p-1", reason: "end_turn" })]);
setInterval(() => {}, 60000);
`;
	/** Starts PROGRAM from a process that exits at once, so its parent is gone (setsid and a double fork: a detach). */
	const LAUNCH = `const child = require("node:child_process").spawn(process.execPath, ["-e", process.argv[1], process.argv[2]], { detached: true, stdio: "ignore" }); process.stdout.write(String(child.pid)); child.unref();`;

	/** Waits until `file` is there (at most 20 s), and reads it as JSON. */
	const answer = async <T>(file: string): Promise<T> => {
		for (const deadline = Date.now() + 20_000; !existsSync(file); await new Promise((done) => setTimeout(done, 20))) {
			if (Date.now() > deadline) throw new Error(`${file} never came`);
		}
		return JSON.parse(readFileSync(file, "utf8")) as T;
	};

	it.skipIf(process.platform !== "linux")(
		"it holds Atlas's live session open and runs session-start as Birch with a fresh token and a config of its own that links Birch to Birch's real folder: refused, nothing claimed, recorded or spooled for Birch, and the person's words it sends after never reach Birch's memory",
		async () => {
			const t = testAgent();
			// The person's Orrery: Atlas and Birch, their data in data/ (the real folder, here a scratch one).
			const data = join(t.dir, "data");
			const home = join(t.dir, "home");
			const folders = { Atlas: join(t.dir, "ws-atlas"), Birch: join(t.dir, "ws-birch") };
			for (const dir of [...Object.values(folders), join(data, "agents", "Atlas"), join(data, "agents", "Birch"), home]) mkdirSync(dir, { recursive: true });
			writeFileSync(t.configPath, twoAgents(data, folders));
			// The program's own config, /tmp/c.toml's kind: its data folder (/tmp/d's) links Birch to Birch's real folder.
			const evil = join(t.dir, "d");
			mkdirSync(join(evil, "agents"), { recursive: true });
			symlinkSync(join(data, "agents", "Birch"), join(evil, "agents", "Birch"));
			const evilConfig = join(t.dir, "c.toml");
			writeFileSync(evilConfig, twoAgents(evil, folders));
			// Atlas's live Grok session, in the home's .grok under Atlas's folder.
			const session = randomUUID();
			const sessionDir = join(home, ".grok", "sessions", grokFolder(folders.Atlas), session);
			mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
			writeFileSync(join(sessionDir, "summary.json"), JSON.stringify({ info: { id: session, cwd: folders.Atlas }, agent_id: "ag1.x", num_messages: 0 }));
			const events = join(sessionDir, "events.jsonl");
			writeFileSync(events, `${JSON.stringify({ type: "mcp_config_resolved", servers: [] })}\n`);
			writeFileSync(join(sessionDir, "updates.jsonl"), "");
			// Atlas's Grok: a live process that has the session's events.jsonl open for writing, recorded as the session's host
			// as its own session start leaves it.
			const fd = openSync(events, "a");
			const grok = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: [fd, "ignore", "ignore"] });
			closeSync(fd);
			const atlasGrok = grok.pid as number;
			pids.push(atlasGrok);
			for (const deadline = Date.now() + 5_000; !(processArgv(atlasGrok)?.join(" ").includes("setTimeout") ?? false); await new Promise((done) => setTimeout(done, 5))) {
				if (Date.now() > deadline) throw new Error("Atlas's Grok never started");
			}
			expect(recordSession(data, { agent: "Atlas", tool: "grok", pid: atlasGrok, grokSession: session, config: t.configPath })).toBe(true);
			hosted.push({ dataDir: data, pid: atlasGrok });
			// The program, started from Atlas's shell (its folder) with ORRERY_AGENT=Birch, a fresh token and its own config.
			const out = join(t.dir, "out");
			mkdirSync(out);
			const c = cliCommand([]);
			const words = "The plan for the launch, in the person's words.";
			const reply = "Noted, the launch plan.";
			const env = cleanEnv({ HOME: home, ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: newToken(), ORRERY_CONFIG: evilConfig });
			const launched = spawnSync(process.execPath, ["-e", LAUNCH, PROGRAM, JSON.stringify({ cmd: c.cmd, args: c.args, events, session, words, reply, dir: out })], { cwd: folders.Atlas, env, encoding: "utf8" });
			const program = Number(launched.stdout);
			expect(Number.isInteger(program) && program > 1, launched.stderr).toBe(true);
			pids.push(program);
			const start = await answer<{ status: number; stdout: string; stderr: string }>(join(out, "start.json"));
			// The person types in Atlas's Grok, which writes the turn into its log; the program then sends the turn's hooks.
			appendFileSync(join(sessionDir, "updates.jsonl"), grokLog.turn(session, "p-1", words, reply, 0).map((line) => `${line}\n`).join(""));
			writeFileSync(join(out, "go"), "");
			const turn = await answer<{ status: number; stdout: string; stderr: string }[]>(join(out, "turn.json"));
			const birch = join(data, "agents", "Birch");
			// A recorder of Birch's that started records what its log confirms: waited for, so its words show here.
			if (existsSync(join(birch, "claude", "holder.json"))) {
				for (const deadline = Date.now() + 10_000; Date.now() < deadline && (existsSync(join(birch, "memory.sqlite")) ? messages({ dir: birch } as AgentConfig) : []).length < 2; ) await new Promise((done) => setTimeout(done, 50));
			}
			const atlasSpool = pendingEvents(join(data, "agents", "Atlas"), session).map((event) => readEvent(event.path)?.kind);
			expect({
				start,
				turn,
				birch: {
					claims: existsSync(join(birch, "claims")) ? readdirSync(join(birch, "claims")) : [],
					spool: listSessions(birch),
					memory: existsSync(join(birch, "memory.sqlite")) ? messages({ dir: birch } as AgentConfig) : [],
				},
				programHosts: existsSync(join(evil, "session-hosts")) ? readdirSync(join(evil, "session-hosts")) : [],
				atlasHost: liveSession(data, atlasGrok),
				atlasSpool,
			}).toEqual({
				start: { status: 0, stdout: JSON.stringify({ systemMessage: `Orrery: can't confirm this is this Grok's own session (Grok process ${atlasGrok} already hosts it), so this session isn't recorded.` }), stderr: "" },
				turn: [
					{ status: 0, stdout: "", stderr: "" },
					{ status: 0, stdout: "", stderr: "" },
				],
				birch: { claims: [], spool: [], memory: [] },
				programHosts: [],
				atlasHost: expect.objectContaining({ agent: "Atlas", grokSession: session }),
				// The program has Atlas's session open for writing too: Atlas's recorder confirms nothing more while it lives.
				atlasSpool: ["grok-shared"],
			});
		},
		60_000,
	);
});
