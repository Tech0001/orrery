import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { install, listVersions } from "../../src/install/install.ts";
import { wire } from "../../src/install/wire.ts";
import { readStatus } from "../../src/lane/status-file.ts";
import { piExtensionFile, piExtensionText } from "../../src/lane/tools.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { commitAll, workingTreeCheckout } from "../install/support.ts";
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
const LANE_DIR = resolve(fileURLToPath(new URL("../../src/lane", import.meta.url)));
const PI_DIR = resolve(fileURLToPath(new URL("../../src/pi", import.meta.url)));
const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
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
describe.skipIf(compiledPi === null)("Orrery's remote lanes inside a compiled pi (Bun)", () => {
	it("rebuilds a remote lane from a snapshot and later saves in Bun's SQLite, keeping every save", async () => {
		await realRemoteRebuild(compiledPi as string);
	}, 90_000);
});

/**
 * A compiled pi loads the extension through jiti with only its own embedded pi packages. This runs orrery's model
 * registry inside the real binary and makes a real call, so an import pi cannot resolve ("Cannot find package
 * 'partial-json'") shows up here.
 */
describe.skipIf(pi === null)("Orrery's models inside a real pi", () => {
	it("checks out a remote lane, records a real turn, saves and closes", async () => {
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
				`import { FileCredentialStore } from ${JSON.stringify(join(LANE_DIR, "credentials.ts"))};
import { createLaneModels } from ${JSON.stringify(join(LANE_DIR, "models.ts"))};

const models = createLaneModels({
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
			`import { takeRequest, writeRequest } from ${JSON.stringify(join(LANE_DIR, "settings-request.ts"))};

try {
	writeRequest(${JSON.stringify(dir)}, { lane: "A", kind: "compactor", args: "a/b low", at: Date.now() });
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

	it("loads the extension and tells pi from OMP: pi's entry registers its handlers, OMP's only its guard's session_start", async () => {
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
			omp: ["session_start"],
		});
	}, 90_000);
});

/**
 * The installed layout end to end: pi loads Orrery through app/current, a second install switches current while pi
 * runs, and the running pi keeps the version it started with (its status says so) while a new pi runs the new one.
 */
describe.skipIf(pi === null)("Orrery installed in app/current, inside a real pi", () => {
	it("a running pi keeps its version across an install", async () => {
		const root = mkdtempSync(join(tmpdir(), "orrery-installed-pi-"));
		dirs.push(root);
		const home = join(root, "home");
		const workspace = join(root, "workspace");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		mkdirSync(workspace);
		const orreryHome = join(home, ".orrery");
		const env = { ...isolated(home), ORRERY_HOME: orreryHome };
		const checkout = workingTreeCheckout();
		dirs.push(checkout);
		// With dev packages (npm ci without --omit=dev); the OMP test installs without them.
		const first = install({ checkout, env, checks: "minimal" });
		const current = join(orreryHome, "app", "current");
		// Wired the way npm run install-local wires; this runner refuses every command (no real claude or systemctl runs).
		const refuse = () => ({ status: 1, stdout: "", stderr: "not run in this test" });
		const wired = await wire(env, { run: refuse, confirm: async () => false });
		expect(wired.join("\n")).toMatch(/^pi: wrote /m);
		expect(readFileSync(piExtensionFile(env), "utf8")).toBe(piExtensionText(current));

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
				"[lanes.Probe]",
				`workspace = ${JSON.stringify(workspace)}`,
				'tool = "pi"',
				'compactor_model = "local/m"',
				'compactor_thinking = "off"',
				"",
			].join("\n"),
			{ mode: 0o600 },
		);
		const laneDir = join(data, "lanes", "Probe");
		const rows = () => {
			if (!existsSync(join(laneDir, "memory.sqlite"))) return [];
			const store = MemoryStore.openReadOnly(join(laneDir, "memory.sqlite"));
			try {
				return store.root.map((m) => `${m.kind}: ${m.text}`);
			} finally {
				store.close();
			}
		};
		const runs: { child: ChildProcessWithoutNullStreams; exited: Promise<void>; output: () => string }[] = [];
		const launch = () => {
			const child = spawn(pi as string, ["--mode", "rpc", "--provider", "local", "--model", "m", "--thinking", "off"], { cwd: workspace, env });
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
			const status = readStatus(laneDir);
			return status !== undefined && status.pid === run.child.pid && status.open !== false ? status : undefined;
		});
		const turn = async (run: (typeof runs)[number], message: string, count: number) => {
			run.child.stdin.write(`${JSON.stringify({ id: `t${count}`, type: "prompt", message })}\n`);
			return until(`${count} rows`, run, () => (rows().length >= count ? rows() : undefined));
		};
		try {
			const running = launch();
			expect((await openStatus(running)).version).toBe(first.version);
			await turn(running, "The codename is Cedar.", 2);

			commitAll(checkout, "a second version");
			const second = install({ checkout, env, checks: "minimal" });
			expect(second.version).not.toBe(first.version);
			expect(second.previous).toBe(first.version);
			expect(readlinkSync(current)).toBe(second.version);
			// The live lane keeps its version folder.
			expect(listVersions(env)).toEqual([
				{ name: first.version, current: false, lanes: ["Probe"] },
				{ name: second.version, current: true, lanes: [] },
			]);

			expect(await turn(running, "What is the codename?", 4)).toEqual(["user: The codename is Cedar.", "talk: pong", "user: What is the codename?", "talk: pong"]);
			expect(readStatus(laneDir)).toMatchObject({ pid: running.child.pid, version: first.version });
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
		}
	}, 300_000);
});
