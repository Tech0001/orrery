import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editAgentCommand, openAgentCommand } from "../../src/cli/agent.ts";
import { agentRemoteCommand, pullAgentCommand, setStorageForTests } from "../../src/cli/remote.ts";
import { setAgentKey, editConfigFile } from "../../src/agent/config-edit.ts";
import { loadConfig, readConfigFile } from "../../src/agent/config.ts";
import { OverviewCache } from "../../src/agent/overview.ts";
import { WITHOUT_ORRERY_QUESTION, WITHOUT_ORRERY_SAID } from "../../src/codex/check.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { createKey, keyToCode } from "../../src/remote/crypto.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { agentSettings, remoteAgentSettings } from "../../src/remote/save-format.ts";
import { saveRemoteSecret } from "../../src/remote/secrets.ts";
import { RemoteSession } from "../../src/remote/session.ts";
import { RemoteError, STALE_MS } from "../../src/remote/types.ts";
import { cleanEnv, cliCommand } from "../claude/support.ts";
import { tempDir } from "../agent/support.ts";
import { fifos, readOnce, stopWriters } from "./read-once.ts";

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

function config(file: string, data: string, agents = "") {
	writeFileSync(file, `# keep this comment\ndata_dir = ${JSON.stringify(data)}\nmachine_name = "pc"\n[remotes.home]\nkind = "cloudflare"\nurl = "https://example.com"\n${agents}`);
	saveRemoteSecret(loadConfig(file), "home", { key: keyToCode(key), token: "private-token" });
}

beforeEach(() => {
	dir = tempDir("orrery-remote-agent-"); path = join(dir, "config.toml"); source = join(dir, "source.toml");
	folder = join(dir, "folder"); mkdirSync(folder);
	clock = Date.parse("2026-10-12T14:02:00Z"); key = createKey();
	storage = new FakeStorage({ name: "home", now: () => clock }); setStorageForTests(() => storage);
	config(path, join(dir, "data"));
	config(source, join(dir, "source"), `[agents.Atlas]\nfolder = ${JSON.stringify(dir)}\ntool = "omp"\ncompactor_model = "openai/gpt-6.1-sol"\ncompactor_thinking = "high"\nview_bytes = 64000\ncompactor_jobs = 3\ncompact_at = 140000\nreads = ["*"]\n`);
	const store = MemoryStore.open(join(loadConfig(source).agents.get("Atlas")!.dir, "memory.sqlite"));
	store.append("user", "from the first machine"); store.close();
});
afterEach(() => { setStorageForTests(undefined); rmSync(dir, { recursive: true, force: true }); });

function sourceOptions() {
	const agent = loadConfig(source).agents.get("Atlas")!;
	return { agent: agent.name, agentDir: agent.dir, storage, key, holder: peer, settings: agentSettings(agent), report: () => {}, renewMs: 0 };
}
async function seed() { await RemoteSession.push(sourceOptions()); }
async function saveMore() {
	const session = await RemoteSession.checkOut(sourceOptions());
	const store = MemoryStore.open(join(sourceOptions().agentDir, "memory.sqlite"));
	session.attach(store); store.append("talk", "a newer remote turn");
	await session.close(); store.close();
}
function texts(file = path) {
	const store = MemoryStore.openReadOnly(join(loadConfig(file).agents.get("Atlas")!.dir, "memory.sqlite"));
	try { return store.root.map((m) => m.text); } finally { store.close(); }
}
async function pull() { return pullAgentCommand(path, "Atlas", "home", folder); }

