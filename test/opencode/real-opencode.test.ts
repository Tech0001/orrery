import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { claimedBy, newToken } from "../../src/agent/pick.ts";
import { readStatus } from "../../src/agent/status-file.ts";
import { opencodeVersionOutput } from "../../src/agent/tools.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { opencodePluginGate, probePlugin, readOpenCodeCheck } from "../../src/opencode/check.ts";
import { readFeed } from "../../src/opencode/feed.ts";
import { configContent } from "../../src/opencode/options.ts";
import { COMPACTION_SUMMARY } from "../../src/opencode/plugin.ts";
import { feedFileOf } from "../../src/opencode/token-file.ts";
import { waitUntil } from "../claude/support.ts";
import { builtRelease, bunReady, removeBuiltRelease } from "../release/support.ts";
import { conversationOf, type FakeRequest, startFakeModel, systemOf } from "./fake-model.ts";

/**
 * The installed OpenCode itself, with Orrery's packed plugin, asked without a model and without its user's setup:
 * every run here has a scratch HOME, XDG folders and TMPDIR, and nothing inherited but PATH. Nothing is ever written to
 * the person's ~/.config/opencode, ~/.local/share/opencode, ~/.local/state/opencode or ~/.cache/opencode, and their
 * background service is never asked (each server here is a private `serve` on a port of its own).
 */
const scratch = mkdtempSync(join(tmpdir(), "orrery-real-opencode-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function isolated(name: string): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(scratch, `${name}-`));
	for (const sub of ["home", "config", "data", "state", "cache", "tmp"]) mkdirSync(join(dir, sub));
	return {
		PATH: process.env.PATH ?? "",
		HOME: join(dir, "home"),
		XDG_CONFIG_HOME: join(dir, "config"),
		XDG_DATA_HOME: join(dir, "data"),
		XDG_STATE_HOME: join(dir, "state"),
		XDG_CACHE_HOME: join(dir, "cache"),
		TMPDIR: join(dir, "tmp"),
		OPENCODE_DISABLE_AUTOUPDATE: "1",
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		ORRERY_RELEASES_URL: "http://127.0.0.1:9/releases",
	};
}

/** The opencode binary: ORRERY_TEST_OPENCODE, or "opencode" on PATH; null when there is none. */
function findOpenCode(): string | null {
	const works = (path: string) => spawnSync(path, ["--version"], { env: isolated("version"), timeout: 30_000 }).status === 0;
	const wanted = process.env.ORRERY_TEST_OPENCODE ?? "opencode";
	if (wanted.includes("/")) return works(wanted) ? wanted : null;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir !== "" && existsSync(join(dir, wanted)) && works(join(dir, wanted))) return join(dir, wanted);
	}
	return null;
}

const opencode = findOpenCode();
const version = opencode === null ? "" : (spawnSync(opencode, ["--version"], { env: isolated("version"), encoding: "utf8" }).stdout.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? "");

/** The release whose plugin is tested: the binary's under test:binary, ORRERY_TEST_RELEASE's, or one built here (Bun). */
const releaseAt = process.env.ORRERY_TEST_BIN ? dirname(dirname(process.env.ORRERY_TEST_BIN)) : process.env.ORRERY_TEST_RELEASE || undefined;
const release = (): Promise<string> => (releaseAt !== undefined ? Promise.resolve(releaseAt) : builtRelease());

/** The packed plugin folder, copied into a folder outside the repository and the release. */
async function pluginCopy(): Promise<string> {
	const to = join(mkdtempSync(join(scratch, "plugin-")), "opencode");
	cpSync(join(await release(), "extensions", "opencode"), to, { recursive: true });
	return to;
}

/**
 * A private `opencode serve --stdio --port 0` given `content`, read until the plugin from `folder` is listed, then
 * stopped: what it listed for the plugin, and what the server wrote on stderr (the plugin's own line among it).
 */
