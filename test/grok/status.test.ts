import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentConfig, type HarnessConfig, parseConfig } from "../../src/agent/config.ts";
import { writeHolder } from "../../src/agent/handover.ts";
import { claimToken, newToken } from "../../src/agent/pick.ts";
import { processEnv } from "../../src/agent/process.ts";
import { forgetSession, recordSession } from "../../src/agent/sessions.ts";
import { statusText } from "../../src/agent/status-text.ts";
import { writeMode } from "../../src/claude/spool.ts";
import { runGrokHook } from "../../src/grok/hooks.ts";
import { grokStatus } from "../../src/grok/status.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { tempDir } from "../agent/support.ts";
import { startedWith } from "../claude/support.ts";
import { grokHomeIn } from "./log-lines.ts";

/**
 * `orrery grok-status`, Grok Build's status row: it answers for the agent ORRERY_AGENT names only when the token is
 * claimed by this Grok (the process that runs the row), and the stdin session_id only chooses which of that agent's
 * sessions it describes. Never a word of memory, never an error into Grok's row.
 */

/** This test's Grok: this test's process (a live one, whose start time Orrery reads), as test/grok/hooks.test.ts uses it. */
const GROK = process.pid;
/** Another live Grok: the test's parent (vitest's), whose start time Orrery reads too. */
const OTHER_GROK = process.ppid;
/** Grok's own command line in default mode (Orrery opens agents with --no-leader). */
const GROK_ARGV = ["grok", "--no-leader", "--rules", "made-up memory"];

