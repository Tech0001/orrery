/** A real compiled host, its real events and model turn, with only the remote transport replaced by FakeStorage. */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { parseConfig } from "../../src/lane/config.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { createKey, keyToCode, unseal } from "../../src/remote/crypto.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { holderFor } from "../../src/remote/index.ts";
import { decodeRows, laneSettings } from "../../src/remote/save-format.ts";
import { saveRemoteSecret } from "../../src/remote/secrets.ts";
import { RemoteSession, type RemoteSessionOptions } from "../../src/remote/session.ts";
import { type Holder, RemoteError, STALE_MS, type Storage } from "../../src/remote/types.ts";

/** The fake remote outlives either real host; byte arrays cross its loopback test transport as JSON. */
const wire = (_key: string, value: unknown) => value instanceof Uint8Array ? { bytes: Array.from(value) } : value !== null && typeof value === "object" && "type" in value && value.type === "Buffer" && "data" in value ? { bytes: value.data } : value;
const unwire = (_key: string, value: unknown) => value !== null && typeof value === "object" && "bytes" in value ? Uint8Array.from((value as { bytes: number[] }).bytes) : value;

type RemoteCall = { method: Exclude<keyof Storage, "name">; args: never[] };

/** One loopback call on the test process's FakeStorage; a RemoteError's kind crosses back to the host. */
async function answerRemote(backend: Storage, { method, args }: RemoteCall, res: ServerResponse): Promise<void> {
	try { res.end(JSON.stringify({ value: await (backend[method] as (...args: never[]) => Promise<unknown>)(...args) }, wire)); }
	catch (error) { res.end(JSON.stringify({ error: { kind: error instanceof RemoteError ? error.kind : "unreachable", message: String(error) } })); }
}

/** The model's reply, streamed as one OpenAI-compatible completion. */
export function streamReply(res: ServerResponse, text: string): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const base = { id: "r1", object: "chat.completion.chunk", created: 1, model: "m" };
	for (const chunk of [
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
	]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.end("data: [DONE]\n\n");
}

