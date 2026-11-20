import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeInstructions } from "../../src/agent/instructions.ts";
import { newToken } from "../../src/agent/pick.ts";
import { TOOL_MARKERS } from "../../src/agent/sessions.ts";
import { MemoryStore, MemoryView } from "../../src/memory/index.ts";
import { cliCommand, waitUntil } from "../claude/support.ts";

/**
 * The installed Antigravity CLI (`agy`), signed in, against its real model (ORRERY_TEST_AGY_MODEL, default Gemini 3.8
 * Flash low): agy keeps its login under the person's HOME, so it runs with that HOME, but with a scratch Orrery config,
 * data and workspace. Orrery's hooks come from the workspace's own .agents/hooks.json, running this checkout's CLI, so
 * nothing is written to the person's ~/.gemini/config. Skipped without agy or a login (ORRERY_TEST_AGY=0 skips it too).
 * agy gets no coding tool's variables, so its hooks and recorder run as in a session of the person's own terminal.
 */
const scratch = mkdtempSync(join(tmpdir(), "orrery-real-agy-"));
/** ORRERY_TEST_AGY_KEEP=1 keeps the scratch folder and each hook's stderr (hook-<event>.err in the workspace), to debug. */
const keep = process.env.ORRERY_TEST_AGY_KEEP === "1";
afterAll(() => (keep ? undefined : rmSync(scratch, { recursive: true, force: true })));

const MODEL = process.env.ORRERY_TEST_AGY_MODEL ?? "gemini-3.8-flash-low";

/** This process's environment without any coding tool's or Orrery's variables: agy as if started from a terminal. */
function cleanEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const markers = new Set(TOOL_MARKERS.map((marker) => marker.variable));
	for (const name of Object.keys(env)) if (markers.has(name) || name.startsWith("ORRERY_") || name.startsWith("CLAUDE") || name.startsWith("CODEX_")) delete env[name];
	return { ...env, TERM: "dumb", ORRERY_RELEASES_URL: "http://127.0.0.1:9/releases" };
}

/** agy on PATH, signed in (its model list answers with the model); null otherwise. */
function findAgy(): string | null {
	const found = spawnSync("sh", ["-c", "command -v agy"], { encoding: "utf8", env: cleanEnv() }).stdout.trim();
	if (found === "") return null;
	const models = spawnSync(found, ["models"], { encoding: "utf8", env: cleanEnv(), timeout: 60_000 });
	return models.status === 0 && models.stdout.includes(MODEL) ? found : null;
}

const agy = process.env.ORRERY_TEST_AGY === "0" ? null : findAgy();

