import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HarnessConfig, loadConfig } from "../../src/agent/config.ts";
import { FileCredentialStore } from "../../src/agent/credentials.ts";
import { claimToken, newToken } from "../../src/agent/pick.ts";
import { forgetSession, type Inside, recordSession, type SessionDeps } from "../../src/agent/sessions.ts";
import { pidNamespace } from "../../src/agent/process.ts";
import { modView } from "../../src/claude/mod-view.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { browseCommand, compactorCliCommand, statusCommand, usageCommand } from "../../src/cli/commands.ts";
import { GateRefusal, gateCommand, readableBy } from "../../src/cli/gate.ts";
import { HELP_COMMANDS } from "../../src/cli/help.ts";
import { fauxModels, tempDir } from "../agent/support.ts";

const dirs: string[] = [];
const sleepers: ChildProcess[] = [];
const recorded: [string, number][] = [];
afterEach(async () => {
	for (const [dataDir, pid] of recorded.splice(0)) forgetSession(dataDir, pid);
	for (const sleeper of sleepers.splice(0)) {
		sleeper.kill();
		await once(sleeper, "exit");
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The agents of a scratch config: Atlas reads Birch (or `reads`); Birch and Cedar read nobody. */
function agents(root: string, reads = '["Birch"]'): string {
	const agent = (name: string, extra = "") => {
		mkdirSync(join(root, `agent-${name}`), { recursive: true });
		return `[agents.${name}]\nfolder = ${JSON.stringify(join(root, `agent-${name}`))}\nmodel = "faux-agent/faux-1"\ncompactor_model = "faux-compactor/faux-1"\ncompactor_thinking = "off"\n${extra}`;
	};
	return `${agent("Atlas", `reads = ${reads}\n`)}${agent("Birch")}${agent("Cedar")}`;
}

/**
 * A scratch Orrery home, its config in its data folder (as ~/.orrery keeps them); HOME is a scratch folder of its own.
 * `atlas`: Atlas's session in it, as the gate's lookup finds it.
 */
function scratch(): { root: string; home: string; configPath: string; config: HarnessConfig; env: NodeJS.ProcessEnv; atlas: Inside } {
	const root = tempDir("orrery-gate-");
	dirs.push(root);
	const home = join(root, "home");
	mkdirSync(home);
	const data = join(root, "data");
	mkdirSync(data);
	const configPath = join(data, "config.toml");
	writeFileSync(configPath, agents(root));
	const config = loadConfig(configPath);
	return { root, home, configPath, config, env: { HOME: home }, atlas: { agent: "Atlas", tool: "claude-code", via: "ancestry", dataDir: config.dataDir } };
}

/** The first refusal: a command that changes memory or settings. */
const changes = (label: string, where = "Atlas, Claude Code") =>
	`${label} can't run inside an agent session (${where}): agents can't change memory or settings. Run it in your own terminal or the TUI.`;
const UNKNOWN = "orrery can't tell which agent's session this is, so inside it only help and the version run.";
/** What a session found only by its markers adds: which, and where the person reads more; never how to clear them. */
const markerNote = (names: string) =>
	` The session is known only by ${names}. If this is your own terminal (a tmux server first started from an agent session keeps its markers), see "Leftover markers" in the docs.`;

/**
 * The gate for `argv` (command first), as parseArgs would split it, with `inside` the session the fake lookup finds
 * ("outside": none).
 */
function gate(t: { configPath: string; env: NodeJS.ProcessEnv; atlas: Inside }, argv: readonly string[], values: Record<string, string | boolean> = {}, inside: Inside | "outside" = t.atlas, env: NodeJS.ProcessEnv = {}) {
	return gateCommand(argv[0], argv, { config: t.configPath, ...values }, { ...t.env, ...env }, { insideSession: () => (inside === "outside" ? undefined : inside) });
}

/** The refusal's message, or undefined when the gate let the command run. */
function refusal(run: () => unknown): string | undefined {
	try {
		run();
		return undefined;
	} catch (error) {
		expect(error).toBeInstanceOf(GateRefusal);
		return (error as Error).message;
	}
}

/** A live process that is no ancestor of this one: a session's host, seen from a detached process. */
function sleeper(): number {
	const child = spawn("sleep", ["120"], { stdio: "ignore" });
	sleepers.push(child);
	return child.pid as number;
}

function record(dataDir: string, entry: Parameters<typeof recordSession>[1], deps?: SessionDeps): void {
	expect(recordSession(dataDir, entry, deps)).toBe(true);
	recorded.push([dataDir, entry.pid]);
}

describe("the CLI gate (spec 2026-10-18-agent-permissions §3)", () => {
	it("outside any session every command runs, the TUI and the plugins' commands included", () => {
		const t = scratch();
		for (const command of [...HELP_COMMANDS, undefined]) {
			const argv = command === undefined ? [] : [command];
			expect(gate(t, argv, {}, "outside"), command).toEqual({});
		}
	});

	it("inside Atlas's session: status, usage and browse of Atlas and the agents it reads; others refused with the fix", () => {
		const t = scratch();
		const ATLAS = t.atlas;
		for (const argv of [["status"], ["status", "Atlas"], ["status", "atlas"], ["status", "."], ["status", "Birch"], ["usage"], ["usage", "."], ["usage", "Birch"], ["browse", "Birch"]]) {
			expect(gate(t, argv).inside, argv.join(" ")).toEqual(ATLAS);
		}
		expect(gate(t, ["browse", "."], { open: true }).inside).toEqual(ATLAS);
		const fix = "Atlas may not read Cedar. Allow it in the TUI (C, Reads) or with: orrery agent set Atlas --reads Birch,Cedar";
		for (const argv of [["status", "Cedar"], ["usage", "Cedar"], ["browse", "Cedar"], ["browse", "cedar"]]) expect(refusal(() => gate(t, argv)), argv.join(" ")).toBe(fix);
		// With no reads at all, the fix names the one agent.
		const birch: Inside = { ...ATLAS, agent: "Birch" };
		expect(refusal(() => gate(t, ["status", "Atlas"], {}, birch))).toBe("Birch may not read Atlas. Allow it in the TUI (C, Reads) or with: orrery agent set Birch --reads Atlas");
		// A name the config lacks is the command's own error to give.
		expect(gate(t, ["status", "Nobody"]).inside).toEqual(ATLAS);
	});

	it("status and usage with no name list only the agent and those it reads", () => {
		const t = scratch();
		const rows = statusCommand(t.config, undefined, { readable: readableBy(t.config, "Atlas") });
		expect(rows.split("\n").filter(Boolean).map((line) => line.split(/\s+/)[0])).toEqual(["Atlas", "Birch"]);
		const json = JSON.parse(statusCommand(t.config, undefined, { json: true, readable: readableBy(t.config, "Cedar") }));
		expect(json.agents.map((row: { name: string }) => row.name)).toEqual(["Cedar"]);
		expect(JSON.parse(usageCommand(t.config, undefined, 7, { json: true, readable: readableBy(t.config, "Atlas") })).agents).toEqual([]);
		// An agent the config lacks reads nobody here.
		expect(statusCommand(t.config, undefined, { readable: readableBy(t.config, "Ghost") })).toBe("No agents configured.\n");
	});

	it("browse replaces a link at its page's place, never writing through it to the file it names", () => {
		const t = scratch();
		const store = MemoryStore.open(join(t.config.agents.get("Atlas")!.dir, "memory.sqlite"));
		store.appendBatch([{ kind: "user", text: "hello" }]);
		store.close();
		const precious = join(t.root, "precious.toml");
		writeFileSync(precious, "kept\n");
		const page = join(t.root, "Atlas-memory.html");
		symlinkSync(precious, page);
		expect(browseCommand(t.config, "Atlas", page)).toBe(page);
		const hard = join(t.root, "hard.html");
		linkSync(precious, hard);
		browseCommand(t.config, "Atlas", hard);
		expect(readFileSync(precious, "utf8")).toBe("kept\n");
		for (const file of [page, hard]) {
			expect(lstatSync(file).isFile()).toBe(true);
			expect(lstatSync(file).mode & 0o777).toBe(0o600);
			expect(readFileSync(file, "utf8")).toContain("hello");
		}
		expect(readdirSync(t.root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("inside a session every command that writes memory, changes settings, touches logins or remotes, or starts a session is refused", () => {
		const t = scratch();
		const ATLAS = t.atlas;
		const cases: [readonly string[], Record<string, string | boolean>, string][] = [
			[["browse", "."], { out: "x.html" }, "orrery browse --out"],
			[["browse", "Atlas"], { out: "x.html", open: true }, "orrery browse --out"],
			[["agent", "set", "Atlas"], { reads: "all" }, "orrery agent"],
			[["agent", "Atlas"], {}, "orrery agent"],
			[["agent", "add", "Dune"], { folder: "/x", tool: "pi", summary: "a/b" }, "orrery agent"],
			[["run", "Atlas"], {}, "orrery run"],
			[["compact", "Atlas"], {}, "orrery compact"],
			[["import", "Atlas"], { "dry-run": true }, "orrery import"],
			[["import", "Atlas"], { commit: "x.jsonl" }, "orrery import"],
			[["backup"], {}, "orrery backup"],
			[["restore", "Atlas"], { from: "2026-01-01" }, "orrery restore"],
			[["login", "openai"], {}, "orrery login"],
			[["logout", "openai"], {}, "orrery logout"],
			[["logins"], {}, "orrery logins"],
			[["trust-host", "box"], {}, "orrery trust-host"],
			[["remote", "key", "home"], {}, "orrery remote"],
			[["remote", "test", "home"], {}, "orrery remote"],
			[["claude-setup", "."], {}, "orrery claude-setup"],
			[["tools"], {}, "orrery tools"],
			[["setup"], {}, "orrery setup"],
			[["install"], { from: "/x" }, "orrery install"],
			[["update"], {}, "orrery update"],
			[["uninstall"], {}, "orrery uninstall"],
			[[], {}, "orrery's TUI"],
		];
		for (const [argv, values, label] of cases) expect(refusal(() => gate(t, argv, values)), argv.join(" ") || "TUI").toBe(changes(label));
		// The tool's name follows the session: pi's, and a session whose tool no record says.
		expect(refusal(() => gate(t, ["backup"], {}, { ...ATLAS, tool: "pi" }))).toBe(changes("orrery backup", "Atlas, pi"));
		expect(refusal(() => gate(t, ["backup"], {}, { ...ATLAS, tool: undefined }))).toBe(changes("orrery backup", "Atlas"));
	});

	it("compactor runs for the session's own agent only, and starts no sign-in", async () => {
		const t = scratch();
		const ATLAS = t.atlas;
		for (const argv of [["compactor", "."], ["compactor", "Atlas"], ["compactor", "atlas", "reset"]]) expect(gate(t, argv).inside).toEqual(ATLAS);
		expect(refusal(() => gate(t, ["compactor", "Birch"]))).toBe(changes("orrery compactor Birch"));
		// A sign-in that needs its flow (OpenRouter, not saved): inside a session it is never started, even on a terminal.
		const faux = fauxModels();
		const sources = { config: t.config, credentials: new FileCredentialStore(join(t.root, "c.json")), models: faux.models };
		const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const key = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		try {
			const text = await compactorCliCommand(t.config, "Atlas", ["signin", "openrouter"], { sources, interactive: false });
			expect(text).toContain("No OpenRouter login saved. In a terminal: orrery login openrouter");
		} finally {
			if (tty === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
			else Object.defineProperty(process.stdin, "isTTY", tty);
			if (key !== undefined) process.env.OPENROUTER_API_KEY = key;
		}
	});

	it("the plugins' commands serve only the session's agent: mcp under another ORRERY_AGENT and holder for another agent are refused", async () => {
		const t = scratch();
		const ATLAS = t.atlas;
		const only = "orrery mcp serves only this session's agent, Atlas, not Birch.";
		expect(refusal(() => gate(t, ["mcp"], {}, ATLAS, { ORRERY_AGENT: "Birch" }))).toBe(only);
		expect(refusal(() => gate(t, ["mcp"], { tool: "codex" }, ATLAS, { ORRERY_AGENT: "Birch" }))).toBe(only);
		expect(gate(t, ["mcp"], {}, ATLAS, { ORRERY_AGENT: "atlas" }).inside).toEqual(ATLAS);
		expect(gate(t, ["mcp"]).inside).toEqual(ATLAS);
		expect(gate(t, ["holder", "Atlas"], { session: "s", "claude-pid": "4242" }).inside).toEqual(ATLAS);
		expect(refusal(() => gate(t, ["holder", "Birch"], { session: "s", "claude-pid": "4242" }))).toBe("orrery holder serves only this session's agent, Atlas, not Birch.");
		// The mod's view in Birch's folder: allowed, and it serves Atlas's section or none, never Birch's.
		expect(gate(t, ["claude-mod", "view"], { cwd: join(t.root, "agent-Birch") }).inside).toEqual(ATLAS);
		const owner = sleeper();
		expect(await modView(t.config, { cwd: join(t.root, "agent-Birch"), env: {}, owner, only: "Atlas" })).toEqual({ lane: null });
		expect(await modView(t.config, { cwd: join(t.root, "agent-Atlas"), env: {}, owner, only: "Atlas" })).toMatchObject({ lane: "Atlas" });
		// The hooks never pass through the gate's lookup: their own per-process decision governs them.
		const looked: string[] = [];
		for (const command of ["claude-hook", "codex-hook"]) {
			expect(gateCommand(command, [command, "pre-tool-use"], {}, t.env, { insideSession: () => (looked.push(command), ATLAS) })).toEqual({});
		}
		expect(looked).toEqual([]);
	});

	it("inside a session whose agent is unknown, only help and the version run", () => {
		const t = scratch();
		const unknown: Inside = { agent: undefined, tool: undefined, via: "ancestry", dataDir: "/data" };
		for (const command of HELP_COMMANDS) {
			if (command === "claude-hook" || command === "codex-hook") continue;
			const message = refusal(() => gate(t, [command, "."], {}, unknown));
			if (command === "help" || command === "version") expect(message, command).toBeUndefined();
			else expect(message, command).toBe(UNKNOWN);
		}
		expect(refusal(() => gate(t, [], {}, unknown))).toBe(UNKNOWN);
	});

	it("a session found only in the default home, while ORRERY_HOME and the config point to scratch folders, is still the session: only help and the version run", () => {
		const t = scratch();
		// The default home under HOME holds its config and its sessions; the test's parent process stands for Atlas's pi.
		const real = join(t.home, ".orrery");
		mkdirSync(real);
		writeFileSync(join(real, "config.toml"), agents(t.root));
		record(real, { agent: "Atlas", tool: "pi", pid: process.ppid });
		const elsewhere = { HOME: t.home, ORRERY_HOME: join(t.root, "scratch-home") };
		const homeChanged = "ORRERY_HOME can't be changed inside an agent session.";
		const configChanged = "--config and ORRERY_CONFIG can't be changed inside an agent session.";
		expect(refusal(() => gateCommand("setup", ["setup"], { config: t.configPath }, elsewhere))).toBe(changes("orrery setup", "Atlas, pi"));
		// ORRERY_HOME elsewhere: the config the command would load is that home's (none), so only help and the version run.
		expect(refusal(() => gateCommand("status", ["status", "."], {}, elsewhere))).toBe(homeChanged);
		expect(gateCommand("help", ["help"], {}, elsewhere)).toEqual({});
		for (const values of [{ config: t.configPath }, { config: join(t.root, "missing.toml") }]) {
			expect(refusal(() => gateCommand("status", ["status", "."], values, elsewhere))).toBe(configChanged);
			expect(refusal(() => gateCommand("status", ["status", "."], values, { HOME: t.home }))).toBe(configChanged);
		}
		// The real config named while ORRERY_HOME is another home that holds a config of its own.
		mkdirSync(join(t.root, "scratch-home"));
		writeFileSync(join(t.root, "scratch-home", "config.toml"), agents(t.root, '["*"]'));
		expect(refusal(() => gateCommand("status", ["status", "."], { config: join(real, "config.toml") }, elsewhere))).toBe(homeChanged);
		// Nothing changed (the normal case): it runs, with the home's own config.
		const gated = gateCommand("status", ["status", "."], {}, { HOME: t.home });
		expect(gated.inside).toMatchObject({ agent: "Atlas", tool: "pi", via: "ancestry" });
		expect(gated.config?.dataDir).toBe(real);
		expect(gateCommand("status", ["status", "."], {}, { HOME: t.home, ORRERY_HOME: real }).config?.dataDir).toBe(real);
	});

	it("inside a session the config that holds its memory rules: a made-up --config or ORRERY_CONFIG naming the real data folder is refused", () => {
		const t = scratch();
		record(t.config.dataDir, { agent: "Atlas", tool: "pi", pid: process.ppid });
		// A config the agent wrote: the real data folder, and Atlas reading every agent.
		const fake = join(t.root, "fake.toml");
		writeFileSync(fake, `data_dir = ${JSON.stringify(t.config.dataDir)}\n${agents(t.root, '["*"]')}`);
		const changed = "--config and ORRERY_CONFIG can't be changed inside an agent session.";
		expect(refusal(() => gateCommand("browse", ["browse", "Cedar"], { config: fake }, t.env))).toBe(changed);
		expect(refusal(() => gateCommand("browse", ["browse", "Cedar"], {}, { ...t.env, ORRERY_CONFIG: fake }))).toBe(changed);
		expect(refusal(() => gateCommand("status", ["status"], { config: fake }, t.env))).toBe(changed);
		// The real one, named or by ORRERY_CONFIG: its reads decide, and it is the config the command gets.
		for (const values of [{ config: t.configPath }, {}]) {
			const env = "config" in values ? t.env : { ...t.env, ORRERY_CONFIG: t.configPath };
			expect(refusal(() => gateCommand("browse", ["browse", "Cedar"], values, env))).toBe("Atlas may not read Cedar. Allow it in the TUI (C, Reads) or with: orrery agent set Atlas --reads Birch,Cedar");
			expect(gateCommand("browse", ["browse", "Birch"], values, env).config?.agents.get("Atlas")?.reads).toEqual(["Birch"]);
		}
		// Outside the session --config works as it always has.
		forgetSession(t.config.dataDir, process.ppid);
		expect(gateCommand("browse", ["browse", "Cedar"], { config: fake }, t.env)).toEqual({});
	});

	it("a config kept outside its data folder (data_dir set): the one the session's record names rules; with none named, only help and the version run", () => {
		const t = scratch();
		const data = join(t.root, "split-data");
		const split = join(t.root, "split.toml");
		writeFileSync(split, `data_dir = ${JSON.stringify(data)}\n${agents(t.root)}`);
		const noConfig = "orrery can't read the config that holds this session's memory, so inside it only help and the version run.";
		// The host recorded the config it loaded (as loadConfig gives it, HarnessConfig.file).
		const loaded = loadConfig(split);
		expect(loaded.file).toBe(split);
		record(data, { agent: "Atlas", tool: "pi", pid: process.ppid, config: loaded.file });
		const gated = gateCommand("status", ["status", "."], { config: split }, t.env);
		expect(gated.inside).toMatchObject({ agent: "Atlas", via: "ancestry", config: split });
		expect(gated.config?.file).toBe(split);
		expect(refusal(() => gateCommand("browse", ["browse", "Cedar"], {}, { ...t.env, ORRERY_CONFIG: split }))).toMatch(/^Atlas may not read Cedar\./);
		// Another config naming the same data folder, given by the caller: refused.
		const fake = join(t.root, "fake.toml");
		writeFileSync(fake, `data_dir = ${JSON.stringify(data)}\n${agents(t.root, '["*"]')}`);
		expect(refusal(() => gateCommand("browse", ["browse", "Cedar"], { config: fake }, t.env))).toBe("--config and ORRERY_CONFIG can't be changed inside an agent session.");
		// A recorded config that no longer names the session's data folder holds nothing: only help and the version.
		record(data, { agent: "Atlas", tool: "pi", pid: process.ppid, config: t.configPath });
		expect(refusal(() => gateCommand("status", ["status", "."], { config: split }, t.env))).toBe(noConfig);
		// A config path that isn't absolute is no record's.
		expect(recordSession(data, { agent: "Atlas", tool: "pi", pid: process.ppid, config: "split.toml" })).toBe(false);
		// A record naming none (a host that loaded no file): only a config in the data folder, or the server path's, counts.
		record(data, { agent: "Atlas", tool: "pi", pid: process.ppid });
		expect(refusal(() => gateCommand("status", ["status", "."], { config: split }, t.env))).toBe(noConfig);
		expect(refusal(() => gateCommand("setup", ["setup"], { config: split }, t.env))).toBe(changes("orrery setup", "Atlas, pi"));
		expect(gateCommand("help", ["help"], { config: split }, t.env)).toEqual({});
	});

	it("a session proven by a token: the config its claimant's record names, else only one in the data folder", () => {
		const t = scratch();
		const data = join(t.root, "split-data");
		const split = join(t.root, "split.toml");
		writeFileSync(split, `data_dir = ${JSON.stringify(data)}\n${agents(t.root)}`);
		const host = sleeper();
		const token = newToken();
		const config = loadConfig(split);
		expect(claimToken(config.agents.get("Atlas")!.dir, token, host)).toBe(true);
		const env = { ...t.env, ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token };
		// Only the token says whose: no record of the claimant, so no config is named.
		expect(refusal(() => gateCommand("status", ["status", "."], { config: split }, env))).toMatch(/^orrery can't read the config that holds this session's memory/);
		// The claimant hosts the session and recorded its config.
		record(data, { agent: "Atlas", tool: "claude-code", pid: host, config: split });
		expect(gateCommand("status", ["status", "."], { config: split }, env)).toMatchObject({ inside: { agent: "Atlas", via: "marker", config: split } });
	});

	it("markers naming an agent the scratch config lacks, with no recorded ancestor there, are no session (a developer's tests)", () => {
		const t = scratch();
		const env = { ...t.env, ORRERY_AGENT: "Ghost", ORRERY_AGENT_TOKEN: newToken(), CLAUDE_PID: String(process.ppid), ORRERY_HOST: String(process.ppid), CODEX_THREAD_ID: "thread-1" };
		for (const argv of [["setup"], ["agent", "Atlas"], ["remote", "key", "home"], ["import", "Atlas"], ["status", "Cedar"]]) {
			expect(gateCommand(argv[0], argv, { config: t.configPath }, env), argv.join(" ")).toEqual({});
		}
	});

	it("a session found only by its markers says which and how to clear them (a tmux server started from an agent's shell)", () => {
		const t = scratch();
		const host = sleeper();
		record(t.config.dataDir, { agent: "Atlas", tool: "claude-code", pid: host });
		const status = (env: NodeJS.ProcessEnv) => refusal(() => gateCommand("status", ["status"], { config: t.configPath }, { ...t.env, ...env }));
		// ORRERY_HOST is public: it says there is a session, never whose.
		expect(status({ ORRERY_HOST: String(host) })).toBe(`${UNKNOWN} The session is known only by ORRERY_HOST. If this is your own terminal (a tmux server first started from an agent session keeps its markers), see "Leftover markers" in the docs.`);
		expect(status({ ORRERY_HOST: String(host), CLAUDE_PID: String(host) })).toBe(`${UNKNOWN}${markerNote("ORRERY_HOST and CLAUDE_PID")}`);
		// A token the host claimed says whose: the agent's own commands run, and the rest are refused with the same note.
		const token = newToken();
		expect(claimToken(t.config.agents.get("Atlas")!.dir, token, host)).toBe(true);
		const marked = { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token, ORRERY_HOST: String(host) };
		expect(gateCommand("status", ["status", "."], { config: t.configPath }, { ...t.env, ...marked })).toMatchObject({ inside: { agent: "Atlas", via: "marker" } });
		expect(refusal(() => gateCommand("setup", ["setup"], { config: t.configPath }, { ...t.env, ...marked }))).toBe(
			`${changes("orrery setup")}${markerNote("ORRERY_AGENT, ORRERY_AGENT_TOKEN and ORRERY_HOST")}`,
		);
	});

	it.runIf(process.platform === "linux")("Codex's sandboxed shell, in a pid namespace of its own, is a session whose agent is unknown, and says so", () => {
		const t = scratch();
		const host = sleeper();
		record(t.config.dataDir, { agent: "Atlas", tool: "codex", pid: host, codexSession: "thread-1" });
		const token = newToken();
		expect(claimToken(t.config.agents.get("Atlas")!.dir, token, host)).toBe(true);
		// Seen from another pid namespace: every record and claim is numbered elsewhere.
		const sandbox: SessionDeps = { ns: (pid) => (pid === "self" ? "pid:[1]" : pidNamespace(pid)) };
		const env = { ...t.env, ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token, CODEX_THREAD_ID: "thread-1" };
		const message = refusal(() => gateCommand("status", ["status", "."], { config: t.configPath }, env, { sessions: sandbox }));
		expect(message).toBe(`${UNKNOWN} This shell carries CODEX_THREAD_ID from Codex, whose sandbox hides which agent's session it is.`);
		expect(gateCommand("help", ["help"], { config: t.configPath }, env, { sessions: sandbox })).toEqual({});
	});

	it("the plugins' commands take the markers their own tool was started with as its own, and a holder its host's record", () => {
		const t = scratch();
		// The MCP server Claude Code starts first, before its process decided: ORRERY_AGENT and a token nobody claimed yet.
		const launch = { ...t.env, ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: newToken() };
		expect(gateCommand("mcp", ["mcp"], { config: t.configPath }, launch, { parent: process.pid })).toEqual({});
		expect(gateCommand("claude-mod", ["claude-mod", "view"], { config: t.configPath }, launch, { parent: process.pid })).toEqual({});
		// The same markers in any other command are a session whose agent is unknown.
		expect(refusal(() => gateCommand("status", ["status"], { config: t.configPath }, launch))).toBe(`${UNKNOWN}${markerNote("ORRERY_AGENT")}`);
		// A holder whose hook exited (no recorded ancestor left), for a Claude Code that opened Atlas by its folder.
		const claude = sleeper();
		record(t.config.dataDir, { agent: "Atlas", tool: "claude-code", pid: claude });
		const hook = { ...t.env, CLAUDE_PID: String(claude) };
		const holder = (name: string, pid: number) => () => gateCommand("holder", ["holder", name], { config: t.configPath, session: "s", "claude-pid": String(pid) }, hook);
		expect(holder("Atlas", claude)()).toMatchObject({ inside: { agent: "Atlas", tool: "claude-code" } });
		expect(refusal(holder("Birch", claude))).toBe("orrery holder serves only this session's agent, Atlas, not Birch.");
		// A host pid that isn't the one the markers point at proves nothing.
		expect(refusal(holder("Birch", process.pid))).toBe(`${UNKNOWN}${markerNote("CLAUDE_PID")}`);
	});
});
