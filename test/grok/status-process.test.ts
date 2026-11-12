import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeHolder } from "../../src/agent/handover.ts";
import { claimToken, newToken } from "../../src/agent/pick.ts";
import { forgetSession, recordSession } from "../../src/agent/sessions.ts";
import { writeMode } from "../../src/claude/spool.ts";
import { approveGrokSettings, checkGrokSettings } from "../../src/grok/settings.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { cleanEnv, cleanupDirs, cliCommand, grokLaunch, type TestAgent, testAgent, waitUntil } from "../claude/support.ts";

/**
 * `orrery grok-status` as Grok Build runs it for its status row: Grok (a stand-in named grok) runs the command as its
 * child, with its status JSON on stdin, on every state change and continuously during a turn. In `npm run test:binary`
 * the command is the release binary (ORRERY_TEST_BIN).
 */

const groks: ChildProcess[] = [];
const recorded: { dataDir: string; pid: number }[] = [];
afterEach(() => {
	for (const grok of groks.splice(0)) grok.kill("SIGKILL");
	for (const { dataDir, pid } of recorded.splice(0)) forgetSession(dataDir, pid);
	cleanupDirs();
});

/** The binary's budget: Grok debounces the row at 300 ms, so a run must be done by then. `node main.ts` gets more. */
const BUDGET_MS = process.env.ORRERY_TEST_BIN ? 300 : 5_000;

/** `count` messages of a few hundred bytes each, as a long-lived agent has. */
function remember(t: TestAgent, count: number): void {
	const store = MemoryStore.open(join(t.agent.dir, "memory.sqlite"));
	try {
		const filler = "lorem ipsum dolor sit amet ".repeat(12);
		store.appendBatch(Array.from({ length: count }, (_, i) => ({ kind: i % 2 === 0 ? ("user" as const) : ("talk" as const), text: `message ${i}: ${filler}`, date: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() })));
	} finally {
		store.close();
	}
}

/**
 * A stand-in Grok that runs `orrery grok-status` as its child once `go` is called, with `stdin` on its stdin; its pid is
 * known before, so a test can claim the token for it and record its session first, as Grok's hooks would. `done`: the
 * command's stdout, stderr and exit code, and how long it took from `go`.
 */
function grokRow(stdin: string, env: Record<string, string>, cwd?: string) {
	const c = cliCommand(["grok-status"]);
	const gate = join(cleanEnv({}).HOME as string, `go-${randomUUID()}`);
	// Waits for the gate file, then execs the command: its parent is the stand-in Grok, as when Grok runs it.
	const [cmd, args] = grokLaunch("/bin/sh", ["-c", 'while [ ! -e "$0" ]; do sleep 0.005; done; exec "$@"', gate, c.cmd, ...c.args]);
	const grok = spawn(cmd, args, { env: cleanEnv(env), stdio: ["pipe", "pipe", "pipe"], ...(cwd === undefined ? {} : { cwd }) });
	groks.push(grok);
	let stdout = "";
	let stderr = "";
	grok.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
	grok.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
	grok.stdin?.end(stdin);
	let from = 0;
	const exited = new Promise<{ code: number | null; ms: number }>((resolve) => grok.on("exit", (code) => resolve({ code, ms: Date.now() - from })));
	return {
		pid: grok.pid as number,
		go: async () => {
			from = Date.now();
			writeFileSync(gate, "");
			const { code, ms } = await exited;
			return { code, ms, stdout, stderr };
		},
	};
}

