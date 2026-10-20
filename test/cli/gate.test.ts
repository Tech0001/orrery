import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HarnessConfig, loadConfig } from "../../src/agent/config.ts";
import { FileCredentialStore } from "../../src/agent/credentials.ts";
import { claimToken, newToken } from "../../src/agent/pick.ts";
import { forgetSession, type Inside, recordSession, type SessionDeps, type ToolSession, type toolSession } from "../../src/agent/sessions.ts";
import { pidNamespace } from "../../src/agent/process.ts";
import { modView } from "../../src/claude/mod-view.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { browseCommand, compactorCliCommand, statusCommand, usageCommand } from "../../src/cli/commands.ts";
import { type GateDeps, type Gated, GateRefusal, gateCommand, realOrreryData, readableBy, vouched, within } from "../../src/cli/gate.ts";
import { HELP_COMMANDS } from "../../src/cli/help.ts";
import { fauxModels, tempDir } from "../agent/support.ts";

const dirs: string[] = [];
const sleepers: ChildProcess[] = [];
/** Processes no handle here holds: the ones under a host (host()). */
const strays: number[] = [];
const recorded: [string, number][] = [];
afterEach(async () => {
	for (const [dataDir, pid] of recorded.splice(0)) forgetSession(dataDir, pid);
	for (const pid of strays.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone already
		}
	}
	for (const sleeper of sleepers.splice(0)) {
		// A host's shell exits once the process under it is gone: its exit may already have been seen, and is not waited for.
		if (sleeper.exitCode !== null || sleeper.signalCode !== null) continue;
		const exited = once(sleeper, "exit");
		sleeper.kill();
		await exited;
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

/**
 * Whether the gate let a command run as it always has, outside every session and every coding tool's session: with the
 * config it read, and nothing more.
 */
const runsAsAlways = (gated: Gated) => gated.inside === undefined && gated.tool === undefined && gated.hostAgent === undefined;

/** What the gate decided (the session, the coding tool's, the one agent a plugin command may serve), less the config it hands over. */
const decided = ({ inside, tool, hostAgent }: Gated) => ({ ...(inside === undefined ? {} : { inside }), ...(tool === undefined ? {} : { tool }), ...(hostAgent === undefined ? {} : { hostAgent }) });

/**
 * A live process that is no ancestor of this one: a session's host, seen from a detached process; or, working in `cwd`
 * and started with `env`, a coding tool that may start an MCP server or the mod's view.
 */
function sleeper(started: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {}): number {
	const env = started.env === undefined ? {} : { env: { PATH: process.env.PATH, ...started.env } };
	const child = spawn("sleep", ["120"], { stdio: "ignore", ...(started.cwd === undefined ? {} : { cwd: started.cwd }), ...env });
	sleepers.push(child);
	return child.pid as number;
}

/**
 * A coding tool working in `cwd`, started with `env` (`pid`), and a process it started that still runs (`under`): the hook
 * that starts a holder. A holder's gate walks up from `under` (SessionDeps.from).
 */
async function host(cwd: string, env: NodeJS.ProcessEnv): Promise<{ readonly pid: number; readonly under: number }> {
	const child = spawn("sh", ["-c", "sleep 120 & echo $!; wait"], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "ignore"] });
	sleepers.push(child);
	const [line] = (await once(child.stdout as NodeJS.ReadableStream, "data")) as [Buffer];
	const under = Number(line.toString().trim());
	strays.push(under);
	return { pid: child.pid as number, under };
}

/**
 * A coding tool (a stand-in: a script named claude in `root`, which Linux names its process after, and macOS's ps shows
 * as sh running it) and a process its shell started that still runs (`under`).
 */
async function tool(root: string): Promise<{ readonly pid: number; readonly under: number }> {
	const program = join(root, "tool-bin", "claude");
	mkdirSync(dirname(program), { recursive: true });
	writeFileSync(program, "#!/bin/sh\nsleep 120 &\necho $!\nwait\n", { mode: 0o755 });
	const child = spawn(program, [], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "ignore"] });
	sleepers.push(child);
	const [line] = (await once(child.stdout as NodeJS.ReadableStream, "data")) as [Buffer];
	const under = Number(line.toString().trim());
	strays.push(under);
	return { pid: child.pid as number, under };
}

