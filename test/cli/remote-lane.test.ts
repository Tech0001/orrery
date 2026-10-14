import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { laneRemoteCommand, pullLaneCommand, setStorageForTests } from "../../src/cli/remote.ts";
import { setLaneKey, editConfigFile } from "../../src/lane/config-edit.ts";
import { loadConfig } from "../../src/lane/config.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { createKey, keyToCode } from "../../src/remote/crypto.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { laneSettings, remoteLaneSettings } from "../../src/remote/save-format.ts";
import { saveRemoteSecret } from "../../src/remote/secrets.ts";
import { RemoteSession } from "../../src/remote/session.ts";
import { RemoteError, STALE_MS } from "../../src/remote/types.ts";
import { cleanEnv, cliCommand } from "../claude/support.ts";
import { tempDir } from "../lane/support.ts";

let dir: string;
let path: string;
let source: string;
let folder: string;
let storage: FakeStorage;
let key: Uint8Array;
let clock: number;
const peer = { machine: "macbook", device: "other-device", pid: 123 };
const yes = { confirm: async () => true };
const no = { confirm: async () => false };

function config(file: string, data: string, lanes = "") {
	writeFileSync(file, `# keep this comment\ndata_dir = ${JSON.stringify(data)}\nmachine_name = "pc"\n[remotes.home]\nkind = "cloudflare"\nurl = "https://example.com"\n${lanes}`);
	saveRemoteSecret(loadConfig(file), "home", { key: keyToCode(key), token: "private-token" });
}

beforeEach(() => {
	dir = tempDir("orrery-remote-lane-"); path = join(dir, "config.toml"); source = join(dir, "source.toml");
	folder = join(dir, "workspace"); mkdirSync(folder);
	clock = Date.parse("2026-10-12T14:02:00Z"); key = createKey();
	storage = new FakeStorage({ name: "home", now: () => clock }); setStorageForTests(() => storage);
	config(path, join(dir, "data"));
	config(source, join(dir, "source"), `[lanes.Atlas]\nworkspace = ${JSON.stringify(dir)}\ntool = "omp"\ncompactor_model = "openai/gpt-6.1-sol"\ncompactor_thinking = "high"\nview_bytes = 64000\ncompactor_jobs = 3\ncompact_at = 140000\nreads = ["*"]\n`);
	const store = MemoryStore.open(join(loadConfig(source).lanes.get("Atlas")!.dir, "memory.sqlite"));
	store.append("user", "from the first machine"); store.close();
});
afterEach(() => { setStorageForTests(undefined); rmSync(dir, { recursive: true, force: true }); });

function sourceOptions() {
	const lane = loadConfig(source).lanes.get("Atlas")!;
	return { lane: lane.name, laneDir: lane.dir, storage, key, holder: peer, settings: laneSettings(lane), report: () => {}, renewMs: 0 };
}
async function seed() { await RemoteSession.push(sourceOptions()); }
async function saveMore() {
	const session = await RemoteSession.checkOut(sourceOptions());
	const store = MemoryStore.open(join(sourceOptions().laneDir, "memory.sqlite"));
	session.attach(store); store.append("talk", "a newer remote turn");
	await session.close(); store.close();
}
function texts(file = path) {
	const store = MemoryStore.openReadOnly(join(loadConfig(file).lanes.get("Atlas")!.dir, "memory.sqlite"));
	try { return store.root.map((m) => m.text); } finally { store.close(); }
}
async function pull() { return pullLaneCommand(path, "Atlas", "home", folder); }

