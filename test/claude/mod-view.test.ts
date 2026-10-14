import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modView } from "../../src/claude/mod-view.ts";
import { pendingEvents, writeMode } from "../../src/claude/spool.ts";
import { writeSetupMarker } from "../../src/claude/view-file.ts";
import { holderFile } from "../../src/lane/handover.ts";
import { claimToken, newToken } from "../../src/lane/pick.ts";
import { MemoryStore, MemoryView, Part } from "../../src/memory/index.ts";
import { cleanEnv, cleanupDirs, cliCommand, seed, spool, type TestLane, testLane } from "./support.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
afterEach(cleanupDirs);

/** A holder.json for a live process, recording SESSION and beating now, unless told otherwise. */
function freshHolder(t: TestLane, options: { session?: string; updatedAt?: number } = {}): void {
	mkdirSync(join(t.lane.dir, "claude"), { recursive: true });
	const now = Date.now();
	writeFileSync(
		holderFile(t.lane.dir),
		JSON.stringify({ pid: process.pid, session: options.session ?? SESSION, claudePid: process.pid, state: "recording", startedAt: now, updatedAt: options.updatedAt ?? now }),
	);
}

/** A lane in mod mode with memory, whose holder chose `mode` for SESSION. */
function modLane(mode: "recording" | "read-only" = "recording"): TestLane {
	const t = testLane();
	seed(t.lane, ["one", "two"]);
	writeSetupMarker(t.lane.dir, t.lane.workspace, "mod");
	writeMode(t.lane.dir, SESSION, { mode, pid: process.pid, claudePid: process.pid, nonce: "n", since: 0 });
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
	it("outside any lane, and with no config: lane null", async () => {
		const t = testLane();
		expect(await modView(t.config, { cwd: "/nowhere" })).toEqual({ lane: null });
		expect(await modView(undefined, { cwd: t.lane.workspace })).toEqual({ lane: null });
	});

	it("mode none and file: no section", async () => {
		const t = testLane();
		expect(await modView(t.config, { cwd: t.lane.workspace })).toMatchObject({ lane: t.lane.name, mode: "none", compactAt: 200_000, section: null });
		writeSetupMarker(t.lane.dir, t.lane.workspace, "CLAUDE.md");
		expect(await modView(t.config, { cwd: t.lane.workspace })).toMatchObject({ mode: "file", section: null });
	});

	it("mod mode: the claude-mod section and the message count, from a subfolder too", async () => {
		const t = testLane();
		seed(t.lane, ["one", "two", "three"]);
		writeSetupMarker(t.lane.dir, t.lane.workspace, "mod");
		const reply = await modView(t.config, { cwd: join(t.lane.workspace, "sub") });
		expect(reply).toMatchObject({ lane: t.lane.name, mode: "mod", messages: 3 });
		expect((reply as { section: string }).section).toMatch(/^# Memory\n\nEarlier conversation reaches you only through the view below\./);
	});

	it("mod mode with no memory yet: section null, messages 0", async () => {
		const t = testLane();
		writeSetupMarker(t.lane.dir, t.lane.workspace, "mod");
		expect(await modView(t.config, { cwd: t.lane.workspace })).toMatchObject({ mode: "mod", messages: 0, section: null });
		writeMode(t.lane.dir, SESSION, { mode: "recording", pid: process.pid, claudePid: process.pid, nonce: "n", since: 0 });
		freshHolder(t);
		expect(await modView(t.config, { cwd: t.lane.workspace, session: SESSION })).toEqual({ lane: t.lane.name, mode: "mod", compactAt: 200_000, messages: 0, section: null, recording: true, sessionMode: "recording" });
	});

	it("an unreadable store: a plain error, no message text", async () => {
		const t = testLane();
		writeSetupMarker(t.lane.dir, t.lane.workspace, "mod");
		writeFileSync(join(t.lane.dir, "memory.sqlite"), "not a database");
		const reply = await modView(t.config, { cwd: t.lane.workspace });
		expect(reply).toHaveProperty("error");
	});

	it("--wait-ms waits while this session's spool has events and a holder is fresh, then renders", async () => {
		const t = testLane();
		seed(t.lane, ["one", "two"]);
		writeSetupMarker(t.lane.dir, t.lane.workspace, "mod");
		freshHolder(t);
		spool(t.lane, SESSION, { kind: "prompt", text: "not yet in memory" }, process.pid);
		const clock = fakeClock();
		const reply = await modView(t.config, { cwd: t.lane.workspace, session: SESSION, waitMs: 1000, now: clock.now, sleep: clock.sleep });
		expect(clock.slept.length).toBeGreaterThan(0);
		expect(clock.now()).toBeGreaterThanOrEqual(clock.start + 1000);
		expect(reply).toMatchObject({ mode: "mod", messages: 2 });
	});

	it("--wait-ms returns as soon as the spool drains, before the deadline", async () => {
		const t = modLane();
		freshHolder(t);
		spool(t.lane, SESSION, { kind: "prompt", text: "not yet in memory" }, process.pid);
		// The holder takes the event in while the view waits.
		const clock = fakeClock(() => {
			for (const event of pendingEvents(t.lane.dir, SESSION)) rmSync(event.path);
		});
		const reply = await modView(t.config, { cwd: t.lane.workspace, session: SESSION, waitMs: 30_000, now: clock.now, sleep: clock.sleep });
		expect(clock.slept).toHaveLength(1);
		expect(reply).toMatchObject({ mode: "mod", recording: true });
	});

	it("--wait-ms does not wait for a stale holder's spool, and the session is not recorded", async () => {
		const t = modLane();
		freshHolder(t, { updatedAt: Date.now() - 60_000 });
		spool(t.lane, SESSION, { kind: "prompt", text: "nobody takes this in" }, process.pid);
		const clock = fakeClock();
		const reply = await modView(t.config, { cwd: t.lane.workspace, session: SESSION, waitMs: 30_000, now: clock.now, sleep: clock.sleep });
		expect(clock.slept).toEqual([]);
		expect(reply).toMatchObject({ mode: "mod", recording: false });
	});

	it("--wait-ms does not wait for another session's holder", async () => {
		const t = modLane();
		freshHolder(t, { session: OTHER });
		spool(t.lane, SESSION, { kind: "prompt", text: "nobody takes this in" }, process.pid);
		const clock = fakeClock();
		await modView(t.config, { cwd: t.lane.workspace, session: SESSION, waitMs: 30_000, now: clock.now, sleep: clock.sleep });
		expect(clock.slept).toEqual([]);
	});

	it("--wait-ms does not wait when no holder or pi is summarizing (status absent or stale) and the spool is empty", async () => {
		const t = testLane();
		seed(t.lane, ["one", "two"]);
		writeSetupMarker(t.lane.dir, t.lane.workspace, "mod");
		const slept: number[] = [];
		await modView(t.config, { cwd: t.lane.workspace, session: SESSION, waitMs: 30_000, sleep: async (ms) => void slept.push(ms) });
		expect(slept).toEqual([]);
		// A status from a live process but stale: still nothing to wait for.
		writeFileSync(join(t.lane.dir, "status.json"), JSON.stringify(status(new Date(Date.now() - 120_000).toISOString(), null)));
		await modView(t.config, { cwd: t.lane.workspace, session: SESSION, waitMs: 30_000, sleep: async (ms) => void slept.push(ms) });
		expect(slept).toEqual([]);
	});

	it("--wait-ms waits for summaries while a fresh status says pi is summarizing an unsettled view", async () => {
		const t = testLane();
		seed(t.lane, ["one", "two"]);
		writeSetupMarker(t.lane.dir, t.lane.workspace, "mod");
		writeFileSync(join(t.lane.dir, "status.json"), JSON.stringify(status(new Date().toISOString(), null)));
		let clock = 0;
		const slept: number[] = [];
		await modView(t.config, { cwd: t.lane.workspace, waitMs: 1000, now: () => clock, sleep: async (ms) => void ((clock += ms), slept.push(ms)) });
		expect(slept.length).toBeGreaterThan(0);
	});

	it("spoolOnly: the wait is for this session's spool alone, never for summaries", async () => {
		const t = modLane();
		const store = MemoryStore.openReadOnly(join(t.lane.dir, "memory.sqlite"));
		expect(new MemoryView(store, t.lane.memory.viewBytes).settled).toBe(false);
		store.close();
		writeFileSync(join(t.lane.dir, "status.json"), JSON.stringify(status(new Date().toISOString(), null)));
		// A fresh status says summaries are being made for an unsettled view, and the spool is empty: no wait.
		const idle = fakeClock();
		const reply = await modView(t.config, { cwd: t.lane.workspace, session: SESSION, waitMs: 5000, spoolOnly: true, now: idle.now, sleep: idle.sleep });
		expect(idle.slept).toEqual([]);
		expect(reply).toMatchObject({ mode: "mod", messages: 2 });
		// This session's holder still has an event to take in: the wait lasts until the spool drains.
		freshHolder(t);
		spool(t.lane, SESSION, { kind: "reply", text: "not yet in memory" }, process.pid);
		const busy = fakeClock(() => {
			if (busy.slept.length === 3) for (const event of pendingEvents(t.lane.dir, SESSION)) rmSync(event.path);
		});
		await modView(t.config, { cwd: t.lane.workspace, session: SESSION, waitMs: 5000, spoolOnly: true, now: busy.now, sleep: busy.sleep });
		expect(busy.slept).toHaveLength(3);
	});

	it("spoolOnly: a spool that does not drain is waited on for the cap at most", async () => {
		const t = modLane();
		freshHolder(t);
		spool(t.lane, SESSION, { kind: "reply", text: "not yet in memory" }, process.pid);
		const clock = fakeClock();
		await modView(t.config, { cwd: t.lane.workspace, session: SESSION, waitMs: 1000, spoolOnly: true, now: clock.now, sleep: clock.sleep });
		expect(clock.now() - clock.start).toBeGreaterThanOrEqual(1000);
		expect(clock.now() - clock.start).toBeLessThan(1500);
	});

	it("--wait-ms does not wait for summaries when status.json says they are failing or stopped", async () => {
		const t = testLane();
		seed(t.lane, ["one", "two"]);
		writeSetupMarker(t.lane.dir, t.lane.workspace, "mod");
		const store = MemoryStore.openReadOnly(join(t.lane.dir, "memory.sqlite"));
		expect(new MemoryView(store, t.lane.memory.viewBytes).settled).toBe(false);
		store.close();
		writeFileSync(join(t.lane.dir, "status.json"), JSON.stringify(status(new Date().toISOString(), { state: "failing", plain: "x" })));
		const slept: number[] = [];
		await modView(t.config, { cwd: t.lane.workspace, waitMs: 30_000, sleep: async (ms) => void slept.push(ms) });
		expect(slept).toEqual([]);
	});

	it("says whether this session is recorded: its holder records it, fresh, and its spool is empty", async () => {
		const t = modLane();
		freshHolder(t);
		expect(await modView(t.config, { cwd: t.lane.workspace, session: SESSION })).toMatchObject({ mode: "mod", recording: true });
		// Without --session there is nothing to say.
		expect(await modView(t.config, { cwd: t.lane.workspace })).not.toHaveProperty("recording");
	});

	it("a read-only session is not recorded", async () => {
		const t = modLane("read-only");
		freshHolder(t);
		expect(await modView(t.config, { cwd: t.lane.workspace, session: SESSION })).toMatchObject({ mode: "mod", recording: false });
	});

	it("a session whose mode no holder chose is not recorded", async () => {
		const t = testLane();
		seed(t.lane, ["one", "two"]);
		writeSetupMarker(t.lane.dir, t.lane.workspace, "mod");
		freshHolder(t);
		expect(await modView(t.config, { cwd: t.lane.workspace, session: SESSION })).toMatchObject({ mode: "mod", recording: false });
	});

	it("a session is not recorded when the fresh holder records another session", async () => {
		const t = modLane();
		freshHolder(t, { session: OTHER });
		expect(await modView(t.config, { cwd: t.lane.workspace, session: SESSION })).toMatchObject({ mode: "mod", recording: false });
	});

	it("a session is not recorded when its holder's heartbeat is stale", async () => {
		const t = modLane();
		freshHolder(t, { updatedAt: Date.now() - 60_000 });
		expect(await modView(t.config, { cwd: t.lane.workspace, session: SESSION })).toMatchObject({ mode: "mod", recording: false });
	});

	it("a session is not recorded when events are still in its spool after the wait", async () => {
		const t = modLane();
		freshHolder(t);
		spool(t.lane, SESSION, { kind: "prompt", text: "not yet in memory" }, process.pid);
		const clock = fakeClock();
		const reply = await modView(t.config, { cwd: t.lane.workspace, session: SESSION, waitMs: 1000, now: clock.now, sleep: clock.sleep });
		expect(clock.slept.length).toBeGreaterThan(0);
		expect(reply).toMatchObject({ mode: "mod", recording: false });
	});

	it("a lane not in mod mode says nothing about recording", async () => {
		const t = modLane();
		freshHolder(t);
		writeSetupMarker(t.lane.dir, t.lane.workspace, "CLAUDE.md");
		expect(await modView(t.config, { cwd: t.lane.workspace, session: SESSION })).not.toHaveProperty("recording");
	});

	it("says what this session's mode file holds, as sessionMode: recording or read-only, whatever the holder does now", async () => {
		const recording = modLane();
		expect(await modView(recording.config, { cwd: recording.lane.workspace, session: SESSION })).toMatchObject({ mode: "mod", recording: false, sessionMode: "recording" });
		const readOnly = modLane("read-only");
		freshHolder(readOnly, { session: OTHER });
		expect(await modView(readOnly.config, { cwd: readOnly.lane.workspace, session: SESSION })).toMatchObject({ mode: "mod", recording: false, sessionMode: "read-only" });
	});

	it("leaves sessionMode out while the session has no mode file, and always without --session", async () => {
		const t = modLane();
		expect(await modView(t.config, { cwd: t.lane.workspace, session: OTHER })).not.toHaveProperty("sessionMode");
		expect(await modView(t.config, { cwd: t.lane.workspace })).not.toHaveProperty("sessionMode");
		const empty = testLane();
		writeSetupMarker(empty.lane.dir, empty.lane.workspace, "mod");
		expect(await modView(empty.config, { cwd: empty.lane.workspace, session: SESSION })).not.toHaveProperty("sessionMode");
		expect(await modView(empty.config, { cwd: empty.lane.workspace, session: SESSION })).toMatchObject({ section: null, recording: false });
	});

	it("says sessionMode in a lane not in mod mode too (the mod shows nothing there)", async () => {
		const t = modLane("read-only");
		writeSetupMarker(t.lane.dir, t.lane.workspace, "CLAUDE.md");
		expect(await modView(t.config, { cwd: t.lane.workspace, session: SESSION })).toMatchObject({ mode: "file", sessionMode: "read-only" });
		expect(await modView(t.config, { cwd: t.lane.workspace })).not.toHaveProperty("sessionMode");
	});

	it("an invalid session id is an error", async () => {
		const t = testLane();
		writeSetupMarker(t.lane.dir, t.lane.workspace, "mod");
		expect(await modView(t.config, { cwd: t.lane.workspace, session: "../x" })).toHaveProperty("error");
	});
});