/** A process whose parent exited: the kernel reparented it (to init, or the nearest subreaper), as a holder whose hook exited. */
async function orphan(): Promise<number> {
	const child = spawn("sh", ["-c", "sleep 120 >/dev/null 2>&1 & echo $!"], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "ignore"] });
	const [line] = (await once(child.stdout as NodeJS.ReadableStream, "data")) as [Buffer];
	const pid = Number(line.toString().trim());
	strays.push(pid);
	if (child.exitCode === null) await once(child, "exit");
	return pid;
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
			expect(gate(t, argv, {}, "outside"), command).toSatisfy(runsAsAlways);
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
			expect(gateCommand(command, [command, "pre-tool-use"], {}, t.env, { insideSession: () => (looked.push(command), ATLAS) })).toSatisfy(runsAsAlways);
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
		expect(gateCommand("help", ["help"], {}, elsewhere)).toSatisfy(runsAsAlways);
		for (const values of [{ config: t.configPath }, { config: join(t.root, "missing.toml") }]) {
			expect(refusal(() => gateCommand("status", ["status", "."], values, elsewhere))).toBe(configChanged);
			expect(refusal(() => gateCommand("status", ["status", "."], values, { HOME: t.home }))).toBe(configChanged);
		}
		// The real config named while ORRERY_HOME is another home that holds a config of its own.
		mkdirSync(join(t.root, "scratch-home"));
		writeFileSync(join(t.root, "scratch-home", "config.toml"), agents(t.root, '["*"]'));
		expect(refusal(() => gateCommand("status", ["status", "."], { config: join(real, "config.toml") }, elsewhere))).toBe(homeChanged);
		// Nothing changed (the normal case): it runs, with the home's own config, read from the session's real data folder
		// (on macOS the temporary folder is a link, /var to /private/var).
		const gated = gateCommand("status", ["status", "."], {}, { HOME: t.home });
		expect(gated.inside).toMatchObject({ agent: "Atlas", tool: "pi", via: "ancestry" });
		expect(gated.config?.dataDir).toBe(realpathSync(real));
		expect(gateCommand("status", ["status", "."], {}, { HOME: t.home, ORRERY_HOME: real }).config?.dataDir).toBe(realpathSync(real));
	});

	it("an ORRERY_HOME that is no absolute path throws nothing out of the gate: outside a session there is no config, and no file to write; inside one it is refused", () => {
		const t = scratch();
		const real = realHome(t);
		const env = { ...t.env, ORRERY_HOME: "relative/home" };
		const outside: GateDeps = { realHome: real.home, insideSession: () => undefined, toolSession: finds(undefined).toolSession };
		for (const argv of [["status"], ["agent", "add", "Dana"], ["setup"], []]) {
			const gated = gateCommand(argv[0], argv, {}, env, outside);
			expect(gated.config, argv.join(" ") || "TUI").toBeUndefined();
			expect((gated.configError as Error).message).toBe("ORRERY_HOME must be an absolute path (got relative/home)");
			// No place for the config: a command that reads or writes it by path fails with that error (src/cli/main.ts judgedFile).
			expect(gated.configFile).toBeUndefined();
		}
		// A config named with --config is there, as in 0.9.0.
		expect(gateCommand("status", ["status"], { config: t.configPath }, env, outside).config?.file).toBe(t.configPath);
		// Inside an agent's session: refused, claude-mod too (its one JSON line says so, src/cli/main.ts).
		const inside: GateDeps = { realHome: real.home, insideSession: () => t.atlas };
		for (const values of [{}, { config: t.configPath }]) {
			for (const argv of [["status"], ["claude-mod", "view"]]) {
				expect(refusal(() => gateCommand(argv[0], argv, values, env, inside)), `${argv[0]} ${JSON.stringify(values)}`).toBe("ORRERY_HOME can't be changed inside an agent session.");
			}
		}
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
		expect(gateCommand("browse", ["browse", "Cedar"], { config: fake }, t.env)).toSatisfy(runsAsAlways);
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
		// A config whose path can't be resolved is recorded as none.
		record(data, { agent: "Atlas", tool: "pi", pid: process.ppid, config: join(t.root, "gone.toml") });
		expect(gateCommand("help", ["help"], { config: split }, t.env)).toSatisfy(runsAsAlways);
		expect(refusal(() => gateCommand("status", ["status", "."], { config: split }, t.env))).toBe(noConfig);
		// A record naming none (a host that loaded no file): only a config in the data folder, or the server path's, counts.
		record(data, { agent: "Atlas", tool: "pi", pid: process.ppid });
		expect(refusal(() => gateCommand("status", ["status", "."], { config: split }, t.env))).toBe(noConfig);
		expect(refusal(() => gateCommand("setup", ["setup"], { config: split }, t.env))).toBe(changes("orrery setup", "Atlas, pi"));
		expect(gateCommand("help", ["help"], { config: split }, t.env)).toSatisfy(runsAsAlways);
	});

	it("a config that can't be loaded (--config /nonexistent) still finds the session kept in the data folder the home's own config names", () => {
		const t = scratch();
		// The home's config keeps memory and session records in a data folder apart from the home (data_dir).
		const data = join(t.root, "split-data");
		const home = join(t.home, ".orrery");
		mkdirSync(home);
		writeFileSync(join(home, "config.toml"), `data_dir = ${JSON.stringify(data)}\n${agents(t.root)}`);
		record(data, { agent: "Atlas", tool: "pi", pid: process.ppid, config: join(home, "config.toml") });
		const changed = "--config and ORRERY_CONFIG can't be changed inside an agent session.";
		const missing = join(t.root, "nonexistent.toml");
		expect(refusal(() => gateCommand("status", ["status", "."], { config: missing }, { HOME: t.home }))).toBe(changed);
		expect(refusal(() => gateCommand("status", ["status", "."], {}, { HOME: t.home, ORRERY_CONFIG: missing }))).toBe(changed);
		expect(refusal(() => gateCommand("setup", ["setup"], { config: missing }, { HOME: t.home }))).toBe(changes("orrery setup", "Atlas, pi"));
		// The same home named by ORRERY_HOME, under a scratch HOME.
		expect(refusal(() => gateCommand("setup", ["setup"], { config: missing }, { HOME: join(t.root, "other"), ORRERY_HOME: home }))).toBe(changes("orrery setup", "Atlas, pi"));
		// No session there: the command runs (and fails on its own config).
		forgetSession(data, process.ppid);
		expect(gateCommand("status", ["status", "."], { config: missing }, { HOME: t.home })).toSatisfy(runsAsAlways);
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
			expect(gateCommand(argv[0], argv, { config: t.configPath }, env), argv.join(" ")).toSatisfy(runsAsAlways);
		}
	});

	it("a session found only by its markers names them and points to the docs, with no recipe (a tmux server started from an agent's shell)", () => {
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
		expect(gateCommand("help", ["help"], { config: t.configPath }, env, { sessions: sandbox })).toSatisfy(runsAsAlways);
	});

	it("the plugins' commands take the markers their own tool was started with as its own; a holder only a host that vouches for it", () => {
		const t = scratch();
		// The MCP server Claude Code starts first, before its process decided: ORRERY_AGENT and a token nobody claimed yet.
		const launch = { ...t.env, ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: newToken() };
		expect(gateCommand("mcp", ["mcp"], { config: t.configPath }, launch, { parent: process.pid })).toSatisfy(runsAsAlways);
		expect(gateCommand("claude-mod", ["claude-mod", "view"], { config: t.configPath }, launch, { parent: process.pid })).toSatisfy(runsAsAlways);
		// The same markers in any other command are a session whose agent is unknown.
		expect(refusal(() => gateCommand("status", ["status"], { config: t.configPath }, launch))).toBe(`${UNKNOWN}${markerNote("ORRERY_AGENT")}`);
		// A holder names its Claude Code on its command line, which is anyone's to write. A detached one (no recorded
		// ancestor) whose CLAUDE_PID and --claude-pid name a Claude Code that is no ancestor of it, by its folder (no
		// token), proves nothing: refused, for that host's agent too.
		const claude = sleeper();
		record(t.config.dataDir, { agent: "Atlas", tool: "claude-code", pid: claude });
		/** The holder, with no coding tool above it (`above`: what the lookup of the tools above it finds). */
		const holder = (name: string, pid: number, env: NodeJS.ProcessEnv = {}, above?: ToolSession) => () =>
			gateCommand("holder", ["holder", name], { config: t.configPath, session: "s", "claude-pid": String(pid) }, { ...t.env, CLAUDE_PID: String(claude), ...env }, { toolSession: finds(above).toolSession });
		for (const name of ["Atlas", "Birch"]) expect(refusal(holder(name, claude)), name).toBe(`${UNKNOWN}${markerNote("CLAUDE_PID")}`);
		expect(refusal(holder("Birch", process.pid))).toBe(`${UNKNOWN}${markerNote("CLAUDE_PID")}`);
		// A launched session: that host holds the claim of the holder's token for the agent its record names. Only its
		// markers found it, and its host is no ancestor of this holder: as a holder its hook started and the kernel
		// reparented once the hook exited (no coding tool above it), it runs; under a coding tool that is not its host,
		// whose shell copied the host's markers (anyone of the user's may read them), it is refused.
		const token = newToken();
		expect(claimToken(t.config.agents.get("Atlas")!.dir, token, claude)).toBe(true);
		const launched = { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token };
		expect(holder("Atlas", claude, launched)()).toMatchObject({ inside: { agent: "Atlas", tool: "claude-code" } });
		expect(refusal(holder("Atlas", claude, launched, CLAUDE))).toBe(noAgent("orrery holder"));
		expect(refusal(holder("Birch", claude, launched))).toBe("orrery holder serves only this session's agent, Atlas, not Birch.");
	});

	it("a holder that only another session's markers place in it is refused under a coding tool that is not that session's own; reparented, it runs", async () => {
		const t = scratch();
		const real = realHome(t);
		// Atlas's session: its Claude Code (a stand-in that is no ancestor of the holders here), recorded as its host, which
		// claimed its launch's token. Its markers are in its environment, which any process of the user's may read.
		const claude = sleeper();
		record(t.config.dataDir, { agent: "Atlas", tool: "claude-code", pid: claude });
		const token = newToken();
		expect(claimToken(t.config.agents.get("Atlas")!.dir, token, claude)).toBe(true);
		const copied = { CLAUDE_PID: String(claude), ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token };
		/** The holder for Atlas whose --claude-pid is `host`, its process tree walked from `from`; the real lookups. */
		const holder = (host: number, from: number) => () =>
			gateCommand("holder", ["holder", "Atlas"], { config: t.configPath, session: "s", "claude-pid": String(host) }, { ...t.env, ...copied }, { realHome: real.home, sessions: { from } });
		// A plain coding tool (a stand-in named claude) and a process its shell started.
		const plain = await tool(t.root);
		const refused = noAgent("orrery holder", `a Claude Code session that is no agent's (process ${plain.pid})`);
		// Naming Atlas's host, with its markers copied: that host is no ancestor, and a tool that is not it is above.
		expect(refusal(holder(claude, plain.under))).toBe(refused);
		// Naming the plain tool itself (an ancestor) as its host: the markers it carries are still another session's.
		expect(refusal(holder(plain.pid, plain.under))).toBe(refused);
		// Atlas's own holder, reparented once the hook that started it exited: no coding tool above it, so it runs.
		expect(holder(claude, await orphan())()).toMatchObject({ inside: { agent: "Atlas", tool: "claude-code" } });
	});

	it("a holder whose named host the gate can't take (pid 1, a pid past the safe integers), with another session's markers, is refused under a coding tool", async () => {
		const t = scratch();
		const real = realHome(t);
		const claude = sleeper();
		record(t.config.dataDir, { agent: "Atlas", tool: "claude-code", pid: claude });
		const token = newToken();
		expect(claimToken(t.config.agents.get("Atlas")!.dir, token, claude)).toBe(true);
		const copied = { CLAUDE_PID: String(claude), ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token };
		const plain = await tool(t.root);
		const refused = noAgent("orrery holder", `a Claude Code session that is no agent's (process ${plain.pid})`);
		// No host to take is no host that vouches: only the markers found the session, and a coding tool is above it.
		for (const option of ["claude-pid", "host-pid"]) {
			for (const pid of ["1", "9007199254740993"]) {
				const gated = () =>
					gateCommand("holder", ["holder", "Atlas"], { config: t.configPath, session: "s", [option]: pid }, { ...t.env, ...copied }, { realHome: real.home, sessions: { from: plain.under } });
				expect(refusal(gated), `--${option} ${pid}`).toBe(refused);
			}
		}
	});

	it("the holder of a session whose coding tool is pid 1 (a container's) runs", () => {
		const t = scratch();
		const real = realHome(t);
		// Found by its host's record, with that tool (pid 1) above it.
		const container: ToolSession = { tool: "claude", via: "ancestry", pid: 1 };
		const gated = gateCommand("holder", ["holder", "Atlas"], { config: t.configPath, session: "s", "claude-pid": "1" }, { ...t.env, CLAUDE_PID: "1" }, { realHome: real.home, insideSession: () => t.atlas, toolSession: finds(container).toolSession });
		expect(gated.inside).toEqual(t.atlas);
	});

	it.runIf(process.platform === "linux")("the holder of a container's session, which no walk up to pid 1 reaches, runs: found by its launch's token, with no coding tool found above it", () => {
		const t = scratch();
		const real = realHome(t);
		// pid 1 stands for the container's Claude Code, which claimed its launch's token.
		const token = newToken();
		expect(claimToken(t.config.agents.get("Atlas")!.dir, token, 1)).toBe(true);
		// The holder (60), started by the hook's shell (30), which the tool at pid 1 started; a walk stops below pid 1.
		const rows: Record<number, { readonly ppid: number; readonly comm: string }> = { 30: { ppid: 1, comm: "sh" }, 60: { ppid: 30, comm: "orrery" } };
		const sessions: SessionDeps = {
			platform: "linux",
			from: 60,
			proc: (pid) => {
				const row = rows[pid];
				return row === undefined ? undefined : `${pid} (${row.comm}) S ${row.ppid} ${Array(17).fill("0").join(" ")} 100 4096 0\n`;
			},
			cmdline: (pid) => (rows[pid] === undefined ? undefined : [rows[pid].comm]),
		};
		const env = { ...t.env, CLAUDE_PID: "1", ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token };
		const gated = gateCommand("holder", ["holder", "Atlas"], { config: t.configPath, session: "s", "claude-pid": "1" }, env, { realHome: real.home, sessions });
		expect(gated.inside).toMatchObject({ agent: "Atlas", via: "marker" });
	});

	it("judges the data folder of every file a command would touch: a scratch HOME and config naming the real logins or config are still inside", () => {
		const t = scratch();
		// A stand-in for the real home: its data folder holds the config, the logins and the session of this test's parent.
		const real = join(t.root, "real-home", ".orrery");
		mkdirSync(real, { recursive: true });
		writeFileSync(join(real, "config.toml"), agents(t.root));
		writeFileSync(join(real, "credentials.json"), "{}\n");
		record(real, { agent: "Atlas", tool: "claude-code", pid: process.ppid });
		// A crafted config: a scratch data folder and the real logins; HOME scratch, no ORRERY_HOME, no markers.
		const crafted = join(t.root, "crafted.toml");
		writeFileSync(crafted, `data_dir = ${JSON.stringify(join(t.root, "scratch-data"))}\ncredentials = ${JSON.stringify(join(real, "credentials.json"))}\n${agents(t.root)}`);
		const env = { HOME: t.home, ORRERY_CONFIG: crafted };
		for (const argv of [["login", "openai"], ["logout", "openai"], ["logins"]]) expect(refusal(() => gateCommand(argv[0], argv, {}, env)), argv[0]).toBe(changes(`orrery ${argv[0]}`));
		// From the scratch config, path options naming the real data folder: browse --out over its config, restore --from.
		expect(refusal(() => gateCommand("browse", ["browse", "Atlas"], { config: t.configPath, out: join(real, "config.toml") }, t.env))).toBe("--config and ORRERY_CONFIG can't be changed inside an agent session.");
		expect(refusal(() => gateCommand("restore", ["restore", "Atlas"], { config: t.configPath, from: join(real, "backups", "2026-01-01") }, t.env))).toBe(changes("orrery restore"));
		const changed = "--config and ORRERY_CONFIG can't be changed inside an agent session.";
		// A records folder planted nearer the file (a pi given a data_dir inside the real one leaves one) hides nothing above it.
		const birch = join(real, "agents", "Birch");
		mkdirSync(join(birch, "session-hosts"), { recursive: true });
		expect(refusal(() => gateCommand("browse", ["browse", "Atlas"], { config: t.configPath, out: join(birch, "memory.sqlite") }, t.env))).toBe(changed);
		// A link to nothing yet: judged where it points.
		const dangling = join(t.root, "page.html");
		symlinkSync(join(real, "agents", "Atlas", "not-yet", "memory.html"), dangling);
		expect(refusal(() => gateCommand("browse", ["browse", "Atlas"], { config: t.configPath, out: dangling }, t.env))).toBe(changed);
		// browse without --out, and import --dry-run, write into the folder they run in.
		expect(refusal(() => gateCommand("browse", ["browse", "Atlas"], { config: t.configPath }, t.env, { cwd: birch }))).toBe(changed);
		expect(refusal(() => gateCommand("import", ["import", "Atlas"], { config: t.configPath, "dry-run": true }, t.env, { cwd: birch }))).toBe(changes("orrery import"));
		expect(gateCommand("browse", ["browse", "Atlas"], { config: t.configPath }, t.env, { cwd: t.root })).toSatisfy(runsAsAlways);
		// No session there: the same commands run.
		forgetSession(real, process.ppid);
		expect(gateCommand("logins", ["logins"], {}, env)).toSatisfy(runsAsAlways);
		expect(gateCommand("browse", ["browse", "Atlas"], { config: t.configPath, out: join(real, "config.toml") }, t.env)).toSatisfy(runsAsAlways);
		expect(gateCommand("browse", ["browse", "Atlas"], { config: t.configPath, out: dangling }, t.env)).toSatisfy(runsAsAlways);
	});

	it("a token claim whose pid now names a process started at another time proves nothing", () => {
		const t = scratch();
		const host = sleeper();
		const token = newToken();
		const dir = t.config.agents.get("Atlas")!.dir;
		expect(claimToken(dir, token, host)).toBe(true);
		const env = { ...t.env, ORRERY_AGENT_TOKEN: token };
		expect(gateCommand("status", ["status", "."], { config: t.configPath }, env)).toMatchObject({ inside: { agent: "Atlas", via: "marker" } });
		const [pid, ns] = readFileSync(join(dir, "claims", token), "utf8").split("\n");
		writeFileSync(join(dir, "claims", token), `${pid}\n${ns}\n1\n`);
		expect(gateCommand("status", ["status", "."], { config: t.configPath }, env)).toSatisfy(runsAsAlways);
	});

	it("a record with a field that can't be read is unsure and kept; a broken config pair untrusts only the config", () => {
		const t = scratch();
		const file = join(t.config.dataDir, "session-hosts", `${process.ppid}.json`);
		record(t.config.dataDir, { agent: "Atlas", tool: "claude-code", pid: process.ppid });
		const good = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		// A config without its real path: the record stands (its session found by ancestry); the data folder's config rules.
		writeFileSync(file, JSON.stringify({ ...good, config: join(t.root, "elsewhere.toml") }));
		const gated = gateCommand("status", ["status", "."], { config: t.configPath }, t.env);
		expect(gated.inside).toMatchObject({ agent: "Atlas", via: "ancestry" });
		expect(gated.inside?.config).toBeUndefined();
		// Read from the session's real data folder (on macOS the temporary folder is a link, /var to /private/var).
		expect(gated.config?.file).toBe(realpathSync(t.configPath));
		// A codexSession that is no string: unsure, kept, and a marker pointing at it is a session whose agent is unknown.
		writeFileSync(file, JSON.stringify({ ...good, codexSession: 7 }));
		expect(refusal(() => gateCommand("status", ["status"], { config: t.configPath }, { ...t.env, CLAUDE_PID: String(process.ppid) }))).toMatch(/^orrery can't tell which agent's session this is/);
		expect(readdirSync(join(t.config.dataDir, "session-hosts"))).toContain(`${process.ppid}.json`);
	});

	it.runIf(process.platform === "linux")("a holder's named host vouches only by ancestry, or a claim holding its start, made in this pid namespace", () => {
		const t = scratch();
		const host = sleeper();
		const atlas: Inside = { agent: "Atlas", tool: "claude-code", via: "ancestry", dataDir: t.config.dataDir };
		const claims = join(t.config.agents.get("Atlas")!.dir, "claims");
		const token = newToken();
		const env = { ORRERY_AGENT_TOKEN: token };
		// An ancestor vouches without a claim.
		expect(vouched(process.ppid, atlas, {})).toBe(true);
		expect(vouched(host, atlas, env)).toBe(false);
		// A claim by the host, holding its start, in this namespace.
		expect(claimToken(t.config.agents.get("Atlas")!.dir, token, host)).toBe(true);
		expect(vouched(host, atlas, env)).toBe(true);
		// Seen from another pid namespace; or a claim without a start, or with another start.
		expect(vouched(host, atlas, env, { sessions: { ns: (pid) => (pid === "self" ? "pid:[1]" : pidNamespace(pid)) } })).toBe(false);
		const [pid, ns] = readFileSync(join(claims, token), "utf8").split("\n");
		writeFileSync(join(claims, token), `${pid}\n${ns}\n`);
		expect(vouched(host, atlas, env)).toBe(false);
		writeFileSync(join(claims, token), `${pid}\n${ns}\n1\n`);
		expect(vouched(host, atlas, env)).toBe(false);
	});

	it("a recorded config reached through a link counts only while the link leads to the file it led to then", () => {
		const t = scratch();
		const data = join(t.root, "split-data");
		const target = join(t.root, "split.toml");
		writeFileSync(target, `data_dir = ${JSON.stringify(data)}\n${agents(t.root)}`);
		const link = join(t.root, "orrery.toml");
		symlinkSync(target, link);
		record(data, { agent: "Atlas", tool: "pi", pid: process.ppid, config: link });
		expect(gateCommand("status", ["status", "."], { config: link }, t.env).config?.file).toBe(link);
		// A config with a relative data_dir, through a link in another folder: read from its file, as the host read it.
		const home = join(t.root, "linked-home");
		mkdirSync(join(home, "data"), { recursive: true });
		const relative = join(t.root, "relative.toml");
		writeFileSync(relative, `data_dir = "data"\n${agents(t.root)}`);
		const homeLink = join(home, "config.toml");
		symlinkSync(relative, homeLink);
		record(join(home, "data"), { agent: "Atlas", tool: "pi", pid: process.ppid, config: homeLink });
		expect(gateCommand("status", ["status", "."], { config: homeLink }, t.env).config?.dataDir).toBe(join(home, "data"));
		forgetSession(join(home, "data"), process.ppid);
		// Re-pointed at a config of the agent's making, naming the same data folder and reading every agent.
		const fake = join(t.root, "fake.toml");
		writeFileSync(fake, `data_dir = ${JSON.stringify(data)}\n${agents(t.root, '["*"]')}`);
		rmSync(link);
		symlinkSync(fake, link);
		expect(refusal(() => gateCommand("browse", ["browse", "Cedar"], { config: link }, t.env))).toBe("orrery can't read the config that holds this session's memory, so inside it only help and the version run.");
	});
});

