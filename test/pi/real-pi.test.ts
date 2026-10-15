import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { installFrom, listVersions, removeVersion } from "../../src/install/install.ts";
import { newToken } from "../../src/agent/pick.ts";
import { readStatus } from "../../src/agent/status-file.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { assertPiWhenRequired, builtRelease, changedSince, installRelease, REPO, releaseReady, removeBuiltRelease } from "../release/support.ts";
import { fakeModel, rpc } from "./host-rpc.ts";
import { realRemoteRebuild, realRemoteTurn, streamReply, writeModels } from "./remote-real-support.ts";

function isolated(home: string): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		TERM: "dumb",
		// The extension's daily update check: a closed local port, never github.com.
		ORRERY_RELEASES_URL: "http://127.0.0.1:9/releases",
		PI_OFFLINE: "1",
	};
}

const scratch = mkdtempSync(join(tmpdir(), "orrery-real-pi-version-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Whether `path` is a script ("#!"): pi's Node build is one; its compiled binary runs on Bun. */
function script(path: string): boolean {
	const fd = openSync(path, "r");
	try {
		const head = Buffer.alloc(2);
		return readSync(fd, head, 0, 2, 0) === 2 && head.toString("latin1") === "#!";
	} finally {
		closeSync(fd);
	}
}

/**
 * The pi binary to test with: ORRERY_TEST_PI, or "pi" on PATH. Null when there is none (a headless server may have no pi).
 * `compiled`: only pi's compiled binary (Bun), never a script such as node_modules/.bin/pi (Node), which npm test puts
 * first on PATH.
 */
function findPi(compiled = false): string | null {
	const works = (path: string) => (!compiled || (existsSync(path) && !script(path))) && spawnSync(path, ["--version"], { cwd: scratch, env: isolated(scratch), timeout: 30_000 }).status === 0;
	const wanted = process.env.ORRERY_TEST_PI ?? "pi";
	if (wanted.includes("/")) return works(wanted) ? wanted : null;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, wanted);
		if (works(candidate)) return candidate;
	}
	return null;
}

const pi = findPi();
const compiledPi = findPi(true);
/** pi's npm build (Node) from the repo's devDependency: a script, where the compiled pi is a binary. Null without it. */
const npmPi: string | null = (() => {
	const path = join(REPO, "node_modules", ".bin", "pi");
	return existsSync(path) && script(path) && spawnSync(path, ["--version"], { cwd: scratch, env: isolated(scratch), timeout: 30_000 }).status === 0 ? path : null;
})();
assertPiWhenRequired(process.env, npmPi);
const AGENT_DIR = resolve(fileURLToPath(new URL("../../src/agent", import.meta.url)));
const PI_DIR = resolve(fileURLToPath(new URL("../../src/pi", import.meta.url)));
const dirs: string[] = [];
afterAll(removeBuiltRelease);
afterAll(() => {
	for (const dir of dirs) removeVersion(dir); // an installed release is read-only
});

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