function serveOnce(content: string, folder: string): Promise<{ readonly state: unknown; readonly stderr: string }> {
	const env = isolated("serve");
	const cwd = mkdtempSync(join(scratch, "cwd-"));
	const password = "test-password-1";
	return new Promise((done, fail) => {
		const child = spawn(opencode as string, ["serve", "--stdio", "--port", "0"], { cwd, env: { ...env, OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: content }, stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		let out = "";
		let state: unknown;
		const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("exit", () => {
			clearTimeout(timer);
			if (state === undefined) fail(new Error(`no answer; stderr: ${stderr}`));
			else done({ state, stderr });
		});
		child.stdout.on("data", async (chunk) => {
			if (out.includes("\n")) return;
			out += chunk;
			if (!out.includes("\n")) return;
			const { url } = JSON.parse(out.slice(0, out.indexOf("\n"))) as { url: string };
			for (let i = 0; i < 100 && state === undefined; i++) {
				const response = await fetch(`${url}/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
				const list = (await response.json()) as { data: { source: { type: string; path?: string }; state: unknown }[] };
				state = list.data.find((plugin) => plugin.source.type === "local" && plugin.source.path?.startsWith(folder))?.state;
				if (state === undefined) await new Promise((wait) => setTimeout(wait, 100));
			}
			child.stdin.end();
		});
	});
}

/**
 * A private `opencode serve --stdio --port 0` in `cwd`, given `content` and `env`, asked for the plugins of `cwd` (that
 * loads them) every 100 ms until `done()` or 20 s.
 */
function serveUntil(content: string, cwd: string, env: NodeJS.ProcessEnv, done: () => boolean): Promise<void> {
	const password = "test-password-2";
	return new Promise((settle) => {
		const child = spawn(opencode as string, ["serve", "--stdio", "--port", "0"], { cwd, env: { ...env, OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: content }, stdio: ["pipe", "pipe", "ignore"] });
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.on("exit", () => {
			clearTimeout(timer);
			settle();
		});
		let out = "";
		child.stdout.on("data", async (chunk) => {
			if (out.includes("\n")) return;
			out += chunk;
			if (!out.includes("\n")) return;
			const { url } = JSON.parse(out.slice(0, out.indexOf("\n"))) as { url: string };
			const started = Date.now();
			while (!done() && Date.now() - started < 20_000) {
				await fetch(`${url}/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } }).catch(() => undefined);
				await new Promise((wait) => setTimeout(wait, 100));
			}
			child.stdin.end();
		});
	});
}

