import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { install } from "../../src/install/install.ts";
import { checkTools, installSteps, ompExtensionFile, ompExtensionText, orreryRoot, runInstall, type ToolCheck } from "../../src/lane/tools.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { noteNoGitWorkTree, repoIsGitWorkTree, workingTreeCheckout } from "../install/support.ts";
import { realRemoteTurn } from "../pi/remote-real-support.ts";

/**
 * OMP's whole environment for every run here: a scratch HOME and XDG folders inside it, nothing inherited but PATH.
 * OMP moves its data under $XDG_*_HOME/omp when that folder exists, so HOME alone would not keep it out of the
 * user's own state; no PI_* or OMP_* variable reaches it either.
 */
function isolated(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		TERM: "dumb",
		...extra,
	};
}

const scratch = mkdtempSync(join(tmpdir(), "orrery-real-omp-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The omp binary: ORRERY_TEST_OMP, or "omp" on PATH; null when there is none. Even --version runs in a scratch HOME. */
function findOmp(): string | null {
	const home = join(scratch, "version-home");
	mkdirSync(home, { recursive: true });
	const works = (path: string) => spawnSync(path, ["--version"], { env: isolated(home), timeout: 30_000 }).status === 0;
	const wanted = process.env.ORRERY_TEST_OMP ?? "omp";
	if (wanted.includes("/")) return works(wanted) ? wanted : null;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir !== "" && works(join(dir, wanted))) return join(dir, wanted);
	}
	return null;
}

const omp = findOmp();
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

interface Call {
	readonly system: string;
	readonly users: string[];
}

/** An OpenAI-compatible server answering every chat call with `reply`; it records each call's system text and user messages. */
async function fakeModel(reply: string) {
	const calls: Call[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			if (req.method === "GET") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "m", object: "model" }] }));
				return;
			}
			const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content));
			const messages = (JSON.parse(body || "{}") as { messages?: { role: string; content: unknown }[] }).messages ?? [];
			calls.push({
				system: messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => text(m.content)).join("\n"),
				users: messages.filter((m) => m.role === "user").map((m) => text(m.content)),
			});
			res.writeHead(200, { "content-type": "text/event-stream" });
			const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m" };
			res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { calls, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => server.close() };
}

type Frame = Record<string, unknown>;

/** OMP in RPC mode (docs/rpc.md): JSON lines out (responses, events, extension UI requests), commands in. */
function rpc(child: ChildProcessWithoutNullStreams) {
	const frames: Frame[] = [];
	const waiters: { test: (frame: Frame) => boolean; done: (frame: Frame) => void }[] = [];
	let buffer = "";
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk));
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			let frame: Frame;
			try {
				frame = JSON.parse(line) as Frame;
			} catch {
				continue;
			}
			frames.push(frame);
			for (const waiter of [...waiters]) {
				if (waiter.test(frame)) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.done(frame);
				}
			}
		}
	});
	const waitFor = (test: (frame: Frame) => boolean, ms = 60_000): Promise<Frame> => {
		const seen = frames.find(test);
		if (seen !== undefined) return Promise.resolve(seen);
		return new Promise((done, fail) => {
			const timer = setTimeout(() => fail(new Error(`no such frame in ${ms} ms. Last frames: ${JSON.stringify(frames.slice(-5))}\nstderr: ${stderr.slice(-2000)}`)), ms);
			waiters.push({
				test,
				done: (frame) => {
					clearTimeout(timer);
					done(frame);
				},
			});
		});
	};
	let next = 0;
	const send = (command: Frame): Promise<Frame> => {
		const id = `t${++next}`;
		child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		return waitFor((f) => f.type === "response" && f.id === id);
	};
	return { frames, send, waitFor };
}

describe.skipIf(omp === null)("Orrery inside a real OMP (isolated OMP home)", () => {
	it("checks out a remote lane, records a real turn, saves and closes", async () => {
		await realRemoteTurn(omp as string, "omp");
	}, 90_000);

	it("lets a delayed shutdown release go stale and retakes it on the same machine", async () => {
		await realRemoteTurn(omp as string, "omp", true);
	}, 60_000);

	it("loads from the install file, switches OMP's features off, records turns and sends only the view and this run", async () => {
		await loadCheck(mkdtempSync(join(scratch, "checkout-")), orreryRoot(), "checkout");
	}, 120_000);

	// Spec call 3: an installed copy without dev packages (npm ci --omit=dev) must load in OMP. src/omp/settings.ts
	// imports @earendil-works/pi-coding-agent at run time; OMP supplies it, or "OMP settings not applied" fails the check.
	noteNoGitWorkTree();
	it.skipIf(!repoIsGitWorkTree)("OMP loads Orrery through app/current", async () => {
		const base = mkdtempSync(join(scratch, "installed-"));
		const checkout = workingTreeCheckout();
		try {
			const home = join(base, "home");
			const { version } = install({ checkout, env: isolated(home), checks: "minimal", omitDev: true });
			expect(existsSync(join(home, ".orrery", "app", version, "node_modules", "@earendil-works", "pi-coding-agent"))).toBe(false);
			await loadCheck(base, join(home, ".orrery", "app", "current"), version);
		} finally {
			rmSync(checkout, { recursive: true, force: true });
		}
	}, 180_000);
});

/**
 * The load check, in `base`: Orrery installed into a scratch OMP home the way the Tools page installs it, against
 * `root` (a checkout, or an install's app/current), then a real OMP run in a lane. Its status records `version`.
 */