function run(cmd: string, args: string[], cwd: string): Promise<string> {
	return new Promise((done) => {
		const home = join(cwd, "home");
		mkdirSync(home, { recursive: true });
		const child = spawn(cmd, args, { cwd, env: isolated(home), stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.on("close", () => {
			clearTimeout(timer);
			done(out);
		});
	});
}

/** Orrery inside the compiled pi runs on Bun's SQLite (bun:sqlite), which no test on Node reaches. */
describe.skipIf(compiledPi === null)("Orrery's remote agents inside a compiled pi (Bun)", () => {
	it("rebuilds a remote agent from a snapshot and later saves in Bun's SQLite, keeping every save", async () => {
		await realRemoteRebuild(compiledPi as string);
	}, 90_000);
});

/**
 * A compiled pi loads the extension through jiti with only its own embedded pi packages. This runs orrery's model
 * registry inside the real binary and makes a real call, so an import pi cannot resolve ("Cannot find package
 * 'partial-json'") shows up here.
 */
describe.skipIf(pi === null)("Orrery's models inside a real pi", () => {
	it("checks out a remote agent, records a real turn, saves and closes", async () => {
		await realRemoteTurn(pi as string, "pi");
	}, 90_000);

	it("completes a summary call through the registry", async () => {
		const dir = mkdtempSync(join(tmpdir(), "orrery-real-pi-"));
		dirs.push(dir);
		let requests = 0;
		const server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				requests += 1;
				res.writeHead(200, { "content-type": "text/event-stream" });
				const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m" };
				res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] }));
				res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
				res.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		try {
			const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
			const fixture = join(dir, "fixture.ts");
			writeFileSync(
				fixture,
				`import { FileCredentialStore } from ${JSON.stringify(join(AGENT_DIR, "credentials.ts"))};
import { createAgentModels } from ${JSON.stringify(join(AGENT_DIR, "models.ts"))};

const models = createAgentModels({
	credentials: new FileCredentialStore(${JSON.stringify(join(dir, "store.json"))}),
	providers: [{ id: "local", baseUrl: ${JSON.stringify(baseUrl)}, models: [{ id: "m", name: "m", reasoning: false, contextWindow: 8000, maxTokens: 1000 }] }],
});
try {
	const model = models.getModel("local", "m");
	if (model === undefined) throw new Error("no model");
	const reply = await models.completeSimple(model, { systemPrompt: "s", messages: [{ role: "user", content: "ping", timestamp: Date.now() }] }, { maxRetries: 0 });
	if (reply.stopReason === "error") throw new Error(reply.errorMessage);
	console.log("reply: " + reply.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
} catch (error) {
	console.log("error: " + (error instanceof Error ? (error.stack ?? error.message) : String(error)));
}
process.exit(0);
export default function () {}
`,
			);
			const out = await run(pi as string, ["-ne", "-e", fixture, "--no-session", "-p", "x"], dir);
			expect(out).toContain("reply: pong");
			expect(out).not.toContain("Cannot find package");
			expect(out).not.toContain("ResolveMessage");
			expect(requests).toBe(1);
		} finally {
			server.close();
		}
	}, 90_000);

	it("takes a settings request through settings-request.ts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "orrery-real-pi-"));
		dirs.push(dir);
		const fixture = join(dir, "fixture.ts");
		writeFileSync(
			fixture,
			`import { takeRequest, writeRequest } from ${JSON.stringify(join(AGENT_DIR, "settings-request.ts"))};

try {
	writeRequest(${JSON.stringify(dir)}, { agent: "A", kind: "compactor", args: "a/b low", at: Date.now() });
	console.log("taken: " + takeRequest(${JSON.stringify(dir)}, "A").request?.args);
} catch (error) {
	console.log("error: " + (error instanceof Error ? (error.stack ?? error.message) : String(error)));
}
process.exit(0);
export default function () {}
`,
		);
		const out = await run(pi as string, ["-ne", "-e", fixture, "--no-session", "-p", "x"], dir);
		expect(out).toContain("taken: a/b low");
		expect(out).not.toContain("Cannot find");
	}, 90_000);

	it("loads the extension and tells pi from OMP: pi's entry registers its handlers, OMP's only its guard's session_start and the session-owner notes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "orrery-real-pi-"));
		dirs.push(dir);
		const fixture = join(dir, "fixture.ts");
		writeFileSync(
			fixture,
			`import { createOrrery, insideOmp } from ${JSON.stringify(join(PI_DIR, "index.ts"))};

export default function (pi) {
	try {
		// The events an entry registers on the real API, with on swapped for a recorder.
		const events = (factory) => {
			const seen = [];
			factory({ ...pi, on: (event) => seen.push(event) });
			return seen;
		};
		const found = { insideOmp: insideOmp(pi), arktype: "arktype" in pi, zod: "zod" in pi, pi: events(createOrrery()), omp: events(createOrrery({ host: "omp" })) };
		console.log("found: " + JSON.stringify(found));
	} catch (error) {
		console.log("error: " + (error instanceof Error ? (error.stack ?? error.message) : String(error)));
	}
	process.exit(0);
}
`,
		);
		const out = await run(pi as string, ["-ne", "-e", fixture, "--no-session", "-p", "x"], dir);
		const line = out.split("\n").find((text) => text.startsWith("found: "));
		expect(line, out).toBeDefined();
		expect(JSON.parse((line as string).slice("found: ".length))).toEqual({
			insideOmp: false,
			arktype: false,
			zod: false,
			pi: expect.arrayContaining(["session_start", "before_agent_start", "context", "message_end", "agent_end", "session_before_compact"]),
			omp: ["session_start", "message_end", "agent_end", "session_shutdown"],
		});
	}, 90_000);
});