const dirs: string[] = [];
const dataDirs: string[] = [];
afterEach(() => {
	for (const dir of dataDirs.splice(0)) {
		forgetSession(dir, GROK);
		forgetSession(dir, OTHER_GROK);
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const AGENT = (name: string, folder: string) => `[agents.${name}]
folder = ${JSON.stringify(folder)}
model = "faux-agent/faux-1"
thinking = "off"
compactor_model = "faux-compactor/faux-1"
compactor_thinking = "off"
compactor_jobs = 2
allowed_roots = [${JSON.stringify(folder)}]
`;

/** A scratch Orrery with two agents, Scratch and Other, each with a folder of its own. */
function world() {
	const dir = tempDir("orrery-grok-status-");
	dirs.push(dir);
	for (const name of ["data", "scratch", "other"]) mkdirSync(join(dir, name));
	const text = `data_dir = ${JSON.stringify(join(dir, "data"))}\n\n${AGENT("Scratch", join(dir, "scratch"))}\n${AGENT("Other", join(dir, "other"))}`;
	writeFileSync(join(dir, "data", "config.toml"), text);
	const config = { ...parseConfig(text, join(dir, "data")), file: join(dir, "data", "config.toml") } as HarnessConfig;
	dataDirs.push(config.dataDir);
	const agent = (name: string) => config.agents.get(name) as AgentConfig & { readonly folder: string };
	return { dir, config, scratch: agent("Scratch"), other: agent("Other") };
}

/** `count` messages in the agent's memory, as earlier sessions left them. */
function remember(agent: AgentConfig, count: number, word = "note"): void {
	const store = MemoryStore.open(join(agent.dir, "memory.sqlite"));
	try {
		store.appendBatch(Array.from({ length: count }, (_, i) => ({ kind: i % 2 === 0 ? ("user" as const) : ("talk" as const), text: `${word} ${i}`, date: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString() })));
	} finally {
		store.close();
	}
}

/**
 * What a Grok session's SessionStart leaves (src/grok/hooks.ts), for `agent` in Grok `grok` with session `session`: the
 * token claimed for that Grok, its host record naming the session, the mode the holder chose, and the holder's
 * heartbeat. Each piece can be left out.
 */
function started(config: HarnessConfig, agent: AgentConfig, session: string, options: { grok?: number; token?: string; record?: boolean; mode?: "recording" | "read-only" | "none"; reason?: string; beat?: number | "none"; holderSession?: string } = {}) {
	const grok = options.grok ?? GROK;
	const token = options.token ?? newToken();
	expect(claimToken(agent.dir, token, grok, () => true)).toBe(true);
	if (options.record !== false) expect(recordSession(config.dataDir, { agent: agent.name, tool: "grok", pid: grok, grokSession: session, config: config.file })).toBe(true);
	const mode = options.mode ?? "recording";
	if (mode !== "none") writeMode(agent.dir, session, { mode, pid: 1, claudePid: grok, nonce: randomUUID(), since: Date.now(), ...(options.reason === undefined ? {} : { reason: options.reason }) });
	if (options.beat !== "none") {
		const at = options.beat ?? Date.now();
		writeHolder(agent.dir, { pid: 1, session: options.holderSession ?? session, claudePid: grok, host: "grok", state: "recording", startedAt: at, updatedAt: at });
	}
	return token;
}

/** Grok's status JSON for `session`, as 1.0.70 pipes it to the row's command (seen live; the words made up). */
const payload = (session: string, extra: object = {}) =>
	`${JSON.stringify({ schema_version: 1, cwd: "/tmp/anywhere", session_id: session, model: { id: "grok-4.6", display_name: "Grok 4.6" }, workspace: { current_dir: "/tmp/anywhere" }, version: "1.0.70", trigger: "state", ...extra })}\n`;

/** The test's Grok folder (GROK_HOME), beside its data folder: never the user's. */
const grokHomeOf = (config: HarnessConfig) => join(config.dataDir, "..", "grok-home");
/** The row's context: the agent and token the launch gave Grok (and its Grok folder), and Grok's process as this test's. */
const ctx = (config: HarnessConfig, env: NodeJS.ProcessEnv, extra: object = {}) => ({
	config,
	env: { GROK_HOME: grokHomeOf(config), ...env },
	grokPid: GROK,
	grokParent: GROK,
	alive: (pid: number) => pid === GROK || pid === OTHER_GROK,
	argvOf: () => GROK_ARGV,
	// Grok was started with the agent and token the row gets (Grok runs its row with its own environment).
	envOf: startedWith(env),
	...extra,
});
/** Switches hooks of Orrery's hook file off in Grok's /hooks tab, as Grok 1.0.70 writes its disabled-hooks file (seen live). */
const switchOff = (config: HarnessConfig, ...events: string[]) => {
	mkdirSync(grokHomeOf(config), { recursive: true });
	writeFileSync(join(grokHomeOf(config), "disabled-hooks"), events.map((event) => `global/orrery:${event}[0].hooks[0]\n`).join(""));
};
const as = (agent: string, token: string) => ({ ORRERY_AGENT: agent, ORRERY_AGENT_TOKEN: token });
/** A session id as Grok 1.0.70 makes them (seen live): a UUIDv7, the ms it was made at in its first 48 bits. */
const uuidV7 = (ms: number) => {
	const time = Math.floor(ms).toString(16).padStart(12, "0");
	const random = randomUUID();
	return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15, 18)}-${random.slice(19, 23)}-${random.slice(24)}`;
};

describe("statusText", () => {
	it("says the agent, its count and its state, as Codex's and Claude Code's SessionStart say it", () => {
		expect(statusText({ name: "Scratch", count: 42, state: "recording" })).toBe("Orrery · Scratch · 42 msgs · recording");
		expect(statusText({ name: "Scratch", count: undefined, state: "not recording yet" })).toBe("Orrery · Scratch · no memory yet · not recording yet");
		expect(statusText({ name: "Scratch", count: 0, state: { readOnly: "this session is not recorded" } })).toBe("Orrery · Scratch · 0 msgs · read-only: this session is not recorded");
		expect(statusText({ name: "Scratch", count: 3, state: { notRecording: "why" } })).toBe("Orrery · Scratch · 3 msgs · not recording: why");
		expect(statusText({ name: "Scratch", count: 3, state: "recording", extra: ["memory from the Orrery mod"] })).toBe("Orrery · Scratch · 3 msgs · recording · memory from the Orrery mod");
	});
});

describe("orrery grok-status", () => {
	it("an Orrery Grok session prints `Orrery · Scratch · 42 msgs · recording`", () => {
		const w = world();
		remember(w.scratch, 42, "secret-word");
		const session = randomUUID();
		const token = started(w.config, w.scratch, session);
		const out = grokStatus(payload(session), ctx(w.config, as("Scratch", token)));
		expect(out).toBe("Orrery · Scratch · 42 msgs · recording");
		// Never a word of memory.
		expect(out).not.toContain("secret-word");
		// The agent's name as ORRERY_AGENT gives it, in any case, is the configured one.
		expect(grokStatus(payload(session), ctx(w.config, as("scratch", token)))).toBe("Orrery · Scratch · 42 msgs · recording");
	});

	it("speaks for the agent and token its Grok was started with, never the row's own: another agent or token prints nothing, and a start that can't be read says so, naming no agent", () => {
		const w = world();
		remember(w.scratch, 3);
		remember(w.other, 5);
		const session = randomUUID();
		const token = started(w.config, w.scratch, session);
		// Other's token claimed for this Grok too (no record, mode or holder of its own).
		const other = started(w.config, w.other, randomUUID(), { record: false, mode: "none", beat: "none" });
		const grok = as("Scratch", token);
		// The honest row: its environment is its Grok's.
		expect(grokStatus(payload(session), ctx(w.config, grok))).toBe("Orrery · Scratch · 3 msgs · recording");
		// The same Grok, the row's own environment naming another agent (whose token this Grok holds too), another token, or none.
		for (const own of [as("Other", other), as("Scratch", newToken()), { ORRERY_AGENT: "Scratch" }]) {
			expect(grokStatus(payload(session), ctx(w.config, own, { envOf: startedWith(grok) })), JSON.stringify(own)).toBe("");
		}
		// Its Grok's start environment can't be read: the hooks record nothing, and the row says why, as they do.
		expect(grokStatus(payload(session), ctx(w.config, grok, { envOf: () => undefined }))).toBe("Orrery · not recording: the environment this Grok was started with can't be read");
		// Not for a row whose own environment names no agent (a plain grok), nor for input that isn't Grok's status JSON.
		expect(grokStatus(payload(session), ctx(w.config, {}, { envOf: () => undefined }))).toBe("");
		expect(grokStatus("not json", ctx(w.config, grok, { envOf: () => undefined }))).toBe("");
	});

	it("on macOS, a HOME, GROK_HOME, ORRERY_HOME or ORRERY_CONFIG that ps cuts at a space, or that stands twice, can't be read, as the hooks find: the row says so, never that SessionStart hasn't run", () => {
		const w = world();
		remember(w.scratch, 3);
		const session = randomUUID();
		// No record of the session, as when the hooks refused: read so, the row would say SessionStart hasn't run.
		const token = started(w.config, w.scratch, session, { record: false, mode: "none", beat: "none" });
		const args = "/Users/u/.grok/bin/grok --no-leader";
		const mac = (env: string) => (pid: number, names: readonly string[]) =>
			processEnv(pid, names, { platform: "darwin", withoutArgs: true, unambiguous: true, ps: (asked) => (asked.includes("-wwE") ? `${args} ${env}\n` : `${args}\n`) });
		const launch = `ORRERY_AGENT=Scratch ORRERY_AGENT_TOKEN=${token}`;
		const home = grokHomeOf(w.config);
		// Past SessionStart's timeout, when the row would say it hasn't run.
		const later = { now: Date.now() + 60_000 };
		for (const env of [
			`PATH=/usr/bin HOME=/Users/my home ${launch} GROK_HOME=${home}`,
			`PATH=/usr/bin HOME=/Users/u ${launch} GROK_HOME=/Users/u/grok home`,
			`PATH=/usr/bin HOME=/Users/u ORRERY_HOME=/Users/u/my orrery ${launch} GROK_HOME=${home}`,
			`PATH=/usr/bin HOME=/Users/u ORRERY_CONFIG=/Users/u/my config.toml ${launch} GROK_HOME=${home}`,
			`PATH=/usr/bin HOME=/Users/u HOME=/tmp/x ${launch} GROK_HOME=${home}`,
		]) {
			expect([env, grokStatus(payload(session), ctx(w.config, as("Scratch", token), { envOf: mac(env), ...later }))]).toEqual([env, "Orrery · not recording: the environment this Grok was started with can't be read"]);
		}
		// The same values without a space: read, and the row says what SessionStart left (here nothing).
		const whole = `PATH=/usr/bin HOME=/Users/u ${launch} GROK_HOME=${home}`;
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token), { envOf: mac(whole), ...later }))).toBe("Orrery · Scratch · 3 msgs · not recording: Orrery's SessionStart hasn't run for this session; resume it or start a new one");
	});

	it("an agent with no memory yet says so", () => {
		const w = world();
		const session = randomUUID();
		const token = started(w.config, w.scratch, session);
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token)))).toBe("Orrery · Scratch · no memory yet · recording");
	});

	it("reads the message count alone, not the memory: summaries aren't loaded", () => {
		const w = world();
		remember(w.scratch, 6);
		// A summary record a full load refuses: the row never loads summaries, so its count stands.
		const raw = new DatabaseSync(join(w.scratch.dir, "memory.sqlite"));
		raw.prepare("INSERT INTO tree (l, i, text, size) VALUES (?, ?, ?, ?)").run(1, 0, Buffer.from("summary"), 999);
		raw.close();
		const session = randomUUID();
		const token = started(w.config, w.scratch, session);
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token)))).toBe("Orrery · Scratch · 6 msgs · recording");
	});

	it("read-only prints the reason", () => {
		const w = world();
		remember(w.scratch, 3);
		// The holder found the agent held by another writer (it notes no reason then): where it is open, as SessionStart says it.
		const held = randomUUID();
		const token = started(w.config, w.scratch, held, { mode: "read-only", beat: "none" });
		expect(grokStatus(payload(held), ctx(w.config, as("Scratch", token)))).toBe("Orrery · Scratch · 3 msgs · read-only: open elsewhere (pi, OMP, Claude Code, Codex, or another Grok session)");
		// A pi session that has the agent open says so in its status.json.
		writeFileSync(join(w.scratch.dir, "status.json"), JSON.stringify({ agent: "Scratch", pid: GROK, open: true, busy: false, model: "pi", thinking: "off", memory: {}, compactor: { stopped: false, failing: 0, model: "faux/faux", thinking: "low", source: "config" }, trouble: null, lastError: null, updatedAt: new Date().toISOString() }));
		expect(grokStatus(payload(held), ctx(w.config, as("Scratch", token)))).toBe("Orrery · Scratch · 3 msgs · read-only: open in pi");
		// A reason of the holder's own (a remote's), on one line, without control characters.
		const remote = randomUUID();
		forgetSession(w.config.dataDir, GROK);
		started(w.config, w.scratch, remote, { token, mode: "read-only", reason: "laptop: moved to\n another\u001b[31m machine", beat: "none" });
		expect(grokStatus(payload(remote), ctx(w.config, as("Scratch", token)))).toBe("Orrery · Scratch · 3 msgs · read-only: laptop: moved to another[31m machine");
	});

	it("the agent named by the environment has no record for this session_id: `not recording: Orrery's SessionStart hasn't run for this session; resume it or start a new one`", () => {
		const w = world();
		remember(w.scratch, 5);
		const notRun = "Orrery · Scratch · 5 msgs · not recording: Orrery's SessionStart hasn't run for this session; resume it or start a new one";
		// SessionStart crashed or timed out (Grok goes on without it), or was switched on only after the session started: only
		// the memory server's claim is there.
		const token = newToken();
		expect(claimToken(w.scratch.dir, token, GROK, () => true)).toBe(true);
		const later = { now: Date.now() + 60_000 };
		expect(grokStatus(payload(randomUUID()), ctx(w.config, as("Scratch", token), later))).toBe(notRun);
		// A record of this Grok that names another of its sessions, and nothing of this one: this one's SessionStart hasn't run either.
		const first = randomUUID();
		started(w.config, w.scratch, first, { token });
		expect(grokStatus(payload(randomUUID()), ctx(w.config, as("Scratch", token), later))).toBe(notRun);
		// Never the old advice: the folder is trusted (Grok quits rather than run an untrusted one beside a hook file).
		expect(grokStatus(payload(randomUUID()), ctx(w.config, as("Scratch", token), later))).not.toMatch(/trust/);
	});

	it("with no record of this Grok's at all, a mode it left for the session is no other session of its own", () => {
		const w = world();
		remember(w.scratch, 5);
		const session = randomUUID();
		const token = started(w.config, w.scratch, session);
		// The record is gone (taken down, or unreadable), though this Grok's mode for the session is there.
		forgetSession(w.config.dataDir, GROK);
		const out = grokStatus(payload(session), ctx(w.config, as("Scratch", token), { now: Date.now() + 60_000 }));
		expect(out).toBe("Orrery · Scratch · 5 msgs · not recording: Orrery's SessionStart hasn't run for this session; resume it or start a new one");
		expect(out).not.toContain("another of its sessions");
	});

	it("Orrery's hooks switched off in Grok's /hooks tab: the row says so, not to trust the folder, and never recording", () => {
		const w = world();
		remember(w.scratch, 5);
		const off = "Orrery · Scratch · 5 msgs · not recording: Orrery's hooks are switched off in /hooks";
		// SessionStart switched off: it never ran, and only the memory server's claim is there (seen live).
		const token = newToken();
		expect(claimToken(w.scratch.dir, token, GROK, () => true)).toBe(true);
		switchOff(w.config, "session_start");
		expect(grokStatus(payload(randomUUID()), ctx(w.config, as("Scratch", token)))).toBe(off);
		// SessionStart ran, then UserPromptSubmit or Stop was switched off: the session no longer records its turns.
		const session = randomUUID();
		started(w.config, w.scratch, session, { token });
		for (const event of ["user_prompt_submit", "stop"]) {
			switchOff(w.config, event);
			expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token))), event).toBe(off);
		}
		// Only the guard, or the session's end, switched off: recording goes on (the guard is Claude Code's plugin's then).
		switchOff(w.config, "pre_tool_use", "session_end", "stop_cancelled");
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token)))).toBe("Orrery · Scratch · 5 msgs · recording");
		// Another hook file's, or a project's, of the same event: not Orrery's.
		writeFileSync(join(grokHomeOf(w.config), "disabled-hooks"), "global/other:session_start[0].hooks[0]\nproject/orrery:stop[0].hooks[0]\n");
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token)))).toBe("Orrery · Scratch · 5 msgs · recording");
		// A read-only session still says where the agent is open.
		switchOff(w.config, "stop");
		const held = randomUUID();
		forgetSession(w.config.dataDir, GROK);
		started(w.config, w.scratch, held, { token, mode: "read-only", beat: "none" });
		expect(grokStatus(payload(held), ctx(w.config, as("Scratch", token)))).toMatch(/· read-only: open /);
	});

	it("an earlier session of this Grok, which the record no longer names, is not recorded", () => {
		const w = world();
		remember(w.scratch, 5);
		const earlier = randomUUID();
		const token = started(w.config, w.scratch, earlier);
		// /clear: SessionStart took the new session; the earlier one keeps its mode file.
		forgetSession(w.config.dataDir, GROK);
		const later = randomUUID();
		started(w.config, w.scratch, later, { token });
		expect(grokStatus(payload(later), ctx(w.config, as("Scratch", token)))).toBe("Orrery · Scratch · 5 msgs · recording");
		expect(grokStatus(payload(earlier), ctx(w.config, as("Scratch", token)))).toBe("Orrery · Scratch · 5 msgs · not recording: this Grok records another of its sessions now");
	});

	it("recorder stopped", () => {
		const w = world();
		remember(w.scratch, 7);
		const stopped = "Orrery · Scratch · 7 msgs · not recording: Orrery's recorder stopped; a new session or a resume starts it again";
		// Its heartbeat went stale.
		const session = randomUUID();
		const token = started(w.config, w.scratch, session, { beat: Date.now() - 60_000 });
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token)))).toBe(stopped);
		// No heartbeat at all.
		rmSync(join(w.scratch.dir, "claude", "holder.json"));
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token)))).toBe(stopped);
		// A fresh holder, but of another session: this one's recorder is gone.
		writeHolder(w.scratch.dir, { pid: 1, session: randomUUID(), claudePid: GROK, host: "grok", state: "recording", startedAt: Date.now(), updatedAt: Date.now() });
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token)))).toBe(stopped);
		// This session's holder only finishing (its session ended).
		writeHolder(w.scratch.dir, { pid: 1, session, claudePid: GROK, host: "grok", state: "finishing", startedAt: Date.now(), updatedAt: Date.now() });
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token)))).toBe(stopped);
		// A heartbeat `now` (the row's clock) still counts as fresh.
		writeHolder(w.scratch.dir, { pid: 1, session, claudePid: GROK, host: "grok", state: "recording", startedAt: 1_000, updatedAt: 1_000 });
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token), { now: 2_000 }))).toBe("Orrery · Scratch · 7 msgs · recording");
	});

	it("a session whose holder hasn't chosen yet is not recording yet", () => {
		const w = world();
		const session = randomUUID();
		const token = started(w.config, w.scratch, session, { mode: "none", beat: "none" });
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token)))).toBe("Orrery · Scratch · no memory yet · not recording yet");
	});

	it("while SessionStart may still run (younger than its 15 s timeout), a session it hasn't recorded yet is not recording yet", () => {
		const w = world();
		remember(w.scratch, 5);
		const yet = "Orrery · Scratch · 5 msgs · not recording yet";
		const notRun = "Orrery · Scratch · 5 msgs · not recording: Orrery's SessionStart hasn't run for this session; resume it or start a new one";
		// The launch: the token claimed (by the memory server or SessionStart), no record yet. Each side of 15 s from the claim.
		const token = newToken();
		expect(claimToken(w.scratch.dir, token, GROK, () => true)).toBe(true);
		const claimed = statSync(join(w.scratch.dir, "claims", token)).mtimeMs;
		const session = randomUUID();
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token), { now: claimed + 14_999 }))).toBe(yet);
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token), { now: claimed + 15_000 }))).toBe(notRun);
		// /new or /clear (seen live): the claim is the launch's and the record names the session before, but the new
		// session's id says when it began (Grok's ids are UUIDv7). Each side of 15 s from that.
		started(w.config, w.scratch, randomUUID(), { token });
		const began = claimed + 60_000;
		const fresh = uuidV7(began);
		expect(grokStatus(payload(fresh), ctx(w.config, as("Scratch", token), { now: began + 14_999 }))).toBe(yet);
		expect(grokStatus(payload(fresh), ctx(w.config, as("Scratch", token), { now: began + 15_000 }))).toBe(notRun);
		// An id that is no UUIDv7 tells no time: only the claim's counts.
		expect(grokStatus(payload(randomUUID()), ctx(w.config, as("Scratch", token), { now: began }))).toBe(notRun);
		// A hook of Orrery's switched off is said at once.
		switchOff(w.config, "session_start");
		expect(grokStatus(payload(fresh), ctx(w.config, as("Scratch", token), { now: began }))).toBe("Orrery · Scratch · 5 msgs · not recording: Orrery's hooks are switched off in /hooks");
	});

	it("no ORRERY_AGENT or a bad token: prints nothing", () => {
		const w = world();
		remember(w.scratch, 4);
		const session = randomUUID();
		const token = started(w.config, w.scratch, session);
		// A plain grok.
		expect(grokStatus(payload(session), ctx(w.config, {}))).toBe("");
		expect(grokStatus(payload(session), ctx(w.config, { ORRERY_AGENT: " ", ORRERY_AGENT_TOKEN: token }))).toBe("");
		// No token, or one not 32 lowercase hex digits.
		expect(grokStatus(payload(session), ctx(w.config, { ORRERY_AGENT: "Scratch" }))).toBe("");
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token.toUpperCase())))).toBe("");
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", "../../claims/x")))).toBe("");
		// A well-formed token nobody claimed: anyone could make one up.
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", newToken())))).toBe("");
		// The right token, asked from another process than the Grok that claimed it (a tool the agent's shell started).
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token), { grokPid: OTHER_GROK, grokParent: OTHER_GROK }))).toBe("");
		// An agent that is not configured.
		expect(grokStatus(payload(session), ctx(w.config, as("Nobody", token)))).toBe("");
	});

	it("a session_id from another agent's session prints nothing about that agent", () => {
		const w = world();
		remember(w.scratch, 4);
		remember(w.other, 9, "other-words");
		// Other is recording a session in another Grok.
		const others = randomUUID();
		const otherToken = started(w.config, w.other, others, { grok: OTHER_GROK });
		// This Grok is Scratch's, with its own session.
		const mine = randomUUID();
		const token = started(w.config, w.scratch, mine);
		// The row's session_id names Other's session: it says only what Scratch's record says of it.
		const out = grokStatus(payload(others), ctx(w.config, as("Scratch", token), { now: Date.now() + 60_000 }));
		expect(out).toBe("Orrery · Scratch · 4 msgs · not recording: Orrery's SessionStart hasn't run for this session; resume it or start a new one");
		expect(out).not.toMatch(/Other|9 msgs|other-words/);
		// Other's own name and token, from this Grok (whose token is Scratch's): nothing.
		expect(grokStatus(payload(others), ctx(w.config, as("Other", otherToken)))).toBe("");
		expect(grokStatus(payload(mine), ctx(w.config, as("Other", otherToken)))).toBe("");
		// Other's name with Scratch's token: nothing.
		expect(grokStatus(payload(others), ctx(w.config, as("Other", token)))).toBe("");
	});

	it("bad JSON on stdin: prints nothing, exit 0", () => {
		const w = world();
		const session = randomUUID();
		const token = started(w.config, w.scratch, session);
		const c = ctx(w.config, as("Scratch", token));
		for (const stdin of ["", "not json", "[]", "null", "42", '"text"', "{", JSON.stringify({ cwd: "/tmp" }), JSON.stringify({ session_id: 7 }), JSON.stringify({ session_id: "../../claims" }), JSON.stringify({ session_id: "a".repeat(129) })]) {
			expect(grokStatus(stdin, c)).toBe("");
		}
		// The camelCase spelling Grok's hooks use is read too.
		expect(grokStatus(JSON.stringify({ sessionId: session }), c)).toBe("Orrery · Scratch · no memory yet · recording");
	});

	it("never fails into Grok's row: an error prints nothing", () => {
		const w = world();
		const session = randomUUID();
		const token = started(w.config, w.scratch, session);
		// Memory that can't be read.
		writeFileSync(join(w.scratch.dir, "memory.sqlite"), "not a database");
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token)))).toBe("");
		// A process lookup that throws.
		rmSync(join(w.scratch.dir, "memory.sqlite"));
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token), { argvOf: () => { throw new Error("boom"); } }))).toBe("");
	});

	it("under Grok's shared leader (leader mode) it never says recording: it names no agent and says why", () => {
		const w = world();
		remember(w.scratch, 4);
		const session = randomUUID();
		const token = started(w.config, w.scratch, session);
		const leader = { argvOf: () => ["/opt/grok/downloads/grok-linux-x86_64", "agent", "leader", "--no-exit-on-disconnect"] };
		// Short enough for the row: what it is, and what Orrery does instead.
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token), leader))).toBe("Orrery · not recording: leader mode; Orrery opens agents with --no-leader");
		// A plain grok under a leader: nothing.
		expect(grokStatus(payload(session), ctx(w.config, {}, leader))).toBe("");
		// A command line that can't be read: whether it is the leader can't be told, so nothing.
		expect(grokStatus(payload(session), ctx(w.config, as("Scratch", token), { argvOf: () => undefined }))).toBe("");
		// One run in its own process (worker start, leader worker start), and one with global options before agent: the same.
		for (const argv of [["grok", "worker", "start"], ["grok", "leader", "worker", "--max-agents", "2", "start"], ["grok", "--debug", "agent", "leader"]]) {
			expect([argv.join(" "), grokStatus(payload(session), ctx(w.config, as("Scratch", token), { argvOf: () => argv }))]).toEqual([argv.join(" "), "Orrery · not recording: leader mode; Orrery opens agents with --no-leader"]);
		}
	});

	it("reads and writes nothing it shouldn't: no claim, no decision, no record", () => {
		const w = world();
		remember(w.scratch, 2);
		const token = newToken();
		const before = readdirSync(w.config.dataDir, { recursive: true }).sort();
		// A well-formed token nobody claimed, at a session's start: the row claims nothing and decides nothing.
		expect(grokStatus(payload(randomUUID()), ctx(w.config, as("Scratch", token)))).toBe("");
		expect(readdirSync(w.config.dataDir, { recursive: true }).sort()).toEqual(before);
	});

	it("says what SessionStart recorded: a session Orrery's hooks started reads recording", async () => {
		const w = world();
		remember(w.scratch, 2);
		const home = grokHomeIn(w.dir, w.scratch.folder);
		try {
			const session = randomUUID();
			home.begin(session);
			const token = newToken();
			const env = { ...as("Scratch", token), GROK_HOME: home.home };
			// A holder that chooses recording and beats, as src/claude/holder.ts does.
			const startHolder = (agent: AgentConfig, id: string, nonce: string, since: number) => {
				writeMode(agent.dir, id, { mode: "recording", pid: 1, claudePid: GROK, nonce, since });
				writeHolder(agent.dir, { pid: 1, session: id, claudePid: GROK, host: "grok", state: "recording", startedAt: since, updatedAt: Date.now() });
			};
			const answer = await runGrokHook("session-start", JSON.stringify({ sessionId: session, session_id: session, source: "new" }), {
				config: w.config,
				env,
				grokPid: GROK,
				envOf: startedWith(env),
				cwdOf: () => w.scratch.folder,
				startHolder,
				modeWaitMs: 200,
				alive: (pid) => pid === GROK,
				argvOf: () => GROK_ARGV,
			});
			expect(JSON.parse(answer)).toEqual({ systemMessage: "Orrery · Scratch · 2 msgs · recording" });
			expect(grokStatus(payload(session), ctx(w.config, env))).toBe("Orrery · Scratch · 2 msgs · recording");
		} finally {
			home.close();
		}
	});
});