describe("agent push and pull", () => {
	it("pushes a closed local agent and its settings, then sets remote without losing comments", async () => {
		expect(await agentRemoteCommand(source, ["push", "atlas"], { to: "home" })).toContain("Atlas");
		expect(loadConfig(source).agents.get("Atlas")?.remote).toBe("home");
		expect(readFileSync(source, "utf8")).toContain("# keep this comment");
		expect((await remoteAgentSettings(storage, key, "Atlas")).settings).toMatchObject({ tool: "omp", viewBytes: 64000, compactorJobs: 3, compactAt: 140000, reads: ["*"] });
		expect((await remoteAgentSettings(storage, key, "Atlas")).settings).not.toHaveProperty("instructions");
		expect((await storage.list())[0].lock?.held).toBe(false);
	});

	it("does not switch the config when push fails", async () => {
		const before = readFileSync(source, "utf8"); storage.snapshot = async () => { throw new RemoteError("unreachable", "offline"); };
		await expect(agentRemoteCommand(source, ["push", "Atlas"], { to: "home" })).rejects.toThrow("offline");
		expect(readFileSync(source, "utf8")).toBe(before);
		// A push that fails before its first snapshot takes the half-created agent off the remote again.
		expect(await storage.list()).toEqual([]);
	});
	it("can make the first push after Memory home has already selected this remote", async () => {
		editConfigFile(source, (text, d) => setAgentKey(text, d, "Atlas", "remote", "home"));
		await agentRemoteCommand(source, ["push", "Atlas"], { to: "home" });
		expect((await storage.fetch("Atlas", -1)).snapshot?.n).toBe(0);
	});

	it("refuses an open local store and an agent assigned to a different remote", async () => {
		const store = MemoryStore.open(join(sourceOptions().agentDir, "memory.sqlite"));
		try { await expect(agentRemoteCommand(source, ["push", "Atlas"], { to: "home" })).rejects.toThrow(/open.*close/i); } finally { store.close(); }
		expect(await storage.list()).toEqual([]);
		writeFileSync(source, `${readFileSync(source, "utf8")}\n[remotes.other]\nkind = "cloudflare"\nurl = "https://other.example.com"\n`);
		editConfigFile(source, (text, d) => setAgentKey(text, d, "Atlas", "remote", "other"));
		await expect(agentRemoteCommand(source, ["push", "Atlas"], { to: "home" })).rejects.toThrow(/already.*remote|keeps.*remote/i);
	});

	it("pulls the snapshot and later saves with portable settings and the chosen folder", async () => {
		await seed(); await saveMore();
		await agentRemoteCommand(path, ["pull", "Atlas"], { from: "home", folder });
		expect(texts()).toEqual(["from the first machine", "a newer remote turn"]);
		expect(loadConfig(path).agents.get("Atlas")).toMatchObject({ folder: folder, remote: "home", tool: "omp", memory: { viewBytes: 64000 }, compactor: { jobs: 3, model: { thinking: "high" } }, compactAt: 140000, reads: ["*"] });
		expect(readFileSync(path, "utf8")).toContain("# keep this comment");
		expect((await storage.list())[0].lock?.held).toBe(false);
	});
	it("pulls without a folder: the agent has no folder, and its instructions.md comes along", async () => {
		writeFileSync(join(loadConfig(source).agents.get("Atlas")!.dir, "instructions.md"), "You are Atlas.\n");
		await seed();
		expect(await pullAgentCommand(path, "Atlas", "home")).toContain("Pulled Atlas from remote home.");
		const agent = loadConfig(path).agents.get("Atlas")!;
		expect(agent.folder).toBeUndefined();
		expect(readFileSync(join(agent.dir, "instructions.md"), "utf8")).toBe("You are Atlas.\n");
	});
	it("agent pull takes --folder only when it is given", async () => {
		await seed();
		await expect(agentRemoteCommand(path, ["pull", "Atlas"], { folder })).rejects.toThrow("agent pull needs --from <remote> (and --folder <dir> for a default folder).");
		expect(await agentRemoteCommand(path, ["pull", "Atlas"], { from: "home" })).toBe("Pulled Atlas from remote home.\n");
		expect(loadConfig(path).agents.get("Atlas")?.folder).toBeUndefined();
	});
	it("preserves the snapshot's summary size and summary-call size when pulling", async () => {
		await RemoteSession.push({ ...sourceOptions(), settings: { ...sourceOptions().settings, nodeBytes: 12000, contextBytes: 73000 } });
		await pull();
		expect(loadConfig(path).agents.get("Atlas")).toMatchObject({ memory: { nodeBytes: 12000 }, compactor: { contextBytes: 73000 } });
	});

	it("drops an older snapshot's instructions setting: the pulled config never names it", async () => {
		await RemoteSession.push({ ...sourceOptions(), settings: { ...sourceOptions().settings, instructions: "GUIDE.md" } });
		await pull();
		expect(readFileSync(path, "utf8")).not.toContain("instructions");
		expect(loadConfig(path).agents.get("Atlas")).toMatchObject({ remote: "home", tool: "omp" });
	});

	it("refuses a duplicate agent case-insensitively before contacting storage", async () => {
		const before = readFileSync(source, "utf8");
		await expect(pullAgentCommand(source, "atlas", "home", folder)).rejects.toThrow(/already exists/);
		expect(readFileSync(source, "utf8")).toBe(before); expect(await storage.list()).toEqual([]);
	});

	it("refuses a name orrery agent uses as a subcommand before contacting storage", async () => {
		const before = readFileSync(path, "utf8");
		await expect(pullAgentCommand(path, "Pull", "home", folder)).rejects.toThrow("Pull is a word orrery agent uses (add, set, edit, archive, push, pull, takeover, local); pick another name.");
		expect(readFileSync(path, "utf8")).toBe(before); expect(await storage.list()).toEqual([]);
	});

	it("refuses relative, missing and non-directory folders without registering the agent", async () => {
		await seed(); const before = readFileSync(path, "utf8");
		for (const bad of ["relative", join(dir, "missing"), path]) await expect(pullAgentCommand(path, "Atlas", "home", bad)).rejects.toThrow(/folder|directory|absolute/i);
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
		await expect(pull()).rejects.toThrow(/config changed.*review agents.Atlas/i);
		expect(readFileSync(path, "utf8")).toContain("# edited during pull");
	});
	it("refuses missing reads dependencies before adding an agent", async () => {
		await RemoteSession.push({ ...sourceOptions(), settings: { ...sourceOptions().settings, reads: ["Missing"] } });
		const before = readFileSync(path, "utf8");
		await expect(pull()).rejects.toThrow(/pull.*first.*Missing/i);
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});

describe("agent takeover", () => {
	async function held() { await seed(); await pull(); await storage.take("Atlas", peer); clock += STALE_MS + 1; }
	it("shows the holder and last seen, asks, force-takes and releases without fetching", async () => {
		await held(); const questions: string[] = [];
		storage.fetch = async () => { throw new Error("takeover must not fetch"); };
		const out = await agentRemoteCommand(path, ["takeover", "Atlas"], {}, { confirm: async (q) => { questions.push(q); return true; } });
		expect(questions.join("\n")).toMatch(/Atlas.*macbook.*last seen/);
		expect(out).toContain("macbook"); expect((await storage.list())[0].lock).toMatchObject({ held: false, holder: { machine: "pc" } });
	});
	it("declining keeps the held lock, while --yes confirms without prompting", async () => {
		await held(); const before = await storage.list();
		expect(await agentRemoteCommand(path, ["takeover", "Atlas"], {}, no)).toMatch(/not taken|cancel/i);
		expect(await storage.list()).toEqual(before);
		await agentRemoteCommand(path, ["takeover", "Atlas"], { yes: true }, { confirm: async () => { throw new Error("unexpected prompt"); } });
		expect((await storage.list())[0].lock?.held).toBe(false);
	});
	it("does not take a fresh lock even with --yes", async () => {
		await held(); clock -= STALE_MS + 1; const before = await storage.list();
		await expect(agentRemoteCommand(path, ["takeover", "Atlas"], { yes: true })).rejects.toThrow(/macbook/);
		expect(await storage.list()).toEqual(before);
	});
	it("orrery agent: plain Codex (a yes to starting without Orrery) takes no stale lock over; as the agent it asks", async () => {
		await held(); const before = await storage.list();
		// A Codex on PATH (only its version is asked: the hook check is the test's).
		const bin = join(dir, "bin"); mkdirSync(bin);
		writeFileSync(join(bin, "codex"), '#!/bin/sh\n[ "$1" = "--version" ] && echo "codex-cli 0.162.1"\nexit 0\n', { mode: 0o755 });
		vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`); vi.stubEnv("HOME", dir); vi.stubEnv("ORRERY_HOME", join(dir, ".orrery"));
		try {
			for (const hooksLoad of [false, true]) {
				const said: string[] = []; const ran: { withoutOrrery?: true }[] = [];
				const io = { say: (line: string) => said.push(`say: ${line}`), confirm: async (q: string) => (said.push(`confirm: ${q}`), false), askPerson: async (q: string) => (said.push(`ask: ${q}`), true) };
				const deps = {
					takeover: async () => { throw new Error("must not take over"); },
					codexGate: async () => (hooksLoad ? { ok: true as const } : { ok: false as const, text: "Orrery's hooks don't load in Codex 0.162.1: x." }),
					run: async (plan: { withoutOrrery?: true }) => (ran.push(plan), { code: 0, signal: null }),
					cache: new OverviewCache({ storage: () => storage, now: () => clock }),
				};
				const code = await openAgentCommand(path, "Atlas", { tool: "codex", args: [], cwd: folder }, io, deps);
				if (!hooksLoad) {
					expect(code).toBe(0);
					expect(said).toEqual(["say: Checking Atlas on home…", "say: Orrery's hooks don't load in Codex 0.162.1: x.", `ask: ${WITHOUT_ORRERY_QUESTION}`, `say: ${WITHOUT_ORRERY_SAID}`]);
					expect(ran).toEqual([expect.objectContaining({ withoutOrrery: true })]);
				} else {
					expect(code).toBe(1);
					expect(said.slice(1)).toEqual([expect.stringMatching(/^confirm: Atlas was open on macbook, last seen .*\. Take over\?$/), "say: Not opened."]);
					expect(ran).toEqual([]);
				}
				expect(await storage.list()).toEqual(before);
			}
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("agent local", () => {
	it("fetches newer memory, clears remote and keeps the remote copy by default", async () => {
		await seed(); await pull(); await saveMore();
		await agentRemoteCommand(path, ["local", "Atlas"]);
		expect(texts()).toEqual(["from the first machine", "a newer remote turn"]);
		expect(loadConfig(path).agents.get("Atlas")?.remote).toBeUndefined();
		expect((await storage.list())[0].lock?.held).toBe(false);
	});
	it("leaves remote configured when the up-to-date copy cannot be fetched", async () => {
		await seed(); await pull(); const before = readFileSync(path, "utf8");
		storage.fetch = async () => { throw new RemoteError("unreachable", "offline"); };
		await expect(agentRemoteCommand(path, ["local", "Atlas"])).rejects.toThrow("offline");
		expect(readFileSync(path, "utf8")).toBe(before);
	});
	it("--delete-remote asks and keeps the remote copy when declined", async () => {
		await seed(); await pull(); let question = "";
		await agentRemoteCommand(path, ["local", "Atlas"], { "delete-remote": true }, { confirm: async (q) => { question = q; return false; } });
		expect(question).toMatch(/delete.*Atlas.*home/i); expect(await storage.list()).toHaveLength(1);
		expect(loadConfig(path).agents.get("Atlas")?.remote).toBeUndefined();
	});
	it("--delete-remote drops under a new lock only after confirmation", async () => {
		await seed(); await pull();
		await agentRemoteCommand(path, ["local", "Atlas"], { "delete-remote": true }, yes);
		expect(await storage.list()).toEqual([]); expect(texts()).toEqual(["from the first machine"]);
		expect(loadConfig(path).agents.get("Atlas")?.remote).toBeUndefined();
	});
	it("does not delete a save made by another machine while the confirmation was open", async () => {
		await seed(); await pull();
		await expect(agentRemoteCommand(path, ["local", "Atlas"], { "delete-remote": true }, { confirm: async () => { await saveMore(); return true; } })).rejects.toThrow(/newer|changed|saved/i);
		expect((await storage.list())[0]).toMatchObject({ newestSave: 1, lock: { held: false } });
	});
	it("does not delete a replaced remote history with the same save number", async () => {
		await seed(); await pull();
		await expect(agentRemoteCommand(path, ["local", "Atlas"], { "delete-remote": true }, { confirm: async () => {
			const held = await storage.take("Atlas", peer); if (!held.ok) throw new Error("held");
			await storage.drop("Atlas", held.lock); await seed(); return true;
		} })).rejects.toThrow(/changed/);
		expect((await storage.list())[0]).toMatchObject({ newestSave: 0, lock: { held: false } });
	});
});

describe("the config as the gate read it: never read again, written only while unchanged", () => {
	afterEach(stopWriters);
	/** `text` (the config at `file`) as the gate read it there; its next read would get a config of another data folder, with no agents. */
	async function judged(file: string, text = readFileSync(file, "utf8")) {
		rmSync(file);
		return readOnce(file, text, `data_dir = ${JSON.stringify(join(dir, "elsewhere"))}\n`);
	}

	it.skipIf(!fifos)("push, local, pull and takeover run with it", async () => {
		let once = await judged(source);
		expect(await agentRemoteCommand(once.file, ["push", "Atlas"], { to: "home" })).toContain("Pushed Atlas to remote home.");
		expect(await once.readAgain()).toBe(false);
		expect(loadConfig(source).agents.get("Atlas")?.remote).toBe("home");
		once = await judged(source);
		expect(await agentRemoteCommand(once.file, ["local", "Atlas"])).toContain("Atlas now keeps its memory locally.");
		expect(await once.readAgain()).toBe(false);
		expect(loadConfig(source).agents.get("Atlas")?.remote).toBeUndefined();
		once = await judged(path);
		expect(await agentRemoteCommand(once.file, ["pull", "Atlas"], { from: "home", folder })).toContain("Pulled Atlas from remote home");
		expect(await once.readAgain()).toBe(false);
		expect(texts()).toEqual(["from the first machine"]);
		await storage.take("Atlas", peer);
		clock += STALE_MS + 1;
		once = await judged(path);
		expect(await agentRemoteCommand(once.file, ["takeover", "Atlas"], { yes: true })).toContain("Taken over and released");
		expect(await once.readAgain()).toBe(false);
		expect((await storage.list())[0].lock).toMatchObject({ held: false, holder: { machine: "pc" } });
	});

	it("in a coding tool's session push, local, takeover and pull refuse a config whose file was swapped or written since, before the remote is asked; the file put there is left alone", async () => {
		const changed = (file: string) => `The config (${file}) changed after Orrery read it, so nothing was written to it. Run the command again.`;
		// Atlas on the remote, pulled into `path`, its lock held by another machine and stale; a third config without it.
		await seed();
		await pull();
		await storage.take("Atlas", peer);
		clock += STALE_MS + 1;
		const third = join(dir, "third.toml");
		config(third, join(dir, "third-data"));
		// Each read as the gate reads it in a coding tool's session; then each file swapped or written by another.
		const checked = (file: string) => ({ ...readConfigFile(file), checked: true });
		const pushed = checked(source);
		const pulled = checked(path);
		const pulling = checked(third);
		const swapped = `# swapped in\ndata_dir = ${JSON.stringify(join(dir, "elsewhere"))}\n`;
		writeFileSync(`${source}.new`, swapped);
		renameSync(`${source}.new`, source);
		for (const file of [path, third]) writeFileSync(file, `${readFileSync(file, "utf8")}# theirs\n`);
		// The remote must not be asked at all.
		const asked: string[] = [];
		for (const method of ["take", "renew", "release", "save", "snapshot", "fetch", "list", "log", "getCheck", "putCheck", "drop"] as const) {
			storage[method] = async () => {
				asked.push(method);
				throw new Error("the remote was asked");
			};
		}
		await expect(agentRemoteCommand(pushed, ["push", "Atlas"], { to: "home" })).rejects.toThrow(changed(source));
		await expect(agentRemoteCommand(pulled, ["local", "Atlas"])).rejects.toThrow(changed(path));
		await expect(agentRemoteCommand(pulled, ["takeover", "Atlas"], { yes: true })).rejects.toThrow(changed(path));
		await expect(agentRemoteCommand(pulling, ["pull", "Atlas"], { from: "home", folder })).rejects.toThrow(changed(third));
		expect(asked).toEqual([]);
		expect(readFileSync(source, "utf8")).toBe(swapped);
		for (const file of [path, third]) expect(readFileSync(file, "utf8")).toMatch(/# theirs\n$/);
	});

	it("in the user's own terminal push and local keep an edit made since the read and finish, as 0.9.0", async () => {
		const mine = (file: string) => ({ ...readConfigFile(file), checked: false });
		let read = mine(source);
		writeFileSync(source, `${readFileSync(source, "utf8")}# theirs\n`);
		expect(await agentRemoteCommand(read, ["push", "Atlas"], { to: "home" })).toContain("Pushed Atlas to remote home.");
		expect(readFileSync(source, "utf8")).toContain("# theirs\n");
		expect(loadConfig(source).agents.get("Atlas")?.remote).toBe("home");
		read = mine(source);
		writeFileSync(source, `${readFileSync(source, "utf8")}# theirs again\n`);
		expect(await agentRemoteCommand(read, ["local", "Atlas"])).toContain("Atlas now keeps its memory locally.");
		expect(readFileSync(source, "utf8")).toContain("# theirs again\n");
		expect(loadConfig(source).agents.get("Atlas")?.remote).toBeUndefined();
	});

	it.skipIf(!fifos)("opening an agent and editing its instructions run with it", async () => {
		const bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "codex"), '#!/bin/sh\n[ "$1" = "--version" ] && echo "codex-cli 0.162.1"\nexit 0\n', { mode: 0o755 });
		vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
		vi.stubEnv("HOME", dir);
		vi.stubEnv("ORRERY_HOME", join(dir, ".orrery"));
		try {
			const text = readFileSync(source, "utf8");
			let once = await judged(source, text);
			const ran: unknown[] = [];
			const io = { say: () => {}, confirm: async () => false, askPerson: async () => true };
			const deps = {
				takeover: async () => { throw new Error("must not take over"); },
				codexGate: async () => ({ ok: false as const, text: "Orrery's hooks don't load in Codex 0.162.1: x." }),
				run: async (plan: unknown) => (ran.push(plan), { code: 0, signal: null }),
				config: once.file,
			};
			expect(await openAgentCommand(undefined, "Atlas", { tool: "codex", args: [], cwd: folder }, io, deps)).toBe(0);
			expect(ran).toHaveLength(1);
			expect(await once.readAgain()).toBe(false);
			once = await judged(source, text);
			const edited: string[] = [];
			expect(await editAgentCommand(once.file, "Atlas", { say: () => {}, confirm: async () => true }, async (file) => (edited.push(file), { code: 0, signal: null }), true)).toBe(0);
			expect(edited).toEqual([join(dir, "source", "agents", "Atlas", "instructions.md")]);
			expect(await once.readAgain()).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

it("wires all four commands and their flags into main and help", () => {
	const cli = (...args: string[]) => {
		const c = cliCommand(["--config", path, ...args]);
		return spawnSync(c.cmd, c.args, { env: cleanEnv({}), encoding: "utf8", timeout: 15000 });
	};
	const help = cli("help", "agent").stdout;
	for (const action of ["push", "pull", "takeover", "local"]) expect(help).toContain(`agent ${action} <Name>`);
	for (const args of [["push", "Missing", "--to", "home"], ["pull", "Atlas", "--from", "missing", "--folder", folder], ["takeover", "Missing", "--yes"], ["local", "Missing", "--delete-remote"]]) {
		const result = cli("agent", ...args); expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/No agent named|unknown remote/); expect(result.stderr).not.toMatch(/Unknown option|needs add/);
	}
});