describe.skipIf(opencode === null || (releaseAt === undefined && !bunReady))("Orrery's plugin in the installed OpenCode (scratch homes, no model)", () => {
	afterAll(removeBuiltRelease);

	it("loads the packed plugin from a folder outside the repository: active, with its options", async () => {
		const folder = await pluginCopy();
		const content = configContent(folder, { agent: "Probe", tokenFile: join(scratch, "no-token-yet") });
		const served = await serveOnce(content, folder);
		expect(served.state).toEqual({ status: "active" });
		expect(served.stderr).toContain("Orrery: loaded for Probe.");
		// Orrery's own check says the same.
		expect(await probePlugin(opencode as string, content, folder, { env: isolated("probe") })).toEqual({ ok: true });
	}, 60_000);

	it("finds a plugin that fails to load, and one OpenCode leaves out (a file, not a folder), and says why", async () => {
		const broken = join(mkdtempSync(join(scratch, "broken-")), "opencode");
		mkdirSync(broken);
		writeFileSync(join(broken, "server.js"), 'export default { id: "orrery", setup() { const x = ; } };\n');
		const content = configContent(broken, { agent: "Probe", tokenFile: join(scratch, "t") });
		expect(await probePlugin(opencode as string, content, broken, { env: isolated("probe") })).toEqual({ ok: false, why: "OpenCode could not load Orrery's plugin (Plugin failed to load)" });
		const file = join(await pluginCopy(), "server.js");
		const skipped = await probePlugin(opencode as string, configContent(file, { agent: "Probe", tokenFile: join(scratch, "t") }), file, { env: isolated("probe") });
		expect(skipped).toEqual({ ok: false, why: "OpenCode loaded its plugins without Orrery's (a policy or a config may leave it out)" });
	}, 60_000);

	it("reads no opencode.json or .opencode/plugins/ in a folder above its scratch folder: only Orrery's plugin loads", async () => {
		// What another user could plant in a shared folder above the check's: a config naming a plugin, and a plugin
		// OpenCode finds by itself. Each writes a mark when it loads.
		const base = mkdtempSync(join(scratch, "planted-"));
		const marks = join(base, "marks");
		mkdirSync(marks);
		const planted = (name: string) => `import { writeFileSync } from "node:fs";\nexport default { id: "planted.${name}", setup() { writeFileSync(${JSON.stringify(join(marks, name))}, "loaded"); } };\n`;
		mkdirSync(join(base, "planted-a"));
		writeFileSync(join(base, "planted-a", "server.js"), planted("a"));
		writeFileSync(join(base, "opencode.json"), JSON.stringify({ plugins: [join(base, "planted-a")] }));
		mkdirSync(join(base, ".opencode", "plugins"), { recursive: true });
		writeFileSync(join(base, ".opencode", "plugins", "planted-b.js"), planted("b"));
		const folder = await pluginCopy();
		const content = configContent(folder, { agent: "Probe", tokenFile: join(scratch, "t") });
		// Without Orrery's settings, a server in a folder below them loads both: the plants work.
		const below = join(base, "below");
		mkdirSync(below);
		await serveUntil(content, below, isolated("planted-control"), () => readdirSync(marks).length === 2);
		expect(readdirSync(marks).sort()).toEqual(["a", "b"]);
		for (const mark of readdirSync(marks)) rmSync(join(marks, mark));
		// Orrery's check runs below them too (Orrery's home is there): its plugin loads, theirs don't.
		const env = { ...isolated("planted"), ORRERY_HOME: join(base, "orrery") };
		expect(await probePlugin(opencode as string, content, folder, { env })).toEqual({ ok: true });
		expect(readdirSync(join(base, "orrery", "scratch"))).toEqual([]);
		expect(readdirSync(marks)).toEqual([]);
	}, 60_000);

	it("keeps a passing check for this OpenCode version in Orrery's home", async () => {
		const folder = await pluginCopy();
		const env = { ...isolated("gate"), ORRERY_HOME: join(scratch, "gate-orrery") };
		const content = configContent(folder, { agent: "Probe", tokenFile: join(scratch, "t") });
		expect(await opencodePluginGate({ path: opencode as string, version, content, folder }, { env, orrery: "0.0.0-test" })).toEqual({ ok: true });
		expect(readOpenCodeCheck(env)).toMatchObject({ version, orrery: "0.0.0-test", ok: true });
		expect(JSON.parse(readFileSync(join(env.ORRERY_HOME, "opencode-check.json"), "utf8"))).toMatchObject({ opencode: version, ok: true });
	}, 60_000);

	it("asks OpenCode's version in a scratch home: the folders the environment names get nothing", () => {
		// Orrery's home is elsewhere: its scratch folder is made there.
		const env: NodeJS.ProcessEnv = { ...isolated("version-probe"), ORRERY_HOME: join(mkdtempSync(join(scratch, "version-orrery-")), "home") };
		const asked = opencodeVersionOutput(opencode as string, env);
		expect(asked.status).toBe(0);
		expect(asked.stdout).toContain(version);
		expect(readdirSync(join(env.ORRERY_HOME as string, "scratch"))).toEqual([]);
		// OpenCode writes a log line even for --version; it went to the scratch folder, not to these.
		for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "HOME"] as const) expect(readdirSync(env[key] as string), key).toEqual([]);
	});
});

/**
 * An Orrery agent in the installed OpenCode with the packed plugin (copied outside the repository), on a fake model
 * server (test/opencode/fake-model.ts): scratch homes, Orrery's config and home in the scratch folder too, and the
 * launch's token in a 0600 file, as `orrery agent <Name> --tool opencode` gives them.
 */
