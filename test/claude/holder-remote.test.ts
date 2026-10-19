import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Holder } from "../../src/claude/holder.ts";
import { runHook } from "../../src/claude/hooks.ts";
import { claudeSetupMod } from "../../src/claude/setup.ts";
import { readMode } from "../../src/claude/spool.ts";
import { agentModelSource } from "../../src/agent/model-source.ts";
import { MemoryAgent } from "../../src/agent/memory-agent.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import * as remotes from "../../src/remote/index.ts";
import { STALE_MS } from "../../src/remote/types.ts";
import { fauxModels } from "../agent/support.ts";
import { checkoutFixture } from "../remote/checkout-fixture.ts";
import { spool } from "./support.ts";
import { transcriptIn } from "./transcript-lines.ts";

let f: Awaited<ReturnType<typeof checkoutFixture>>;
let holder: Holder | undefined;
const reports: string[] = [];
beforeEach(async () => { f = await checkoutFixture(); reports.length = 0; vi.spyOn(remotes, "openStorage").mockImplementation(() => f.storage); });
afterEach(async () => { await holder?.stop("test cleanup"); holder = undefined; vi.restoreAllMocks(); f.close(); });
async function start() {
	holder = await Holder.start({ config: f.config, agent: f.agent, session: "remote-session", claudePid: process.pid, nonce: "test", models: agentModelSource(fauxModels().models), log: (m) => reports.push(m), tickMs: 60_000 });
	return holder;
}

it("a remote Claude holder finishing summaries yields before pi takes the remote lock", async () => {
	await start();
	const previous = holder!;
	previous.agent.compactor.summarizer = { summarize: () => new Promise(() => {}) };
	spool(f.agent, "remote-session", { kind: "prompt", text: "pending summary ".repeat(1000) }, process.pid);
	spool(f.agent, "remote-session", { kind: "end" }, process.pid);
	previous.tick();
	expect(previous.state).toBe("finishing");
	const take = f.storage.take.bind(f.storage);
	vi.spyOn(f.storage, "take").mockImplementation(async (...args) => {
		expect(previous.agent.store.writable).toBe(false);
		return take(...args);
	});
	const ticker = setInterval(() => previous.tick(), 10);
	let pi: MemoryAgent | undefined;
	try {
		pi = await MemoryAgent.openChecked({ config: f.config, agent: f.agent, models: agentModelSource(fauxModels().models), report: () => {} });
		await previous.done;
		expect(pi.remote).toBeDefined();
		expect(pi.store.writable).toBe(true);
	} finally { clearInterval(ticker); await pi?.close(); }
});

it("checks out at recorder start, saves an ingested turn and releases at session end", async () => {
	await start();
	expect(holder?.agent.store.root[0].text).toBe("from the remote");
	spool(f.agent, "remote-session", { kind: "prompt", text: "hello" }, process.pid);
	spool(f.agent, "remote-session", { kind: "reply", text: "recorded reply" }, process.pid);
	holder!.tick();
	await vi.waitFor(async () => expect((await f.storage.fetch("Test", 0)).newestSave).toBeGreaterThan(0));
	spool(f.agent, "remote-session", { kind: "end" }, process.pid);
	holder!.tick();
	await holder!.done;
	expect((await f.storage.list())[0].lock?.held).toBe(false);
});

it("a stale remote lock opens read-only and reports the explicit takeover command", async () => {
	await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 });
	f.clock.value += STALE_MS + 1;
	expect(await start()).toBeUndefined();
	expect(readMode(f.agent.dir, "remote-session")).toMatchObject({ mode: "read-only", reason: expect.stringContaining("run orrery agent takeover Test") });
	expect(reports.join("\n")).toContain("run orrery agent takeover Test");
	expect(existsSync(join(f.agent.dir, "memory.sqlite"))).toBe(false);
});