/**
 * ORRERY_AGENT in a real pi: the named agent opens in a folder outside its folder, and the ORRERY_AGENT_TOKEN claim
 * names that pi's own process, so a second pi started with the same variables (a tool the agent ran) is not the agent.
 */
describe.skipIf(pi === null)("ORRERY_AGENT inside a real pi", () => {
	it("opens the named agent in a plain folder and records there; a second pi with the same token is not the agent", async () => {
		const root = mkdtempSync(join(tmpdir(), "orrery-agent-pi-"));
		const model = await fakeModel("pong");
		try {
			const home = join(root, "home");
			const plain = join(root, "plain");
			const piAgentDir = join(home, ".pi", "agent");
			const orreryHome = join(home, ".orrery");
			for (const dir of [piAgentDir, plain, orreryHome]) mkdirSync(dir, { recursive: true });
			writeModels(piAgentDir, "pi", model.baseUrl);
			const data = join(root, "data");
			writeFileSync(
				join(orreryHome, "config.toml"),
				[
					`data_dir = ${JSON.stringify(data)}`,
					"[[providers]]",
					'id = "local"',
					`base_url = ${JSON.stringify(model.baseUrl)}`,
					"[[providers.models]]",
					'id = "m"',
					'name = "m"',
					"context_window = 128000",
					"max_tokens = 4096",
					"reasoning = false",
					"[agents.Probe]",
					`folder = ${JSON.stringify(join(root, "agent-Probe"))}`,
					'tool = "pi"',
					'compactor_model = "local/m"',
					'compactor_thinking = "off"',
					"",
				].join("\n"),
				{ mode: 0o600 },
			);
			const token = newToken();
			const env = { ...isolated(home), ORRERY_HOME: orreryHome, PI_CODING_AGENT_DIR: piAgentDir, ORRERY_AGENT: "Probe", ORRERY_AGENT_TOKEN: token };
			const agentDir = join(data, "agents", "Probe");
			const rows = () => {
				if (!existsSync(join(agentDir, "memory.sqlite"))) return [];
				const store = MemoryStore.openReadOnly(join(agentDir, "memory.sqlite"));
				try {
					return store.root.map((m) => `${m.kind}: ${m.text}`);
				} finally {
					store.close();
				}
			};
			const start = () => {
				const child = spawn(pi as string, ["--mode", "rpc", "--provider", "local", "--model", "m", "--thinking", "off", "-ne", "-e", join(PI_DIR, "index.ts")], { cwd: plain, env });
				const exited = new Promise<void>((done) => child.on("close", () => done()));
				return { child, exited, ...rpc(child) };
			};
			const stop = async (run: ReturnType<typeof start>) => {
				run.child.stdin.end();
				const kill = setTimeout(() => run.child.kill("SIGKILL"), 10_000);
				await run.exited;
				clearTimeout(kill);
			};
			const agent = start();
			try {
				await agent.waitFor((f) => f.method === "setStatus" && f.statusKey === "orrery" && f.statusText === "Orrery · Probe · 0 msgs");
				expect(readFileSync(join(agentDir, "claims", token), "utf8")).toBe(`${agent.child.pid}\n`);
				await agent.send({ type: "prompt", message: "The codename is Cedar." });
				await agent.waitFor((f) => f.type === "agent_end");
				const deadline = Date.now() + 30_000;
				while (rows().length < 2 && Date.now() < deadline) await delay(50);
				expect(rows()).toEqual(["user: The codename is Cedar.", "talk: pong"]);
				const tool = start();
				try {
					await tool.send({ type: "prompt", message: "Said by a tool the agent started." });
					await tool.waitFor((f) => f.type === "agent_end");
					expect(tool.frames.filter((f) => f.method === "setStatus" && f.statusKey === "orrery")).toEqual([]);
				} finally {
					await stop(tool);
				}
				expect(rows()).toEqual(["user: The codename is Cedar.", "talk: pong"]);
				expect(`${agent.stderr()}\n${JSON.stringify(agent.frames)}`).not.toMatch(/Cannot find (package|module)|ResolveMessage/);
			} finally {
				await stop(agent);
			}
			expect(readStatus(agentDir)?.open).toBe(false);
		} finally {
			model.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 90_000);
});

/** spec §9: a real pi opens an agent, by ORRERY_AGENT, from a folder that is not its own, with its instructions and memory. */
describe.skipIf(pi === null)("an agent opened outside its folder, inside a real pi", () => {
	it("puts its instructions, then its memory, in the system prompt", async () => {
		const root = mkdtempSync(join(tmpdir(), "orrery-agent-pi-"));
		dirs.push(root);
		const home = join(root, "home");
		const agentDir = join(root, "data", "agents", "Probe");
		for (const dir of [join(root, "agent-Probe"), join(root, "elsewhere"), agentDir]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(agentDir, "instructions.md"), "You are Probe. Your tag is TAG-4711.\n");
		const store = MemoryStore.open(join(agentDir, "memory.sqlite"));
		store.appendBatch([{ kind: "user", text: "The codename is Cedar.", date: "2026-10-01T10:00:00.000Z" }, { kind: "talk", text: "Noted.", date: "2026-10-01T10:00:05.000Z" }]);
		store.close();
		const model = await fakeModel("pong");
		try {
			const piAgentDir = join(home, ".pi", "agent");
			mkdirSync(join(piAgentDir, "extensions"), { recursive: true });
			writeFileSync(join(piAgentDir, "extensions", "orrery.ts"), `export { default } from ${JSON.stringify(join(PI_DIR, "index.ts"))};\n`);
			writeModels(piAgentDir, "pi", model.baseUrl);
			writeFileSync(join(root, "config.toml"), [`data_dir = ${JSON.stringify(join(root, "data"))}`, "[[providers]]", 'id = "local"', `base_url = ${JSON.stringify(model.baseUrl)}`, "[[providers.models]]", 'id = "m"', 'name = "m"', "context_window = 128000", "max_tokens = 4096", "reasoning = false", "[agents.Probe]", `folder = ${JSON.stringify(join(root, "agent-Probe"))}`, 'tool = "pi"', 'compactor_model = "local/m"', 'compactor_thinking = "off"', ""].join("\n"));
			const env = { ...isolated(home), ORRERY_CONFIG: join(root, "config.toml"), PI_CODING_AGENT_DIR: piAgentDir, ORRERY_AGENT: "Probe" };
			const child = spawn(pi as string, ["--mode", "rpc", "--provider", "local", "--model", "m", "--thinking", "off"], { cwd: join(root, "elsewhere"), env });
			const exited = new Promise<void>((done) => child.on("close", () => done()));
			const { send, waitFor } = rpc(child);
			try {
				await waitFor((f) => f.method === "setStatus" && f.statusKey === "orrery" && f.statusText === "Orrery · Probe · 2 msgs");
				await send({ type: "prompt", message: "Who are you?" });
				await waitFor((f) => f.type === "agent_end");
				const system = model.calls.find((call) => call.users.some((text) => text.includes("Who are you?")))?.system ?? "";
				expect(system).toContain("# Agent: Probe");
				expect(system).toContain("TAG-4711");
				expect(system).toContain("The codename is Cedar.");
				expect(system.indexOf("# Agent: Probe")).toBeLessThan(system.indexOf("# Memory"));
			} finally {
				child.stdin.end();
				const stop = setTimeout(() => child.kill("SIGKILL"), 10_000);
				await exited;
				clearTimeout(stop);
			}
		} finally {
			model.close();
		}
	}, 90_000);
});

/**
 * The installed layout end to end: pi loads Orrery through app/current, a second install switches current while pi
 * runs, and the running pi keeps the version it started with (its status says so) while a new pi runs the new one.
 */
// Needs pi's compiled binary (a dev build such as node_modules/.bin/pi does not count: CI has none) and a release.
describe.skipIf(compiledPi === null || !releaseReady)("Orrery installed in app/current, inside a real pi", () => {
	it("a running pi keeps its version across an install", async () => {
		const root = mkdtempSync(join(tmpdir(), "orrery-installed-pi-"));
		dirs.push(root);
		const home = join(root, "home");
		const folder = join(root, "folder");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		mkdirSync(folder);
		const orreryHome = join(home, ".orrery");
		const env = { ...isolated(home), ORRERY_HOME: orreryHome };
		const release = await builtRelease();
		const first = installFrom({ from: release, env });
		const current = join(orreryHome, "app", "current");
		// Written by hand until the wiring knows releases: pi's extension file re-exports the installed pi.js.
		mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "extensions", "orrery.ts"), `export { default } from ${JSON.stringify(join(current, "extensions", "pi.js"))};\n`);

		let chats = 0;
		const server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				if (req.method === "GET") {
					res.end(JSON.stringify({ object: "list", data: [{ id: "m" }] }));
					return;
				}
				chats += 1;
				streamReply(res, "pong");
			});
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		writeModels(join(home, ".pi", "agent"), "pi", baseUrl);
		const data = join(root, "data");
		writeFileSync(
			join(orreryHome, "config.toml"),
			[
				`data_dir = ${JSON.stringify(data)}`,
				"[[providers]]",
				'id = "local"',
				`base_url = ${JSON.stringify(baseUrl)}`,
				"[[providers.models]]",
				'id = "m"',
				'name = "m"',
				"context_window = 128000",
				"max_tokens = 4096",
				"reasoning = false",
				"[agents.Probe]",
				`folder = ${JSON.stringify(folder)}`,
				'tool = "pi"',
				'compactor_model = "local/m"',
				'compactor_thinking = "off"',
				"",
			].join("\n"),
			{ mode: 0o600 },
		);
		const agentDir = join(data, "agents", "Probe");
		const rows = () => {
			if (!existsSync(join(agentDir, "memory.sqlite"))) return [];
			const store = MemoryStore.openReadOnly(join(agentDir, "memory.sqlite"));
			try {
				return store.root.map((m) => `${m.kind}: ${m.text}`);
			} finally {
				store.close();
			}
		};
		const runs: { child: ChildProcessWithoutNullStreams; exited: Promise<void>; output: () => string }[] = [];
		const launch = () => {
			const child = spawn(pi as string, ["--mode", "rpc", "--provider", "local", "--model", "m", "--thinking", "off"], { cwd: folder, env });
			let output = "";
			child.stdout.on("data", (chunk) => (output += chunk));
			child.stderr.on("data", (chunk) => (output += chunk));
			const exited = new Promise<void>((done) => {
				child.on("error", (error) => {
					output += String(error);
					done();
				});
				child.on("close", () => done());
			});
			const run = { child, exited, output: () => output };
			runs.push(run);
			return run;
		};
		const until = async <T>(what: string, run: (typeof runs)[number], value: () => T | undefined): Promise<T> => {
			const deadline = Date.now() + 30_000;
			for (;;) {
				const seen = value();
				if (seen !== undefined) return seen;
				if (Date.now() > deadline || run.child.exitCode !== null) throw new Error(`no ${what}: ${run.output().slice(-3000)}`);
				await delay(50);
			}
		};
		const openStatus = (run: (typeof runs)[number]) => until("open status", run, () => {
			const status = readStatus(agentDir);
			return status !== undefined && status.pid === run.child.pid && status.open !== false ? status : undefined;
		});
		const turn = async (run: (typeof runs)[number], message: string, count: number) => {
			run.child.stdin.write(`${JSON.stringify({ id: `t${count}`, type: "prompt", message })}\n`);
			return until(`${count} rows`, run, () => (rows().length >= count ? rows() : undefined));
		};
		// The daily check's answer, fresh: the session shows it and asks nothing.
		writeFileSync(join(orreryHome, "update-check.json"), JSON.stringify({ checkedAt: Date.now(), latest: "99.0.0" }), { mode: 0o600 });
		const said = (run: (typeof runs)[number], text: string) => until(`"${text}"`, run, () => (run.output().includes(text) ? true : undefined));
		try {
			const running = launch();
			expect((await openStatus(running)).version).toBe(first.version);
			await said(running, "Orrery 99.0.0 is available. Run `orrery update`, then restart this session.");
			await turn(running, "The codename is Cedar.", 2);

			// A second version: the same release under another VERSION (its binary reports the file's version).
			const other = join(root, "second-release");
			cpSync(release, other, { recursive: true });
			writeFileSync(join(other, "VERSION"), `${first.version}-second\n`);
			const second = installFrom({ from: other, env });
			expect(second.version).not.toBe(first.version);
			expect(second.previous).toBe(first.version);
			expect(readlinkSync(current)).toBe(second.version);
			// The live agent keeps its version folder.
			expect(listVersions(env)).toEqual([
				{ name: first.version, current: false, agents: ["Probe"] },
				{ name: second.version, current: true, agents: [] },
			]);

			// The running pi says, on its next status tick, that Orrery was updated under it.
			await said(running, `Orrery was updated to ${second.version}; restart this session to use it.`);
			expect(await turn(running, "What is the codename?", 4)).toEqual(["user: The codename is Cedar.", "talk: pong", "user: What is the codename?", "talk: pong"]);
			expect(readStatus(agentDir)).toMatchObject({ pid: running.child.pid, version: first.version });
			running.child.stdin.end();
			await running.exited;

			const fresh = launch();
			expect((await openStatus(fresh)).version).toBe(second.version);
			fresh.child.stdin.end();
			await fresh.exited;
			expect(chats).toBeGreaterThanOrEqual(2);
		} finally {
			for (const run of runs) {
				run.child.stdin.end();
				const stop = setTimeout(() => run.child.kill("SIGKILL"), 5000);
				await run.exited;
				clearTimeout(stop);
			}
			server.closeAllConnections();
			await new Promise<void>((done) => server.close(() => done()));
			removeVersion(root); // the installed versions are read-only
		}
	}, 300_000);
});