async function agentWorld() {
	const base = mkdtempSync(join(scratch, "agent-"));
	const ws = join(base, "ws");
	const home = join(base, "orrery-home");
	mkdirSync(ws);
	mkdirSync(join(home, "tokens"), { recursive: true, mode: 0o700 });
	writeFileSync(
		join(base, "config.toml"),
		[`data_dir = ${JSON.stringify(join(base, "data"))}`, "[updates]", "check = false", "[agents.Atlas]", `folder = ${JSON.stringify(ws)}`, 'tool = "opencode"', 'compactor_model = "openai/gpt-5.4-mini"', 'compactor_thinking = "off"', ""].join("\n"),
	);
	const agentDir = join(base, "data", "agents", "Atlas");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "instructions.md"), "Atlas keeps the map.\n");
	const token = newToken();
	const tokenFile = join(home, "tokens", `opencode-${process.pid}-aaaaaaaaaaaa`);
	writeFileSync(tokenFile, token, { mode: 0o600 });
	const model = await startFakeModel();
	const folder = await pluginCopy();
	const content = JSON.stringify({
		model: "fake/fake-model",
		providers: { fake: { name: "Fake", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: model.baseURL, apiKey: "fake-key" }, models: { "fake-model": { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 1_000_000, output: 4096 } } } } },
		plugins: [...JSON.parse(configContent(folder, { agent: "Atlas", tokenFile })).plugins],
	});
	const env: NodeJS.ProcessEnv = { ...isolated("agent"), ORRERY_HOME: home, ORRERY_CONFIG: join(base, "config.toml"), OPENCODE_CONFIG_CONTENT: content };
	/** The agent's memory as "kind: text" lines. */
	const memory = (): string[] => {
		const store = MemoryStore.openReadOnly(join(agentDir, "memory.sqlite"));
		try {
			return store.root.map((message) => `${message.kind}: ${message.text}`);
		} finally {
			store.close();
		}
	};
	return { base, ws, agentDir, token, tokenFile, model, env, memory };
}

/** Runs `opencode <args>` in `cwd` (async: the fake model answers from this process), its output kept. */
function opencodeRun(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(opencode as string, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
		child.on("exit", (status) => {
			clearTimeout(timer);
			done({ status, stdout, stderr });
		});
	});
}

const sessionIn = (stdout: string) => /"sessionID":"(ses_[A-Za-z0-9]+)"/.exec(stdout)?.[1];