describe("orrery grok-status, process by process", () => {
	it(`a run takes no write lock (a held write lock doesn't delay it) and prints within ${BUDGET_MS} ms on a 20,000-message memory`, async () => {
		const t = testAgent();
		remember(t, 20_000);
		const session = randomUUID();
		const token = newToken();
		const row = grokRow(`${JSON.stringify({ schema_version: 1, session_id: session, cwd: t.folder, trigger: "state" })}\n`, { ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token });
		// What Grok's SessionStart left: the token claimed for this Grok, its record naming the session, a recording holder.
		await waitUntil(() => claimToken(t.agent.dir, token, row.pid));
		expect(recordSession(t.config.dataDir, { agent: "Test", tool: "grok", pid: row.pid, grokSession: session, config: t.configPath })).toBe(true);
		recorded.push({ dataDir: t.config.dataDir, pid: row.pid });
		writeMode(t.agent.dir, session, { mode: "recording", pid: 1, claudePid: row.pid, nonce: randomUUID(), since: Date.now() });
		writeHolder(t.agent.dir, { pid: 1, session, claudePid: row.pid, host: "grok", state: "recording", startedAt: Date.now(), updatedAt: Date.now() });
		// The recorder writes memory meanwhile: it holds the writer lock (and the store open) for the whole run.
		const writer = MemoryStore.open(join(t.agent.dir, "memory.sqlite"));
		try {
			const files = readdirSync(t.config.dataDir, { recursive: true }).sort();
			const run = await row.go();
			expect(run).toMatchObject({ code: 0, stdout: "Orrery · Test · 20000 msgs · recording\n", stderr: "" });
			expect(run.ms).toBeLessThan(BUDGET_MS);
			// It wrote nothing: no lock, claim, decision or record of its own.
			expect(readdirSync(t.config.dataDir, { recursive: true }).sort()).toEqual(files);
		} finally {
			writer.close();
		}
	});

	it("bad JSON on stdin, or a plain grok: prints nothing, exit 0", async () => {
		const t = testAgent();
		const token = newToken();
		const bad = grokRow("{ not json", { ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token });
		await waitUntil(() => claimToken(t.agent.dir, token, bad.pid));
		expect(await bad.go()).toMatchObject({ code: 0, stdout: "", stderr: "" });
		// No ORRERY_AGENT (a plain grok), and no Orrery config at all: nothing, and no error.
		const plain = grokRow(`${JSON.stringify({ session_id: randomUUID() })}\n`, {});
		expect(await plain.go()).toMatchObject({ code: 0, stdout: "", stderr: "" });
		// A config that can't be read: nothing in Grok's row either.
		const broken = join(t.dir, "broken.toml");
		writeFileSync(broken, "[[[ not toml");
		const unreadable = grokRow(`${JSON.stringify({ session_id: randomUUID() })}\n`, { ORRERY_CONFIG: broken, ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token });
		expect(await unreadable.go()).toMatchObject({ code: 0, stdout: "", stderr: "" });
		expect(existsSync(join(t.config.dataDir, "grok-processes"))).toBe(false);
	});

	it(`says when Grok's settings changed since they were approved, for the folder Grok runs in, within ${BUDGET_MS} ms; not once approved again`, async () => {
		const t = testAgent();
		// Grok's settings: a scratch HOME and Grok folder, and the session folder Grok runs in (the agent's).
		const settings = { HOME: join(t.dir, "home"), GROK_HOME: join(t.dir, "grok-home") };
		mkdirSync(settings.HOME);
		mkdirSync(join(settings.GROK_HOME, "hooks"), { recursive: true });
		const approve = () => approveGrokSettings(t.config.dataDir, checkGrokSettings(t.config.dataDir, settings, t.folder).shown);
		approve();
		// A project hook file in the folder Grok runs in, planted after the approval.
		mkdirSync(join(t.folder, ".grok", "hooks"), { recursive: true });
		writeFileSync(join(t.folder, ".grok", "hooks", "planted.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }));
		/** One run of the row in a stand-in Grok started in the agent's folder, its session recording as SessionStart left it. */
		const once = async () => {
			const session = randomUUID();
			const token = newToken();
			const row = grokRow(`${JSON.stringify({ schema_version: 1, session_id: session, cwd: t.folder, trigger: "state" })}\n`, { ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token, ...settings }, t.folder);
			await waitUntil(() => claimToken(t.agent.dir, token, row.pid));
			expect(recordSession(t.config.dataDir, { agent: "Test", tool: "grok", pid: row.pid, grokSession: session, config: t.configPath })).toBe(true);
			recorded.push({ dataDir: t.config.dataDir, pid: row.pid });
			writeMode(t.agent.dir, session, { mode: "recording", pid: 1, claudePid: row.pid, nonce: randomUUID(), since: Date.now() });
			writeHolder(t.agent.dir, { pid: 1, session, claudePid: row.pid, host: "grok", state: "recording", startedAt: Date.now(), updatedAt: Date.now() });
			const run = await row.go();
			expect(run.ms).toBeLessThan(BUDGET_MS);
			return run;
		};
		const changed = { code: 0, stdout: "Orrery · Test · no memory yet · recording · Grok settings changed\n", stderr: "" };
		// The first run checks in full and leaves its cache; the next one reads it.
		expect(await once()).toMatchObject(changed);
		expect(statSync(join(t.config.dataDir, "grok-settings-stamp.json")).mode & 0o777).toBe(0o600);
		expect(await once()).toMatchObject(changed);
		approve();
		expect(await once()).toMatchObject({ code: 0, stdout: "Orrery · Test · no memory yet · recording\n", stderr: "" });
	});
});
