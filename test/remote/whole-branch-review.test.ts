import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentRemoteCommand, pullAgentCommand, setStorageForTests } from "../../src/cli/remote.ts";
import { Agent } from "../../src/agent/agent.ts";
import { MemoryAgent } from "../../src/agent/memory-agent.ts";
import { AgentHeld } from "../../src/agent/memory-agent.ts";
import { agentModelSource } from "../../src/agent/model-source.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { checkOutAgent, withBriefCheckOut } from "../../src/remote/checkout.ts";
import { unseal } from "../../src/remote/crypto.ts";
import * as remotes from "../../src/remote/index.ts";
import { RemoteError, STALE_MS } from "../../src/remote/types.ts";
import { realDeps } from "../../src/tui/deps.ts";
import { fauxModels, agentConfigToml } from "../agent/support.ts";
import { checkoutFixture } from "./checkout-fixture.ts";

let f: Awaited<ReturnType<typeof checkoutFixture>>;
let pi: MemoryAgent | undefined;
let path: string;
const reports: string[] = [];
beforeEach(async () => {
	f = await checkoutFixture();
	path = join(f.root, "config.toml");
	writeFileSync(path, `${agentConfigToml({ dataDir: f.config.dataDir, folder: f.agent.folder, extra: 'remote = "home"' })}\n[remotes.home]\nkind = "cloudflare"\nurl = "https://example.invalid"\n`);
	reports.length = 0;
	vi.spyOn(remotes, "openStorage").mockReturnValue(f.storage);
	setStorageForTests(() => f.storage);
});
afterEach(async () => { await pi?.close(); pi = undefined; setStorageForTests(undefined); vi.restoreAllMocks(); f.close(); });
async function openPi() {
	pi = await MemoryAgent.openChecked({ config: f.config, agent: f.agent, models: agentModelSource(fauxModels().models), report: (m) => reports.push(m) });
	return pi;
}

it.each(["brief", "run", "takeover", "local", "pull"])("%s refuses the live local pi before touching a stale remote lock", async (operation) => {
	const first = await openPi();
	f.clock.value += STALE_MS + 1;
	const take = vi.spyOn(f.storage, "take");
	const release = vi.spyOn(f.storage, "release");
	if (operation === "pull") writeFileSync(path, `data_dir = ${JSON.stringify(f.config.dataDir)}\n[remotes.home]\nkind = "cloudflare"\nurl = "https://example.invalid"\n`);
	const work = operation === "brief" ? withBriefCheckOut(f.config, f.agent, () => { throw new Error("must not write"); }, () => {})
		: operation === "run" ? Agent.open({ config: f.config, agent: "Test", models: fauxModels().models })
		: operation === "pull" ? pullAgentCommand(path, "Test", "home", f.agent.folder)
		: agentRemoteCommand(path, [operation, "Test"], operation === "takeover" ? { yes: true } : {});
	await expect(work).rejects.toThrow(/already open|held locally|open on this machine/i);
	expect(take).not.toHaveBeenCalled();
	expect(release).not.toHaveBeenCalled();
	await first.remote!.renew();
	expect(first.remote!.lost).toBe(false);
	expect(first.store.writable).toBe(true);
	expect(reports.some((m) => m.includes("moved"))).toBe(false);
});

it.each(["brief", "run", "takeover", "local", "pull"])("%s keeps its local writer reservation while taking the remote lock", async (operation) => {
	if (operation === "takeover") {
		await f.storage.take("Test", { machine: "macbook", device: "other", pid: 1 });
		f.clock.value += STALE_MS + 1;
	}
	if (operation === "pull") writeFileSync(path, `data_dir = ${JSON.stringify(f.config.dataDir)}\n[remotes.home]\nkind = "cloudflare"\nurl = "https://example.invalid"\n`);
	const take = f.storage.take.bind(f.storage);
	vi.spyOn(f.storage, "take").mockImplementation(async (...args) => {
		expect(() => MemoryStore.open(join(f.agent.dir, "memory.sqlite")).close()).toThrow(/already open/i);
		return take(...args);
	});
	if (operation === "brief") await withBriefCheckOut(f.config, f.agent, () => {}, () => {});
	else if (operation === "run") { const agent = await Agent.open({ config: f.config, agent: "Test", models: fauxModels().models }); await agent.close(); }
	else if (operation === "pull") await pullAgentCommand(path, "Test", "home", f.agent.folder);
	else await agentRemoteCommand(path, [operation, "Test"], operation === "takeover" ? { yes: true } : {});
	MemoryStore.open(join(f.agent.dir, "memory.sqlite")).close();
});