/**
 * A release as installed: app/<version> read-only, app/current linking to it, and pi's one-line extension file
 * re-exporting extensions/pi.js by absolute path. pi of both kinds must supply what pi.js leaves out: the compiled one
 * through its virtual modules (Bun), the npm one through its aliases (Node).
 */
describe.skipIf(!releaseReady)("Orrery from a read-only installed release, inside a real pi", () => {
	for (const [kind, binary] of [["compiled", compiledPi], ["npm", npmPi]] as const) {
		it.skipIf(binary === null)(`the ${kind} pi loads extensions/pi.js, summarizes through Orrery's registry, records a turn, and writes nothing into the release`, async () => {
			await releaseCheck(binary as string);
		}, 120_000);
	}
});

async function releaseCheck(binary: string): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "orrery-release-pi-"));
	dirs.push(root);
	const home = join(root, "home");
	const folder = join(root, "folder");
	const data = join(root, "data");
	mkdirSync(folder);
	const installed = installRelease(await builtRelease(), home);
	const model = await fakeModel("pong");
	try {
		const piAgentDir = join(home, ".pi", "agent");
		mkdirSync(join(piAgentDir, "extensions"), { recursive: true });
		writeFileSync(join(piAgentDir, "extensions", "orrery.ts"), `export { default } from ${JSON.stringify(join(installed.current, "extensions", "pi.js"))};\n`);
		writeModels(piAgentDir, "pi", model.baseUrl);
		writeFileSync(
			join(home, ".orrery", "config.toml"),
			[
				`data_dir = ${JSON.stringify(data)}`,
				"[[providers]]",
				'id = "local"',
				`base_url = ${JSON.stringify(model.baseUrl)}`,
				"[[providers.models]]",
				'id = "m"',
				'name = "m"',
				"context_window = 128000",
				"max_tokens = 4096",
				"reasoning = false",
				"[agents.Probe]",
				`folder = ${JSON.stringify(folder)}`,
				'tool = "pi"',
				'compactor_model = "local/m"',
				'compactor_thinking = "off"',
				"",
			].join("\n"),
			{ mode: 0o600 },
		);
		const env = { ...isolated(home), ORRERY_HOME: join(home, ".orrery"), PI_CODING_AGENT_DIR: piAgentDir };
		const child = spawn(binary, ["--mode", "rpc", "--provider", "local", "--model", "m", "--thinking", "off"], { cwd: folder, env });
		const exited = new Promise<void>((done) => child.on("close", () => done()));
		const { frames, send, waitFor, stderr } = rpc(child);
		const agentDir = join(data, "agents", "Probe");
		try {
			await waitFor((f) => f.method === "setStatus" && f.statusKey === "orrery" && f.statusText === "Orrery · Probe · 0 msgs");
			// The version comes from the release's VERSION, found from extensions/pi.js (src/agent/running.ts).
			expect(readStatus(agentDir)).toMatchObject({ agent: "Probe", pid: child.pid, open: true, version: installed.version });
			// The summary call: /compactor reset tests the agent's config model through Orrery's registry, then says so.
			const calls = model.calls.length;
			await send({ type: "prompt", message: "/compactor reset" });
			await waitFor((f) => f.method === "notify" && f.message === "summaries: local/m (off) · from config");
			expect(model.calls.length).toBe(calls + 1);
			await send({ type: "prompt", message: "The codename is Cedar." });
			await waitFor((f) => f.type === "agent_end");
			const deadline = Date.now() + 30_000;
			const rows = () => {
				if (!existsSync(join(agentDir, "memory.sqlite"))) return [];
				const store = MemoryStore.openReadOnly(join(agentDir, "memory.sqlite"));
				try {
					return store.root.map((m) => `${m.kind}: ${m.text}`);
				} finally {
					store.close();
				}
			};
			while (rows().length < 2 && Date.now() < deadline) await delay(50);
			expect(rows()).toEqual(["user: The codename is Cedar.", "talk: pong"]);
			expect(`${stderr()}\n${JSON.stringify(frames)}`).not.toMatch(/Cannot find (package|module)|ResolveMessage/);
		} finally {
			child.stdin.end();
			const stop = setTimeout(() => child.kill("SIGKILL"), 10_000);
			await exited;
			clearTimeout(stop);
		}
		expect(readStatus(agentDir)?.open).toBe(false);
		expect(changedSince(installed.folder, installed.marker)).toEqual([]);
	} finally {
		model.close();
		installed.remove();
	}
}