it("a recorder that loses its lock stops recording and leaves later hooks read-only", async () => {
	await start();
	f.clock.value += STALE_MS + 1;
	await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 }, { force: true });
	await holder!.agent.remote!.renew();
	spool(f.agent, "remote-session", { kind: "reply", text: "must not be recorded" }, process.pid);
	holder!.tick();
	await holder!.done;
	expect(readMode(f.agent.dir, "remote-session")?.mode).toBe("read-only");
	expect(holder!.agent.store.root.map((m) => m.text)).toEqual(["from the remote"]);
	expect((await f.storage.fetch("Test", 0)).newestSave).toBe(0);
});


it("hands a remote agent to a new session of the same Claude process", async () => {
	await start();
	const previous = holder!;
	const ticker = setInterval(() => previous.tick(), 10);
	try {
		const next = await Holder.start({ config: f.config, agent: f.agent, session: "next-session", claudePid: process.pid, nonce: "next", models: agentModelSource(fauxModels().models), log: (m) => reports.push(m), tickMs: 60_000, yieldWaitMs: 1000 });
		if (next !== undefined) holder = next;
		expect(next).toBeDefined();
		await previous.done;
		expect(next!.agent.store.writable).toBe(true);
		expect((await f.storage.list())[0].lock?.held).toBe(true);
	} finally { clearInterval(ticker); await previous.stop("cleanup"); }
});


it.each(["fresh elsewhere", "own live holder"])("does not suggest takeover for a %s", async (kind) => {
	// Another live process on this machine (the parent): this process's own pid would count as a lock it left behind.
	await f.storage.take("Test", kind === "own live holder" ? { ...remotes.holderFor(f.config), pid: process.ppid } : { machine: "macbook", device: "other", pid: 1 });
	expect(await start()).toBeUndefined();
	expect(readMode(f.agent.dir, "remote-session")?.reason).not.toContain("orrery agent takeover");
	expect(reports.join("\n")).not.toContain("orrery agent takeover");
});

it.each(["existing memory", "split history"])("shows %s check-out notices at session start while recording", async (kind) => {
	claudeSetupMod(f.agent);
	if (kind === "split history") {
		await start();
		await holder!.stop("first session over");
	}
	const local = MemoryStore.open(join(f.agent.dir, "memory.sqlite"));
	local.append("user", "this machine's unsaved memory");
	local.close();
	if (kind === "split history") {
		const other = await MemoryAgent.openChecked({ config: f.config, agent: { ...f.agent, dir: join(f.root, "other-machine") }, models: agentModelSource(fauxModels().models), report: () => {} });
		other.store.append("user", "another machine's new turn");
		await other.close();
	}
	await start();
	const mode = readMode(f.agent.dir, "remote-session");
	expect(mode?.mode).toBe("recording");
	expect(mode?.reason).toMatch(kind === "split history" ? /unsaved-.*\.json/ : /memory already on this machine was kept aside/);
	// SessionStart from its Claude Code (this process), its transcript in a scratch config folder.
	const transcript = transcriptIn(f.root);
	const input = JSON.stringify({ session_id: "remote-session", cwd: f.agent.folder, transcript_path: transcript.path("remote-session") });
	const out = JSON.parse(await runHook("session-start", input, {
		config: f.config, env: { CLAUDE_PROJECT_DIR: f.agent.folder, CLAUDE_CONFIG_DIR: transcript.configDir }, claudePid: process.pid, peer: () => process.pid, home: join(f.root, "home"),
		startHolder: () => { throw new Error("holder is already running"); },
	}));
	expect(out.systemMessage).toContain(mode!.reason);
	// A /compact reuses the recorder and runs SessionStart again: the notice isn't said twice.
	const again = JSON.parse(await runHook("session-start", input, {
		config: f.config, env: { CLAUDE_PROJECT_DIR: f.agent.folder, CLAUDE_CONFIG_DIR: transcript.configDir }, claudePid: process.pid, peer: () => process.pid, home: join(f.root, "home"),
		startHolder: () => { throw new Error("holder is already running"); },
	}));
	expect(again.systemMessage ?? "").not.toContain(mode!.reason);
	expect(out.hookSpecificOutput.additionalContext).toContain(mode!.reason);
});