/**
 * A stand-in for the user's real Orrery home: `<root>/real/.orrery`, holding a config and its agents. The gate is given
 * `<root>/real` as the password database's home (GateDeps.realHome), never through HOME.
 */
function realHome(t: { root: string }): { home: string; orrery: string; configPath: string } {
	const home = join(t.root, "real");
	const orrery = join(home, ".orrery");
	mkdirSync(orrery, { recursive: true });
	const configPath = join(orrery, "config.toml");
	writeFileSync(configPath, agents(t.root));
	return { home, orrery, configPath };
}

/** The coding tool's session the fake lookup finds: Claude Code, by its process 4242. */
const CLAUDE: ToolSession = { tool: "claude", via: "ancestry", pid: 4242 };

/** A fake toolSession that answers `found`, keeping what it was asked. */
function finds(found: ToolSession | undefined): { readonly asked: Parameters<typeof toolSession>[]; readonly toolSession: typeof toolSession } {
	const asked: Parameters<typeof toolSession>[] = [];
	return { asked, toolSession: (...args) => (asked.push(args), found) };
}

/** The refusal in a coding tool's session that is no agent's. */
const noAgent = (label: string, session = "a Claude Code session that is no agent's (process 4242)") =>
	`${label} can't run here: this is ${session}, and those can't read or change Orrery's memory or settings. Run it in your own terminal or the TUI.`;