/** Runs `agy -p` to its end without blocking this process. */
function runAgy(args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
	return new Promise((done) => {
		const child = spawn(agy as string, ["--model", MODEL, "--output-format", "json", ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
		child.on("close", (status) => {
			clearTimeout(timer);
			done({ status, stdout, stderr });
		});
	});
}

const reply = (stdout: string): { readonly response: string; readonly conversation: string } => {
	const parsed = JSON.parse(stdout) as { response?: string; conversation_id?: string };
	return { response: parsed.response ?? "", conversation: parsed.conversation_id ?? "" };
};

/** Atlas in a scratch config, a workspace whose hooks run this checkout's CLI, and the environment `orrery agent` gives agy. */
function world(name: string) {
	const home = mkdtempSync(join(scratch, `${name}-`));
	const work = join(home, "work");
	mkdirSync(join(work, ".agents"), { recursive: true });
	const config = join(home, "config.toml");
	// Their summary model has no login here: summaries stop, and nothing calls a model of Orrery's.
	const summaries = 'compactor_model = "openai/gpt-6.1-sol"';
	writeFileSync(config, `data_dir = ${JSON.stringify(join(home, "data"))}\n[agents.Atlas]\nfolder = ${JSON.stringify(work)}\ntool = "antigravity"\n${summaries}\n[agents.Birch]\nfolder = ${JSON.stringify(join(home, "birch"))}\n${summaries}\n`);
	const atlasDir = join(home, "data", "agents", "Atlas");
	mkdirSync(atlasDir, { recursive: true });
	const birchView = join(home, "data", "agents", "Birch", "view.md");
	mkdirSync(join(home, "data", "agents", "Birch"), { recursive: true });
	writeFileSync(birchView, "Birch's private memory view.\n");
	const cli = cliCommand([]);
	const hook = (event: string) => ({ type: "command", command: `${[cli.cmd, ...cli.args, "agy-hook", event].map((word) => `'${word}'`).join(" ")}${keep ? ` 2>>'${join(work, `hook-${event}.err`)}'` : ""}`, timeout: 60 });
	writeFileSync(join(work, ".agents", "hooks.json"), JSON.stringify({ orrery: { PreInvocation: [hook("pre-invocation")], PreToolUse: [{ matcher: "", hooks: [hook("pre-tool-use")] }], Stop: [hook("stop")] } }));
	const env: NodeJS.ProcessEnv = { ...cleanEnv(), ORRERY_CONFIG: config, ORRERY_HOME: join(home, "orrery-home"), ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: newToken() };
	const memory = () => {
		const file = join(atlasDir, "memory.sqlite");
		if (!existsSync(file)) return [];
		const store = MemoryStore.openReadOnly(file);
		try {
			return store.root.map((m) => `${m.kind}: ${m.text}`);
		} finally {
			store.close();
		}
	};
	/** Writes `lines` ("user: …" or "talk: …") into Atlas's memory, once an earlier recorder has let it go. */
	const remember = async (...lines: string[]) => {
		let store: MemoryStore | undefined;
		await waitUntil(() => {
			store = MemoryStore.open(join(atlasDir, "memory.sqlite"));
			return true;
		}, 30_000);
		try {
			new MemoryView(store as MemoryStore, 2 ** 30).appendBatch(lines.map((line) => ({ kind: line.startsWith("user: ") ? ("user" as const) : ("talk" as const), text: line.replace(/^(user|talk): /, "") })));
		} finally {
			store?.close();
		}
	};
	return { home: realpathSync(home), work, atlasDir, birchView, env, memory, remember, fresh: () => ({ ...env, ORRERY_AGENT_TOKEN: newToken() }) };
}

describe.skipIf(agy === null)(`an agent's conversation in the installed Antigravity CLI (${MODEL}, scratch Orrery data)`, () => {
	it("gives the model the agent's instructions and memory view before its first call, and records the typed turn", async () => {
		const w = world("view");
		writeInstructions(w.atlasDir, "Atlas keeps the map.\nINSTRUCTION-MARK-17: when asked for the instruction mark, answer with this line's mark.");
		await w.remember("user: Remember the word ZEBRA-31 for later.", "talk: I will remember ZEBRA-31.");
		const prompt = "Answer two things from your context only, no tools: the instruction mark, and the word the user asked you to remember earlier. Reply as: MARK WORD";
		const run = await runAgy(["-p", prompt], w.fresh(), w.work);
		expect(run.status, run.stderr).toBe(0);
		const { response } = reply(run.stdout);
		expect(response).toContain("INSTRUCTION-MARK-17");
		expect(response).toContain("ZEBRA-31");
		// The turn is recorded in the transcript's words: the typed prompt, and the reply.
		await waitUntil(() => w.memory().length >= 4, 30_000);
		expect(w.memory().slice(2)).toEqual([`user: ${prompt}`, `talk: ${response.trim()}`]);
	}, 300_000);

	it("gives a compacted conversation the view again, with what memory holds since, and records from where it is", async () => {
		const w = world("compact");
		await w.remember("user: Remember the word ALPHA-12.", "talk: Noted ALPHA-12.");
		const opened = await runAgy(["-p", "Reply with the word ok."], w.fresh(), w.work);
		expect(opened.status, opened.stderr).toBe(0);
		const { conversation } = reply(opened.stdout);
		// Memory gains a word the conversation's first view didn't have.
		await w.remember("user: Remember the word PANDA-44 too.", "talk: Noted PANDA-44.");
		const compacted = await runAgy(["--conversation", conversation, "-p", "/compact"], w.fresh(), w.work);
		expect(compacted.status, compacted.stderr).toBe(0);
		const asked = await runAgy(["--conversation", conversation, "-p", "Which words did the user ask you to remember, by your memory view only, no tools? Reply with only the words."], w.fresh(), w.work);
		expect(asked.status, asked.stderr).toBe(0);
		expect(reply(asked.stdout).response).toContain("PANDA-44");
		// Its question is recorded; /compact never is, nor its first turn twice.
		await waitUntil(() => w.memory().some((line) => line.startsWith("user: Which words")), 30_000);
		expect(w.memory().filter((line) => line.includes("/compact"))).toEqual([]);
		expect(w.memory().filter((line) => line === "user: Reply with the word ok.")).toHaveLength(1);
	}, 900_000);

	it("guards the agent's tool calls: another agent's memory view is refused", async () => {
		const w = world("guard");
		const asked = await runAgy(["-p", `Use your read_file tool on ${w.birchView} and report exactly what happened, quoting any error word for word.`], w.fresh(), w.work);
		expect(asked.status, asked.stderr).toBe(0);
		const { response } = reply(asked.stdout);
		// Refused as Orrery's private data: another agent's memory, not a config that can't be read.
		expect(response).toMatch(/Orrery guard: .*(sensitive file|private data)/s);
		expect(response).not.toContain("could not be read");
		expect(response).not.toContain("Birch's private memory view");
	}, 300_000);

	it("gives a plain agy (no ORRERY_AGENT) no memory, and records nothing", async () => {
		const w = world("plain");
		writeInstructions(w.atlasDir, "PLAIN-MARK-88");
		await w.remember("user: The plain word is PLAIN-WORD-5.");
		const { ORRERY_AGENT: _agent, ORRERY_AGENT_TOKEN: _token, ...plain } = w.env;
		const run = await runAgy(["-p", "If your context has a line PLAIN-MARK-88 or PLAIN-WORD-5, reply YES, else reply NO."], plain, w.work);
		expect(run.status, run.stderr).toBe(0);
		expect(reply(run.stdout).response).toMatch(/NO/);
		expect(existsSync(join(w.home, "data", "antigravity-processes"))).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 2000));
		expect(w.memory()).toEqual(["user: The plain word is PLAIN-WORD-5."]);
		expect(readFileSync(join(w.work, ".agents", "hooks.json"), "utf8")).toContain("agy-hook");
	}, 300_000);
});
