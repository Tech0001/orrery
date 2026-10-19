import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHook } from "../../src/claude/hooks.ts";
import { UNCONFIRMED_NOTICE } from "../../src/claude/pick.ts";
import { modView } from "../../src/claude/mod-view.ts";
import { pendingEvents, writeMode } from "../../src/claude/spool.ts";
import { writeSetupMarker } from "../../src/claude/view-file.ts";
import { holderFile } from "../../src/agent/handover.ts";
import { newToken } from "../../src/agent/pick.ts";
import { processStartedAt } from "../../src/agent/process.ts";
import { forgetSession, recordSession } from "../../src/agent/sessions.ts";
import { MemoryStore, MemoryView, Part } from "../../src/memory/index.ts";
import { cleanEnv, cleanupDirs, cliCommand, seed, spool, type TestAgent, testAgent } from "./support.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
afterEach(cleanupDirs);

/** A holder.json for a live process, recording SESSION and beating now, unless told otherwise. */
function freshHolder(t: TestAgent, options: { session?: string; updatedAt?: number } = {}): void {
	mkdirSync(join(t.agent.dir, "claude"), { recursive: true });
	const now = Date.now();
	writeFileSync(
		holderFile(t.agent.dir),
		JSON.stringify({ pid: process.pid, session: options.session ?? SESSION, claudePid: process.pid, state: "recording", startedAt: now, updatedAt: options.updatedAt ?? now }),
	);
}

/** An agent in mod mode with memory, whose holder chose `mode` for SESSION. */
function modAgent(mode: "recording" | "read-only" = "recording"): TestAgent {
	const t = testAgent();
	seed(t.agent, ["one", "two"]);
	writeSetupMarker(t.agent.dir, t.agent.folder, "mod");
	writeMode(t.agent.dir, SESSION, { mode, pid: process.pid, claudePid: process.pid, nonce: "n", since: 0 });
	return t;
}

/** A fake clock that starts now (so a holder's heartbeat is judged as it really is) and a sleep that moves it. */
function fakeClock(onSleep: () => void = () => {}): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[]; start: number } {
	const start = Date.now();
	let clock = start;
	const slept: number[] = [];
	return {
		now: () => clock,
		sleep: async (ms) => {
			slept.push(ms);
			clock += ms;
			onSleep();
		},
		slept,
		start,
	};
}