/** What that refusal adds when a tool's marker found the session: where the person reads more. */
const TOOL_MARKER_NOTE = ` If this is your own terminal (a tmux server first started from a coding tool's shell keeps its markers), see "Leftover markers" in the docs.`;

/**
 * A fake Linux for the real toolSession: 60 (this command) ← 50 (bash) ← 20 (foot) ← 10 (systemd --user) ← 1, the
 * user's terminal; `tool` puts a process at 40, between the shell and the terminal.
 */
function tree(tool?: { readonly comm: string; readonly argv?: readonly string[] }): SessionDeps {
	const rows: Record<number, { readonly ppid: number; readonly comm: string; readonly argv?: readonly string[] }> = {
		10: { ppid: 1, comm: "systemd", argv: ["/usr/lib/systemd/systemd", "--user"] },
		20: { ppid: 10, comm: "foot" },
		50: { ppid: tool === undefined ? 20 : 40, comm: "bash" },
		60: { ppid: 50, comm: "orrery", argv: ["orrery"] },
	};
	if (tool !== undefined) rows[40] = { ppid: 20, ...tool };
	return {
		platform: "linux",
		from: 60,
		proc: (pid) => {
			const row = rows[pid];
			return row === undefined ? undefined : `${pid} (${row.comm}) S ${row.ppid} ${Array(17).fill("0").join(" ")} 100 4096 0\n`;
		},
		cmdline: (pid) => {
			const row = rows[pid];
			return row === undefined ? undefined : (row.argv ?? [row.comm]);
		},
	};
}

