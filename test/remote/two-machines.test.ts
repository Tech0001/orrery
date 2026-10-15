/** Task 11: two independent machine configs use the commands, writer checkout, and reader tools together. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRemoteCommand, remoteCommand, setStorageForTests } from "../../src/cli/remote.ts";
import { loadConfig } from "../../src/agent/config.ts";
import { MemoryAgent } from "../../src/agent/memory-agent.ts";
import { readerTools } from "../../src/agent/memory-tools.ts";
import { agentModelSource } from "../../src/agent/model-source.ts";
import { readStatus } from "../../src/agent/status-file.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import * as remotes from "../../src/remote/index.ts";
import { readRemoteSecret } from "../../src/remote/secrets.ts";
import { type LockState, RemoteError, STALE_MS, type Storage } from "../../src/remote/types.ts";
import { fauxModels } from "../agent/support.ts";
import { fakeSsh } from "./fake-ssh.ts";

type Machine = { path: string; folder: string; reports: string[] };
let root: string;
let setOffline: (offline: boolean) => void;
const opened = new Set<MemoryAgent>();
const noPrompt = { secret: async () => { throw new Error("The command unexpectedly asked for a secret instead of using --code-file"); } };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "orrery-two-machines-"));
	setOffline = () => {};
});
afterEach(async () => {
	setOffline(false);
	try { for (const agent of opened) await close(agent); }
	finally {
		setStorageForTests(undefined);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});

function machine(name: string, source = false): Machine {
	const dir = join(root, name), folder = join(dir, "folder"), path = join(dir, "config.toml");
	mkdirSync(folder, { recursive: true });
	writeFileSync(path, `data_dir = ${JSON.stringify(join(dir, "data"))}
machine_name = ${JSON.stringify(name)}
[hosts.server]
host = "fake.invalid"
user = "test"
identity_file = "ssh/test-identity"
known_hosts = "ssh/test-known-hosts"
${source ? `[agents.Atlas]
folder = ${JSON.stringify(folder)}
compactor_model = "faux-compactor/faux-1"
compactor_thinking = "off"
[agents.Birch]
folder = ${JSON.stringify(folder)}
compactor_model = "faux-compactor/faux-1"
compactor_thinking = "off"
reads = ["Atlas"]
` : ""}`);
	return { path, folder, reports: [] };
}

async function open(machine: Machine, name = "Atlas", confirmTakeover?: (held: LockState) => Promise<boolean>): Promise<MemoryAgent> {
	const config = loadConfig(machine.path);
	const memory = await MemoryAgent.openChecked({ config, agent: config.agents.get(name)!, models: agentModelSource(fauxModels().models),
		report: (message) => machine.reports.push(message), confirmTakeover });
	opened.add(memory);
	memory.writeStatus(false, true);
	return memory;
}

async function close(agent: MemoryAgent): Promise<void> {
	try {
		// Agent adapters publish closed status before MemoryAgent.close() tears down the store.
		agent.writeStatus(false, false);
		await agent.close();
	} finally { opened.delete(agent); }
}

function texts(machine: Machine): string[] {
	const agent = loadConfig(machine.path).agents.get("Atlas")!;
	const store = MemoryStore.openReadOnly(join(agent.dir, "memory.sqlite"));
	try { return store.root.map((row) => row.text); }
	finally { store.close(); }
}

async function turn(agent: MemoryAgent, storage: Storage, user: string, answer: string): Promise<void> {
	const before = (await storage.fetch("Atlas", 0)).newestSave;
	agent.view.append("user", user);
	agent.view.append("talk", answer);
	agent.afterTurn();
	// afterTurn is deliberately fire-and-forget. Observe its remote effect without issuing another save.
	await vi.waitFor(async () => expect((await storage.fetch("Atlas", 0)).newestSave).toBe(before + 1), { timeout: 10_000 });
	expect(agent.remote?.status().state).toBe("saved");
}

describe("two-machine command workflow", () => {
	it.each(["fake", "server"] as const)("hands memory between machines, fences writers, reads offline, and returns local (%s)", async (kind) => {
		const a = machine("machine-a", true), b = machine("machine-b");
		let clock = Date.now();
		let fake: Storage | undefined;
		if (kind === "fake") {
			let offline = false;
			fake = new Proxy(new FakeStorage({ name: "home", now: () => clock }), {
				get(target, prop) {
					const value = Reflect.get(target, prop);
					if (typeof value !== "function") return value;
					return (...args: unknown[]) => offline ? Promise.reject(new RemoteError("unreachable", "test remote is down")) : value.apply(target, args);
				},
			});
			setOffline = (value) => { offline = value; };
			setStorageForTests(() => fake!);
			// The command hook is CLI-only; writer and reader factories receive the same fake remote.
			vi.spyOn(remotes, "openStorage").mockImplementation(() => fake!);
		} else {
			const home = join(root, "server"), bin = join(root, "bin"), ssh = join(bin, "ssh");
			mkdirSync(bin);
			const connected = fakeSsh(home, undefined, { ORRERY_TEST_STALE_SECONDS: "1" });
			const disconnected = fakeSsh(home, "connect");
			symlinkSync(connected.path, ssh);
			setOffline = (value) => { unlinkSync(ssh); symlinkSync(value ? disconnected.path : connected.path, ssh); };
			// All server clients, including those opened inside agent_memory, use the real storage factory.
			vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
		}

		// A initializes the remote through the command and pushes its closed local memory.
		const added = await remoteCommand(a.path, ["add", "home"], { server: "server:agents" }, noPrompt);
		const code = added.split("\n").find((line) => /^[A-Za-z0-9_-]{43}$/.test(line));
		if (code === undefined) throw new Error("First remote add did not return a recovery code");
		const original = await open(a);
		original.view.append("user", "A's original turn");
		original.view.append("talk", "A's original answer");
		original.afterTurn();
		await close(original);
		expect(await agentRemoteCommand(a.path, ["push", "Atlas"], { to: "home" })).toContain("Pushed Atlas");
		const storage = remotes.openStorage(loadConfig(a.path), "home");
		expect((await storage.list())[0].lock?.held).toBe(false);
		expect(loadConfig(a.path).agents.get("Atlas")?.remote).toBe("home");

		// B has a different config, secret file, device identity, and agent directory; only the remote is shared.
		const codeFile = join(root, "machine-b", "recovery-code");
		writeFileSync(codeFile, `${code}\n`, { mode: 0o600 });
		expect(await remoteCommand(b.path, ["add", "home"], { server: "server:agents", "code-file": codeFile }, noPrompt)).toContain("Added remote home");
		expect(readRemoteSecret(loadConfig(b.path), "home")?.key).toBe(code);
		expect(await agentRemoteCommand(b.path, ["pull", "Atlas"], { from: "home", folder: b.folder })).toContain("Pulled Atlas");
		const configA = loadConfig(a.path), configB = loadConfig(b.path);
		expect(configB.dataDir).not.toBe(configA.dataDir);
		expect(configB.agents.get("Atlas")?.dir).not.toBe(configA.agents.get("Atlas")?.dir);
		expect(remotes.holderFor(configB).device).not.toBe(remotes.holderFor(configA).device);
		const firstB = await open(b);
		expect(firstB.store.root.map((row) => row.text)).toEqual(["A's original turn", "A's original answer"]);
		await turn(firstB, storage, "B's first turn", "B's first answer");
		await close(firstB);
		const firstA = await open(a);
		expect(firstA.store.root.map((row) => row.text)).toEqual(["A's original turn", "A's original answer", "B's first turn", "B's first answer"]);
		await close(firstA);

		// A is refused while B is fresh. Once B goes quiet, A must explicitly confirm the takeover.
		const heldB = await open(b);
		await expect(open(a)).rejects.toMatchObject({ kind: "held", message: expect.stringContaining("Atlas is open on machine-b") });
		if (kind === "fake") clock += STALE_MS + 1;
		await vi.waitFor(async () => expect((await storage.list())[0].lock).toMatchObject({ held: true, stale: true }), { timeout: 10_000 });
		const confirm = vi.fn(async (held: LockState) => {
			expect(held).toMatchObject({ stale: true, holder: { machine: "machine-b" } });
			return true;
		});
		const takenA = await open(a, "Atlas", confirm);
		expect(confirm).toHaveBeenCalledOnce();
		expect((await storage.list())[0].lock).toMatchObject({ held: true, holder: { machine: "machine-a" } });
		const beforeRefusal = (await storage.fetch("Atlas", 0)).newestSave;
		heldB.view.append("user", "B's fenced-out turn");
		heldB.afterTurn();
		await vi.waitFor(() => {
			expect(heldB.remote?.status().state).toBe("lost");
			expect(heldB.store.writable).toBe(false);
			expect(readStatus(heldB.config.dir)).toMatchObject({ open: false, busy: false });
		}, { timeout: 10_000 });
		expect(heldB.remote?.lost).toBe(true);
		expect(() => heldB.view.append("talk", "must not record after loss")).toThrow(/closed/i);
		expect(heldB.statusLine()).toContain("home: moved to machine-a");
		expect(b.reports.some((message) => message.includes("runs without memory"))).toBe(true);
		expect((await storage.fetch("Atlas", 0)).newestSave).toBe(beforeRefusal);
		await close(heldB);
		await turn(takenA, storage, "A's takeover turn", "A's takeover answer");
		await close(takenA);

		// B holds a newer copy while A's Birch reads it without taking B's lock or using A's old working copy.
		const readingB = await open(b);
		await turn(readingB, storage, "B's reader-visible turn", "B's reader-visible answer");
		expect(texts(a)).not.toContain("B's reader-visible turn");
		const reader = await open(a, "Birch");
		expect(reader.config.reads).toEqual(["Atlas"]);
		const agentMemory = readerTools(() => reader.config, loadConfig(a.path)).find((tool) => tool.name === "agent_memory")!;
		const lockBeforeRead = (await storage.list())[0].lock;
		// Zoom reads the full message even when its summary has not been built or saved yet.
		const readTurn = { agent: "Atlas", action: "zoom", id: readingB.store.root.length - 2, n: 1 };
		const view = await agentMemory.run(readTurn);
		expect(view).toContain("B's reader-visible turn");
		expect(await agentMemory.run({ ...readTurn, id: readTurn.id + 1 })).toContain("B's reader-visible answer");
		expect(view).not.toContain("B's fenced-out turn");
		expect(view).not.toContain("(as of ");
		// Reading leaves B's lock as it was. Its "stale" flag is the server's clock against a one-second limit, which a slow
		// machine can pass during a read, so it is left out of the comparison.
		expect({ ...(await storage.list())[0].lock, stale: undefined }).toEqual({ ...lockBeforeRead, stale: undefined });
		expect(lockBeforeRead).toMatchObject({ held: true, holder: { machine: "machine-b" } });
		// Advance only the reader's client clock past its 60-second cache lifetime; server staleness stays real.
		const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
		setOffline(true);
		try {
			const cached = await agentMemory.run(readTurn);
			expect(cached).toMatch(/^\(as of \d{2}:\d{2}\)\n/);
			expect(cached.replace(/^\(as of \d{2}:\d{2}\)\n/, "")).toBe(view);
		} finally { later.mockRestore(); setOffline(false); }
		expect({ ...(await storage.list())[0].lock, stale: undefined }).toEqual({ ...lockBeforeRead, stale: undefined });
		await close(reader);

		// local must fetch a final save absent from both A's working copy and its cached reader copy.
		await turn(readingB, storage, "B's newest turn before local", "B's newest answer before local");
		await close(readingB);
		expect(texts(a)).not.toContain("B's newest turn before local");
		expect(await agentRemoteCommand(a.path, ["local", "Atlas"])).toContain("now keeps its memory locally");
		expect(loadConfig(a.path).agents.get("Atlas")?.remote).toBeUndefined();
		expect(texts(a)).toEqual(texts(b));
		expect(texts(a)).toContain("B's newest turn before local");
		expect(texts(a)).not.toContain("B's fenced-out turn");
		expect((await storage.list())[0]).toMatchObject({ lane: "Atlas", lock: { held: false } });
	}, 30_000);
});