/** The host's only provider: the test's own server. */
export function writeModels(agent: string, host: "pi" | "omp", baseUrl: string): void {
	writeFileSync(join(agent, host === "pi" ? "models.json" : "models.yml"), JSON.stringify({ providers: { local: {
		baseUrl, apiKey: "none", api: "openai-completions", models: [{ id: "m", name: "m", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" } }],
	} } }));
}

/** Fixture source for a Storage whose every call goes to the test process's FakeStorage (the fixture imports RemoteError). */
const loopbackStorage = (url: string) => `Object.fromEntries([ ["name", "home"], ...["take", "renew", "release", "save", "snapshot", "fetch", "list", "log", "getCheck", "putCheck", "drop"].map((method) => [method, async (...args) => {
   while (args.length && args.at(-1) === undefined) args.pop();
   const response = await fetch(${JSON.stringify(url)}, { method: "POST", body: JSON.stringify({ method, args }, (_k, v) => v instanceof Uint8Array ? { bytes: Array.from(v) } : v?.type === "Buffer" ? { bytes: v.data } : v) });
   const reply = JSON.parse(await response.text(), (_k, v) => v && typeof v === "object" && "bytes" in v ? Uint8Array.from(v.bytes) : v);
   if (reply.error) throw new RemoteError(reply.error.kind, reply.error.message);
   return reply.value;
 }]) ])`;

/** A scratch HOME (and XDG folders) for the real host: it never sees the user's own. */
const hostEnv = (home: string): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"), TERM: "dumb", PI_OFFLINE: "1" });

export async function realRemoteTurn(binary: string, host: "pi" | "omp", delayedRelease = false): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), `orrery-remote-${host}-`));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const agent = join(home, host === "pi" ? ".pi" : ".omp", "agent");
	mkdirSync(agent, { recursive: true });
	mkdirSync(workspace);
	const calls: string[] = [];
	const clock = { now: Date.now() };
	const backend = new FakeStorage({ name: "home", now: () => clock.now });
	let releases = 0;
	let releaseDelayed = false;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", async () => {
			if (req.url === "/remote") {
				const call = JSON.parse(body, unwire) as RemoteCall;
				// Push releases once. Delay the first host's final release beyond OMP's two-second hook budget.
				if (call.method === "release" && ++releases === 2) { releaseDelayed = true; return; }
				await answerRemote(backend, call, res);
				return;
			}
			if (req.method === "GET") { res.end(JSON.stringify({ object: "list", data: [{ id: "m" }] })); return; }
			calls.push(body);
			streamReply(res, "remote pong");
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	writeModels(agent, host, baseUrl);
	if (host === "omp") writeFileSync(join(agent, "config.yml"), "setupVersion: 2\nmodelRoles:\n  default: local/m\n");
	const src = fileURLToPath(new URL("../../src/", import.meta.url));
	// OMP's loader follows and rewrites relative imports, as its installed Orrery entry does.
	const module = (file: string) => JSON.stringify(relative(root, join(src, file)));
	const fixture = join(root, "extension.ts");
	const toml = `data_dir = ${JSON.stringify(join(root, "data"))}\n[remotes.home]\nkind = "cloudflare"\nurl = "https://example.invalid"\n[lanes.Probe]\nworkspace = ${JSON.stringify(workspace)}\nremote = "home"\ncompactor_model = "missing/summary"\n`;
	writeFileSync(fixture, `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOrrery } from ${module("pi/index.ts")};
import { applyLaneSettings } from ${module("omp/settings.ts")};
import { parseConfig } from ${module("lane/config.ts")};
import { MemoryStore } from ${module("memory/store.ts")};
import { Part } from ${module("memory/types.ts")};
import { FakeStorage } from ${module("remote/fake.ts")};
import { RemoteSession } from ${module("remote/session.ts")};
import { createKey, keyToCode, unseal } from ${module("remote/crypto.ts")};
import { laneSettings, decodeRows } from ${module("remote/save-format.ts")};
import { readRemoteSecret, saveRemoteSecret } from ${module("remote/secrets.ts")};
import { codeToKey } from ${module("remote/crypto.ts")};
import { RemoteError } from ${module("remote/types.ts")};

export default async function (api) {
 const root = ${JSON.stringify(root)};
 const config = parseConfig(${JSON.stringify(toml)}, root);
 const lane = config.lanes.get("Probe");
 const previous = readRemoteSecret(config, "home");
 const key = previous === undefined ? createKey() : codeToKey(previous.key);
 const storage = ${delayedRelease ? loopbackStorage(baseUrl.replace(/\/v1$/, "/remote")) : 'new FakeStorage({ name: "home" })'};
 saveRemoteSecret(config, "home", { key: keyToCode(key), token: "fake-token" });
 if ((await storage.list()).length === 0) {
 const source = join(root, "source");
 const store = MemoryStore.open(join(source, "memory.sqlite"));
 store.append("user", "remembered on another machine");
 store.saveNode(new Part(0, 0), "remembered on another machine");
 store.close();
 await RemoteSession.push({ lane: "Probe", laneDir: source, key, storage, holder: { machine: "macbook", device: "other", pid: 1 }, settings: laneSettings(lane), report: () => {} });
 }
 let opened;
 createOrrery({ config, host: ${JSON.stringify(host)}, ${host === "omp" ? "laneSettings: (ctx, workspace) => applyLaneSettings(ctx, workspace)," : ""} remoteStorage: () => storage, onLane: (memory) => { opened = memory; } })(api);
 const report = (name, value) => writeFileSync(join(root, name + ".json"), JSON.stringify(value));
 api.on("session_start", () => report("opened", { remote: opened?.remote !== undefined, messages: opened?.store.root.map((m) => m.text) }));
 api.on("agent_end", async () => {
   // Observe afterTurn's own save: calling remote.save() here would conceal missing lifecycle wiring.
   for (let i = 0; i < 150 && (await storage.list())[0].newestSave === 0; i++) await new Promise((done) => setTimeout(done, 20));
   const entry = (await storage.list())[0];
   const fetched = await storage.fetch("Probe", 0);
   report("saved", { entry, rows: fetched.saves.flatMap((save) => decodeRows(unseal(key, "Probe", "save", save.n, save.file)).main.map((row) => row.text)) });
 });
 api.on("session_shutdown", async () => {
   // OMP can dispatch shutdown observers concurrently with Orrery's async close.
   for (let i = 0; i < 150 && opened !== undefined; i++) await new Promise((done) => setTimeout(done, 20));
   report("closed", { entry: (await storage.list())[0], memoryClosed: opened === undefined });
 });
}
`);
	const launch = () => spawn(binary, ["--mode", "rpc", "--provider", "local", "--model", "m", "--thinking", "off", "-e", fixture], {
		cwd: workspace,
		env: hostEnv(home),
	});
	let child = launch();
	let output = "";
	const observe = () => {
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { output += chunk; });
		return new Promise<void>((done) => { child.on("error", (error) => { output += String(error); done(); }); child.on("exit", () => done()); });
	};
	let exited = observe();
	const read = async (name: string) => {
		const path = join(root, `${name}.json`);
		const deadline = Date.now() + 20_000;
		while (!existsSync(path) && Date.now() < deadline && child.exitCode === null) await delay(20);
		expect(existsSync(path), output).toBe(true);
		return JSON.parse(readFileSync(path, "utf8"));
	};
	try {
		expect(await read("opened")).toEqual({ remote: true, messages: ["remembered on another machine"] });
		child.stdin.write(`${JSON.stringify({ id: "turn", type: "prompt", message: "A remote turn." })}\n`);
		expect(await read("saved")).toMatchObject({ entry: { newestSave: 1, lock: { held: true } }, rows: ["A remote turn.", "remote pong"] });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("remembered on another machine");
		child.stdin.end();
		if (!delayedRelease) expect(await read("closed")).toMatchObject({ entry: { newestSave: 1, lock: { held: false } }, memoryClosed: true });
		else {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try { await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`OMP did not exit after its shutdown budget: ${output}`)), 6000); })]); }
			finally { clearTimeout(timeout); }
			expect(releaseDelayed).toBe(true);
			const old = (await backend.list())[0].lock!;
			expect(old).toMatchObject({ held: true, stale: false });
			clock.now += STALE_MS + 1;
			expect((await backend.list())[0].lock).toMatchObject({ held: true, stale: true });
			for (const name of ["opened", "closed"]) rmSync(join(root, `${name}.json`), { force: true });
			child = launch();
			exited = observe();
			expect(await read("opened"), output.split("\n").filter((line) => line.includes('"notify"')).join("\n")).toMatchObject({ remote: true, messages: ["remembered on another machine", "A remote turn.", "remote pong"] });
			const retaken = (await backend.list())[0].lock!;
			expect(retaken).toMatchObject({ held: true, stale: false, holder: { machine: old.holder.machine, device: old.holder.device } });
			expect(retaken.lock).toBeGreaterThan(old.lock);
			child.stdin.end();
			expect(await read("closed")).toMatchObject({ entry: { lock: { held: false } }, memoryClosed: true });
		}
	} finally {
		child.stdin.end();
		const stop = setTimeout(() => child.kill("SIGKILL"), 3000);
		await exited;
		clearTimeout(stop);
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		rmSync(root, { recursive: true, force: true });
	}
}