async function loadCheck(base: string, root: string, version: string): Promise<void> {
	const model = await fakeModel("pong");
	const home = join(base, "home");
	const lane = join(base, "lane");
	const data = join(base, "data", "lanes", "Probe");
	// A Claude Code lane's import line: OMP would put the stale view in its prompt unless Orrery disables CLAUDE.md.
	mkdirSync(join(lane, ".orrery"), { recursive: true });
	writeFileSync(join(lane, "CLAUDE.md"), "Lane rules.\n\n@.orrery/view.md\n");
	writeFileSync(join(lane, ".orrery", "view.md"), "STALE-VIEW-MARKER-77\n");
	const env = isolated(home, { ORRERY_CONFIG: join(base, "config.toml") });
	const agentDir = join(home, ".omp", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.yml"),
		[
			"providers:",
			"  local:",
			`    baseUrl: ${model.baseUrl}`,
			"    apiKey: none",
			"    api: openai-completions",
			"    models:",
			"      - id: m",
			"        name: m",
			"        reasoning: false",
			"        input: [text]",
			"        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
			"        contextWindow: 128000",
			"        maxTokens: 4096",
			"        compat:",
			"          supportsStore: false",
			"          supportsDeveloperRole: false",
			"          maxTokensField: max_tokens",
			"",
		].join("\n"),
	);
	writeFileSync(join(agentDir, "config.yml"), "modelRoles:\n  default: local/m\nsetupVersion: 2\n");
	// Installed the way the Tools page installs (src/lane/tools.ts), into the scratch agent folder: env's HOME is scratch.
	// Runner: no tool's --version or `claude plugin list` runs here; only OMP's wiring matters.
	const quiet = () => ({ status: 1, stdout: "", stderr: "" });
	const ompCheck = (): ToolCheck => checkTools({ root, env, run: quiet }).find((check) => check.id === "omp") as ToolCheck;
	const file = ompExtensionFile(env);
	expect(file).toBe(join(agentDir, "extensions", "orrery.ts"));
	expect(ompCheck().wiring).toBe("missing");
	const steps = installSteps(ompCheck(), root, env);
	expect(steps.map((step) => (step.kind === "write" ? step.path : step.kind))).toEqual([file]);
	expect(runInstall(steps, quiet)).toMatchObject({ ok: true });
	expect(readFileSync(file, "utf8")).toBe(ompExtensionText(root, file));
	expect(ompCheck().wiring).toBe("installed");
	writeFileSync(
		join(base, "config.toml"),
		[
			`data_dir = ${JSON.stringify(join(base, "data"))}`,
			`credentials = ${JSON.stringify(join(base, "credentials.json"))}`,
			"[[providers]]",
			'id = "local"',
			`base_url = ${JSON.stringify(model.baseUrl)}`,
			"[[providers.models]]",
			'id = "m"',
			'name = "m"',
			"context_window = 128000",
			"max_tokens = 4096",
			"reasoning = false",
			"[lanes.Probe]",
			`workspace = ${JSON.stringify(lane)}`,
			'tool = "omp"',
			'compactor_model = "local/m"',
			'compactor_thinking = "off"',
			"",
		].join("\n"),
	);
	const child = spawn(omp as string, ["--mode", "rpc"], { cwd: lane, env });
	const exited = new Promise<void>((done) => child.on("exit", () => done()));
	const { frames, send, waitFor } = rpc(child);
	try {
		await waitFor((f) => f.type === "ready");
		await waitFor((f) => f.method === "setStatus" && f.statusKey === "orrery" && f.statusText === "Orrery · Probe · 0 msgs");
		const state = (await send({ type: "get_state" })).data as { autoCompactionEnabled: boolean; systemPrompt: string[]; dumpTools: { name: string }[] };
		expect(state.autoCompactionEnabled).toBe(false);
		expect(state.systemPrompt.join("\n")).not.toContain("STALE-VIEW-MARKER-77");
		const tools = state.dumpTools.map((tool) => tool.name);
		expect(tools).toEqual(expect.arrayContaining(["zoom", "date", "memory_search"]));
		expect(tools).not.toContain("search");
		// Orrery's own summary registry inside OMP (models.ts's fallback): /compactor reset makes one test call through it.
		await send({ type: "prompt", message: "/compactor reset" });
		await waitFor((f) => f.method === "notify" && f.message === "summaries: local/m (off) · from config");
		const first = await send({ type: "prompt", message: "The codename is Cedar." });
		await waitFor((f) => f.type === "prompt_result" && f.id === first.id);
		const second = await send({ type: "prompt", message: "What is the codename?" });
		await waitFor((f) => f.type === "prompt_result" && f.id === second.id);
		const turn2 = model.calls.find((call) => call.system.includes("# Memory") && call.users.some((u) => u.includes("What is the codename?")));
		expect(turn2?.system).toContain("The codename is Cedar.");
		expect(turn2?.system).toContain("zoom, date and memory_search are the Orrery memory tools");
		expect(turn2?.users).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(data, "status.json"), "utf8"))).toMatchObject({ lane: "Probe", model: "omp", open: true, version });
		expect(frames.filter((f) => f.method === "notify" && String(f.message).includes("OMP settings not applied"))).toEqual([]);
	} finally {
		child.stdin.end();
		const stop = setTimeout(() => child.kill("SIGTERM"), 10_000);
		await exited;
		clearTimeout(stop);
		model.close();
	}
	const store = MemoryStore.openReadOnly(join(data, "memory.sqlite"));
	const rows = store.root.map((m) => `${m.kind}: ${m.text}`);
	store.close();
	expect(rows).toEqual(["user: The codename is Cedar.", "talk: pong", "user: What is the codename?", "talk: pong"]);
	expect(JSON.parse(readFileSync(join(data, "status.json"), "utf8")).open).toBe(false);
}
