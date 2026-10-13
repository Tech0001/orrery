import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { realRemoteTurn } from "./remote-real-support.ts";

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

/** The pi binary to test with: ORRERY_TEST_PI, or "pi" on PATH. Null when there is none (a headless server may have no pi). */
function findPi(): string | null {
	const works = (path: string) => spawnSync(path, ["--version"], { cwd: scratch, env: isolated(scratch), timeout: 30_000 }).status === 0;
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