describe.skipIf(opencode === null || (releaseAt === undefined && !bunReady))("an Orrery agent in the installed OpenCode (packed plugin, fake model, scratch homes)", () => {
	afterAll(removeBuiltRelease);

	it("records the prompt and its reply, ends the request's system prompt with the instructions and the memory section, and asks no model for a title", async () => {
		const world = await agentWorld();
		try {
			// As `orrery agent Atlas --tool opencode -- run …` starts it: --standalone, a private server for this run.
			const run = await opencodeRun(["run", "--standalone", "--format", "json", "TEXT Noted: Saffron-42."], world.ws, world.env);
			expect(run.status, run.stderr).toBe(0);
			// One request, the agent loop's (with its tools): no title request.
			expect(world.model.requests).toHaveLength(1);
			const [request] = world.model.requests;
			expect((request?.body.tools ?? []).length).toBeGreaterThan(0);
			const system = systemOf(request as FakeRequest);
			const instructions = system.lastIndexOf("# Agent: Atlas\n\nAtlas keeps the map.");
			const memoryAt = system.lastIndexOf("# Memory\n\nEarlier conversation reaches you only through the view below.");
			expect(instructions).toBeGreaterThan(0);
			expect(memoryAt).toBeGreaterThan(instructions);
			expect(system.endsWith("</chat>")).toBe(true);
			// The prompt as OpenCode admitted it, and the reply: recorded before OpenCode's server stopped.
			const prompt = conversationOf(request as FakeRequest)[0]?.replace(/^user: /, "");
			expect(world.memory()).toEqual([`user: ${prompt}`, "talk: Noted: Saffron-42."]);
			// The token was claimed for OpenCode's server (gone now), and its status says it closed.
			expect(claimedBy(world.agentDir, world.token)).not.toBe(process.pid);
			expect(readStatus(world.agentDir)).toMatchObject({ open: false, model: "opencode" });
			expect(readFeed(feedFileOf(world.tokenFile))?.line).toMatch(/^Orrery · Atlas · 2 msgs( · summarizing)? · recording$/);
		} finally {
			await world.model.close();
		}
	}, 90_000);

	it("keeps a session's system prompt the same bytes; a second session sees the first's turns; a compaction asks no model and brings the view back fresh; a subagent's turn is not memory", async () => {
		const world = await agentWorld();
		const password = "test-password-3";
		const server = spawn(opencode as string, ["serve", "--stdio", "--port", "0"], { cwd: world.ws, env: { ...world.env, OPENCODE_PASSWORD: password }, stdio: ["pipe", "pipe", "ignore"] });
		const stopped = new Promise((done) => server.on("exit", done));
		try {
			const url = await new Promise<string>((done, fail) => {
				let out = "";
				server.stdout.on("data", (chunk) => {
					out += chunk;
					if (out.includes("\n")) done((JSON.parse(out.slice(0, out.indexOf("\n"))) as { url: string }).url);
				});
				server.on("exit", () => fail(new Error("the server stopped")));
			});
			const client: NodeJS.ProcessEnv = { ...world.env, OPENCODE_PASSWORD: password };
			delete client.OPENCODE_CONFIG_CONTENT;
			const turn = async (text: string, session?: string) => {
				const run = await opencodeRun(["run", "--server", url, "--format", "json", ...(session === undefined ? [] : ["-s", session]), text], world.ws, client);
				expect(run.status, run.stderr).toBe(0);
				return sessionIn(run.stdout) as string;
			};
			const requests = world.model.requests;
			const a = await turn("TEXT first-reply");
			expect(await turn("TEXT second-reply", a)).toBe(a);
			// The same session's second turn: its system prompt is the first's, byte for byte, though memory grew.
			expect(systemOf(requests[1] as FakeRequest)).toBe(systemOf(requests[0] as FakeRequest));
			await waitUntil(() => world.memory().length === 4);
			// A second session's starts with the first's turns.
			const b = await turn("TEXT b-reply");
			expect(b).not.toBe(a);
			expect(systemOf(requests[2] as FakeRequest)).toContain("talk: second-reply");
			// Compaction: answered from memory, no model request; OpenCode keeps its recent turn and the view comes back fresh.
			const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
			expect((await fetch(`${url}/api/session/${a}/compact`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" })).status).toBe(200);
			expect((await fetch(`${url}/api/experimental/session/${a}/wait`, { method: "POST", headers: auth })).status).toBe(204);
			expect(requests).toHaveLength(3);
			await turn("TEXT after-compact", a);
			const after = requests[3] as FakeRequest;
			expect(systemOf(after)).toContain("talk: b-reply");
			expect(systemOf(after)).not.toBe(systemOf(requests[0] as FakeRequest));
			expect(conversationOf(after)[0]).toContain(`<summary>\n${COMPACTION_SUMMARY}\n</summary>`);
			// A subagent: its request ends with its session's memory section; its prompt and reply are not memory.
			await turn('TOOL subagent {"agent":"general","description":"say ok","prompt":"TEXT child-reply-7"}', a);
			const child = requests.find((request) => conversationOf(request).some((line) => line.includes("You are a subagent")));
			expect(child).toBeDefined();
			const tail = (system: string) => system.slice(system.lastIndexOf("# Memory"));
			expect(tail(systemOf(child as FakeRequest))).toBe(tail(systemOf(after)));
			await waitUntil(() => world.memory().some((line) => line.startsWith("talk: TOOLRESULT:")));
			expect(world.memory().filter((line) => line.includes("You are a subagent") || line === "talk: child-reply-7")).toEqual([]);
			expect(world.memory().filter((line) => line.startsWith("user: "))).toHaveLength(5);
			// Every request was the agent loop's (with tools): no title or compaction request reached the model.
			for (const request of requests) expect((request.body.tools ?? []).length, `request ${request.n}`).toBeGreaterThan(0);
			expect(requests).toHaveLength(7);
		} finally {
			server.stdin.end();
			const killer = setTimeout(() => server.kill("SIGKILL"), 10_000);
			await stopped;
			clearTimeout(killer);
			await world.model.close();
		}
		// Cleanup released the writer lock: the memory opens for writing now.
		expect(readStatus(world.agentDir)).toMatchObject({ open: false });
		MemoryStore.open(join(world.agentDir, "memory.sqlite")).close();
	}, 120_000);
});
