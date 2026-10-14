import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Holder, type HolderOptions } from "../../src/claude/holder.ts";
import { sessionDir, viewFile } from "../../src/claude/paths.ts";
import { claudeSetup } from "../../src/claude/setup.ts";
import { pendingEvents, readMode, spoolKey, writeMode } from "../../src/claude/spool.ts";
import { readSetupMarker } from "../../src/claude/view-file.ts";
import { holderFile, readHolder, requestYield } from "../../src/agent/handover.ts";
import { agentModelSource, type ModelSource } from "../../src/agent/model-source.ts";
import { memorySection } from "../../src/agent/view-text.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { fauxModels } from "../agent/support.ts";
import { brokenGit, cleanupDirs, gitIn, messages, spool, type TestAgent, testAgent, waitUntil, withGit } from "./support.ts";

const holders: Holder[] = [];
afterEach(async () => {
	for (const holder of holders.splice(0)) await holder.stop("test over");
	cleanupDirs();
});

async function start(t: TestAgent, extra: Partial<HolderOptions> = {}): Promise<Holder | undefined> {
	const holder = await Holder.start({
		agent: t.agent,
		session: "s1",
		claudePid: 111,
		nonce: "n1",
		models: agentModelSource(fauxModels().models),
		alive: (pid) => pid === 111 || pid === 222,
		tickMs: 20,
		yieldWaitMs: 1000,
		...extra,
	});
	if (holder !== undefined) holders.push(holder);
	return holder;
}

const LONG = (word: string) => `${word} ${"detail ".repeat(100)}`;
const free = (t: TestAgent) => MemoryStore.open(join(t.agent.dir, "memory.sqlite")).close();

/** Summaries that come only once `release()` is called; they fail when the compactor aborts them. */
function gated(): { models: ModelSource; release(): void } {
	let open = false;
	const waiting: Array<() => void> = [];
	const models: ModelSource = {
		find: (provider, id) => ({ api: "faux", provider, id, contextWindow: 200_000 }),
		streamSimple: (_model, _context, options) => ({
			result: () =>
				new Promise((resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					const reply = () =>
						resolve({
							role: "assistant",
							content: [{ type: "text", text: "user: summarized" }],
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
							stopReason: "stop",
						} as never);
					if (open) reply();
					else waiting.push(reply);
				}),
		}),
	};
	return {
		models,
		release: () => {
			open = true;
			for (const reply of waiting.splice(0)) reply();
		},
	};
}

/** Resolves with `promise`, or fails after `ms` (a holder that never lets go must fail the test, not hang it). */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(`not within ${ms} ms`)), ms)))]);
	} finally {
		clearTimeout(timer);
	}
}

const failing: ModelSource = {
	find: (provider, id) => ({ api: "faux", provider, id, contextWindow: 200_000 }),
	streamSimple: () => ({
		result: async () => {
			throw new Error("quota exceeded");
		},
	}),
};