describe("lane push and pull", () => {
	it("pushes a closed local lane and its settings, then sets remote without losing comments", async () => {
		expect(await laneRemoteCommand(source, ["push", "atlas"], { to: "home" })).toContain("Atlas");
		expect(loadConfig(source).lanes.get("Atlas")?.remote).toBe("home");
		expect(readFileSync(source, "utf8")).toContain("# keep this comment");
		expect((await remoteLaneSettings(storage, key, "Atlas")).settings).toMatchObject({ tool: "omp", viewBytes: 64000, compactorJobs: 3, compactAt: 140000, reads: ["*"] });
		expect((await remoteLaneSettings(storage, key, "Atlas")).settings).not.toHaveProperty("instructions");
		expect((await storage.list())[0].lock?.held).toBe(false);
	});

	it("does not switch the config when push fails", async () => {
		const before = readFileSync(source, "utf8"); storage.snapshot = async () => { throw new RemoteError("unreachable", "offline"); };
		await expect(laneRemoteCommand(source, ["push", "Atlas"], { to: "home" })).rejects.toThrow("offline");
		expect(readFileSync(source, "utf8")).toBe(before);
		// A push that fails before its first snapshot takes the half-created lane off the remote again.
		expect(await storage.list()).toEqual([]);
	});
	it("can make the first push after Memory home has already selected this remote", async () => {
		editConfigFile(source, (text, d) => setLaneKey(text, d, "Atlas", "remote", "home"));
		await laneRemoteCommand(source, ["push", "Atlas"], { to: "home" });
		expect((await storage.fetch("Atlas", -1)).snapshot?.n).toBe(0);
	});

	it("refuses an open local store and a lane assigned to a different remote", async () => {
		const store = MemoryStore.open(join(sourceOptions().laneDir, "memory.sqlite"));
		try { await expect(laneRemoteCommand(source, ["push", "Atlas"], { to: "home" })).rejects.toThrow(/open.*close/i); } finally { store.close(); }
		expect(await storage.list()).toEqual([]);
		writeFileSync(source, `${readFileSync(source, "utf8")}\n[remotes.other]\nkind = "cloudflare"\nurl = "https://other.example.com"\n`);
		editConfigFile(source, (text, d) => setLaneKey(text, d, "Atlas", "remote", "other"));
		await expect(laneRemoteCommand(source, ["push", "Atlas"], { to: "home" })).rejects.toThrow(/already.*remote|keeps.*remote/i);
	});

	it("pulls the snapshot and later saves with portable settings and the chosen workspace", async () => {
		await seed(); await saveMore();
		await laneRemoteCommand(path, ["pull", "Atlas"], { from: "home", folder });
		expect(texts()).toEqual(["from the first machine", "a newer remote turn"]);
		expect(loadConfig(path).lanes.get("Atlas")).toMatchObject({ workspace: folder, remote: "home", tool: "omp", memory: { viewBytes: 64000 }, compactor: { jobs: 3, model: { thinking: "high" } }, compactAt: 140000, reads: ["*"] });
		expect(readFileSync(path, "utf8")).toContain("# keep this comment");
		expect((await storage.list())[0].lock?.held).toBe(false);
	});
	it("pulls without a folder: the lane has no workspace, and its instructions.md comes along", async () => {
		writeFileSync(join(loadConfig(source).lanes.get("Atlas")!.dir, "instructions.md"), "You are Atlas.\n");
		await seed();
		expect(await pullLaneCommand(path, "Atlas", "home")).toContain("Pulled Atlas from remote home.");
		const lane = loadConfig(path).lanes.get("Atlas")!;
		expect(lane.workspace).toBeUndefined();
		expect(readFileSync(join(lane.dir, "instructions.md"), "utf8")).toBe("You are Atlas.\n");
	});
	it("lane pull takes --folder only when it is given", async () => {
		await seed();
		await expect(laneRemoteCommand(path, ["pull", "Atlas"], { folder })).rejects.toThrow("lane pull needs --from <remote> (and --folder <dir> for a default folder).");
		expect(await laneRemoteCommand(path, ["pull", "Atlas"], { from: "home" })).toBe("Pulled Atlas from remote home.\n");
		expect(loadConfig(path).lanes.get("Atlas")?.workspace).toBeUndefined();
	});
	it("preserves the snapshot's summary size and summary-call size when pulling", async () => {
		await RemoteSession.push({ ...sourceOptions(), settings: { ...sourceOptions().settings, nodeBytes: 12000, contextBytes: 73000 } });
		await pull();
		expect(loadConfig(path).lanes.get("Atlas")).toMatchObject({ memory: { nodeBytes: 12000 }, compactor: { contextBytes: 73000 } });
	});

	it("drops an older snapshot's instructions setting: the pulled config never names it", async () => {
		await RemoteSession.push({ ...sourceOptions(), settings: { ...sourceOptions().settings, instructions: "GUIDE.md" } });
		await pull();
		expect(readFileSync(path, "utf8")).not.toContain("instructions");
		expect(loadConfig(path).lanes.get("Atlas")).toMatchObject({ remote: "home", tool: "omp" });
	});

	it("refuses a duplicate lane case-insensitively before contacting storage", async () => {
		const before = readFileSync(source, "utf8");
		await expect(pullLaneCommand(source, "atlas", "home", folder)).rejects.toThrow(/already exists/);
		expect(readFileSync(source, "utf8")).toBe(before); expect(await storage.list()).toEqual([]);
	});

	it("refuses a name orrery agent uses as a subcommand before contacting storage", async () => {
		const before = readFileSync(path, "utf8");
		await expect(pullLaneCommand(path, "Pull", "home", folder)).rejects.toThrow("Pull is a word orrery agent uses (add, set, edit, archive, push, pull, takeover, local); pick another name.");
		expect(readFileSync(path, "utf8")).toBe(before); expect(await storage.list()).toEqual([]);
	});

	it("refuses relative, missing and non-directory workspaces without registering the lane", async () => {
		await seed(); const before = readFileSync(path, "utf8");
		for (const bad of ["relative", join(dir, "missing"), path]) await expect(pullLaneCommand(path, "Atlas", "home", bad)).rejects.toThrow(/folder|directory|absolute/i);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("rolls back the added config after a held pull so the same pull can be retried", async () => {
		await seed(); const held = await storage.take("Atlas", peer); if (!held.ok) throw new Error("held");
		const before = readFileSync(path, "utf8");
		await expect(pull()).rejects.toThrow(/macbook/); expect(readFileSync(path, "utf8")).toBe(before);
		await storage.release("Atlas", held.lock); await pull(); expect(texts()).toEqual(["from the first machine"]);
	});
	it("keeps an intervening config edit if checkout fails while a pull is running", async () => {
		await seed();
		storage.take = async () => { writeFileSync(path, `${readFileSync(path, "utf8")}# edited during pull\n`); throw new RemoteError("unreachable", "offline"); };
		await expect(pull()).rejects.toThrow(/config changed.*review lanes.Atlas/i);
		expect(readFileSync(path, "utf8")).toContain("# edited during pull");
	});
	it("refuses missing reads dependencies before adding a lane", async () => {
		await RemoteSession.push({ ...sourceOptions(), settings: { ...sourceOptions().settings, reads: ["Missing"] } });
		const before = readFileSync(path, "utf8");
		await expect(pull()).rejects.toThrow(/pull.*first.*Missing/i);
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});

describe("lane takeover", () => {
	async function held() { await seed(); await pull(); await storage.take("Atlas", peer); clock += STALE_MS + 1; }
	it("shows the holder and last seen, asks, force-takes and releases without fetching", async () => {
		await held(); const questions: string[] = [];
		storage.fetch = async () => { throw new Error("takeover must not fetch"); };
		const out = await laneRemoteCommand(path, ["takeover", "Atlas"], {}, { confirm: async (q) => { questions.push(q); return true; } });
		expect(questions.join("\n")).toMatch(/Atlas.*macbook.*last seen/);
		expect(out).toContain("macbook"); expect((await storage.list())[0].lock).toMatchObject({ held: false, holder: { machine: "pc" } });
	});
	it("declining keeps the held lock, while --yes confirms without prompting", async () => {
		await held(); const before = await storage.list();
		expect(await laneRemoteCommand(path, ["takeover", "Atlas"], {}, no)).toMatch(/not taken|cancel/i);
		expect(await storage.list()).toEqual(before);
		await laneRemoteCommand(path, ["takeover", "Atlas"], { yes: true }, { confirm: async () => { throw new Error("unexpected prompt"); } });
		expect((await storage.list())[0].lock?.held).toBe(false);
	});
	it("does not take a fresh lock even with --yes", async () => {
		await held(); clock -= STALE_MS + 1; const before = await storage.list();
		await expect(laneRemoteCommand(path, ["takeover", "Atlas"], { yes: true })).rejects.toThrow(/macbook/);
		expect(await storage.list()).toEqual(before);
	});
});

describe("lane local", () => {
	it("fetches newer memory, clears remote and keeps the remote copy by default", async () => {
		await seed(); await pull(); await saveMore();
		await laneRemoteCommand(path, ["local", "Atlas"]);
		expect(texts()).toEqual(["from the first machine", "a newer remote turn"]);
		expect(loadConfig(path).lanes.get("Atlas")?.remote).toBeUndefined();
		expect((await storage.list())[0].lock?.held).toBe(false);
	});
	it("leaves remote configured when the up-to-date copy cannot be fetched", async () => {
		await seed(); await pull(); const before = readFileSync(path, "utf8");
		storage.fetch = async () => { throw new RemoteError("unreachable", "offline"); };
		await expect(laneRemoteCommand(path, ["local", "Atlas"])).rejects.toThrow("offline");
		expect(readFileSync(path, "utf8")).toBe(before);
	});
	it("--delete-remote asks and keeps the remote copy when declined", async () => {
		await seed(); await pull(); let question = "";
		await laneRemoteCommand(path, ["local", "Atlas"], { "delete-remote": true }, { confirm: async (q) => { question = q; return false; } });
		expect(question).toMatch(/delete.*Atlas.*home/i); expect(await storage.list()).toHaveLength(1);
		expect(loadConfig(path).lanes.get("Atlas")?.remote).toBeUndefined();
	});
	it("--delete-remote drops under a new lock only after confirmation", async () => {
		await seed(); await pull();
		await laneRemoteCommand(path, ["local", "Atlas"], { "delete-remote": true }, yes);
		expect(await storage.list()).toEqual([]); expect(texts()).toEqual(["from the first machine"]);
		expect(loadConfig(path).lanes.get("Atlas")?.remote).toBeUndefined();
	});
	it("does not delete a save made by another machine while the confirmation was open", async () => {
		await seed(); await pull();
		await expect(laneRemoteCommand(path, ["local", "Atlas"], { "delete-remote": true }, { confirm: async () => { await saveMore(); return true; } })).rejects.toThrow(/newer|changed|saved/i);
		expect((await storage.list())[0]).toMatchObject({ newestSave: 1, lock: { held: false } });
	});
	it("does not delete a replaced remote history with the same save number", async () => {
		await seed(); await pull();
		await expect(laneRemoteCommand(path, ["local", "Atlas"], { "delete-remote": true }, { confirm: async () => {
			const held = await storage.take("Atlas", peer); if (!held.ok) throw new Error("held");
			await storage.drop("Atlas", held.lock); await seed(); return true;
		} })).rejects.toThrow(/changed/);
		expect((await storage.list())[0]).toMatchObject({ newestSave: 0, lock: { held: false } });
	});
});

it("wires all four commands and their flags into main and help", () => {
	const cli = (...args: string[]) => {
		const c = cliCommand(["--config", path, ...args]);
		return spawnSync(c.cmd, c.args, { env: cleanEnv({}), encoding: "utf8", timeout: 15000 });
	};
	const help = cli("help").stdout;
	for (const action of ["push", "pull", "takeover", "local"]) expect(help).toContain(`lane ${action} <Lane>`);
	for (const args of [["push", "Missing", "--to", "home"], ["pull", "Atlas", "--from", "missing", "--folder", folder], ["takeover", "Missing", "--yes"], ["local", "Missing", "--delete-remote"]]) {
		const result = cli("lane", ...args); expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/No lane named|unknown remote/); expect(result.stderr).not.toMatch(/Unknown option|needs add/);
	}
});