describe("orrery claude-mod view", () => {
	it("outside any agent, and with no config: agent null", async () => {
		const t = testAgent();
		expect(await modView(t.config, { cwd: "/nowhere" })).toEqual({ lane: null });
		expect(await modView(undefined, { cwd: t.agent.folder })).toEqual({ lane: null });
	});

	it("a session its SessionStart found unconfirmed gets no view, even once the start can be read; a mark made before this Claude Code started is another's", async () => {
		const t = modAgent();
		// This test process stands for the Claude Code whose start could not be read at SessionStart (src/claude/hooks.ts).
		const unconfirmed = { mode: "read-only" as const, pid: process.pid, claudePid: process.pid, nonce: "u", since: Date.now(), reason: UNCONFIRMED_NOTICE };
		writeMode(t.agent.dir, OTHER, unconfirmed);
		const view = (session?: string, owner = process.pid) => modView(t.config, { cwd: t.agent.folder, env: {}, owner, ...(session === undefined ? {} : { session }) });
		expect(await view(OTHER)).toEqual({ lane: null });
		// Without a session: any session of the process marked so.
		expect(await view()).toEqual({ lane: null });
		// Another session of the process, which its hooks record, and another process: the view as ever.
		expect(await view(SESSION)).toMatchObject({ lane: "Test", mode: "mod" });
		expect(await view(OTHER, process.ppid)).toMatchObject({ lane: "Test" });
		// Made before this process started: a gone Claude Code's, whose pid this one reuses.
		writeMode(t.agent.dir, OTHER, { ...unconfirmed, since: (processStartedAt(process.pid) as number) - 60_000 });
		expect(await view(OTHER)).toMatchObject({ lane: "Test" });
		expect(await view()).toMatchObject({ lane: "Test" });
		// A read-only session for another reason is no such mark.
		writeMode(t.agent.dir, OTHER, { ...unconfirmed, reason: "pi holds Test" });
		expect(await view(OTHER)).toMatchObject({ lane: "Test" });
	});

	it("mode none and file: no section", async () => {
		const t = testAgent();
		expect(await modView(t.config, { cwd: t.agent.folder })).toMatchObject({ lane: t.agent.name, mode: "none", compactAt: 200_000, section: null });
		writeSetupMarker(t.agent.dir, t.agent.folder, "CLAUDE.md");
		expect(await modView(t.config, { cwd: t.agent.folder })).toMatchObject({ mode: "file", section: null });
	});

	it("mod mode: the claude-mod section and the message count, from a subfolder too", async () => {
		const t = testAgent();
		seed(t.agent, ["one", "two", "three"]);
		writeSetupMarker(t.agent.dir, t.agent.folder, "mod");
		const reply = await modView(t.config, { cwd: join(t.agent.folder, "sub") });
		expect(reply).toMatchObject({ lane: t.agent.name, mode: "mod", messages: 3 });
		expect((reply as { section: string }).section).toMatch(/^# Memory\n\nEarlier conversation reaches you only through the view below\./);
	});

	it("mod mode with no memory yet: section null, messages 0", async () => {
		const t = testAgent();
		writeSetupMarker(t.agent.dir, t.agent.folder, "mod");
		expect(await modView(t.config, { cwd: t.agent.folder })).toMatchObject({ mode: "mod", messages: 0, section: null });
		writeMode(t.agent.dir, SESSION, { mode: "recording", pid: process.pid, claudePid: process.pid, nonce: "n", since: 0 });
		freshHolder(t);
		expect(await modView(t.config, { cwd: t.agent.folder, session: SESSION })).toEqual({ lane: t.agent.name, mode: "mod", compactAt: 200_000, messages: 0, section: null, instructions: null, recording: true, sessionMode: "recording" });
	});

	it("an unreadable store: a plain error, no message text", async () => {
		const t = testAgent();
		writeSetupMarker(t.agent.dir, t.agent.folder, "mod");
		writeFileSync(join(t.agent.dir, "memory.sqlite"), "not a database");
		const reply = await modView(t.config, { cwd: t.agent.folder });
		expect(reply).toHaveProperty("error");
	});

	it("--wait-ms waits while this session's spool has events and a holder is fresh, then renders", async () => {
		const t = testAgent();
		seed(t.agent, ["one", "two"]);
		writeSetupMarker(t.agent.dir, t.agent.folder, "mod");
		freshHolder(t);
		spool(t.agent, SESSION, { kind: "prompt", text: "not yet in memory" }, process.pid);
		const clock = fakeClock();
		const reply = await modView(t.config, { cwd: t.agent.folder, session: SESSION, waitMs: 1000, now: clock.now, sleep: clock.sleep });
		expect(clock.slept.length).toBeGreaterThan(0);
		expect(clock.now()).toBeGreaterThanOrEqual(clock.start + 1000);
		expect(reply).toMatchObject({ mode: "mod", messages: 2 });
	});

	it("--wait-ms returns as soon as the spool drains, before the deadline", async () => {
		const t = modAgent();
		freshHolder(t);
		spool(t.agent, SESSION, { kind: "prompt", text: "not yet in memory" }, process.pid);
		// The holder takes the event in while the view waits.
		const clock = fakeClock(() => {
			for (const event of pendingEvents(t.agent.dir, SESSION)) rmSync(event.path);
		});
		const reply = await modView(t.config, { cwd: t.agent.folder, session: SESSION, waitMs: 30_000, now: clock.now, sleep: clock.sleep });
		expect(clock.slept).toHaveLength(1);
		expect(reply).toMatchObject({ mode: "mod", recording: true });
	});

	it("--wait-ms does not wait for a stale holder's spool, and the session is not recorded", async () => {
		const t = modAgent();
		freshHolder(t, { updatedAt: Date.now() - 60_000 });
		spool(t.agent, SESSION, { kind: "prompt", text: "nobody takes this in" }, process.pid);
		const clock = fakeClock();
		const reply = await modView(t.config, { cwd: t.agent.folder, session: SESSION, waitMs: 30_000, now: clock.now, sleep: clock.sleep });
		expect(clock.slept).toEqual([]);
		expect(reply).toMatchObject({ mode: "mod", recording: false });
	});

	it("--wait-ms does not wait for another session's holder", async () => {
		const t = modAgent();
		freshHolder(t, { session: OTHER });
		spool(t.agent, SESSION, { kind: "prompt", text: "nobody takes this in" }, process.pid);
		const clock = fakeClock();
		await modView(t.config, { cwd: t.agent.folder, session: SESSION, waitMs: 30_000, now: clock.now, sleep: clock.sleep });
		expect(clock.slept).toEqual([]);
	});

	it("--wait-ms does not wait when no holder or pi is summarizing (status absent or stale) and the spool is empty", async () => {
		const t = testAgent();
		seed(t.agent, ["one", "two"]);
		writeSetupMarker(t.agent.dir, t.agent.folder, "mod");
		const slept: number[] = [];
		await modView(t.config, { cwd: t.agent.folder, session: SESSION, waitMs: 30_000, sleep: async (ms) => void slept.push(ms) });
		expect(slept).toEqual([]);
		// A status from a live process but stale: still nothing to wait for.
		writeFileSync(join(t.agent.dir, "status.json"), JSON.stringify(status(new Date(Date.now() - 120_000).toISOString(), null)));
		await modView(t.config, { cwd: t.agent.folder, session: SESSION, waitMs: 30_000, sleep: async (ms) => void slept.push(ms) });
		expect(slept).toEqual([]);
	});

	it("--wait-ms waits for summaries while a fresh status says pi is summarizing an unsettled view", async () => {
		const t = testAgent();
		seed(t.agent, ["one", "two"]);
		writeSetupMarker(t.agent.dir, t.agent.folder, "mod");
		writeFileSync(join(t.agent.dir, "status.json"), JSON.stringify(status(new Date().toISOString(), null)));
		let clock = 0;
		const slept: number[] = [];
		await modView(t.config, { cwd: t.agent.folder, waitMs: 1000, now: () => clock, sleep: async (ms) => void ((clock += ms), slept.push(ms)) });
		expect(slept.length).toBeGreaterThan(0);
	});

	it("spoolOnly: the wait is for this session's spool alone, never for summaries", async () => {
		const t = modAgent();
		const store = MemoryStore.openReadOnly(join(t.agent.dir, "memory.sqlite"));
		expect(new MemoryView(store, t.agent.memory.viewBytes).settled).toBe(false);
		store.close();
		writeFileSync(join(t.agent.dir, "status.json"), JSON.stringify(status(new Date().toISOString(), null)));
		// A fresh status says summaries are being made for an unsettled view, and the spool is empty: no wait.
		const idle = fakeClock();
		const reply = await modView(t.config, { cwd: t.agent.folder, session: SESSION, waitMs: 5000, spoolOnly: true, now: idle.now, sleep: idle.sleep });
		expect(idle.slept).toEqual([]);
		expect(reply).toMatchObject({ mode: "mod", messages: 2 });
		// This session's holder still has an event to take in: the wait lasts until the spool drains.
		freshHolder(t);
		spool(t.agent, SESSION, { kind: "reply", text: "not yet in memory" }, process.pid);
		const busy = fakeClock(() => {
			if (busy.slept.length === 3) for (const event of pendingEvents(t.agent.dir, SESSION)) rmSync(event.path);
		});
		await modView(t.config, { cwd: t.agent.folder, session: SESSION, waitMs: 5000, spoolOnly: true, now: busy.now, sleep: busy.sleep });
		expect(busy.slept).toHaveLength(3);
	});

	it("spoolOnly: a spool that does not drain is waited on for the cap at most", async () => {
		const t = modAgent();
		freshHolder(t);
		spool(t.agent, SESSION, { kind: "reply", text: "not yet in memory" }, process.pid);
		const clock = fakeClock();
		await modView(t.config, { cwd: t.agent.folder, session: SESSION, waitMs: 1000, spoolOnly: true, now: clock.now, sleep: clock.sleep });
		expect(clock.now() - clock.start).toBeGreaterThanOrEqual(1000);
		expect(clock.now() - clock.start).toBeLessThan(1500);
	});

	it("--wait-ms does not wait for summaries when status.json says they are failing or stopped", async () => {
		const t = testAgent();
		seed(t.agent, ["one", "two"]);
		writeSetupMarker(t.agent.dir, t.agent.folder, "mod");
		const store = MemoryStore.openReadOnly(join(t.agent.dir, "memory.sqlite"));
		expect(new MemoryView(store, t.agent.memory.viewBytes).settled).toBe(false);
		store.close();
		writeFileSync(join(t.agent.dir, "status.json"), JSON.stringify(status(new Date().toISOString(), { state: "failing", plain: "x" })));
		const slept: number[] = [];
		await modView(t.config, { cwd: t.agent.folder, waitMs: 30_000, sleep: async (ms) => void slept.push(ms) });
		expect(slept).toEqual([]);
	});

	it("says whether this session is recorded: its holder records it, fresh, and its spool is empty", async () => {
		const t = modAgent();
		freshHolder(t);
		expect(await modView(t.config, { cwd: t.agent.folder, session: SESSION })).toMatchObject({ mode: "mod", recording: true });
		// Without --session there is nothing to say.
		expect(await modView(t.config, { cwd: t.agent.folder })).not.toHaveProperty("recording");
	});

	it("a read-only session is not recorded", async () => {
		const t = modAgent("read-only");
		freshHolder(t);
		expect(await modView(t.config, { cwd: t.agent.folder, session: SESSION })).toMatchObject({ mode: "mod", recording: false });
	});

	it("a session whose mode no holder chose is not recorded", async () => {
		const t = testAgent();
		seed(t.agent, ["one", "two"]);
		writeSetupMarker(t.agent.dir, t.agent.folder, "mod");
		freshHolder(t);
		expect(await modView(t.config, { cwd: t.agent.folder, session: SESSION })).toMatchObject({ mode: "mod", recording: false });
	});

	it("a session is not recorded when the fresh holder records another session", async () => {
		const t = modAgent();
		freshHolder(t, { session: OTHER });
		expect(await modView(t.config, { cwd: t.agent.folder, session: SESSION })).toMatchObject({ mode: "mod", recording: false });
	});

	it("a session is not recorded when its holder's heartbeat is stale", async () => {
		const t = modAgent();
		freshHolder(t, { updatedAt: Date.now() - 60_000 });
		expect(await modView(t.config, { cwd: t.agent.folder, session: SESSION })).toMatchObject({ mode: "mod", recording: false });
	});

	it("a session is not recorded when events are still in its spool after the wait", async () => {
		const t = modAgent();
		freshHolder(t);
		spool(t.agent, SESSION, { kind: "prompt", text: "not yet in memory" }, process.pid);
		const clock = fakeClock();
		const reply = await modView(t.config, { cwd: t.agent.folder, session: SESSION, waitMs: 1000, now: clock.now, sleep: clock.sleep });
		expect(clock.slept.length).toBeGreaterThan(0);
		expect(reply).toMatchObject({ mode: "mod", recording: false });
	});

	it("an agent not in mod mode says nothing about recording", async () => {
		const t = modAgent();
		freshHolder(t);
		writeSetupMarker(t.agent.dir, t.agent.folder, "CLAUDE.md");
		expect(await modView(t.config, { cwd: t.agent.folder, session: SESSION })).not.toHaveProperty("recording");
	});

	it("says what this session's mode file holds, as sessionMode: recording or read-only, whatever the holder does now", async () => {
		const recording = modAgent();
		expect(await modView(recording.config, { cwd: recording.agent.folder, session: SESSION })).toMatchObject({ mode: "mod", recording: false, sessionMode: "recording" });
		const readOnly = modAgent("read-only");
		freshHolder(readOnly, { session: OTHER });
		expect(await modView(readOnly.config, { cwd: readOnly.agent.folder, session: SESSION })).toMatchObject({ mode: "mod", recording: false, sessionMode: "read-only" });
	});

	it("leaves sessionMode out while the session has no mode file, and always without --session", async () => {
		const t = modAgent();
		expect(await modView(t.config, { cwd: t.agent.folder, session: OTHER })).not.toHaveProperty("sessionMode");
		expect(await modView(t.config, { cwd: t.agent.folder })).not.toHaveProperty("sessionMode");
		const empty = testAgent();
		writeSetupMarker(empty.agent.dir, empty.agent.folder, "mod");
		expect(await modView(empty.config, { cwd: empty.agent.folder, session: SESSION })).not.toHaveProperty("sessionMode");
		expect(await modView(empty.config, { cwd: empty.agent.folder, session: SESSION })).toMatchObject({ section: null, recording: false });
	});

	it("says sessionMode in an agent not in mod mode too (the mod shows nothing there)", async () => {
		const t = modAgent("read-only");
		writeSetupMarker(t.agent.dir, t.agent.folder, "CLAUDE.md");
		expect(await modView(t.config, { cwd: t.agent.folder, session: SESSION })).toMatchObject({ mode: "file", sessionMode: "read-only" });
		expect(await modView(t.config, { cwd: t.agent.folder })).not.toHaveProperty("sessionMode");
	});

	it("an invalid session id is an error", async () => {
		const t = testAgent();
		writeSetupMarker(t.agent.dir, t.agent.folder, "mod");
		expect(await modView(t.config, { cwd: t.agent.folder, session: "../x" })).toHaveProperty("error");
	});
});

/** A status.json of this (live) process. */
function status(updatedAt: string, trouble: { state: string; plain: string } | null): object {
	return {
		agent: "Test",
		pid: process.pid,
		open: true,
		busy: false,
		model: "faux-agent/faux-1",
		thinking: "off",
		memory: {},
		modelSource: "config",
		compactor: { stopped: false, failing: 0, model: "faux-compactor/faux-1", thinking: "off", source: "config" },
		lastError: null,
		trouble,
		updatedAt,
	};
}

describe("the CLI", () => {
	it("prints one JSON line, exit 0, and exit 1 with { error } for a broken config", () => {
		const t = testAgent();
		const c = cliCommand(["claude-mod", "view", "--cwd", t.agent.folder]);
		const run = (config: string) => spawnSync(c.cmd, c.args, { env: cleanEnv({ ORRERY_CONFIG: config }), encoding: "utf8", timeout: 20_000 });
		const ok = run(t.configPath);
		expect(ok.status).toBe(0);
		expect(JSON.parse(ok.stdout)).toHaveProperty("lane");
		const broken = join(t.dir, "broken.toml");
		writeFileSync(broken, "[[[");
		const bad = run(broken);
		expect(bad.status).toBe(1);
		expect(typeof JSON.parse(bad.stdout).error).toBe("string");
		expect(bad.stderr).toBe("");
	});

	it("under ORRERY_AGENT (--agent, or its own environment) answers what its Claude Code process decided, in any folder, and never decides", async () => {
		const t = modAgent();
		const elsewhere = join(t.dir, "elsewhere");
		mkdirSync(elsewhere);
		/** The view, run by this test, or (`viaShell`) by a shell this test starts, which is then its parent. */
		const view = (args: string[], env: Record<string, string> = {}, viaShell = false) => {
			const c = cliCommand(["claude-mod", "view", "--cwd", elsewhere, "--session", SESSION, ...args]);
			const [cmd, argv] = viaShell ? ["sh", ["-c", '"$@"; exit $?', "sh", c.cmd, ...c.args]] : [c.cmd, c.args];
			const run = spawnSync(cmd, argv, { env: cleanEnv({ ORRERY_CONFIG: t.configPath, ...env }), encoding: "utf8", timeout: 20_000 });
			expect([run.status, run.stderr]).toEqual([0, ""]);
			return JSON.parse(run.stdout);
		};
		// Its Claude Code (its parent: here this test) decided nothing yet: no agent, rather than a pick of its own.
		expect(view(["--agent", "Test"])).toEqual({ lane: null });
		// That process's SessionStart decides.
		const token = newToken();
		const env = { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token };
		const record = join(t.config.dataDir, "claude-processes", `${process.pid}.json`);
		try {
			await runHook("session-start", JSON.stringify({ session_id: OTHER, cwd: elsewhere }), {
				config: t.config,
				env: { ...env, CLAUDE_PROJECT_DIR: elsewhere },
				claudePid: process.pid,
				// On its stdin's other end: its Claude Code (src/claude/peer.ts).
				peer: () => process.pid,
				startHolder: () => {},
				modeWaitMs: 100,
				home: join(t.dir, "home"),
			});
			expect(view(["--agent", "Test", "--agent-token", token])).toMatchObject({ lane: "Test", mode: "mod", messages: 2, section: expect.stringContaining("one") });
			expect(view([], env)).toMatchObject({ lane: "Test", mode: "mod" });
			// The record is the process's under that ORRERY_AGENT and token only: told another agent, or the token missing, it
			// answers no agent (it never picks one itself).
			expect(view(["--agent", "Nobody"])).toEqual({ lane: null });
			expect(view(["--agent", "Test"])).toEqual({ lane: null });
			// Without ORRERY_AGENT the folder decides.
			expect(view([])).toEqual({ lane: null });
			// The view's Claude Code is its parent, never CLAUDE_PID: a claude started from an agent's Bash inherits the agent's.
			expect(view(["--agent", "Test", "--agent-token", token], { CLAUDE_PID: String(process.ppid) })).toMatchObject({ lane: "Test" });
			expect(view(["--agent", "Test", "--agent-token", token], { CLAUDE_PID: String(process.pid) }, true)).toEqual({ lane: null });
		} finally {
			rmSync(record, { force: true });
		}
	});

	it("inside an agent's session serves only that agent; a session whose agent is unknown gets an error, never stderr (spec 2026-10-18-agent-permissions §3)", async () => {
		const t = testAgent();
		const other = join(t.dir, "other");
		mkdirSync(other);
		const configPath = t.configPath;
		writeFileSync(configPath, `${readFileSync(t.configPath, "utf8")}\n[agents.Other]\nfolder = ${JSON.stringify(other)}\nmodel = "faux-agent/faux-1"\n`);
		const view = (cwd: string, env: Record<string, string> = {}) => {
			const c = cliCommand(["claude-mod", "view", "--cwd", cwd]);
			return spawnSync(c.cmd, c.args, { env: cleanEnv({ ORRERY_CONFIG: configPath, ...env }), encoding: "utf8", timeout: 20_000 });
		};
		// This test process, the view's parent, stands for Test's Claude Code, with its host recorded.
		expect(recordSession(t.config.dataDir, { agent: "Test", tool: "claude-code", pid: process.pid })).toBe(true);
		try {
			const elsewhere = view(other);
			expect([elsewhere.status, JSON.parse(elsewhere.stdout), elsewhere.stderr]).toEqual([0, { lane: null }, ""]);
			expect(JSON.parse(view(t.agent.folder).stdout)).toMatchObject({ lane: "Test" });
		} finally {
			forgetSession(t.config.dataDir, process.pid);
		}
		// Only ORRERY_HOST says there is a session (its host is no ancestor of the view's), and nothing proves whose.
		const host = spawn("sleep", ["120"], { stdio: "ignore" });
		try {
			expect(recordSession(t.config.dataDir, { agent: "Test", tool: "claude-code", pid: host.pid as number })).toBe(true);
			const unknown = view(t.agent.folder, { ORRERY_HOST: String(host.pid) });
			expect([unknown.status, unknown.stderr]).toEqual([1, ""]);
			expect(JSON.parse(unknown.stdout)).toEqual({
				error:
					"orrery can't tell which agent's session this is, so inside it only help and the version run. The session is known only by ORRERY_HOST. If this is your own terminal (a tmux server first started from an agent session keeps its markers), see \"Leftover markers\" in the docs.",
			});
		} finally {
			host.kill();
			await once(host, "exit");
			forgetSession(t.config.dataDir, host.pid as number);
		}
	});

	it("takes --spool-only with --wait-ms", () => {
		const t = testAgent();
		const c = cliCommand(["claude-mod", "view", "--cwd", t.agent.folder, "--session", SESSION, "--wait-ms", "3000", "--spool-only"]);
		const run = spawnSync(c.cmd, c.args, { env: cleanEnv({ ORRERY_CONFIG: t.configPath }), encoding: "utf8", timeout: 20_000 });
		expect(run.status).toBe(0);
		expect(JSON.parse(run.stdout)).toHaveProperty("lane");
		expect(run.stderr).toBe("");
	});

	it("--spool-only changes the wait: with summaries being made for an unsettled view, it does not wait for them", () => {
		const t = modAgent();
		writeFileSync(join(t.agent.dir, "status.json"), JSON.stringify(status(new Date().toISOString(), null)));
		const timed = (waitMs: number, extra: string[]) => {
			const started = Date.now();
			const c = cliCommand(["claude-mod", "view", "--cwd", t.agent.folder, "--session", SESSION, "--wait-ms", String(waitMs), ...extra]);
			const run = spawnSync(c.cmd, c.args, { env: cleanEnv({ ORRERY_CONFIG: t.configPath }), encoding: "utf8", timeout: 30_000 });
			expect(run.status).toBe(0);
			expect(JSON.parse(run.stdout)).toMatchObject({ mode: "mod", messages: 2 });
			return Date.now() - started;
		};
		// The plain wait waits for the summaries (here: its whole cap), so this setup is one the flag must change.
		expect(timed(1500, [])).toBeGreaterThanOrEqual(1500);
		// With the flag the same call returns long before its cap.
		expect(timed(20_000, ["--spool-only"])).toBeLessThan(10_000);
	}, 40_000);

	// A reply bigger than a pipe holds (64 KB), read late as the mod's process.run reads it, once came out cut at 65,536
	// bytes (src/cli/exit.ts): on Node when the CLI exited at once, on Bun when it waited on an empty write.
	it("delivers a reply over 64 KB in full through a pipe its reader drains late", () => {
		const t = modAgent();
		// 120 messages of 660 bytes, each with its line built: a view of about 80 KB.
		const store = MemoryStore.open(join(t.agent.dir, "memory.sqlite"));
		const texts = Array.from({ length: 120 }, (_, i) => `${i} ${"long words ".repeat(60)}`);
		store.appendBatch(texts.map((text) => ({ kind: "user" as const, text })));
		texts.forEach((text, i) => store.saveNode(new Part(0, i + 2), `user: ${text}`));
		store.close();
		const code = join(t.dir, "code");
		const c = cliCommand(["claude-mod", "view", "--cwd", t.agent.folder, "--session", SESSION]);
		const run = spawnSync("sh", ["-c", '{ "$@"; echo $? > "$CODE"; } | { sleep 0.3; cat; }', "sh", c.cmd, ...c.args], {
			env: cleanEnv({ ORRERY_CONFIG: t.configPath, CODE: code }),
			encoding: "utf8",
			maxBuffer: 10_000_000,
			timeout: 20_000,
		});
		expect([readFileSync(code, "utf8"), run.stderr]).toEqual(["0\n", ""]);
		expect(run.stdout.length).toBeGreaterThan(65_536);
		expect(JSON.parse(run.stdout)).toMatchObject({ mode: "mod", messages: 122 });
	});
});
