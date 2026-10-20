import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import { type LaunchPlan, runTool } from "../../src/agent/launch.ts";
import { opensHere, plainNested } from "../../src/agent/plain-nested.ts";
import { forgetSession, type Inside, nestedNotice, recordSession, type SessionTool } from "../../src/agent/sessions.ts";
import { above, npmCodex, OPENCODE, plainDeps, realHomeOf, STARTS } from "./plain-support.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
const recorded: { dataDir: string; pid: number }[] = [];
afterEach(() => {
	for (const { dataDir, pid } of recorded.splice(0)) forgetSession(dataDir, pid);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Atlas (folder ws) in a scratch Orrery home, its data folder `data`; `extra` goes at the config's top. */
function scene(extra = "") {
	const dir = tempDir("orrery-plain-nested-");
	dirs.push(dir);
	mkdirSync(join(dir, "ws"));
	const toml = `${extra}data_dir = ${JSON.stringify(join(dir, "data"))}\n[agents.Atlas]\nfolder = ${JSON.stringify(join(dir, "ws"))}\ntool = "pi"\ncompactor_model = "faux-compactor/faux-1"\n`;
	const config = parseConfig(toml, dir);
	return { dir, config, ws: join(dir, "ws") };
}

/** The tool asking: this process, as `tool`. */
const host = (tool: SessionTool) => ({ pid: process.pid, tool });

describe("plainNested: a tool session started from a coding tool's session that is no agent's (spec 2026-10-19-no-agent-sessions §4c)", () => {
	it("under a plain Claude Code's shell (claude → bash → this tool): no agent's, naming the tool, by its process", () => {
		const { config } = scene();
		for (const tool of ["pi", "omp", "claude-code", "codex", "opencode", "run"] as const) {
			expect(plainNested(config, {}, host(tool), plainDeps(process.pid, STARTS.claude, config.dataDir)), tool).toEqual({ agent: undefined, tool: undefined, via: "ancestry", dataDir: config.dataDir, plain: "claude" });
		}
		// Codex and pi shells too, the same tool's included: a Codex its shell exec'd has the outer Codex for its parent.
		expect(plainNested(config, {}, host("codex"), plainDeps(process.pid, STARTS.codex, config.dataDir))).toMatchObject({ plain: "codex", via: "ancestry" });
		expect(plainNested(config, {}, host("pi"), plainDeps(process.pid, STARTS.pi, config.dataDir))).toMatchObject({ plain: "pi" });
		expect(plainNested(config, {}, host("claude-code"), plainDeps(process.pid, STARTS.claude, config.dataDir))).toMatchObject({ plain: "claude" });
	});

	it("only where the config touches the user's real Orrery data: a scratch home is never judged", () => {
		const { config, dir } = scene();
		// The real home's Orrery home is elsewhere: this scratch one is no real data.
		const elsewhere = realHomeOf(join(dir, "real-data"));
		expect(plainNested(config, {}, host("pi"), { sessions: above(process.pid, STARTS.claude), realHome: elsewhere })).toBeUndefined();
		expect(plainNested(config, { CLAUDECODE: "1" }, host("pi"), { sessions: above(process.pid, STARTS.terminal), realHome: elsewhere })).toBeUndefined();
	});

	it("a scratch config that names real data (an SSH host's key, the logins) is judged as real", () => {
		const real = tempDir("orrery-plain-real-");
		dirs.push(real);
		const home = realHomeOf(join(real, "data"));
		writeFileSync(join(real, "data", "id_box"), "");
		const { config } = scene(`[hosts.box]\nhost = "box"\nidentity_file = ${JSON.stringify(join(real, "data", "id_box"))}\n`);
		expect(plainNested(config, {}, host("pi"), { sessions: above(process.pid, STARTS.claude), realHome: home })).toMatchObject({ plain: "claude" });
		const logins = scene(`credentials = ${JSON.stringify(join(real, "data", "credentials.json"))}\n`).config;
		expect(plainNested(logins, {}, host("pi"), { sessions: above(process.pid, STARTS.claude), realHome: home })).toMatchObject({ plain: "claude" });
	});

	it("by another tool's marker where the ancestry is cut (a detached process, a sandbox): it names the variable's tool", () => {
		const { config } = scene();
		const deps = plainDeps(process.pid, STARTS.terminal, config.dataDir);
		expect(plainNested(config, { CLAUDECODE: "1" }, host("pi"), deps)).toEqual({ agent: undefined, tool: undefined, via: "marker", dataDir: config.dataDir, plain: "claude", variable: "CLAUDECODE" });
		expect(plainNested(config, { OPENCODE: "1" }, host("claude-code"), deps)).toMatchObject({ via: "marker", plain: "opencode", variable: "OPENCODE" });
		expect(plainNested(config, { PI_CODING_AGENT: "true" }, host("omp"), deps)).toMatchObject({ via: "marker", plain: "pi", variable: "PI_CODING_AGENT" });
		// Found by a process: no variable.
		expect(plainNested(config, { CLAUDECODE: "1" }, host("pi"), plainDeps(process.pid, STARTS.claude, config.dataDir))).not.toHaveProperty("variable");
		// orrery run is no coding tool: every tool's marker counts.
		expect(plainNested(config, { PI_CODING_AGENT: "true" }, host("run"), deps)).toMatchObject({ via: "marker", plain: "pi" });
	});

	it("its walk whole: its own tool's markers it set itself, or that the desktop app gave it, are no evidence", () => {
		const { config } = scene();
		const desktop = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" };
		expect(plainNested(config, desktop, host("claude-code"), plainDeps(process.pid, STARTS.desktop, config.dataDir, { startEnv: desktop }))).toBeUndefined();
		// Claude Code gives its hooks CLAUDECODE; pi sets PI_CODING_AGENT in its own process. Neither was started with it.
		expect(plainNested(config, { CLAUDECODE: "1" }, host("claude-code"), plainDeps(process.pid, STARTS.terminal, config.dataDir))).toBeUndefined();
		expect(plainNested(config, { PI_CODING_AGENT: "true" }, host("pi"), plainDeps(process.pid, STARTS.terminal, config.dataDir))).toBeUndefined();
		// OpenCode's variables, and CLAUDE_CODE_ENTRYPOINT (VS Code's and SDK launches set it), never count there.
		expect(plainNested(config, { OPENCODE: "1", OPENCODE_SESSION_ID: "ses_1" }, host("opencode"), plainDeps(process.pid, STARTS.agent, config.dataDir, { startEnv: { OPENCODE: "1" } }))).toBeUndefined();
		expect(plainNested(config, { CLAUDECODE: "1" }, host("claude-code"), plainDeps(process.pid, STARTS.terminal, config.dataDir, { startEnv: { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" } }))).toBeUndefined();
	});

	it("its walk whole (Linux): CLAUDECODE, PI_CODING_AGENT or CODEX_THREAD_ID it was started with nest it, naming the variable", () => {
		const { config } = scene();
		// A plain Claude Code's `claude -p … &` from a subshell that exits, or `setsid claude -p …`: reparented to the
		// user's systemd, no tool above it, and Claude Code's variable in what it was started with.
		const detached = [{ comm: "systemd", argv: ["/usr/lib/systemd/systemd", "--user"] }];
		const found = plainNested(config, { CLAUDECODE: "1" }, host("claude-code"), plainDeps(process.pid, detached, config.dataDir, { startEnv: { CLAUDECODE: "1" } }));
		expect(found).toEqual({ agent: undefined, tool: undefined, via: "marker", dataDir: config.dataDir, plain: "claude", variable: "CLAUDECODE" });
		expect(nestedNotice(found as Inside)).toBe('Orrery: started inside a Claude Code session that is no agent\'s (found CLAUDECODE; see "Leftover markers" in the README), so this one opens no memory and records nothing.');
		// A pi started from a plain pi's shell, detached; a Codex from a plain Codex's.
		expect(plainNested(config, { PI_CODING_AGENT: "true" }, host("pi"), plainDeps(process.pid, detached, config.dataDir, { startEnv: { PI_CODING_AGENT: "true" } }))).toMatchObject({ via: "marker", plain: "pi", variable: "PI_CODING_AGENT" });
		expect(plainNested(config, {}, host("codex"), plainDeps(process.pid, detached, config.dataDir, { startEnv: { CODEX_THREAD_ID: "019b-plain" } }))).toMatchObject({ via: "marker", plain: "codex", variable: "CODEX_THREAD_ID" });
		// A leftover CLAUDECODE in the user's own terminal: a `claude` typed there opens no memory either.
		expect(plainNested(config, { CLAUDECODE: "1" }, host("claude-code"), plainDeps(process.pid, STARTS.terminal, config.dataDir, { startEnv: { CLAUDECODE: "1" } }))).toMatchObject({ plain: "claude", variable: "CLAUDECODE" });
	});

	it("started by orrery agent from a pane with a leftover CLAUDECODE: the launcher clears the tools' variables, so it opens", async () => {
		const { config, ws } = scene();
		const pane = { PATH: "/usr/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", PI_CODING_AGENT: "true", CODEX_THREAD_ID: "019b-plain", CODEX_SESSION_ID: "019b-plain", CODEX_SANDBOX: "seatbelt", OPENCODE: "1", OPENCODE_SESSION_ID: "ses_1" };
		let started: NodeJS.ProcessEnv = {};
		const spawn = ((_command: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
			started = options.env;
			const child = new EventEmitter();
			queueMicrotask(() => child.emit("exit", 0, null));
			return child;
		}) as never;
		const plan: LaunchPlan = { agent: "Atlas", tool: "claude-code", command: "claude", args: [], cwd: ws, env: { ORRERY_AGENT: "Atlas", ORRERY_AGENT_TOKEN: "a".repeat(32) }, agentDir: join(config.dataDir, "agents", "Atlas"), steps: [] };
		await runTool(plan, { env: pane, spawn });
		const startEnv = Object.fromEntries(Object.entries(started).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
		expect(startEnv).toMatchObject({ PATH: "/usr/bin", ORRERY_AGENT: "Atlas" });
		// Claude Code gives its hooks CLAUDECODE again; what it was started with has none.
		expect(plainNested(config, { CLAUDECODE: "1" }, host("claude-code"), plainDeps(process.pid, STARTS.agent, config.dataDir, { startEnv }))).toBeUndefined();
		// Typed in that pane instead, it would have kept the variable.
		expect(plainNested(config, { CLAUDECODE: "1" }, host("claude-code"), plainDeps(process.pid, STARTS.terminal, config.dataDir, { startEnv: pane }))).toMatchObject({ plain: "claude" });
	});

	it("where its walk is cut (a sandbox's pid namespace, a parent that can't be read), its own tool's markers it was started with nest it", () => {
		const { config } = scene();
		const inherited = { startEnv: { CLAUDECODE: "1" } };
		// claude in a Claude Code's sandboxed shell: the outer claude is out of sight, its variable is not.
		expect(plainNested(config, { CLAUDECODE: "1" }, host("claude-code"), plainDeps(process.pid, STARTS.terminal, config.dataDir, { ...inherited, namespace: "pid:[4026533000]" }))).toEqual({
			agent: undefined,
			tool: undefined,
			via: "marker",
			dataDir: config.dataDir,
			plain: "claude",
			variable: "CLAUDECODE",
		});
		expect(plainNested(config, { CLAUDECODE: "1" }, host("claude-code"), plainDeps(process.pid, STARTS.terminal, config.dataDir, { ...inherited, cut: true }))).toMatchObject({ plain: "claude" });
		expect(plainNested(config, { PI_CODING_AGENT: "true" }, host("pi"), plainDeps(process.pid, STARTS.terminal, config.dataDir, { cut: true, startEnv: undefined }))).toMatchObject({ plain: "pi" });
		// Not those the host set itself (pi sets PI_CODING_AGENT; Claude Code gives its hooks CLAUDECODE).
		expect(plainNested(config, { PI_CODING_AGENT: "true" }, host("pi"), plainDeps(process.pid, STARTS.terminal, config.dataDir, { cut: true }))).toBeUndefined();
		expect(plainNested(config, { CLAUDECODE: "1" }, host("claude-code"), plainDeps(process.pid, STARTS.terminal, config.dataDir, { namespace: "pid:[4026533000]" }))).toBeUndefined();
		// Nor under the desktop app's wrapper, its known launcher, which may have given them.
		expect(plainNested(config, { CLAUDECODE: "1" }, host("claude-code"), plainDeps(process.pid, STARTS.desktop, config.dataDir, { ...inherited, cut: true }))).toBeUndefined();
	});

	it("opens as today when started from the user's terminal, the TUI, orrery agent, Ori, or the Claude Code desktop app", () => {
		const { config } = scene();
		for (const [start, chain] of [
			["terminal", STARTS.terminal],
			["tui", STARTS.tui],
			["orrery agent", STARTS.agent],
			["ori", STARTS.ori],
			["desktop", STARTS.desktop],
		] as const) {
			for (const tool of ["pi", "omp", "claude-code", "codex", "opencode", "run"] as const) {
				expect(plainNested(config, {}, host(tool), plainDeps(process.pid, chain, config.dataDir)), `${tool} from ${start}`).toBeUndefined();
			}
		}
	});

	it("its own launcher right above it, by the shape the tool starts it in, is no outer session: npm's Codex, OpenCode's TUI", () => {
		const { config } = scene();
		const npm = npmCodex();
		const binary = { host: npm.binary };
		expect(plainNested(config, {}, host("codex"), plainDeps(process.pid, [npm.launcher, ...STARTS.agent], config.dataDir, binary))).toBeUndefined();
		const server = { host: OPENCODE.server };
		expect(plainNested(config, {}, host("opencode"), plainDeps(process.pid, [OPENCODE.tui, ...STARTS.agent], config.dataDir, server))).toBeUndefined();
		// Started from a plain session all the same: the outer tool is found past them.
		expect(plainNested(config, {}, host("codex"), plainDeps(process.pid, [npm.launcher, ...STARTS.claude], config.dataDir, binary))).toMatchObject({ plain: "claude" });
		expect(plainNested(config, {}, host("opencode"), plainDeps(process.pid, [OPENCODE.tui, OPENCODE.server, ...STARTS.terminal], config.dataDir, server))).toMatchObject({ plain: "opencode" });
		// Any other shape is nesting: a host that is no binary or server of theirs, or a launcher not right above it.
		expect(plainNested(config, {}, host("codex"), plainDeps(process.pid, [npm.launcher, ...STARTS.agent], config.dataDir))).toMatchObject({ plain: "codex" });
		expect(plainNested(config, {}, host("opencode"), plainDeps(process.pid, [OPENCODE.tui, ...STARTS.agent], config.dataDir))).toMatchObject({ plain: "opencode" });
		expect(plainNested(config, {}, host("opencode"), plainDeps(process.pid, [OPENCODE.tui, { comm: "node", argv: ["node", "/usr/local/bin/opencode"] }, ...STARTS.agent], config.dataDir, server))).toMatchObject({ plain: "opencode" });
		// Only Codex's own: another tool's launcher right above it is that tool's session.
		expect(plainNested(config, {}, host("pi"), plainDeps(process.pid, [npm.launcher, ...STARTS.agent], config.dataDir))).toMatchObject({ plain: "codex" });
	});

	it("an agent's own Codex session: its thread id is no marker for a tool started from it, as its record names it", () => {
		const { config } = scene();
		// The agent's Codex (a live process of this test's: its parent) recorded with its session's id.
		expect(recordSession(config.dataDir, { agent: "Atlas", tool: "codex", pid: process.ppid, codexSession: "019a-atlas" })).toBe(true);
		recorded.push({ dataDir: config.dataDir, pid: process.ppid });
		const deps = plainDeps(process.pid, STARTS.terminal, config.dataDir);
		expect(plainNested(config, { CODEX_THREAD_ID: "019a-atlas" }, host("pi"), deps)).toBeUndefined();
		// One no record names is a plain Codex's.
		expect(plainNested(config, { CODEX_THREAD_ID: "019b-plain" }, host("pi"), deps)).toMatchObject({ via: "marker", plain: "codex" });
		// The agent's Codex itself, asking about its own host: Codex's variables are its own.
		expect(plainNested(config, { CODEX_THREAD_ID: "019b-plain" }, host("codex"), deps)).toBeUndefined();
	});
});

describe("opensHere: whether a session here would open an agent's memory but for being nested", () => {
	it("an agent's folder, or ORRERY_AGENT set; else not", () => {
		const { config, ws, dir } = scene();
		expect(opensHere(config, {}, ws)).toBe(true);
		expect(opensHere(config, {}, join(ws, "sub"))).toBe(true);
		expect(opensHere(config, {}, dir)).toBe(false);
		expect(opensHere(config, { ORRERY_AGENT: "Atlas" }, dir)).toBe(true);
		expect(opensHere(config, { ORRERY_AGENT: " " }, dir)).toBe(false);
	});
});