/** A status.json of this (live) process. */
function status(updatedAt: string, trouble: { state: string; plain: string } | null): object {
	return {
		lane: "Test",
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
		const t = testLane();
		const c = cliCommand(["claude-mod", "view", "--cwd", t.lane.workspace]);
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

	it("answers for the lane --agent (or ORRERY_AGENT) names, in any folder; with a token, only for the Claude Code that claimed it", () => {
		const t = modLane();
		const elsewhere = join(t.dir, "elsewhere");
		mkdirSync(elsewhere);
		const view = (args: string[], env: Record<string, string> = {}) => {
			const c = cliCommand(["claude-mod", "view", "--cwd", elsewhere, "--session", SESSION, ...args]);
			const run = spawnSync(c.cmd, c.args, { env: cleanEnv({ ORRERY_CONFIG: t.configPath, ...env }), encoding: "utf8", timeout: 20_000 });
			expect([run.status, run.stderr]).toEqual([0, ""]);
			return JSON.parse(run.stdout);
		};
		expect(view(["--agent", "Test"])).toMatchObject({ lane: "Test", mode: "mod", messages: 2, section: expect.stringContaining("one") });
		expect(view([])).toEqual({ lane: null });
		expect(view([], { ORRERY_AGENT: "Test" })).toMatchObject({ lane: "Test", mode: "mod" });
		expect(view(["--agent", "Nobody"], { ORRERY_AGENT: "Test" })).toEqual({ lane: null });
		const token = newToken();
		expect(claimToken(t.lane.dir, token, process.pid)).toBe(true);
		// The view's Claude Code is CLAUDE_PID, else its parent (here this test, which claimed the token).
		expect(view(["--agent", "Test", "--agent-token", token])).toMatchObject({ lane: "Test" });
		expect(view(["--agent", "Test", "--agent-token", token], { CLAUDE_PID: String(process.ppid) })).toEqual({ lane: null });
	});

	it("takes --spool-only with --wait-ms", () => {
		const t = testLane();
		const c = cliCommand(["claude-mod", "view", "--cwd", t.lane.workspace, "--session", SESSION, "--wait-ms", "3000", "--spool-only"]);
		const run = spawnSync(c.cmd, c.args, { env: cleanEnv({ ORRERY_CONFIG: t.configPath }), encoding: "utf8", timeout: 20_000 });
		expect(run.status).toBe(0);
		expect(JSON.parse(run.stdout)).toHaveProperty("lane");
		expect(run.stderr).toBe("");
	});

	it("--spool-only changes the wait: with summaries being made for an unsettled view, it does not wait for them", () => {
		const t = modLane();
		writeFileSync(join(t.lane.dir, "status.json"), JSON.stringify(status(new Date().toISOString(), null)));
		const timed = (waitMs: number, extra: string[]) => {
			const started = Date.now();
			const c = cliCommand(["claude-mod", "view", "--cwd", t.lane.workspace, "--session", SESSION, "--wait-ms", String(waitMs), ...extra]);
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
		const t = modLane();
		// 120 messages of 660 bytes, each with its line built: a view of about 80 KB.
		const store = MemoryStore.open(join(t.lane.dir, "memory.sqlite"));
		const texts = Array.from({ length: 120 }, (_, i) => `${i} ${"long words ".repeat(60)}`);
		store.appendBatch(texts.map((text) => ({ kind: "user" as const, text })));
		texts.forEach((text, i) => store.saveNode(new Part(0, i + 2), `user: ${text}`));
		store.close();
		const code = join(t.dir, "code");
		const c = cliCommand(["claude-mod", "view", "--cwd", t.lane.workspace, "--session", SESSION]);
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
