import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeSession } from "../../src/claude/pick.ts";
import { listSessions, pendingEvents, readEvent, readMode } from "../../src/claude/spool.ts";
import { readHolder } from "../../src/agent/handover.ts";
import { forgetSession, recordSession } from "../../src/agent/sessions.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { cleanupFakes, releasesServer, scratch } from "../release/fake-releases.ts";
import { cleanEnv, cleanupDirs, cliCommand, fakeClaude, hookCli, messages, type TestAgent, testAgent, waitUntil } from "./support.ts";
import { line, transcriptIn } from "./transcript-lines.ts";

afterEach(cleanupDirs);
afterEach(cleanupFakes);

/**
 * The built binary (npm run test:binary): only it can ask who is on the other end of its stdin (bun:ffi getsockopt), so
 * only its writing hooks record. Under Node the CLI refuses them all (spec 2026-10-18-agent-permissions 3c).
 */
const binary = Boolean(process.env.ORRERY_TEST_BIN);
const CALLER_NOTICE = "Orrery: can't confirm prompts in this Claude Code version, so this session isn't recorded.";

describe("the hooks as Claude Code runs them", () => {
	it.skipIf(!binary)("record a session: SessionStart starts a real holder, prompts and replies land in memory, SessionEnd lets it go", async () => {
		const t = testAgent({ setup: true });
		const claude = fakeClaude();
		const transcript = transcriptIn(t.dir);
		const env = { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.folder, CLAUDE_CONFIG_DIR: transcript.configDir };
		const at = { session_id: "s1", cwd: t.folder, transcript_path: transcript.path("s1") };
		try {
			const before = Date.now();
			const start = await claude.hook("session-start", { ...at, source: "startup" }, env);
			expect([start.status, start.stderr]).toEqual([0, ""]);
			expect(JSON.parse(start.stdout).hookSpecificOutput.additionalContext).toMatch(/· recording/);
			// The holder got SessionStart's time as --since: earlier than its own start, which comes after loading.
			expect(readMode(t.agent.dir, "s1")?.since).toBeGreaterThanOrEqual(before);
			expect(readMode(t.agent.dir, "s1")?.since).toBeLessThan(readHolder(t.agent.dir)!.startedAt);
			// Nothing for the model. The holder runs with summaries off (see testAgent); on a slow machine its notice can
			// land between SessionStart and this prompt, and then it reaches the user here, once.
			const prompted = (await claude.hook("user-prompt-submit", { ...at, prompt: "Codename Saffron.", prompt_id: "p-1" }, env)).stdout;
			if (prompted !== "") expect(JSON.parse(prompted)).toEqual({ systemMessage: expect.stringMatching(/^Orrery: Test's summaries stopped: unknown model /) });
			// Claude Code writes the prompt into its transcript once the hook has run: the holder records it then.
			transcript.add("s1", line.typed("p-1", "Codename Saffron."));
			await claude.hook("stop", { ...at, last_assistant_message: "Noted: Saffron." }, env);
			await waitUntil(() => messages(t.agent).length === 2);
			const end = await claude.hook("session-end", { ...at, reason: "other" }, env);
			expect([end.status, end.stdout, end.stderr]).toEqual([0, "", ""]);
			await waitUntil(() => readHolder(t.agent.dir) === undefined, 10_000);
			expect(messages(t.agent)).toEqual(["user: Codename Saffron.", "talk: Noted: Saffron."]);
			MemoryStore.open(join(t.agent.dir, "memory.sqlite")).close();
		} finally {
			claude.kill();
		}
	}, 60_000);

	it.skipIf(!binary)("run a second Claude Code's session read-only while the first records, and record none of its words", async () => {
		const t = testAgent({ setup: true });
		const a = fakeClaude();
		const b = fakeClaude();
		const transcript = transcriptIn(t.dir);
		const env = { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.folder, CLAUDE_CONFIG_DIR: transcript.configDir };
		const at = (session: string) => ({ session_id: session, cwd: t.folder, transcript_path: transcript.path(session) });
		try {
			expect(JSON.parse((await a.hook("session-start", at("a1"), env)).stdout).hookSpecificOutput.additionalContext).toMatch(/· recording/);
			const second = JSON.parse((await b.hook("session-start", at("b1"), env)).stdout);
			expect(second.hookSpecificOutput.additionalContext).toMatch(/· read-only/);
			await b.hook("user-prompt-submit", { ...at("b1"), prompt: "Not for memory.", prompt_id: "p-b" }, env);
			transcript.add("b1", line.typed("p-b", "Not for memory."));
			await a.hook("user-prompt-submit", { ...at("a1"), prompt: "For memory.", prompt_id: "p-a" }, env);
			transcript.add("a1", line.typed("p-a", "For memory."));
			await waitUntil(() => messages(t.agent).length === 1);
			await new Promise((resolve) => setTimeout(resolve, 700));
			expect(messages(t.agent)).toEqual(["user: For memory."]);
		} finally {
			a.kill();
			b.kill();
			await waitUntil(() => readHolder(t.agent.dir) === undefined, 5000).catch(() => {});
		}
	}, 60_000);

	// Without ORRERY_CONFIG, ~/.orrery or ~/.config/orrery, the hook falls back to the server's config, which a test must not read.
	it.skipIf(existsSync("/etc/orrery/config.toml"))("exit 0 and print nothing without any orrery config", () => {
		const t = testAgent();
		const none = hookCli("user-prompt-submit", { session_id: "s1", cwd: t.folder, prompt: "x" }, { HOME: t.dir });
		expect([none.status, none.stdout, none.stderr]).toEqual([0, "", ""]);
	}, 60_000);

	it.skipIf(binary)("under Node, which cannot ask who is on stdin, record nothing, and SessionStart says why", () => {
		const t = testAgent({ setup: true });
		const transcript = transcriptIn(t.dir);
		const env = { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.folder, CLAUDE_CONFIG_DIR: transcript.configDir };
		const at = { session_id: "s1", cwd: t.folder, transcript_path: transcript.path("s1") };
		const start = hookCli("session-start", { ...at, source: "startup" }, env);
		expect([start.status, start.stderr]).toEqual([0, ""]);
		// Said by its cause, not as a Claude Code version's.
		expect(JSON.parse(start.stdout)).toEqual({ systemMessage: "Orrery can't check who calls its hooks here (it runs under Node, not its own binary), so this session isn't recorded." });
		expect(hookCli("user-prompt-submit", { ...at, prompt: "Not recorded.", prompt_id: "p-1" }, env).stdout).toBe("");
		expect(listSessions(t.agent.dir)).toEqual([]);
		expect(readHolder(t.agent.dir)).toBeUndefined();
	}, 60_000);

	it.skipIf(!binary)("tell the user once that a newer release is out, from the cache, and never ask the network themselves", async () => {
		const t = testAgent();
		const home = scratch();
		mkdirSync(join(home, "app", "0.6.0"), { recursive: true });
		writeFileSync(join(home, "app", "0.6.0", "VERSION"), "0.6.0\n");
		symlinkSync("0.6.0", join(home, "app", "current"));
		// A day-old answer: the hook shows it and leaves the refresh to the recorder.
		writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: Date.now() - 2 * 86_400_000, latest: "0.6.1" }));
		const { base, hits } = await releasesServer("0.6.2", {});
		const env = { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.folder, ORRERY_HOME: home, ORRERY_RELEASES_URL: base };
		const at = { session_id: "s1", cwd: t.folder };
		// The hook's Claude Code is this test's process (its parent, its stdin's peer): decided, as a SessionStart would.
		claudeSession(t.config, { env: { CLAUDE_PROJECT_DIR: t.folder }, cwd: t.folder, pid: process.pid, decide: true });
		const first = hookCli("user-prompt-submit", { ...at, prompt: "hello" }, env);
		expect([first.status, first.stderr]).toEqual([0, ""]);
		expect(JSON.parse(first.stdout)).toEqual({ systemMessage: "Orrery 0.6.1 is available. Run `orrery update`, then restart this session." });
		expect(hookCli("stop", { ...at, last_assistant_message: "hi" }, env).stdout).toBe("");
		expect(hits).toEqual([]);
	}, 60_000);

	it("exit 0 and print nothing outside an agent; a broken config gets one stderr line, never the input", () => {
		const t = testAgent();
		const outside = hookCli("session-start", { session_id: "s1", cwd: t.dir }, { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.dir });
		expect([outside.status, outside.stdout, outside.stderr]).toEqual([0, "", ""]);
		const broken = hookCli("stop", { session_id: "s1", cwd: t.folder, last_assistant_message: "secret words" }, { ORRERY_CONFIG: join(t.dir, "missing.toml") });
		expect([broken.status, broken.stdout]).toEqual([0, ""]);
		expect(broken.stderr).toMatch(/^Orrery: .*missing\.toml.*\n$/);
		expect(broken.stderr).not.toContain("secret");
	}, 60_000);

	it("PreToolUse denies every call while a config is there but cannot be read, or is named and missing (fix round 1)", () => {
		const t = testAgent();
		const call = { session_id: "s1", cwd: t.folder, tool_name: "Read", tool_input: { file_path: join(t.folder, "notes.md") } };
		const broken = join(t.dir, "broken.toml");
		writeFileSync(broken, "[");
		for (const config of [broken, join(t.dir, "missing.toml")]) {
			const out = hookCli("pre-tool-use", call, { ORRERY_CONFIG: config, CLAUDE_PROJECT_DIR: t.folder });
			expect([config, out.status]).toEqual([config, 0]);
			expect(JSON.parse(out.stdout)).toEqual({
				hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(/^Orrery guard: Orrery's config could not be read/) },
			});
			expect(out.stderr).toMatch(/^Orrery: /);
		}
		// The same call with the agent's good config goes through.
		expect(hookCli("pre-tool-use", call, { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.folder }).stdout).toBe("");
	}, 60_000);

	it("PreToolUse keeps the config file ORRERY_CONFIG names read-only and named in no command (fix round 2)", () => {
		const t = testAgent();
		// The config inside the agent's own folder: only the config rule can refuse a write there.
		const file = join(t.folder, "orrery.toml");
		writeFileSync(file, readFileSync(t.configPath, "utf8"));
		const tool = (tool_name: string, tool_input: object) =>
			hookCli("pre-tool-use", { session_id: "s1", cwd: t.folder, tool_name, tool_input }, { ORRERY_CONFIG: file, CLAUDE_PROJECT_DIR: t.folder }).stdout;
		expect(tool("Bash", { command: `printf '[' >> ${file}` })).toMatch(/"permissionDecision":"deny".*sensitive/);
		expect(tool("Write", { file_path: file, content: "[" })).toMatch(/"permissionDecision":"deny".*Orrery's config/);
		expect(tool("Read", { file_path: file })).toBe("");
		expect(tool("Write", { file_path: join(t.folder, "notes.md"), content: "x" })).toBe("");
	}, 60_000);
});

describe.skipIf(!binary)("the caller check in the built binary (spec 2026-10-18-agent-permissions 3c)", () => {
	/** A set-up agent Test, its scratch Claude Code config folder, the hooks' environment, and session s1's input. */
	const setUp = () => {
		const t = testAgent({ setup: true });
		const transcript = transcriptIn(t.dir);
		const env = { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.folder, CLAUDE_CONFIG_DIR: transcript.configDir };
		const at = { session_id: "s1", cwd: t.folder, transcript_path: transcript.path("s1") };
		return { t, transcript, env, at };
	};
	/**
	 * The hook command as this test's process runs it, standing for Claude Code: its child, CLAUDE_PID its pid, the input
	 * on piped stdio, which Node (libuv) makes a socket pair whose peer is this process, as Claude Code's is.
	 */
	const own = (event: string, input: object, env: Record<string, string>) => hookCli(event, input, { ...env, CLAUDE_PID: String(process.pid) });
	const prompts = (t: TestAgent) => pendingEvents(t.agent.dir, "s1").map((e) => readEvent(e.path)).filter((e) => e?.kind === "prompt");
	const decision = (t: TestAgent) => join(t.config.dataDir, "claude-processes", `${process.pid}.json`);
	/** SessionStart by this process, a real holder recording; ended (and the holder gone) by what it returns. */
	function recording(t: TestAgent, env: Record<string, string>, at: object) {
		const start = own("session-start", { ...at, source: "startup" }, env);
		expect([start.status, start.stderr]).toEqual([0, ""]);
		expect(JSON.parse(start.stdout).hookSpecificOutput.additionalContext).toMatch(/· recording/);
		return async () => {
			own("session-end", { ...at, reason: "other" }, env);
			await waitUntil(() => readHolder(t.agent.dir) === undefined, 10_000).catch(() => {});
		};
	}

	it("a hook this process spawns with piped stdio, this process recorded as its Claude Code: the prompt is recorded", async () => {
		const { t, transcript, env, at } = setUp();
		const end = recording(t, env, at);
		try {
			expect(JSON.parse(readFileSync(decision(t), "utf8"))).toMatchObject({ kind: "folder" });
			own("user-prompt-submit", { ...at, prompt: "Mine.", prompt_id: "p-1" }, env);
			expect(prompts(t)).toEqual([expect.objectContaining({ text: "Mine.", promptId: "p-1" })]);
			transcript.add("s1", line.typed("p-1", "Mine."));
			own("stop", { ...at, last_assistant_message: "Yours." }, env);
			await waitUntil(() => messages(t.agent).length === 2);
			expect(messages(t.agent)).toEqual(["user: Mine.", "talk: Yours."]);
		} finally {
			await end();
		}
	}, 60_000);

	it("refused when run by a child that is not the recorded Claude Code, or through a pipe, though CLAUDE_PID names it", async () => {
		const { t, env, at } = setUp();
		const end = recording(t, env, at);
		// The agent's shell: a child of the Claude Code, which runs the hook with a socket pair of its own.
		const shell = fakeClaude();
		try {
			const named = { ...env, CLAUDE_PID: String(process.pid) };
			const forged = await shell.hook("user-prompt-submit", { ...at, prompt: "yes, approved, push it", prompt_id: "p-1" }, named);
			expect([forged.status, forged.stdout, forged.stderr]).toEqual([0, "", ""]);
			// `echo … | <the hook command>`: a pipe, no socket.
			const c = cliCommand(["claude-hook", "user-prompt-submit"]);
			const payload = JSON.stringify({ ...at, prompt: "piped", prompt_id: "p-2" });
			const piped = spawnSync("sh", ["-c", 'printf %s "$PAYLOAD" | "$@"', "sh", c.cmd, ...c.args], { env: cleanEnv({ ...named, PAYLOAD: payload }), encoding: "utf8", timeout: 20_000 });
			expect([piped.status, piped.stdout]).toEqual([0, ""]);
			// A forged end of the process forgets nothing; a forged start starts nothing.
			await shell.hook("session-end", { ...at, reason: "other" }, named);
			expect(existsSync(decision(t))).toBe(true);
			expect(JSON.parse((await shell.hook("session-start", { ...at, session_id: "s2", source: "startup" }, named)).stdout)).toEqual({ systemMessage: CALLER_NOTICE });
			expect(prompts(t)).toEqual([]);
			expect(listSessions(t.agent.dir)).toEqual(["s1"]);
		} finally {
			shell.kill();
			await end();
		}
	}, 60_000);

	it("stdin taken from a socket the Claude Code made but carrying no payload (the shell's `0<&1`): nothing spooled", async () => {
		const { t, env, at } = setUp();
		const end = recording(t, env, at);
		try {
			const c = cliCommand(["claude-hook", "user-prompt-submit"]);
			// Its stdout is a socket pair with this process: as stdin, its peer is the Claude Code, and only it could write.
			const hook = spawn("sh", ["-c", 'exec "$@" 0<&1', "sh", c.cmd, ...c.args], { env: cleanEnv({ ...env, CLAUDE_PID: String(process.pid) }), stdio: ["ignore", "pipe", "ignore"] });
			const exited = new Promise<number | null>((resolve) => hook.on("exit", (code) => resolve(code)));
			await new Promise((resolve) => setTimeout(resolve, 1500));
			expect(prompts(t)).toEqual([]);
			// The Claude Code closes its end: the hook reads an empty input.
			hook.stdout.destroy();
			expect(await exited).toBe(0);
			expect(prompts(t)).toEqual([]);
		} finally {
			await end();
		}
	}, 60_000);

	it.skipIf(process.platform !== "linux")("the check adds under 50 ms to a writing hook (Linux)", async () => {
		const { t, transcript, env, at } = setUp();
		const end = recording(t, env, at);
		try {
			const time = (run: () => unknown) => {
				const started = performance.now();
				run();
				return performance.now() - started;
			};
			const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
			const writing: number[] = [];
			const guard: number[] = [];
			for (let i = 0; i < 9; i++) {
				writing.push(time(() => own("user-prompt-submit", { ...at, prompt: `Prompt ${i}.`, prompt_id: `p-${i}` }, env)));
				transcript.add("s1", line.typed(`p-${i}`, `Prompt ${i}.`));
				guard.push(time(() => own("pre-tool-use", { ...at, tool_name: "Read", tool_input: { file_path: join(t.folder, "notes.md") } }, env)));
			}
			// PreToolUse runs the same start-up, config load and pick, and no peer check, spool or transcript work.
			expect(median(writing) - median(guard)).toBeLessThan(50);
		} finally {
			await end();
		}
	}, 120_000);
});

const claudeReady = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;

/**
 * The installed Claude Code itself, with a scratch HOME and CLAUDE_CONFIG_DIR (the person's settings are never read or
 * written) whose only hook is Orrery's SessionStart, and an API that answers nothing (a closed local port): enough for
 * the hook to run, and for Orrery to decide which agent's the session is. Nothing reaches a model.
 */
// Only the binary's hooks can confirm their caller: under Node every writing hook, SessionStart's too, records nothing.
describe.skipIf(!claudeReady || !binary)("the hooks in the installed Claude Code (scratch homes, no model)", () => {
	const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
	/**
	 * `claude -p` in `cwd`, killed once `done(its pid)` holds (or after 30 s); its pid. Orrery's hooks for `events` (Claude
	 * Code's event names, to Orrery's) are its only ones.
	 */
	async function claudeUntil(t: ReturnType<typeof testAgent>, cwd: string, done: (pid: number) => boolean, events: Record<string, string> = { SessionStart: "session-start" }): Promise<number> {
		const settings = join(t.dir, "claude-config");
		mkdirSync(settings, { recursive: true });
		const hook = (event: string) => {
			const c = cliCommand(["claude-hook", event]);
			return [{ hooks: [{ type: "command", command: [c.cmd, ...c.args].map(quote).join(" ") }] }];
		};
		writeFileSync(join(settings, "settings.json"), JSON.stringify({ hooks: Object.fromEntries(Object.entries(events).map(([name, event]) => [name, hook(event)])) }));
		const env = cleanEnv({
			HOME: join(t.dir, "home"),
			CLAUDE_CONFIG_DIR: settings,
			ORRERY_CONFIG: t.configPath,
			ANTHROPIC_API_KEY: `sk-ant-${"test"}`,
			ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			DISABLE_AUTOUPDATER: "1",
		});
		const child = spawn("claude", ["-p", "hello", "--max-turns", "1"], { cwd, env, stdio: ["ignore", "ignore", "ignore"] });
		const pid = child.pid as number;
		try {
			await waitUntil(() => done(pid), 30_000);
		} finally {
			child.kill("SIGKILL");
		}
		return pid;
	}
	const decision = (t: ReturnType<typeof testAgent>, pid: number) => join(t.config.dataDir, "claude-processes", `${pid}.json`);

	it("its SessionStart hook knows the Claude Code by CLAUDE_PID, its parent: the decision and the host record are that process's", async () => {
		const t = testAgent();
		mkdirSync(join(t.dir, "home"));
		// Only a hook whose CLAUDE_PID passed the check decides anything (src/claude/pick.ts claudeHookPid).
		const pid = await claudeUntil(t, t.folder, (claude) => existsSync(join(t.config.dataDir, "session-hosts", `${claude}.json`)));
		expect(JSON.parse(readFileSync(decision(t, pid), "utf8"))).toMatchObject({ kind: "folder" });
		expect(JSON.parse(readFileSync(join(t.config.dataDir, "session-hosts", `${pid}.json`), "utf8"))).toMatchObject({ agent: "Test", tool: "claude-code", pid });
	}, 60_000);

	it("records a real `claude -p`'s prompt: its hooks' stdin is a socket whose peer is Claude Code, its transcript confirms the prompt", async () => {
		const t = testAgent({ setup: true });
		mkdirSync(join(t.dir, "home"));
		const events = { SessionStart: "session-start", UserPromptSubmit: "user-prompt-submit", Stop: "stop", SessionEnd: "session-end" };
		try {
			await claudeUntil(t, t.folder, () => messages(t.agent).includes("user: hello"), events);
			expect(messages(t.agent)[0]).toBe("user: hello");
		} finally {
			await waitUntil(() => readHolder(t.agent.dir) === undefined, 15_000).catch(() => {});
		}
	}, 90_000);

	it("started inside an agent's session (a recorded ancestor), in the agent's own folder: decided nested, nothing recorded for it", async () => {
		const t = testAgent();
		mkdirSync(join(t.dir, "home"));
		// This test's process stands for a pi session of Test's that started Claude Code from its shell.
		expect(recordSession(t.config.dataDir, { agent: "Test", tool: "pi", pid: process.pid })).toBe(true);
		try {
			const pid = await claudeUntil(t, t.folder, (claude) => existsSync(decision(t, claude)));
			expect(JSON.parse(readFileSync(decision(t, pid), "utf8"))).toMatchObject({ kind: "nested", outer: "Test", tool: "pi" });
			expect(readdirSync(join(t.config.dataDir, "session-hosts"))).toEqual([`${process.pid}.json`]);
		} finally {
			forgetSession(t.config.dataDir, process.pid);
		}
	}, 60_000);
});