it("pi refuses an agent held by a brief writer without touching or losing the brief writer's remote lock", async () => {
	await withBriefCheckOut(f.config, f.agent, async (remote) => {
		f.clock.value += STALE_MS + 1;
		const take = vi.spyOn(f.storage, "take");
		await expect(openPi()).rejects.toBeInstanceOf(AgentHeld);
		expect(take).not.toHaveBeenCalled();
		await remote!.renew();
		expect(remote!.lost).toBe(false);
	}, (m) => reports.push(m));
	expect(reports.some((m) => m.includes("moved"))).toBe(false);
});

it.each(["CLI", "TUI"])("audits a %s takeover on the next checkout's first save, once", async (source) => {
	await f.storage.take("Test", { machine: "old laptop", device: "other", pid: 1 });
	f.clock.value += STALE_MS + 1;
	if (source === "CLI") await agentRemoteCommand(path, ["takeover", "Test"], { yes: true });
	else await realDeps({ configPath: path, tui: { requestRender: () => {} } as unknown as TUI, quit: () => {} }).takeoverAgent!("Test");
	const marker = join(f.agent.dir, "takeover-from.json");
	expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ machine: "old laptop" });
	const agent = await openPi();
	expect(existsSync(marker)).toBe(false);
	agent.store.append("talk", "first after takeover");
	await agent.remote!.save();
	agent.store.append("talk", "ordinary next save");
	await agent.remote!.save();
	const logs = (await f.storage.log("Test")).map((entry) => JSON.parse(Buffer.from(unseal(f.key, "Test", "log", entry.n, entry.file)).toString("utf8")));
	expect(logs.map((log) => log.takeover)).toEqual([{ from: "old laptop" }, undefined]);
});

it("keeps the takeover marker when checkout fails before restoring memory", async () => {
	await f.storage.take("Test", { machine: "old laptop", device: "other", pid: 1 });
	f.clock.value += STALE_MS + 1;
	await agentRemoteCommand(path, ["takeover", "Test"], { yes: true });
	const fetch = f.storage.fetch.bind(f.storage);
	vi.spyOn(f.storage, "fetch").mockImplementation(async (agent, after) => { if (after === -1) throw new RemoteError("unreachable", "offline"); return fetch(agent, after); });
	await expect(openPi()).rejects.toMatchObject({ kind: "unreachable" });
	expect(JSON.parse(readFileSync(join(f.agent.dir, "takeover-from.json"), "utf8"))).toEqual({ machine: "old laptop" });
	expect((await f.storage.list())[0].lock?.held).toBe(false);
});

it("audits locally pending rows when checkout itself sends the first save after a command takeover", async () => {
	const remote = await checkOutAgent(f.config, f.agent, { report: () => {} });
	await remote!.close();
	const store = MemoryStore.open(join(f.agent.dir, "memory.sqlite"));
	store.append("talk", "pending from an offline close");
	store.close();
	await f.storage.take("Test", { machine: "old laptop", device: "other", pid: 1 });
	f.clock.value += STALE_MS + 1;
	await agentRemoteCommand(path, ["takeover", "Test"], { yes: true });
	const agent = await openPi();
	agent.store.append("talk", "after opening");
	await agent.remote!.save();
	const logs = (await f.storage.log("Test")).map((entry) => JSON.parse(Buffer.from(unseal(f.key, "Test", "log", entry.n, entry.file)).toString("utf8")));
	expect(logs[0].takeover).toEqual({ from: "old laptop" });
	expect(logs.slice(1).map((log) => log.takeover)).toEqual([undefined]);
});