/**
 * A check-out that rebuilds the working copy inside the real host (Bun's SQLite), from a snapshot plus the saves after
 * it: this machine has an unsaved turn while another machine saved since (the split), so the turn is kept aside and the
 * copy is rebuilt from the remote. The remote state is written here, in the test process; only the check-out runs in pi.
 */
export async function realRemoteRebuild(binary: string): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "orrery-rebuild-pi-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const agent = join(home, ".pi", "agent");
	mkdirSync(agent, { recursive: true });
	mkdirSync(workspace);
	const backend = new FakeStorage({ name: "home" });
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", async () => {
			if (req.url === "/remote") { await answerRemote(backend, JSON.parse(body, unwire) as RemoteCall, res); return; }
			if (req.method === "GET") { res.end(JSON.stringify({ object: "list", data: [{ id: "m" }] })); return; }
			streamReply(res, "rebuilt pong");
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	writeModels(agent, "pi", baseUrl);
	const toml = `data_dir = ${JSON.stringify(join(root, "data"))}\n[remotes.home]\nkind = "cloudflare"\nurl = "https://example.invalid"\n[lanes.Probe]\nworkspace = ${JSON.stringify(workspace)}\nremote = "home"\ncompactor_model = "missing/summary"\n`;
	const config = parseConfig(toml, root);
	const lane = config.lanes.get("Probe")!;
	const dbPath = join(lane.dir, "memory.sqlite");
	const key = createKey();
	saveRemoteSecret(config, "home", { key: keyToCode(key), token: "fake-token" });
	const machine = (laneDir: string, holder: Holder): RemoteSessionOptions => ({ lane: "Probe", laneDir, storage: backend, key, holder, settings: laneSettings(lane), report: () => {}, renewMs: 0 });
	const mac = machine(join(root, "macbook", "Probe"), { machine: "macbook", device: "device-mac", pid: process.pid });
	const here = machine(lane.dir, holderFor(config));
	const session = async (o: RemoteSessionOptions, work: (store: MemoryStore, s: RemoteSession) => Promise<void> = async () => {}) => {
		const s = await RemoteSession.checkOut(o);
		const store = MemoryStore.open(join(o.laneDir, "memory.sqlite"));
		s.attach(store);
		try { await work(store, s); } finally { await s.close(); store.close(); }
	};

	// The Mac pushes snapshot 0. This machine checks the lane out, then writes a turn it never saves (lid shut). The Mac
	// saves six times since: this machine's next check-out keeps its turn aside and rebuilds from snapshot 0 + saves 1-6.
	const pushed = ["pushed 1", "pushed 2", "pushed 3"];
	const source = MemoryStore.open(join(mac.laneDir, "memory.sqlite"));
	for (const text of pushed) source.append("user", text);
	source.close();
	await RemoteSession.push(mac);
	await session(here);
	const unsaved = MemoryStore.open(dbPath);
	unsaved.append("user", "this machine's unsaved turn");
	unsaved.close();
	const saved: string[] = [];
	await session(mac, async (store, s) => {
		for (let n = 1; n <= 6; n++) {
			store.append("user", `saved ${n}: ask`);
			store.append("talk", `saved ${n}: answer`);
			saved.push(`saved ${n}: ask`, `saved ${n}: answer`);
			await s.save();
		}
	});
	const fetched = await backend.fetch("Probe", -1);
	expect({ snapshot: fetched.snapshot?.n, saves: fetched.saves.map((save) => save.n) }).toEqual({ snapshot: 0, saves: [1, 2, 3, 4, 5, 6] });

	const src = fileURLToPath(new URL("../../src/", import.meta.url));
	const module = (file: string) => JSON.stringify(relative(root, join(src, file)));
	const fixture = join(root, "extension.ts");
	writeFileSync(fixture, `
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOrrery } from ${module("pi/index.ts")};
import { parseConfig } from ${module("lane/config.ts")};
import { RemoteError } from ${module("remote/types.ts")};

export default async function (api) {
 const root = ${JSON.stringify(root)};
 const storage = ${loopbackStorage(baseUrl.replace(/\/v1$/, "/remote"))};
 let opened;
 createOrrery({ config: parseConfig(${JSON.stringify(toml)}, root), host: "pi", remoteStorage: () => storage, onLane: (memory) => { opened = memory; } })(api);
 // pi may load the extension again for a new session: reports are numbered by the files already written.
 const report = (name, value) => {
   let n = 1;
   while (existsSync(join(root, name + "-" + n + ".json"))) n++;
   writeFileSync(join(root, "report.tmp"), JSON.stringify(value));
   renameSync(join(root, "report.tmp"), join(root, name + "-" + n + ".json"));
 };
 api.on("session_start", () => report("opened", { bun: typeof process.versions.bun === "string", remote: opened?.remote !== undefined, messages: opened?.store.root.map((m) => m.text) }));
 api.on("session_shutdown", async () => {
   for (let i = 0; i < 150 && opened !== undefined; i++) await new Promise((done) => setTimeout(done, 20));
   report("closed", { memoryClosed: opened === undefined });
 });
}
`);
	let output = "";
	const notices = () => output.split("\n").flatMap((line) => {
		try {
			const frame = JSON.parse(line) as { method?: string; message?: unknown };
			return frame.method === "notify" ? [String(frame.message)] : [];
		} catch { return []; }
	});
	const launch = () => {
		const child = spawn(binary, ["--mode", "rpc", "--provider", "local", "--model", "m", "--thinking", "off", "-e", fixture], { cwd: workspace, env: hostEnv(home) });
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { output += chunk; });
		// "close": its output is all in, so notices can be told apart per phase.
		const exited = new Promise<void>((done) => { child.on("error", (error) => { output += String(error); done(); }); child.on("close", () => done()); });
		return { child, exited };
	};
	let pi = launch();
	const send = (command: object) => pi.child.stdin.write(`${JSON.stringify(command)}\n`);
	const read = async (name: string) => {
		const path = join(root, `${name}.json`);
		const deadline = Date.now() + 20_000;
		while (!existsSync(path) && Date.now() < deadline && pi.child.exitCode === null) await delay(20);
		expect(existsSync(path), output).toBe(true);
		return JSON.parse(readFileSync(path, "utf8"));
	};
	const trouble = (list: string[]) => list.filter((notice) => /disk I\/O error|runs without memory|not fully written|past the database/i.test(notice));
	const rows = async (n: number) => {
		const save = (await backend.fetch("Probe", n - 1)).saves.find((file) => file.n === n);
		return save === undefined ? undefined : decodeRows(unseal(key, "Probe", "save", n, save.file)).main.map((row) => row.text);
	};
	try {
		// The check-out ran in pi: every row of the snapshot and of all six saves, and not the unsaved turn.
		const remote = [...pushed, ...saved];
		expect(await read("opened-1"), notices().join("\n")).toEqual({ bun: true, remote: true, messages: remote });
		expect(notices().filter((notice) => notice.includes("unsaved-"))).toHaveLength(1);
		// A turn on the rebuilt copy goes up as save 7: its marks match the file.
		send({ id: "turn", type: "prompt", message: "A turn after the rebuild." });
		const deadline = Date.now() + 20_000;
		while ((await backend.list())[0].newestSave < 7 && Date.now() < deadline && pi.child.exitCode === null) await delay(20);
		expect(await rows(7), output).toEqual(["A turn after the rebuild.", "rebuilt pong"]);
		expect(trouble(notices())).toEqual([]);
		// A new session in the same process opens the lane again (live, this open failed with "disk I/O error").
		const all = [...remote, "A turn after the rebuild.", "rebuilt pong"];
		const beforeNew = notices().length;
		send({ id: "new", type: "new_session" });
		expect(await read("closed-1")).toEqual({ memoryClosed: true });
		expect(await read("opened-2"), notices().join("\n")).toEqual({ bun: true, remote: true, messages: all });
		pi.child.stdin.end();
		expect(await read("closed-2")).toEqual({ memoryClosed: true });
		await pi.exited;
		// pi (1.0.4, 1.1.0) sends an RPC new session's session_start twice: the second open finds the lane already open in
		// this same pi and says it runs without memory. That is not the rebuild's doing; opened-2 shows the lane open.
		expect(trouble(notices().slice(beforeNew)).filter((notice) => !notice.startsWith("Probe is open in another pi"))).toEqual([]);

		// After pi: every row is in the file itself, none left in a WAL.
		expect(lstatSync(`${dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0);
		const copy = MemoryStore.openReadOnly(dbPath);
		try { expect(copy.root.map((m) => m.text)).toEqual(all); } finally { copy.close(); }
		const files = readdirSync(lane.dir);
		expect(files.filter((name) => name.startsWith(".rebuild-") || name.startsWith(".restore-"))).toEqual([]);
		const aside = files.filter((name) => name.startsWith("unsaved-"));
		expect(aside).toHaveLength(1);
		expect(readFileSync(join(lane.dir, aside[0]), "utf8")).toContain("this machine's unsaved turn");

		// A later pi opens the copy cleanly too.
		const beforeLater = notices().length;
		pi = launch();
		expect(await read("opened-3"), notices().join("\n")).toEqual({ bun: true, remote: true, messages: all });
		pi.child.stdin.end();
		expect(await read("closed-3")).toEqual({ memoryClosed: true });
		await pi.exited;
		expect(trouble(notices().slice(beforeLater))).toEqual([]);
		expect((await backend.list())[0]).toMatchObject({ newestSave: 7, lock: { held: false } });
	} finally {
		pi.child.stdin.end();
		const stop = setTimeout(() => pi.child.kill("SIGKILL"), 3000);
		await pi.exited;
		clearTimeout(stop);
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		rmSync(root, { recursive: true, force: true });
	}
}