describe("the holder", () => {
	it("records prompts and replies in order, once each, and writes the view Claude Code loads once it settles", async () => {
		const t = testAgent({ setup: true });
		const holder = (await start(t))!;
		expect(readMode(t.agent.dir, "s1")).toMatchObject({ mode: "recording", nonce: "n1", claudePid: 111 });
		spool(t.agent, "s1", { kind: "prompt", text: "Use pnpm here." }, 111);
		const last = spool(t.agent, "s1", { kind: "reply", text: LONG("Switched to pnpm.") }, 111);
		await waitUntil(() => messages(t.agent).length === 2 && holder.agent.view.settled);
		expect(messages(t.agent)).toEqual(["user: Use pnpm here.", `talk: ${LONG("Switched to pnpm.")}`]);
		expect(holder.agent.store.getMeta(spoolKey("s1"))).toBe(last);
		expect(pendingEvents(t.agent.dir, "s1")).toEqual([]);
		await waitUntil(() => readFileSync(viewFile(t.folder), "utf8") === memorySection(holder.agent.view, "claude-code"));
		expect(statSync(viewFile(t.folder)).mode & 0o777).toBe(0o600);
		expect(statSync(join(t.folder, ".orrery")).mode & 0o777).toBe(0o700);
		expect(readHolder(t.agent.dir)).toMatchObject({ session: "s1", claudePid: 111, state: "recording" });
	});

	it("keeps the reply to Orrery's own command out of memory, for that session only, until its next prompt", async () => {
		const t = testAgent();
		writeMode(t.agent.dir, "old", { mode: "recording", pid: 1, claudePid: 999, nonce: "x", since: 0 });
		spool(t.agent, "s1", { kind: "prompt", text: "Use pnpm here." }, 111);
		spool(t.agent, "s1", { kind: "reply", text: "Switched to pnpm." }, 111);
		spool(t.agent, "s1", { kind: "command" }, 111);
		spool(t.agent, "old", { kind: "reply", text: "Left by another session." }, 999);
		spool(t.agent, "s1", { kind: "reply", text: "Orrery · Test · 2 msgs" }, 111);
		spool(t.agent, "s1", { kind: "command" }, 111);
		spool(t.agent, "s1", { kind: "prompt", text: "Next: the oracle." }, 111);
		const last = spool(t.agent, "s1", { kind: "reply", text: "Oracle done." }, 111);
		const holder = (await start(t))!;
		await waitUntil(() => holder.agent.store.getMeta(spoolKey("s1")) === last);
		expect(messages(t.agent)).toEqual(["user: Use pnpm here.", "talk: Switched to pnpm.", "talk: Left by another session.", "user: Next: the oracle.", "talk: Oracle done."]);
		expect(pendingEvents(t.agent.dir, "s1")).toEqual([]);
	});

	it("leaves a folder whose CLAUDE.md does not load the view untouched", async () => {
		const t = testAgent();
		const holder = (await start(t))!;
		spool(t.agent, "s1", { kind: "prompt", text: "hello" }, 111);
		await waitUntil(() => messages(t.agent).length === 1);
		await holder.stop("test");
		expect(existsSync(join(t.folder, ".orrery"))).toBe(false);
	});

	it("after a crash, records what the dead holder left exactly once and in order, and never a read-only session's words", async () => {
		const t = testAgent();
		writeMode(t.agent.dir, "old", { mode: "recording", pid: 1, claudePid: 999, nonce: "x", since: 0 });
		const recorded = spool(t.agent, "old", { kind: "prompt", text: "already recorded" }, 999);
		const store = MemoryStore.open(join(t.agent.dir, "memory.sqlite"));
		store.appendBatch([{ kind: "user", text: "already recorded" }], { [spoolKey("old")]: recorded });
		store.close();
		spool(t.agent, "old", { kind: "reply", text: "left in the spool" }, 999);
		writeMode(t.agent.dir, "ro", { mode: "read-only", pid: 1, claudePid: 999, nonce: "y", since: 0 });
		spool(t.agent, "ro", { kind: "prompt", text: "never recorded" }, 999);
		spool(t.agent, "lost", { kind: "prompt", text: "no holder answered" }, 999);
		spool(t.agent, "busy", { kind: "prompt", text: "not mine yet" }, 222);
		await start(t);
		await waitUntil(() => messages(t.agent).length === 3);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(messages(t.agent)).toEqual(["user: already recorded", "talk: left in the spool", "user: no holder answered"]);
		expect(existsSync(sessionDir(t.agent.dir, "old"))).toBe(false);
		expect(existsSync(sessionDir(t.agent.dir, "ro"))).toBe(false);
		expect(pendingEvents(t.agent.dir, "busy")).toHaveLength(1);
	});

	it("runs read-only while another writer holds the agent, drops what it spooled meanwhile, and keeps what came before", async () => {
		const t = testAgent();
		writeMode(t.agent.dir, "s1", { mode: "recording", pid: 1, claudePid: 111, nonce: "old", since: 0 });
		spool(t.agent, "s1", { kind: "prompt", text: "spooled while it recorded" }, 111, Date.now() - 60_000);
		spool(t.agent, "s1", { kind: "prompt", text: "spooled while undecided" }, 111, Date.now() + 60_000);
		const pi = MemoryStore.open(join(t.agent.dir, "memory.sqlite"));
		try {
			expect(await start(t, { yieldWaitMs: 200 })).toBeUndefined();
			expect(readMode(t.agent.dir, "s1")).toMatchObject({ mode: "read-only", nonce: "n1" });
			expect(readMode(t.agent.dir, "s1")?.reason).toBeUndefined();
			expect(pendingEvents(t.agent.dir, "s1")).toHaveLength(1);
		} finally {
			pi.close();
		}
		await start(t, { session: "s2", claudePid: 222, nonce: "n2" });
		await waitUntil(() => messages(t.agent).length === 1);
		expect(messages(t.agent)).toEqual(["user: spooled while it recorded"]);
	});

	it("after its session ends, releases the agent once summaries settle, not before", async () => {
		const t = testAgent({ setup: true });
		const gate = gated();
		const holder = (await start(t, { models: gate.models }))!;
		spool(t.agent, "s1", { kind: "prompt", text: LONG("Pending") }, 111);
		spool(t.agent, "s1", { kind: "end", reason: "other" }, 111);
		await waitUntil(() => holder.state === "finishing");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(readHolder(t.agent.dir)?.state).toBe("finishing");
		gate.release();
		await holder.done;
		free(t);
		expect(readFileSync(viewFile(t.folder), "utf8")).toContain("0+1|user: summarized");
		expect(readHolder(t.agent.dir)).toBeUndefined();
		expect(existsSync(sessionDir(t.agent.dir, "s1"))).toBe(false);
	});

	it("does not hold the agent for summaries that cannot come: failing, or still running after finishMs", async () => {
		const t = testAgent();
		const broken = (await start(t, { models: failing }))!;
		spool(t.agent, "s1", { kind: "prompt", text: LONG("Fails") }, 111);
		// The summary fails before the session ends, so the holder stops for it and not because summaries settled.
		await waitUntil(() => broken.agent.summaryTrouble()?.state === "failing");
		spool(t.agent, "s1", { kind: "end" }, 111);
		await broken.done;
		expect(broken.agent.view.settled).toBe(false);
		expect(readHolder(t.agent.dir)).toBeUndefined();
		free(t);
		const hung = (await start(t, { session: "s2", models: gated().models, finishMs: 200 }))!;
		spool(t.agent, "s2", { kind: "prompt", text: LONG("Hangs") }, 111);
		const ended = Date.now();
		spool(t.agent, "s2", { kind: "end" }, 111);
		await hung.done;
		// It finished for finishMs (counted from the end it saw after `ended`), then gave up.
		expect(Date.now() - ended).toBeGreaterThanOrEqual(200);
		expect(hung.agent.view.settled).toBe(false);
		expect(readHolder(t.agent.dir)).toBeUndefined();
		free(t);
	});

	it("ends its session when the Claude Code process is gone, without SessionEnd", async () => {
		const t = testAgent();
		let running = true;
		const holder = (await start(t, { alive: () => running }))!;
		expect(existsSync(sessionDir(t.agent.dir, "s1"))).toBe(true);
		running = false;
		await holder.done;
		free(t);
		expect(readHolder(t.agent.dir)).toBeUndefined();
		expect(existsSync(holderFile(t.agent.dir))).toBe(false);
		expect(existsSync(sessionDir(t.agent.dir, "s1"))).toBe(false);
	});

	it("leaves no timer running when its first look already ends it", async () => {
		const t = testAgent();
		const set = vi.spyOn(globalThis, "setInterval");
		const clear = vi.spyOn(globalThis, "clearInterval");
		try {
			const holder = (await start(t, { alive: () => false }))!;
			await holder.done;
			const timers = set.mock.results.map((result) => result.value as unknown);
			expect(timers).toHaveLength(1);
			expect(clear.mock.calls.map(([timer]) => timer as unknown)).toEqual(timers);
		} finally {
			set.mockRestore();
			clear.mockRestore();
		}
	});

	it("still yields, and still ends with its session, while writing the view keeps failing", async () => {
		const t = testAgent({ setup: true });
		// A folder takes the view's place: every write of the view fails.
		mkdirSync(viewFile(t.folder), { recursive: true });
		const asked = (await start(t))!;
		spool(t.agent, "s1", { kind: "prompt", text: "hello" }, 111);
		await waitUntil(() => messages(t.agent).length === 1);
		expect(requestYield(t.agent.dir, 111)).toBe(true);
		await within(asked.done, 3000);
		expect(readHolder(t.agent.dir)).toBeUndefined();
		let running = true;
		const ending = (await start(t, { session: "s2", nonce: "n2", alive: () => running }))!;
		spool(t.agent, "s2", { kind: "prompt", text: "again" }, 111);
		await waitUntil(() => messages(t.agent).length === 2);
		running = false;
		await within(ending.done, 3000);
		expect(readHolder(t.agent.dir)).toBeUndefined();
	});

	it("stops writing the view once git would see it mid-session: takes the marker back, deletes the view it wrote, and logs why", async () => {
		const t = testAgent();
		gitIn(t.folder)("init", "-q");
		claudeSetup(t.agent);
		const lines: string[] = [];
		await start(t, { log: (line) => lines.push(line) });
		spool(t.agent, "s1", { kind: "prompt", text: "hello" }, 111);
		await waitUntil(() => existsSync(viewFile(t.folder)));
		writeFileSync(join(t.folder, ".gitignore"), "!.orrery/\n");
		spool(t.agent, "s1", { kind: "reply", text: "hi" }, 111);
		await waitUntil(() => messages(t.agent).length === 2 && readSetupMarker(t.agent.dir) === undefined && !existsSync(viewFile(t.folder)));
		spool(t.agent, "s1", { kind: "prompt", text: "still recording" }, 111);
		await waitUntil(() => messages(t.agent).length === 3);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(existsSync(viewFile(t.folder))).toBe(false);
		// One line: the agent and the kind of exposure, no file names from the repo.
		expect(lines.filter((line) => line.includes("withdrawn"))).toEqual(["s1: Test's memory view withdrawn: git would see it (not ignored)"]);
	});

	it("logs once a view taken out while git cannot answer, and once a withdrawal that failed (agent and kind only)", async () => {
		const t = testAgent();
		gitIn(t.folder)("init", "-q");
		claudeSetup(t.agent);
		const lines: string[] = [];
		await start(t, { log: (line) => lines.push(line) });
		let n = 0;
		const say = async (text: string) => {
			spool(t.agent, "s1", { kind: n % 2 === 0 ? "prompt" : "reply", text }, 111);
			n += 1;
			await waitUntil(() => messages(t.agent).length === n && holder().agent.view.settled);
			await new Promise((resolve) => setTimeout(resolve, 60));
		};
		const holder = () => holders[holders.length - 1];
		await say("hello");
		expect(existsSync(viewFile(t.folder))).toBe(true);
		// Git cannot answer: the view goes until it does, the marker stays.
		await withGit(brokenGit(t), async () => {
			await say("one");
			await say("two");
		});
		expect([existsSync(viewFile(t.folder)), readSetupMarker(t.agent.dir) !== undefined]).toEqual([false, true]);
		await say("back");
		expect(existsSync(viewFile(t.folder))).toBe(true);
		// Git would see it, but the view cannot be deleted: the marker stays, and the holder tries again.
		writeFileSync(join(t.folder, ".gitignore"), "!.orrery/\n");
		chmodSync(join(t.folder, ".orrery"), 0o500);
		try {
			await say("three");
			await say("four");
			expect([existsSync(viewFile(t.folder)), readSetupMarker(t.agent.dir) !== undefined]).toEqual([true, true]);
		} finally {
			chmodSync(join(t.folder, ".orrery"), 0o700);
		}
		await say("five");
		expect([existsSync(viewFile(t.folder)), readSetupMarker(t.agent.dir)]).toEqual([false, undefined]);
		expect(lines.filter((line) => line.includes("memory view"))).toEqual([
			"s1: Test's memory view taken out until git answers again (unchecked)",
			"s1: Test's memory view could not be withdrawn: git would see it (not ignored); trying again",
			"s1: Test's memory view withdrawn: git would see it (not ignored)",
		]);
	});

	it("says once that it cannot write the view, not on every tick", async () => {
		const t = testAgent({ setup: true });
		mkdirSync(viewFile(t.folder), { recursive: true });
		const lines: string[] = [];
		await start(t, { log: (line) => lines.push(line) });
		spool(t.agent, "s1", { kind: "prompt", text: "hello" }, 111);
		await waitUntil(() => messages(t.agent).length === 1);
		await new Promise((resolve) => setTimeout(resolve, 200));
		const failures = lines.filter((line) => line.includes(viewFile(t.folder)));
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatch(/^s1: writing the view: /);
	});

	it("never records what a session spooled after SessionStart ran (since) when it turns read-only", async () => {
		const t = testAgent();
		const since = Date.now() - 1000;
		spool(t.agent, "s1", { kind: "prompt", text: "before SessionStart" }, 111, since - 500);
		// SessionStart ran, the holder was still loading its modules, and the user typed: pi holds the agent.
		spool(t.agent, "s1", { kind: "prompt", text: "after SessionStart, before the holder answered" }, 111, since + 500);
		const pi = MemoryStore.open(join(t.agent.dir, "memory.sqlite"));
		try {
			expect(await start(t, { since, yieldWaitMs: 200 })).toBeUndefined();
			expect(readMode(t.agent.dir, "s1")).toMatchObject({ mode: "read-only", since });
		} finally {
			pi.close();
		}
		await start(t, { session: "s2", claudePid: 222, nonce: "n2" });
		await waitUntil(() => messages(t.agent).length >= 1);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(messages(t.agent)).toEqual(["user: before SessionStart"]);
	});

	it("keeps the mode a resumed session's new holder writes while the old holder cleans up after it", async () => {
		const t = testAgent();
		const holder = (await start(t))!;
		const close = holder.agent.close.bind(holder.agent);
		vi.spyOn(holder.agent, "close").mockImplementation(async () => {
			await close();
			// The session is resumed at once: its new holder takes the agent and answers before the old one cleans up.
			writeMode(t.agent.dir, "s1", { mode: "recording", pid: process.pid + 1, claudePid: 111, nonce: "n2", since: Date.now() });
		});
		spool(t.agent, "s1", { kind: "end" }, 111);
		await within(holder.done, 3000);
		expect(readMode(t.agent.dir, "s1")?.nonce).toBe("n2");
	});

	it("keeps what a resumed session writes while it sweeps that session's old folder", async () => {
		const t = testAgent();
		writeMode(t.agent.dir, "x", { mode: "recording", pid: 1, claudePid: 999, nonce: "old", since: 0 });
		let resumed = false;
		await start(t, {
			alive: (pid) => {
				// The sweep finds x's Claude Code gone; just then x is resumed: its new holder and its hook write.
				if (pid === 999 && !resumed) {
					resumed = true;
					writeMode(t.agent.dir, "x", { mode: "read-only", pid: 2, claudePid: 333, nonce: "new", since: Date.now() });
					spool(t.agent, "x", { kind: "prompt", text: "resumed while read-only" }, 333);
				}
				return pid === 111 || pid === 333;
			},
		});
		await waitUntil(() => resumed);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(readMode(t.agent.dir, "x")?.nonce).toBe("new");
		expect(pendingEvents(t.agent.dir, "x")).toHaveLength(1);
		expect(messages(t.agent)).toEqual([]);
	});

	it("ignores a SessionEnd that an earlier run of the same session left in the spool", async () => {
		const t = testAgent();
		spool(t.agent, "s1", { kind: "end" }, 111, Date.now() - 60_000);
		const holder = (await start(t))!;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(holder.state).toBe("recording");
	});

	it("yields once its session ended to whoever opens the agent next; while recording, only to its own Claude Code", async () => {
		const t = testAgent();
		const gate = gated();
		const a = (await start(t, { session: "a", claudePid: 111, models: gate.models }))!;
		expect(await start(t, { session: "b", claudePid: 222, yieldWaitMs: 300 })).toBeUndefined();
		expect(readMode(t.agent.dir, "b")?.mode).toBe("read-only");
		const c = (await start(t, { session: "c", claudePid: 111, models: gate.models }))!;
		await a.done;
		expect(readMode(t.agent.dir, "c")?.mode).toBe("recording");
		spool(t.agent, "c", { kind: "prompt", text: LONG("Pending at the end") }, 111);
		spool(t.agent, "c", { kind: "end" }, 111);
		await waitUntil(() => c.state === "finishing");
		const d = (await start(t, { session: "d", claudePid: 222 }))!;
		await c.done;
		expect(readHolder(t.agent.dir)).toMatchObject({ session: "d", state: "recording" });
		expect(messages(t.agent)).toEqual([`user: ${LONG("Pending at the end")}`]);
		expect(d.state).toBe("recording");
	});

	it("applies a summary model chosen through the spool (orrery compactor while a session records)", async () => {
		const t = testAgent();
		const holder = (await start(t))!;
		spool(t.agent, "s1", { kind: "compactor", args: "faux-agent/faux-1 low" }, 111);
		await waitUntil(() => holder.agent.compactorSource === "chat");
		expect(holder.agent.store.getMeta("lane.compactor-model")).toBe(JSON.stringify({ provider: "faux-agent", modelId: "faux-1", thinking: "low" }));
	});
});
