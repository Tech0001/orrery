/** A real compiled host, its real events and model turn, with only the remote transport replaced by FakeStorage. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { FakeStorage } from "../../src/remote/fake.ts";
import { RemoteError, STALE_MS, type Storage } from "../../src/remote/types.ts";

/** The fake remote outlives either real host; byte arrays cross its loopback test transport as JSON. */
const wire = (_key: string, value: unknown) => value instanceof Uint8Array ? { bytes: Array.from(value) } : value !== null && typeof value === "object" && "type" in value && value.type === "Buffer" && "data" in value ? { bytes: value.data } : value;
const unwire = (_key: string, value: unknown) => value !== null && typeof value === "object" && "bytes" in value ? Uint8Array.from((value as { bytes: number[] }).bytes) : value;

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
				const { method, args } = JSON.parse(body, unwire) as { method: Exclude<keyof Storage, "name">; args: never[] };
				// Push releases once. Delay the first host's final release beyond OMP's two-second hook budget.
				if (method === "release" && ++releases === 2) { releaseDelayed = true; return; }
				try { res.end(JSON.stringify({ value: await (backend[method] as (...args: never[]) => Promise<unknown>)(...args) }, wire)); }
				catch (error) { res.end(JSON.stringify({ error: { kind: error instanceof RemoteError ? error.kind : "unreachable", message: String(error) } })); }
				return;
			}
			if (req.method === "GET") { res.end(JSON.stringify({ object: "list", data: [{ id: "m" }] })); return; }
			calls.push(body);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const base = { id: "r1", object: "chat.completion.chunk", created: 1, model: "m" };
			for (const chunk of [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "remote pong" }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
			]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	writeFileSync(join(agent, host === "pi" ? "models.json" : "models.yml"), JSON.stringify({ providers: { local: {
		baseUrl, apiKey: "none", api: "openai-completions", models: [{ id: "m", name: "m", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" } }],
	} } }));
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
 const storage = ${delayedRelease ? `Object.fromEntries([ ["name", "home"], ...["take", "renew", "release", "save", "snapshot", "fetch", "list", "log", "getCheck", "putCheck", "drop"].map((method) => [method, async (...args) => {
   while (args.length && args.at(-1) === undefined) args.pop();
   const response = await fetch(${JSON.stringify(baseUrl.replace(/\/v1$/, "/remote"))}, { method: "POST", body: JSON.stringify({ method, args }, (_k, v) => v instanceof Uint8Array ? { bytes: Array.from(v) } : v?.type === "Buffer" ? { bytes: v.data } : v) });
   const reply = JSON.parse(await response.text(), (_k, v) => v && typeof v === "object" && "bytes" in v ? Uint8Array.from(v.bytes) : v);
   if (reply.error) throw new RemoteError(reply.error.kind, reply.error.message);
   return reply.value;
 }]) ])` : 'new FakeStorage({ name: "home" })'};
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
		env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"), TERM: "dumb", PI_OFFLINE: "1" },
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