describe("a coding tool's session that is no agent's (spec 2026-10-19-no-agent-sessions §1, §2, §4)", () => {
	it("tool session refuses browse/import/agent/run/restore with the exact copy, and every command but help, the version, status and usage", () => {
		const t = scratch();
		const real = realHome(t);
		const deps: GateDeps = { realHome: real.home, toolSession: finds(CLAUDE).toolSession };
		const env = { HOME: real.home };
		const cases: [readonly string[], Record<string, string | boolean>, string][] = [
			[["browse", "Atlas"], {}, "orrery browse"],
			[["browse", "."], { open: true }, "orrery browse"],
			[["import", "Atlas"], { "dry-run": true }, "orrery import"],
			[["import", "Atlas"], { commit: "x.jsonl" }, "orrery import"],
			[["agent", "set", "Atlas"], { reads: "all" }, "orrery agent"],
			[["agent", "Atlas"], {}, "orrery agent"],
			[["run", "Atlas"], {}, "orrery run"],
			[["restore", "Atlas"], { from: "2026-01-01" }, "orrery restore"],
			// No agent to retarget, and it reads nobody.
			[["compactor", "Atlas"], {}, "orrery compactor"],
			[["compact", "Atlas"], {}, "orrery compact"],
			[["backup"], {}, "orrery backup"],
			[["login", "openai"], {}, "orrery login"],
			[["logout", "openai"], {}, "orrery logout"],
			[["logins"], {}, "orrery logins"],
			[["trust-host", "box"], {}, "orrery trust-host"],
			[["remote", "key", "home"], {}, "orrery remote"],
			[["claude-setup", "."], {}, "orrery claude-setup"],
			[["tools"], {}, "orrery tools"],
			[["setup"], {}, "orrery setup"],
			[["install"], { from: "/x" }, "orrery install"],
			[["update"], {}, "orrery update"],
			[["uninstall"], {}, "orrery uninstall"],
			[[], {}, "orrery's TUI"],
		];
		for (const [argv, values, label] of cases) expect(refusal(() => gateCommand(argv[0], argv, values, env, deps)), argv.join(" ") || "TUI").toBe(noAgent(label));
		// Every command is here but those it may run and the plugins' own.
		const runs = ["help", "version", "status", "usage", "mcp", "claude-mod", "holder", "claude-hook", "codex-hook"];
		expect(HELP_COMMANDS.filter((command) => !runs.includes(command) && !cases.some(([argv]) => argv[0] === command))).toEqual([]);
		// Each tool by its name, with its article; an id with no name, by the id.
		const by = (tool: string) => refusal(() => gateCommand("browse", ["browse", "Atlas"], {}, env, { ...deps, toolSession: finds({ tool, via: "ancestry", pid: 7 }).toolSession }));
		expect(by("codex")).toBe(noAgent("orrery browse", "a Codex session that is no agent's (process 7)"));
		expect(by("opencode")).toBe(noAgent("orrery browse", "an OpenCode session that is no agent's (process 7)"));
		expect(by("omp")).toBe(noAgent("orrery browse", "an OMP session that is no agent's (process 7)"));
		expect(by("pi")).toBe(noAgent("orrery browse", "a pi session that is no agent's (process 7)"));
		expect(by("zed")).toBe(noAgent("orrery browse", "a zed session that is no agent's (process 7)"));
	});

	it("tool session allows help, version, status, usage: status and usage get the session, to show no agent", () => {
		const t = scratch();
		const real = realHome(t);
		const fake = finds(CLAUDE);
		const deps: GateDeps = { realHome: real.home, toolSession: fake.toolSession };
		const env = { HOME: real.home };
		for (const command of ["help", "version"]) expect(gateCommand(command, [command], {}, env, deps), command).toEqual({});
		expect(fake.asked).toEqual([]);
		for (const argv of [["status"], ["status", "Atlas"], ["status", "."], ["usage"], ["usage", "Birch"]]) {
			expect(decided(gateCommand(argv[0], argv, {}, env, deps)), argv.join(" ")).toEqual({ tool: CLAUDE });
			expect(decided(gateCommand(argv[0], argv, { json: true }, env, deps)), argv.join(" ")).toEqual({ tool: CLAUDE });
		}
		// The lookup was asked with the gate's own view of the processes, and the environment it was given.
		expect(fake.asked.at(-1)?.[0]).toEqual(env);
	});

	it("marker refusal names the variable and points to the docs; a Codex id that a record names is no marker", () => {
		const t = scratch();
		const real = realHome(t);
		// The user's terminal, no tool above it, in a tmux server first started from a Claude Code shell: CLAUDECODE.
		const deps: GateDeps = { realHome: real.home, sessions: tree() };
		const env = { HOME: real.home, CLAUDECODE: "1" };
		expect(refusal(() => gateCommand("browse", ["browse", "Atlas"], {}, env, deps))).toBe(`${noAgent("orrery browse", "a Claude Code session that is no agent's (found CLAUDECODE)")}${TOOL_MARKER_NOTE}`);
		expect(refusal(() => gateCommand(undefined, [], {}, env, deps))).toBe(`${noAgent("orrery's TUI", "a Claude Code session that is no agent's (found CLAUDECODE)")}${TOOL_MARKER_NOTE}`);
		expect(decided(gateCommand("status", ["status"], {}, env, deps))).toEqual({ tool: { tool: "claude", via: "marker", variable: "CLAUDECODE" } });
		// Found by ancestry, the tool's process is named, with no note.
		const claude: GateDeps = { realHome: real.home, sessions: tree({ comm: "claude", argv: ["claude", "--resume"] }) };
		expect(refusal(() => gateCommand("browse", ["browse", "Atlas"], {}, { HOME: real.home }, claude))).toBe(noAgent("orrery browse", "a Claude Code session that is no agent's (process 40)"));
		// An agent's Codex session recorded in the real data folder, while the config given names a scratch one: its own
		// Codex id is no marker; any other Codex id is.
		const host = sleeper();
		record(real.orrery, { agent: "Atlas", tool: "codex", pid: host, codexSession: "thread-1" });
		const codex = (id: string) => () => gateCommand("browse", ["browse", "Atlas"], { config: t.configPath }, { HOME: real.home, CODEX_THREAD_ID: id }, deps);
		expect(codex("thread-1")()).toSatisfy(runsAsAlways);
		expect(refusal(codex("thread-2"))).toBe(`${noAgent("orrery browse", "a Codex session that is no agent's (found CODEX_THREAD_ID)")}${TOOL_MARKER_NOTE}`);
		// The ids are read only when a Codex id is set.
		const fake = finds(undefined);
		gateCommand("status", ["status"], { config: t.configPath }, { HOME: real.home, CODEX_SESSION_ID: "thread-1" }, { ...deps, toolSession: fake.toolSession });
		gateCommand("status", ["status"], { config: t.configPath }, { HOME: real.home }, { ...deps, toolSession: fake.toolSession });
		expect(fake.asked.map(([, asked]) => asked?.recordedCodexIds)).toEqual([new Set(["thread-1"]), undefined]);
	});

	it("plumbing: the hooks never come here, and mcp and claude-mod serve only what their host's own launch names", () => {
		const t = scratch();
		const real = realHome(t);
		const atlas = join(t.root, "agent-Atlas");
		const elsewhere = join(t.root, "elsewhere");
		mkdirSync(elsewhere);
		const fake = finds(CLAUDE);
		for (const command of ["claude-hook", "codex-hook"]) {
			expect(gateCommand(command, [command, "pre-tool-use"], {}, { HOME: real.home }, { realHome: real.home, toolSession: fake.toolSession }), command).toEqual({});
		}
		expect(fake.asked).toEqual([]);
		/** A coding tool working in `cwd`, started with `launch`, whose MCP server or mod view the command is (its parent). */
		const under = (cwd: string, launch: NodeJS.ProcessEnv = {}) => {
			const pid = sleeper({ cwd, env: launch });
			return { pid, deps: { realHome: real.home, toolSession: finds({ tool: "claude", via: "ancestry", pid }).toolSession, parent: pid } satisfies GateDeps };
		};
		const env = { HOME: real.home, CLAUDECODE: "1" };
		const mcp = (deps: GateDeps, cwd: string, more: NodeJS.ProcessEnv = {}) => gateCommand("mcp", ["mcp"], {}, { ...env, ...more }, { ...deps, cwd });
		const mod = (deps: GateDeps, values: Record<string, string>, more: NodeJS.ProcessEnv = {}) => () => gateCommand("claude-mod", ["claude-mod", "view"], values, { ...env, ...more }, { ...deps, cwd: elsewhere });
		const serves = (agent: string | null) => (gated: Gated) => gated.hostAgent === agent && gated.config?.file === real.configPath;
		// A Claude Code started in Atlas's folder starts its MCP server before its session is recorded: it serves Atlas.
		const inAtlas = under(atlas);
		expect(mcp(inAtlas.deps, atlas)).toSatisfy(serves("Atlas"));
		expect(mod(inAtlas.deps, { cwd: atlas })()).toSatisfy(serves("Atlas"));
		// A plain Claude Code elsewhere: its own MCP server and mod view serve no agent, quietly.
		const plain = under(elsewhere);
		expect(mcp(plain.deps, elsewhere)).toSatisfy(serves(null));
		expect(mod(plain.deps, { cwd: elsewhere })()).toSatisfy(serves(null));
		// Its shell runs `cd <Atlas's folder> && exec orrery mcp`: its parent is the tool, whose folder is no agent's.
		expect(mcp(plain.deps, atlas)).toSatisfy(serves(null));
		expect(mcp(plain.deps, elsewhere, { CLAUDE_PROJECT_DIR: atlas })).toSatisfy(serves(null));
		const differ = (pid: number) => `orrery claude-mod serves no agent here: its folder is Atlas's, and the folder of this Claude Code (process ${pid}) is no agent's.`;
		expect(refusal(mod(plain.deps, { cwd: atlas }))).toBe(differ(plain.pid));
		// Without exec its parent is the shell, not the tool.
		const shell = { ...plain.deps, parent: inAtlas.pid };
		expect(mcp(shell, atlas)).toSatisfy(serves(null));
		expect(refusal(mod(shell, { cwd: atlas }))).toBe("orrery claude-mod serves no agent here: it was not started by this Claude Code session's own process.");
		// A tool `orrery agent Atlas` started elsewhere: its ORRERY_AGENT and token are its own launch's, so they count.
		const token = newToken();
		const launch = { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token };
		const launched = under(elsewhere, launch);
		expect(mcp(launched.deps, elsewhere, launch)).toSatisfy(serves("Atlas"));
		expect(mod(launched.deps, { cwd: elsewhere, agent: "Atlas", "agent-token": token })()).toSatisfy(serves("Atlas"));
		// Given by hand to a command under a tool started without them, or with another token: none.
		const forged = "orrery claude-mod serves no agent here: ORRERY_AGENT is not the one this Claude Code (process %) was started with.";
		expect(mcp(plain.deps, elsewhere, launch)).toSatisfy(serves(null));
		expect(mcp(launched.deps, elsewhere, { ...launch, ORRERY_AGENT_TOKEN: newToken() })).toSatisfy(serves(null));
		expect(refusal(mod(plain.deps, { cwd: elsewhere, agent: "Atlas", "agent-token": token }))).toBe(forged.replace("%", String(plain.pid)));
		// A host whose launch can't be read: none, and the mod says that, not that the launch differs.
		const unread: GateDeps = { ...launched.deps, hostEnv: () => undefined };
		expect(mcp(unread, elsewhere, launch)).toSatisfy(serves(null));
		expect(refusal(mod(unread, { cwd: elsewhere, agent: "Atlas", "agent-token": token }))).toBe(
			`orrery claude-mod serves no agent here: the environment this Claude Code (process ${launched.pid}) was started with can't be read.`,
		);
		// Its own folder (and --cwd) no agent's: none, quietly, and the host's folder is never asked; its own folder an
		// agent's: asked.
		const asked: number[] = [];
		const counted: GateDeps = { ...inAtlas.deps, hostCwd: (pid) => (asked.push(pid), atlas) };
		expect(mcp(counted, elsewhere)).toSatisfy(serves(null));
		expect(mod(counted, { cwd: elsewhere })()).toSatisfy(serves(null));
		expect(asked).toEqual([]);
		expect(mcp(counted, atlas)).toSatisfy(serves("Atlas"));
		expect(asked).toEqual([inAtlas.pid]);
		// A config of the caller's own, naming the agents' folders and data as it likes: none.
		const crafted = join(t.root, "crafted.toml");
		writeFileSync(crafted, `data_dir = ${JSON.stringify(real.orrery)}\n${agents(t.root)}`);
		expect(gateCommand("mcp", ["mcp"], { config: crafted }, env, { ...inAtlas.deps, cwd: atlas })).toMatchObject({ hostAgent: null });
		expect(refusal(() => gateCommand("claude-mod", ["claude-mod", "view"], { config: crafted, cwd: atlas }, env, { ...inAtlas.deps, cwd: atlas }))).toBe(
			"orrery claude-mod serves no agent here: its config is not your Orrery home's.",
		);
		// The MCP server lists no tools then; why goes to stderr, one line, so a missing-tools case can be told apart.
		expect(mcp(plain.deps, atlas).notice).toBe(`orrery: mcp serves no agent here: its folder is Atlas's, and the folder of this Claude Code (process ${plain.pid}) is no agent's.`);
		expect(mcp(shell, atlas).notice).toBe("orrery: mcp serves no agent here: it was not started by this Claude Code session's own process.");
		expect(mcp(plain.deps, elsewhere, launch).notice).toBe(`orrery: mcp serves no agent here: ORRERY_AGENT is not the one this Claude Code (process ${plain.pid}) was started with.`);
		expect(mcp(unread, elsewhere, launch).notice).toBe(`orrery: mcp serves no agent here: the environment this Claude Code (process ${launched.pid}) was started with can't be read.`);
		expect(gateCommand("mcp", ["mcp"], { config: crafted }, env, { ...inAtlas.deps, cwd: atlas }).notice).toBe("orrery: mcp serves no agent here: its config is not your Orrery home's.");
		// None quietly where its own folder is no agent's, and nothing to say where it serves one.
		expect(mcp(plain.deps, elsewhere)).not.toHaveProperty("notice");
		expect(mcp(inAtlas.deps, atlas)).not.toHaveProperty("notice");
		expect(mcp(launched.deps, elsewhere, launch)).not.toHaveProperty("notice");
	});

	it("a holder in a coding tool's session that is no agent's runs only for a session shown to be its agent's and its own", async () => {
		const t = scratch();
		const real = realHome(t);
		const atlasDir = loadConfig(real.configPath).agents.get("Atlas")!.dir;
		const elsewhere = join(t.root, "elsewhere");
		mkdirSync(elsewhere);
		/** The holder for Atlas whose --claude-pid is `host`, run with `env`, under the plain tool that is this test's parent. */
		const holder = (host: number, env: NodeJS.ProcessEnv = {}, more: GateDeps = {}) => () =>
			gateCommand("holder", ["holder", "Atlas"], { session: "s", "claude-pid": String(host) }, { HOME: real.home, ...env }, { realHome: real.home, toolSession: finds({ tool: "claude", via: "ancestry", pid: process.ppid }).toolSession, ...more });
		const refused = noAgent("orrery holder", `a Claude Code session that is no agent's (process ${process.ppid})`);
		// Run by hand from the plain tool's own shell: the tool is its ancestor, which alone vouches for nothing.
		expect(refusal(holder(process.ppid))).toBe(refused);
		// Naming another session's host (pids are public): its record names Atlas, but it is no ancestor of this holder.
		const other = sleeper();
		record(real.orrery, { agent: "Atlas", tool: "claude-code", pid: other });
		expect(refusal(holder(other))).toBe(refused);
		// Naming a host `orrery agent Atlas` started: refused without its token, with another, and with its own token copied
		// from its environment (anyone of the user's may read it), from a shell that is not under it.
		const token = newToken();
		const launch = { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token };
		const launched = await host(elsewhere, launch);
		expect(claimToken(atlasDir, token, launched.pid)).toBe(true);
		const noSession: GateDeps = { insideSession: () => undefined };
		expect(refusal(holder(launched.pid, {}, noSession))).toBe(refused);
		expect(refusal(holder(launched.pid, { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: newToken() }, noSession))).toBe(refused);
		expect(refusal(holder(launched.pid, launch, noSession))).toBe(refused);
		// Under it (the hook it runs started the holder), with its token: that session's own.
		const underIt: GateDeps = { ...noSession, sessions: { from: launched.under } };
		expect(holder(launched.pid, launch, underIt)()).toSatisfy(runsAsAlways);
		expect(refusal(holder(launched.pid, { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: newToken() }, underIt))).toBe(refused);
		// A record of an ancestor naming Atlas (the hook that started the holder still runs): it runs.
		forgetSession(real.orrery, other);
		record(real.orrery, { agent: "Atlas", tool: "claude-code", pid: process.ppid });
		expect(holder(process.ppid, {}, noSession)()).toSatisfy(runsAsAlways);
		// …but not for another agent, nor with a config of the caller's own naming the real data.
		const lone: GateDeps = { realHome: real.home, toolSession: finds(CLAUDE).toolSession, insideSession: () => undefined };
		expect(refusal(() => gateCommand("holder", ["holder", "Birch"], { session: "s", "claude-pid": String(process.ppid) }, { HOME: real.home }, lone))).toBe(noAgent("orrery holder"));
		const crafted = join(t.root, "crafted.toml");
		writeFileSync(crafted, `data_dir = ${JSON.stringify(real.orrery)}\n${agents(t.root)}`);
		expect(refusal(() => gateCommand("holder", ["holder", "Atlas"], { config: crafted, session: "s", "claude-pid": String(process.ppid) }, { HOME: real.home }, lone))).toBe(noAgent("orrery holder"));
	});

	it("the Claude Code holder of an agent opened with `orrery agent`, in its folder or elsewhere, runs", async () => {
		const t = scratch();
		const real = realHome(t);
		const atlasDir = loadConfig(real.configPath).agents.get("Atlas")!.dir;
		for (const cwd of [join(t.root, "agent-Atlas"), t.root]) {
			// Its Claude Code: launched with ORRERY_AGENT and a fresh token, which its first consumer claimed for it, and
			// recorded as Atlas's host when that decided. The holder, started by SessionStart's hook (`under` it, still
			// running), inherits both.
			const token = newToken();
			const launch = { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: token };
			const claude = await host(cwd, launch);
			expect(claimToken(atlasDir, token, claude.pid)).toBe(true);
			record(real.orrery, { agent: "Atlas", tool: "claude-code", pid: claude.pid });
			const holder = (more: GateDeps = {}) =>
				gateCommand("holder", ["holder", "Atlas"], { session: "s", "claude-pid": String(claude.pid) }, { HOME: real.home, CLAUDE_PID: String(claude.pid), ...launch }, {
					realHome: real.home,
					toolSession: finds(CLAUDE).toolSession,
					sessions: { from: claude.under },
					...more,
				});
			expect(holder().tool, cwd).toBeUndefined();
			expect(holder().inside, cwd).toMatchObject({ agent: "Atlas", via: "ancestry" });
			// Were its session not found, the gate for sessions that are no agent's lets it run too: by its record, or, with
			// none, by its launch.
			expect(holder({ insideSession: () => undefined }), cwd).toSatisfy(runsAsAlways);
			forgetSession(real.orrery, claude.pid);
			expect(holder({ insideSession: () => undefined }), cwd).toSatisfy(runsAsAlways);
		}
	});

	it("a config read in a coding tool's session is handed over to be written back only as it was read; in the user's terminal as 0.9.0", () => {
		const t = scratch();
		const real = realHome(t);
		const gated = (found: ToolSession | undefined, argv: readonly string[]) => gateCommand(argv[0], argv, { config: t.configPath }, t.env, { realHome: real.home, toolSession: finds(found).toolSession, cwd: t.root });
		for (const argv of [["agent", "set", "Atlas"], ["remote", "key", "home"], ["setup"], []]) {
			expect(gated(CLAUDE, argv).configFile, argv.join(" ") || "TUI").toMatchObject({ path: t.configPath, checked: true });
			expect(gated(undefined, argv).configFile, argv.join(" ") || "TUI").toMatchObject({ path: t.configPath, checked: false });
		}
		// Status in such a session, with the real data: checked too.
		expect(gateCommand("status", ["status"], { config: real.configPath }, { HOME: real.home }, { realHome: real.home, toolSession: finds(CLAUDE).toolSession }).configFile).toMatchObject({ checked: true });
	});

	it("scratch home is never judged: a command touching nothing of the real data runs, from a coding tool's session", () => {
		const t = scratch();
		const real = realHome(t);
		const fake = finds(CLAUDE);
		const deps: GateDeps = { realHome: real.home, toolSession: fake.toolSession, cwd: t.root };
		const cases: [readonly string[], Record<string, string | boolean>][] = [
			[["browse", "Atlas"], {}],
			[["browse", "Atlas"], { out: join(t.root, "x.html") }],
			[["import", "Atlas"], { "dry-run": true }],
			[["agent", "set", "Atlas"], { reads: "all" }],
			[["agent", "Atlas"], {}],
			[["run", "Atlas"], {}],
			[["restore", "Atlas"], { from: join(t.root, "data", "backups", "2026-01-01") }],
			[["setup"], {}],
			[["status"], {}],
			[[], {}],
		];
		for (const [argv, values] of cases) expect(gateCommand(argv[0], argv, { config: t.configPath, ...values }, t.env, deps), argv.join(" ") || "TUI").toSatisfy(runsAsAlways);
		// ORRERY_HOME and HOME scratch, no config named: the same.
		const home = { HOME: t.home, ORRERY_HOME: join(t.root, "scratch-home") };
		expect(gateCommand("browse", ["browse", "Atlas"], {}, home, deps)).toSatisfy(runsAsAlways);
		// The tool is found each time; the real data, looked up then, is touched by none.
		expect(fake.asked).toHaveLength(cases.length + 1);
	});

	it("fake HOME still protects real home: the real data is judged by the password database's home, never $HOME", () => {
		const t = scratch();
		const real = realHome(t);
		const deps: GateDeps = { realHome: real.home, toolSession: finds(CLAUDE).toolSession, cwd: t.root };
		// HOME=/tmp/x: a scratch folder of its own.
		const elsewhere = { HOME: join(t.root, "x") };
		const browse = noAgent("orrery browse");
		const gated = (values: Record<string, string | boolean>, env: NodeJS.ProcessEnv = elsewhere) => () => gateCommand("browse", ["browse", "Atlas"], values, env, deps);
		expect(refusal(gated({ config: real.configPath }))).toBe(browse);
		expect(refusal(gated({}, { ...elsewhere, ORRERY_CONFIG: real.configPath }))).toBe(browse);
		expect(refusal(gated({}, { ...elsewhere, ORRERY_HOME: real.orrery }))).toBe(browse);
		expect(decided(gateCommand("status", ["status"], { config: real.configPath }, elsewhere, deps))).toEqual({ tool: CLAUDE });
		// From a scratch config: --out into the real home (a file not there yet), and a link to nothing that points there.
		expect(refusal(gated({ config: t.configPath, out: join(real.orrery, "agents", "Atlas", "not-yet", "memory.html") }))).toBe(browse);
		const dangling = join(t.root, "page.html");
		symlinkSync(join(real.orrery, "not-yet", "memory.html"), dangling);
		expect(refusal(gated({ config: t.configPath, out: dangling }))).toBe(browse);
		// browse without --out writes where it runs.
		expect(refusal(() => gateCommand("browse", ["browse", "Atlas"], { config: t.configPath }, elsewhere, { ...deps, cwd: real.orrery }))).toBe(browse);
		// A crafted config whose data folder is a link to the real one.
		const linked = join(t.root, "linked");
		symlinkSync(real.orrery, linked);
		const crafted = join(t.root, "crafted.toml");
		writeFileSync(crafted, `data_dir = ${JSON.stringify(linked)}\n${agents(t.root)}`);
		expect(refusal(gated({ config: crafted }))).toBe(browse);
		// The real home's config keeps its data apart (data_dir): that folder is real data too.
		const apart = join(t.root, "apart");
		mkdirSync(apart);
		writeFileSync(real.configPath, `data_dir = ${JSON.stringify(apart)}\n${agents(t.root)}`);
		const naming = join(t.root, "naming-apart.toml");
		writeFileSync(naming, `data_dir = ${JSON.stringify(apart)}\n${agents(t.root)}`);
		expect(refusal(gated({ config: naming }))).toBe(browse);
		// The scratch config alone touches none of it.
		expect(gated({ config: t.configPath })()).toSatisfy(runsAsAlways);
		// Kept apart as ~/…: ~ is the real home, whatever HOME says (this test run's HOME is a scratch folder of its own).
		const tilde = join(real.home, "apart-home");
		mkdirSync(tilde);
		writeFileSync(real.configPath, `data_dir = "~/apart-home"\n${agents(t.root)}`);
		const namingTilde = join(t.root, "naming-tilde.toml");
		writeFileSync(namingTilde, `data_dir = ${JSON.stringify(tilde)}\n${agents(t.root)}`);
		expect(refusal(gated({ config: namingTilde }))).toBe(browse);
		// …and read raw: a setting Orrery would reject elsewhere in the config hides none of it.
		writeFileSync(real.configPath, `data_dir = "~/apart-home"\nunknown_setting = [1, "two"]\n[agents.bad]\nmodel = 7\n`);
		expect(refusal(gated({ config: namingTilde }))).toBe(browse);
		// The logins the real config keeps outside its data folder: its credentials, and an SSH host's key.
		const logins = join(t.root, "logins");
		mkdirSync(logins);
		writeFileSync(join(logins, "credentials.json"), "{}\n");
		writeFileSync(join(logins, "id_box"), "key\n");
		writeFileSync(real.configPath, `credentials = ${JSON.stringify(join(logins, "credentials.json"))}\n[hosts.box]\nhost = "box"\nidentity_file = ${JSON.stringify(join(logins, "id_box"))}\n${agents(t.root)}`);
		for (const [key, file] of [["credentials", "credentials.json"], ["hosts.box.identity_file", "id_box"]]) {
			const scratchConfig = join(t.root, `naming-${file}.toml`);
			const line = key === "credentials" ? `credentials = ${JSON.stringify(join(logins, file))}\n` : `[hosts.box]\nhost = "box"\nidentity_file = ${JSON.stringify(join(logins, file))}\n`;
			writeFileSync(scratchConfig, `data_dir = ${JSON.stringify(join(t.root, "scratch-data"))}\n${line}${agents(t.root)}`);
			expect(refusal(() => gateCommand("logins", ["logins"], { config: scratchConfig }, elsewhere, deps)), key).toBe(noAgent("orrery logins"));
		}
		// A scratch agent's memory file that is a link to the real one: judged where it leads.
		const realAtlas = join(real.orrery, "agents", "Atlas");
		mkdirSync(realAtlas, { recursive: true });
		writeFileSync(join(realAtlas, "memory.sqlite"), "");
		const scratchAtlas = join(t.root, "scratch-data", "agents", "Atlas");
		mkdirSync(scratchAtlas, { recursive: true });
		const memoryLink = join(t.root, "memory-link.toml");
		writeFileSync(memoryLink, `data_dir = ${JSON.stringify(join(t.root, "scratch-data"))}\n${agents(t.root)}`);
		expect(gated({ config: memoryLink })()).toSatisfy(runsAsAlways);
		symlinkSync(join(realAtlas, "memory.sqlite"), join(scratchAtlas, "memory.sqlite"));
		expect(refusal(gated({ config: memoryLink }))).toBe(browse);
		rmSync(join(scratchAtlas, "memory.sqlite"));
		// So is any other file there, and the hooks' spool beside it.
		mkdirSync(join(scratchAtlas, "claude"));
		symlinkSync(join(realAtlas, "memory.sqlite"), join(scratchAtlas, "claude", "spool.jsonl"));
		expect(refusal(gated({ config: memoryLink }))).toBe(browse);
	});

	it("an agent session still wins over a tool ancestor", () => {
		const t = scratch();
		const real = realHome(t);
		const fake = finds(CLAUDE);
		const deps: GateDeps = { realHome: real.home, toolSession: fake.toolSession };
		// The test's parent stands for Atlas's Claude Code, recorded in the real data folder.
		record(real.orrery, { agent: "Atlas", tool: "claude-code", pid: process.ppid });
		const env = { HOME: real.home, CLAUDECODE: "1" };
		expect(gateCommand("status", ["status"], {}, env, deps)).toMatchObject({ inside: { agent: "Atlas", via: "ancestry" } });
		expect(gateCommand("status", ["status"], {}, env, deps).tool).toBeUndefined();
		expect(refusal(() => gateCommand("browse", ["browse", "Cedar"], {}, env, deps))).toMatch(/^Atlas may not read Cedar\./);
		expect(refusal(() => gateCommand("setup", ["setup"], {}, env, deps))).toBe(changes("orrery setup"));
		expect(fake.asked).toEqual([]);
	});

	it("the user's terminal is unchanged: no tool above it and no marker, every command runs", () => {
		const t = scratch();
		const real = realHome(t);
		// The real home is never even looked up: no tool, nothing more to read (on macOS, no `id -P`).
		let lookedUp = 0;
		const deps: GateDeps = {
			sessions: tree(),
			get realHome() {
				lookedUp++;
				return real.home;
			},
		};
		const env = { HOME: real.home };
		for (const command of [...HELP_COMMANDS, undefined]) {
			const argv = command === undefined ? [] : [command];
			expect(gateCommand(command, argv, {}, env, deps), command).toSatisfy(runsAsAlways);
		}
		// Variables no tool sets as its own are no markers: AGENT, CI, CODEX_HOME, CLAUDE_CODE_SESSION_ID.
		expect(gateCommand("browse", ["browse", "Atlas"], {}, { ...env, AGENT: "1", CI: "1", CODEX_HOME: "/x", CLAUDE_CODE_SESSION_ID: "s" }, deps)).toSatisfy(runsAsAlways);
		expect(lookedUp).toBe(0);
	});

	// The server path's data counts too, when there is one: none on a machine that runs these tests.
	it.skipIf(existsSync("/etc/orrery/config.toml"))("realOrreryData: the home's Orrery folder and the data folder its config keeps apart, links resolved, missing ones left out", () => {
		const t = scratch();
		const home = join(t.root, "real");
		expect(realOrreryData({ home })).toEqual([]);
		const orrery = join(home, ".orrery");
		mkdirSync(orrery, { recursive: true });
		expect(realOrreryData({ home })).toEqual([realpathSync(orrery)]);
		// Its config keeps its data in the home, or apart (data_dir), here through a link.
		const config = join(orrery, "config.toml");
		writeFileSync(config, agents(t.root));
		expect(realOrreryData({ home })).toEqual([realpathSync(orrery)]);
		const apart = join(t.root, "apart");
		mkdirSync(apart);
		symlinkSync(apart, join(t.root, "apart-link"));
		writeFileSync(config, `data_dir = ${JSON.stringify(join(t.root, "apart-link"))}\n${agents(t.root)}`);
		expect(realOrreryData({ home })).toEqual([realpathSync(orrery), realpathSync(apart)]);
		// Relative to the config's folder, as Orrery reads it.
		writeFileSync(config, `data_dir = "data"\n${agents(t.root)}`);
		mkdirSync(join(orrery, "data"));
		expect(realOrreryData({ home })).toEqual([realpathSync(orrery), realpathSync(join(orrery, "data"))]);
		// A data folder not there, or a config that can't be read: the home alone.
		writeFileSync(config, `data_dir = ${JSON.stringify(join(t.root, "missing"))}\n`);
		expect(realOrreryData({ home })).toEqual([realpathSync(orrery)]);
		writeFileSync(config, "not toml [");
		expect(realOrreryData({ home })).toEqual([realpathSync(orrery)]);
		// A home given through a link is the folder it leads to.
		symlinkSync(home, join(t.root, "home-link"));
		expect(realOrreryData({ home: join(t.root, "home-link") })).toEqual([realpathSync(orrery)]);
		expect(dirname(realOrreryData({ home })[0] as string)).toBe(realpathSync(home));
		// ~ is the real home, never $HOME; the logins it keeps outside the data folder count, as Orrery reads them (relative:
		// from the data folder).
		mkdirSync(join(home, "kept"));
		mkdirSync(join(home, "keys"));
		writeFileSync(join(home, "keys", "credentials.json"), "{}\n");
		writeFileSync(join(home, "keys", "id"), "key\n");
		writeFileSync(join(home, "kept", "known"), "\n");
		writeFileSync(config, `data_dir = "~/kept"\ncredentials = "~/keys/credentials.json"\n[hosts.box]\nhost = "box"\nidentity_file = "~/keys/id"\nknown_hosts = "known"\n`);
		const real = (path: string) => realpathSync(join(home, path));
		expect(realOrreryData({ home })).toEqual([realpathSync(orrery), real("kept"), real("keys/credentials.json"), real("keys/id"), real("kept/known")]);
	});

	it("with no record of this user in the password database every folder counts (fail closed)", () => {
		expect(realOrreryData({ passwordHome: () => undefined })).toEqual(["/"]);
		expect(within("/", "/tmp/anything")).toBe(true);
	});

	it("within: the same folder or inside it, as the file system names both; a sibling with the same start is not", () => {
		const t = scratch();
		const root = join(t.root, "real", ".orrery");
		mkdirSync(join(root, "agents"), { recursive: true });
		mkdirSync(join(t.root, "real", ".orrery-old"));
		expect(within(root, root)).toBe(true);
		expect(within(root, join(root, "agents", "Atlas", "not-yet"))).toBe(true);
		expect(within(root, join(t.root, "real", ".orrery-old"))).toBe(false);
		expect(within(root, join(t.root, "real"))).toBe(false);
		expect(within(root, `${root}-old/x`)).toBe(false);
		// A case-insensitive disk (macOS): the file system's own name decides, not the case the path was written in.
		const stored = new Map([["/Users", "/Users"], ["/Users/u", "/Users/u"], ["/Users/u/.orrery", "/Users/u/.orrery"], ["/Users/u/.orrery/agents", "/Users/u/.orrery/agents"]]);
		const caseless = (path: string) => {
			for (const [key, name] of stored) if (key.toLowerCase() === path.toLowerCase()) return name;
			throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
		};
		expect(within("/Users/u/.orrery", "/users/U/.ORRERY/Agents/new", caseless)).toBe(true);
		expect(within("/Users/u/.orrery", "/users/U/.ORRERY/Agents/new", (path) => path)).toBe(false);
	});

	it("a record in a folder that is no real data folder, naming the tool's own process, is no agent's session", () => {
		const t = scratch();
		const real = realHome(t);
		const atlas = join(real.orrery, "agents", "Atlas");
		mkdirSync(atlas, { recursive: true });
		// A scratch data folder with its own config, its Atlas linked to the real one, and a record naming the plain tool
		// (this test's parent) as Atlas's Claude Code.
		const forged = join(t.root, "forged");
		mkdirSync(join(forged, "agents"), { recursive: true });
		symlinkSync(atlas, join(forged, "agents", "Atlas"));
		const config = join(forged, "config.toml");
		writeFileSync(config, agents(t.root, '["*"]'));
		record(forged, { agent: "Atlas", tool: "claude-code", pid: process.ppid });
		const deps: GateDeps = { realHome: real.home, toolSession: finds(CLAUDE).toolSession, cwd: t.root };
		const elsewhere = { HOME: join(t.root, "x") };
		expect(refusal(() => gateCommand("browse", ["browse", "Atlas"], { config }, elsewhere, deps))).toBe(noAgent("orrery browse"));
		expect(decided(gateCommand("status", ["status"], { config }, elsewhere, deps))).toEqual({ tool: CLAUDE });
		// With nothing real touched it stays the session it says, under 0.9.0's rules (a developer's scratch home).
		rmSync(join(forged, "agents", "Atlas"));
		expect(gateCommand("browse", ["browse", "Atlas"], { config }, elsewhere, deps)).toMatchObject({ inside: { agent: "Atlas", dataDir: forged } });
		// A record in the real data folder is the session, a tool above it or not.
		record(real.orrery, { agent: "Atlas", tool: "claude-code", pid: process.ppid });
		expect(gateCommand("status", ["status"], {}, { HOME: real.home }, deps)).toMatchObject({ inside: { agent: "Atlas", dataDir: real.orrery } });
	});

	it("outside every session the gate hands over the config it read and judged, or why it couldn't, never to be read again", () => {
		const t = scratch();
		const gated = gateCommand("status", ["status"], { config: t.configPath }, t.env);
		expect(gated).toSatisfy(runsAsAlways);
		expect(gated.config?.file).toBe(t.configPath);
		expect([...(gated.config?.agents.keys() ?? [])]).toEqual(["Atlas", "Birch", "Cedar"]);
		const missing = gateCommand("status", ["status"], { config: join(t.root, "missing.toml") }, t.env);
		expect(missing.config).toBeUndefined();
		expect((missing.configError as NodeJS.ErrnoException).code).toBe("ENOENT");
	});
});
