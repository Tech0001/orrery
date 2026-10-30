import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentMode, writeSetupMarker } from "../../src/claude/view-file.ts";
import { parseConfig } from "../../src/agent/config.ts";
import { applyFix, checkCodexHooks, checkOpenCodePlugin, exitText, launchLabel, launchPlan, runAgent, runTool, withoutOrrery } from "../../src/agent/launch.ts";
import { cutNotice, instructionsSection, readInstructions, writeInstructions } from "../../src/agent/instructions.ts";
import { codexLaunch } from "../../src/codex/launch.ts";
import { addGrokConfig, grokHookFile } from "../../src/grok/install.ts";
import { GROK_ARG_MAX } from "../../src/grok/launch.ts";
import { entries } from "../../src/install/layout.ts";
import { grokLeftOut, memorySection } from "../../src/agent/view-text.ts";
import { claimToken } from "../../src/agent/pick.ts";
import { agentOverview } from "../../src/agent/overview.ts";
import { MemoryStore, MemoryView, Part } from "../../src/memory/index.ts";
import { checkTools, installSteps, ompExtensionFile, orreryRoot, piExtensionFile, type ToolCheck } from "../../src/agent/tools.ts";
import { fillMemory, tempDir } from "./support.ts";
import { fakeOpenCode } from "../opencode/fake-opencode.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(tool: string, folder?: string, extra = "") {
	const dir = tempDir("orrery-launch-");
	dirs.push(dir);
	const ws = folder ?? join(dir, `my "odd" folder ünï`);
	mkdirSync(ws, { recursive: true });
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const out = join(dir, "out.txt");
	for (const name of ["pi", "claude", "codex", "omp", "ori", "opencode", "grok"]) {
		writeFileSync(join(bin, name), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0; exit 0; fi\nif [ "$1" = "plugin" ]; then echo '[]'; exit 0; fi\npwd > ${JSON.stringify(out)}\nexit 3\n`);
		chmodSync(join(bin, name), 0o755);
	}
	const env = { PATH: bin, HOME: dir };
	const config = parseConfig(`data_dir = ${JSON.stringify(join(dir, "data"))}\n[agents.A]\nfolder = ${JSON.stringify(ws)}\ntool = "${tool}"\ncompactor_model = "openai/gpt-6.1-sol"\n${extra}`, dir);
	const row = agentOverview(config)[0];
	const tools = checkTools({ root: orreryRoot(), env });
	return { config, row, tools, env, ws, out };
}

describe("launchPlan and runTool", () => {
	it("runs the tool in the agent's folder (spaces, quotes, non-ASCII) and reports its exit code", async () => {
		const { config, row, tools, env, ws, out } = setup("codex");
		const plan = launchPlan(config, row, tools);
		expect(plan.blocked).toBeUndefined();
		expect(plan.steps).toEqual([]);
		const exit = await runTool(plan, { env });
		expect(readFileSync(out, "utf8").trim()).toBe(realpathSync(ws)); // the shell reports the physical path (macOS tmp is /private/var behind /var)
		expect(exit).toEqual({ code: 3, signal: null });
		expect(exitText("Codex", exit)).toBe("Codex exited with code 3.");
		expect(exitText("Codex", { code: 0, signal: null })).toBeUndefined();
		expect(exitText("Codex", { code: null, signal: "SIGTERM" })).toBe("Codex was stopped (SIGTERM).");
	});

	it("asks before launching pi without its extension, saying the file it writes, and installs it on yes", () => {
		const { config, row, tools, env } = setup("pi");
		const plan = launchPlan(config, row, tools, { root: orreryRoot(), env });
		const describe = `write ${piExtensionFile(env)} (a re-export of ${join(orreryRoot(), "src", "pi", "index.ts")})`;
		expect(plan.steps).toEqual([{ text: `Orrery's pi extension is not installed, so this session won't record. Installing it will:\n  ${describe}\nInstall it now?`, confirm: true, fix: "install-pi" }]);
		expect(applyFix("install-pi", config, row, tools, { root: orreryRoot(), env })).toContain("wrote ");
	});

	it("offers to rewrite a pi or OMP extension that names Orrery's entry of the other install shape", () => {
		for (const tool of ["pi", "omp"] as const) {
			const { config, row, tools, env } = setup(tool);
			const stale = tools.map((t) => (t.id === tool ? { ...t, wiring: "update available" as const, detail: "Orrery's binary entry; setup moves it to this version's", now: "points at /h/.orrery/app/current/extensions/x.js" } : t));
			const plan = launchPlan(config, row, stale, { root: orreryRoot(), env });
			const label = tool === "pi" ? "pi" : "OMP";
			expect(plan.steps).toHaveLength(1);
			expect(plan.steps[0]).toMatchObject({ confirm: true, fix: `install-${tool}` });
			expect(plan.steps[0].text).toMatch(new RegExp(`^Orrery's ${label} extension names the other install shape's entry, so this session won't record\\. Installing it will:\\n  rewrite `));
		}
	});

	it("asks to install the plugin, listing the commands, and nothing to set up: the mod needs no setup", () => {
		const { config, row, tools, env } = setup("claude-code");
		const plan = launchPlan(config, row, tools, { root: orreryRoot(), env });
		expect(plan.steps.map((s) => s.fix)).toEqual(["install-claude-code"]);
		expect(plan.steps[0].text).toBe(`The Orrery plugin for Claude Code is not installed. Installing it will:\n  claude plugin marketplace add ${orreryRoot()}\n  claude plugin install orrery@orrery\nInstall it now?`);
	});

	it("neither blocks nor offers an install when Claude Code's plugin list is in a shape Orrery doesn't know", () => {
		const { config, row, tools } = setup("claude-code");
		const unknown = tools.map((t) => (t.id === "claude-code" ? { ...t, wiring: "unknown" as const, detail: "?" } : t));
		const plan = launchPlan(config, row, unknown);
		expect(plan.blocked).toBeUndefined();
		expect(plan.steps.map((s) => s.fix).filter((fix) => fix !== undefined)).toEqual([]);
	});

	it("opens an agent without a folder in the current folder, with nothing to create", () => {
		const { config, row, tools } = setup("codex");
		const { folder: _, ...bare } = row;
		const plan = launchPlan(config, bare, tools);
		expect(plan.cwd).toBe(process.cwd());
		expect(plan.steps).toEqual([]);
	});

	it("blocks when the tool is not on PATH, and offers to create a missing folder", () => {
		const { config, row, env, ws } = setup("pi");
		const noTools = checkTools({ root: orreryRoot(), env: { ...env, PATH: "/nonexistent" } });
		expect(launchPlan(config, row, noTools).blocked).toBe('pi is not on PATH (looked for "pi"). Get it at https://pi.dev, or change the agent\'s tool with C.');
		const gone = { ...row, folder: join(ws, "missing") };
		const plan = launchPlan(config, gone, checkTools({ root: orreryRoot(), env }));
		expect(plan.steps[0]).toEqual({ text: `The folder ${gone.folder} does not exist. Create it?`, confirm: true, fix: "create-folder" });
		applyFix("create-folder", config, gone, []);
		expect(existsSync(gone.folder)).toBe(true);
	});

	it("warns that a second session won't record when the agent is open", () => {
		const { config, row, tools } = setup("codex");
		const open = { ...row, state: "open" as const, openIn: "pi" as const };
		expect(launchPlan(config, open, tools).steps[0]).toEqual({ text: "A is already open in pi. A second session won't record. Launch anyway?", confirm: true, asAgent: true });
	});

	it("plain Codex (a yes to starting without Orrery) opens no agent: no second-session question, but the folder is still made", () => {
		const { config, row, tools } = setup("codex");
		const gone = { ...row, state: "open" as const, openIn: "claude-code" as const, folder: join(row.folder as string, "not-yet") };
		const plan = launchPlan(config, gone, tools);
		expect(plan.steps.map((step) => step.text)).toEqual([`The folder ${gone.folder} does not exist. Create it?`, "A is already open in Claude Code. A second session won't record. Launch anyway?"]);
		expect(withoutOrrery(plan).steps).toEqual([{ text: `The folder ${gone.folder} does not exist. Create it?`, confirm: true, fix: "create-folder" }]);
	});

	it("gives the signal when a tool cannot start, and passes the env it is given", async () => {
		const { config, row, tools, env } = setup("codex");
		const before = process.listenerCount("SIGINT");
		const plan = launchPlan(config, row, tools);
		await expect(runTool(plan, { env, spawn: (() => { throw new Error("no spawn"); }) as never })).rejects.toThrow("no spawn");
		expect(process.listenerCount("SIGINT")).toBe(before);
		const seen: unknown[] = [];
		const fake = ((_c: string, _a: string[], o: { env?: unknown }) => {
			seen.push(o.env);
			const h: Record<string, (...a: unknown[]) => void> = {};
			setTimeout(() => h.exit?.(0, null), 0);
			return { on: (n: string, f: (...a: unknown[]) => void) => { h[n] = f; } };
		}) as never;
		await runTool(plan, { env: { ORRERY_CONFIG: "/x.toml", ORRERY_AGENT: "inherited", ORRERY_AGENT_TOKEN: "f".repeat(32) }, spawn: fake });
		// The plan's agent variables are added, over any the environment had.
		expect(seen).toEqual([{ ORRERY_CONFIG: "/x.toml", ORRERY_AGENT: "A", ORRERY_AGENT_TOKEN: plan.env.ORRERY_AGENT_TOKEN }]);
	});

	it("starts every tool without the variables coding tools give their shells, even inherited (a pane a tmux server left them in)", async () => {
		const leftover = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", PI_CODING_AGENT: "true", CODEX_THREAD_ID: "019b-plain", CODEX_SESSION_ID: "019b-plain", CODEX_SANDBOX: "seatbelt", OPENCODE: "1", OPENCODE_SESSION_ID: "ses_1" };
		const seen: NodeJS.ProcessEnv[] = [];
		const fake = ((_c: string, _a: string[], o: { env: NodeJS.ProcessEnv }) => {
			seen.push(o.env);
			const h: Record<string, (...a: unknown[]) => void> = {};
			setTimeout(() => h.exit?.(0, null), 0);
			return { on: (n: string, f: (...a: unknown[]) => void) => { h[n] = f; } };
		}) as never;
		for (const tool of ["pi", "omp", "claude-code", "codex", "opencode"]) {
			const { config, row, tools, env } = setup(tool);
			const plan = launchPlan(config, row, tools, { env });
			await runTool(plan, { env: { ...env, ...leftover }, spawn: fake });
			// Started without Orrery (plain Codex or OpenCode) too.
			await runTool(withoutOrrery(plan), { env: { ...env, ...leftover }, spawn: fake });
		}
		expect(seen).toHaveLength(10);
		for (const started of seen) {
			expect(Object.keys(started).filter((name) => name in leftover)).toEqual([]);
			expect(started.PATH).toBeDefined();
		}
		// Through Ori as well.
		const { config, row, tools, env } = setup("pi", undefined, 'launcher = "ori"\n');
		await runTool(launchPlan(config, row, tools, { env }), { env: { ...env, ...leftover }, spawn: fake });
		expect(Object.keys(seen.at(-1) as NodeJS.ProcessEnv).filter((name) => name in leftover)).toEqual([]);
		// The shell Codex runs the hooks in is checked with that environment.
		const codex = setup("codex");
		const shells: NodeJS.ProcessEnv[] = [];
		await checkCodexHooks(launchPlan(codex.config, codex.row, codex.tools, { env: codex.env }), { env: { ...codex.env, ...leftover }, probe: async () => ({ ok: true as const }), shellCheck: (shellEnv) => (shells.push(shellEnv), { quiet: true as const }) });
		expect(Object.keys(shells[0] as NodeJS.ProcessEnv).filter((name) => name in leftover)).toEqual([]);
	});

	it("asks before launching OMP without its extension, saying the file it writes, and installs it on yes; omp gets no arguments", () => {
		const { config, row, tools, env } = setup("omp");
		const plan = launchPlan(config, row, tools, { root: orreryRoot(), env });
		const describe = `write ${ompExtensionFile(env)} (a relative re-export of ${join(orreryRoot(), "src", "omp", "index.ts")})`;
		expect(plan.steps).toEqual([{ text: `Orrery's OMP extension is not installed, so this session won't record. Installing it will:\n  ${describe}\nInstall it now?`, confirm: true, fix: "install-omp" }]);
		expect(plan.args).toEqual([]);
		expect(applyFix("install-omp", config, row, tools, { root: orreryRoot(), env })).toContain("wrote ");
	});

	it("blocks when OMP is not on PATH, and names OMP when an agent is open in it", () => {
		const { config, row, env } = setup("omp");
		const noTools = checkTools({ root: orreryRoot(), env: { ...env, PATH: "/nonexistent" } });
		expect(launchPlan(config, row, noTools).blocked).toBe('OMP is not on PATH (looked for "omp"). Get it at https://omp.sh, or change the agent\'s tool with C.');
		const codex = setup("codex");
		const open = { ...codex.row, state: "open" as const, openIn: "omp" as const };
		expect(launchPlan(codex.config, open, codex.tools).steps[0]).toEqual({ text: "A is already open in OMP. A second session won't record. Launch anyway?", confirm: true, asAgent: true });
	});
});

describe("opening an agent in Grok", () => {
	/** Grok's folder in setup's scratch home, its hook file and config. */
	const grokFolder = (env: { HOME: string }) => ({ hooks: join(env.HOME, ".grok", "hooks", "orrery.json"), config: join(env.HOME, ".grok", "config.toml"), disabled: join(env.HOME, ".grok", "disabled-hooks") });
	/** Writes Grok's hook file and config in setup's scratch home: `hooks` the Orrery the hook file runs, `config` the config's text. */
	function grokFiles(env: { HOME: string }, hooks: string | undefined, config: string) {
		const files = grokFolder(env);
		mkdirSync(dirname(files.hooks), { recursive: true });
		if (hooks !== undefined) writeFileSync(files.hooks, grokHookFile(hooks));
		writeFileSync(files.config, config);
	}
	/** This checkout's Orrery command, which the launch's wiring check (root orreryRoot()) wants Grok's hooks to run. */
	const own = () => entries(orreryRoot()).cli;

	/** setup(), with Orrery connected to Grok in the scratch home's Grok folder as setup connects it, and the tools checked again. */
	function connected(...args: Parameters<typeof setup>) {
		const s = setup(...args);
		grokFiles(s.env, own(), addGrokConfig("", own()).next);
		const tools = checkTools({ root: orreryRoot(), env: s.env });
		expect(tools.find((t) => t.id === "grok")?.wiring).toBe("installed");
		return { ...s, tools };
	}

	/** The connect question for `why`, listing `steps`. */
	const connect = (why: string, steps: readonly string[]) => `${why}. Connecting Orrery to Grok will:\n${steps.map((step) => `  ${step}`).join("\n")}\nConnect Orrery to Grok now?`;

	it("asks to connect Orrery to Grok when its hooks aren't installed, with setup's steps; a yes connects it as setup does, and the next launch asks nothing", () => {
		const { config, row, tools, env } = setup("grok");
		const { hooks, config: grokConfig } = grokFolder(env);
		const options = { root: orreryRoot(), env };
		const plan = launchPlan(config, row, tools, options);
		expect(plan.blocked).toBeUndefined();
		expect(plan.steps).toEqual([
			{
				text: connect("Orrery's hooks for Grok are not installed, so this session won't record", [`write ${hooks} (Orrery's hooks for every Grok session)`, `add Orrery's status row and memory tools to ${grokConfig} unless it has its own (a copy of it first)`]),
				confirm: true,
				fix: "install-grok",
			},
		]);
		// The steps are setup's own (src/agent/tools.ts installSteps).
		const grok = tools.find((t) => t.id === "grok") as ToolCheck;
		expect(plan.steps[0]?.text).toContain(installSteps(grok, orreryRoot(), env).map((step) => `  ${step.describe}`).join("\n"));
		// The launch's command line is as it is once connected.
		expect(plan.args).toEqual(["--no-leader"]);
		// A yes: the hook file and both config entries, as setup writes them.
		const done = applyFix("install-grok", config, row, tools, options);
		expect(done).toContain(`wrote ${hooks}`);
		expect(readFileSync(hooks, "utf8")).toBe(grokHookFile(own()));
		expect(readFileSync(grokConfig, "utf8")).toBe(addGrokConfig("", own()).next);
		const after = checkTools({ root: orreryRoot(), env });
		expect(after.find((t) => t.id === "grok")?.wiring).toBe("installed");
		expect(launchPlan(config, row, after, options).steps).toEqual([]);
	});

	it("asks to add back a config entry of Orrery's the person removed, saying the session still records", () => {
		const { config, row, env } = setup("grok");
		// Orrery's hooks, and its status row without its memory server.
		const full = addGrokConfig("", own()).next;
		grokFiles(env, own(), full.slice(0, full.indexOf("[mcp_servers.orrery]")));
		const tools = checkTools({ root: orreryRoot(), env });
		expect(tools.find((t) => t.id === "grok")?.wiring).toBe("missing");
		const plan = launchPlan(config, row, tools, { root: orreryRoot(), env });
		expect(plan.steps).toEqual([{ text: connect("Grok's config lacks Orrery's status row or memory tools", [`add Orrery's status row and memory tools to ${grokFolder(env).config} unless it has its own (a copy of it first)`]), confirm: true, fix: "install-grok" }]);
	});

	it("asks to connect Orrery to Grok when Grok runs Orrery's hooks of the other install shape, or another hook file", () => {
		const { config, row, env } = setup("grok");
		const { hooks } = grokFolder(env);
		const options = { root: orreryRoot(), env };
		const replace = (now: string) => `replace ${hooks} (now ${now}) with Orrery's hooks for every Grok session`;
		const check = () => checkTools({ root: orreryRoot(), env });
		// This checkout's other shape (a release's bin/orrery), the config entries there.
		const shape = join(orreryRoot(), "bin", "orrery");
		grokFiles(env, shape, addGrokConfig("", own()).next);
		expect(check().find((t) => t.id === "grok")?.wiring).toBe("update available");
		expect(launchPlan(config, row, check(), options).steps).toEqual([{ text: connect("Orrery's hooks for Grok name the other install shape's entry, so this session won't record", [replace(`runs ${shape}`)]), confirm: true, fix: "install-grok" }]);
		// Another Orrery's hooks: that Orrery may record the session, or may not.
		grokFiles(env, "/opt/other/bin/orrery", addGrokConfig("", own()).next);
		expect(check().find((t) => t.id === "grok")?.wiring).toBe("other");
		const other = launchPlan(config, row, check(), options);
		expect(other.steps).toEqual([{ text: connect("Grok doesn't run this Orrery's hooks, so this session may not record", [replace("runs /opt/other/bin/orrery")]), confirm: true, fix: "install-grok" }]);
		// A hook file that isn't Orrery's: set aside first, as setup does.
		writeFileSync(hooks, '{"hooks":{}}\n');
		expect(launchPlan(config, row, check(), options).steps[0]?.text).toBe(connect("Grok doesn't run this Orrery's hooks, so this session may not record", [replace("not Orrery's hook file")]));
		applyFix("install-grok", config, row, check(), options);
		expect(readFileSync(hooks, "utf8")).toBe(grokHookFile(own()));
		expect(readdirSync(dirname(hooks)).filter((name) => name.startsWith("orrery.json.before-orrery-"))).toHaveLength(1);
		expect(launchPlan(config, row, check(), options).steps).toEqual([]);
	});

	it("says, without asking, when Orrery can't read Grok's wiring, and opens Grok", () => {
		const { config, row, tools, env } = setup("grok");
		const unknown = tools.map((t) => (t.id === "grok" ? { ...t, wiring: "unknown" as const, detail: `cannot read ${grokFolder(env).hooks}; tested with Grok 1.0.70` } : t));
		const plan = launchPlan(config, row, unknown, { root: orreryRoot(), env });
		expect(plan.blocked).toBeUndefined();
		expect(plan.steps).toEqual([{ text: "Orrery can't tell whether Grok runs its hooks, so this session may not record; orrery tools says why.", confirm: false }]);
		expect(plan.command).toBe(join(env.PATH, "grok"));
	});

	it("says which of Orrery's hooks Grok's /hooks tab has switched off, and how to switch them on, then opens Grok", () => {
		const { config, row, tools, env } = connected("grok");
		const { disabled } = grokFolder(env);
		const open = () => launchPlan(config, row, tools, { root: orreryRoot(), env });
		// Others' hooks, or a project's hook of Orrery's name: nothing to say.
		writeFileSync(disabled, "project/orrery:pre_tool_use[0].hooks[0]\nglobal/other:session_start[0].hooks[0]\n");
		expect(open().steps).toEqual([]);
		writeFileSync(disabled, "global/orrery:stop[0].hooks[0]\n");
		expect(open().steps).toEqual([{ text: "Orrery's recording hooks are switched off in Grok's /hooks, so this session won't be fully recorded: switch them on there, then start a new session (/new).", confirm: false }]);
		writeFileSync(disabled, "global/orrery:pre_tool_use[0].hooks[0]\n");
		expect(open().steps).toEqual([{ text: "Orrery's guard is switched off in Grok's /hooks, so it checks none of this session's tool calls: switch it on there.", confirm: false }]);
		writeFileSync(disabled, "global/orrery:session_start[0].hooks[0]\nglobal/orrery:pre_tool_use[0].hooks[0]\n");
		const both = open();
		expect(both.steps).toEqual([{ text: "Orrery's recording hooks and its guard are switched off in Grok's /hooks, so this session won't be fully recorded and the guard checks none of its tool calls: switch them on there, then start a new session (/new).", confirm: false }]);
		expect(both).toMatchObject({ command: join(env.PATH, "grok"), args: ["--no-leader"] });
	});

	/** A fake grok that writes down what it was started with: the agent, the token, the folder and each argument on its own line. */
	function fakeGrok(out: string, bin: string) {
		writeFileSync(join(bin, "grok"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "grok 1.0.70 (abc) [stable]"; exit 0; fi\n{ printf '%s\\n' "$ORRERY_AGENT" "$ORRERY_AGENT_TOKEN" "$(pwd)"; for a in "$@"; do printf '%s\\n' "$a"; done; } > ${JSON.stringify(out)}\n`, { mode: 0o755 });
	}

	it("tool grok opens grok with ORRERY_AGENT and a fresh token, in the current folder", async () => {
		const { config, row, tools, env, out } = connected("grok");
		fakeGrok(out, join(dirname(out), "bin"));
		const here = tempDir("orrery-launch-grok-here-");
		dirs.push(here);
		writeInstructions(config.agents.get("A")!.dir, "Keep notes.\n");
		const plan = launchPlan(config, row, checkTools({ root: orreryRoot(), env }), { env, cwd: here, args: ["--resume", "abc"] });
		expect(plan).toMatchObject({ tool: "grok", command: join(env.PATH, "grok"), cwd: here, steps: [{ text: resumedNotice, confirm: false }] });
		expect(plan.blocked).toBeUndefined();
		// Orrery's flags first: --no-leader (Grok's leader mode would run every session's hooks in one shared process), then --rules.
		expect(plan.args.slice(0, 2)).toEqual(["--no-leader", "--rules"]);
		expect(plan.args[2]).toContain("# Agent: A");
		expect(plan.args.slice(3)).toEqual(["--resume", "abc"]);
		const token = plan.env.ORRERY_AGENT_TOKEN as string;
		expect(token).toMatch(/^[0-9a-f]{32}$/);
		// What Grok's hooks do at its start: claim the token.
		expect(claimToken(plan.agentDir, token, 999_999)).toBe(true);
		expect(await runAgent(plan, (p) => runTool(p, { env }))).toEqual({ code: 0, signal: null, claimedBy: 999_999 });
		const [agent, seen, cwd, leader, flag, ...rest] = readFileSync(out, "utf8").split("\n");
		expect([agent, seen, realpathSync(cwd as string), leader, flag]).toEqual(["A", token, realpathSync(here), "--no-leader", "--rules"]);
		expect(rest.slice(0, 2)).toEqual(["# Agent: A", ""]);
		expect(rest.slice(-3, -1)).toEqual(["--resume", "abc"]);
		expect(readdirSync(join(plan.agentDir, "claims"))).toEqual([]);
	});

	/** What the person is told when Grok resumes a session, whose memory section is its first launch's. */
	const resumedNotice = "Orrery: a resumed Grok session keeps A's memory as it was at that session's first launch; newer memory is reachable with the zoom and search tools. Start a new session for a fresh view.";

	it("says a resumed session keeps its first launch's memory (Grok doesn't take --rules again on a resume), for each way of resuming", () => {
		const { config, row, tools, env } = connected("grok");
		writeInstructions(config.agents.get("A")!.dir, "Keep notes.\n");
		for (const args of [["--resume", "abc"], ["--resume"], ["--resume=abc"], ["-r", "abc"], ["--continue"], ["-c"], ["-p", "hi", "-c"]]) {
			const plan = launchPlan(config, row, tools, { env, args });
			expect(plan.steps, args.join(" ")).toEqual([{ text: resumedNotice, confirm: false }]);
			expect(plan.args.slice(-args.length)).toEqual(args);
		}
		for (const args of [[], ["-p", "hi"], ["--", "-c"], ["--resumex"], ["-cx"]]) expect(launchPlan(config, row, tools, { env, args }).steps, args.join(" ")).toEqual([]);
	});

	it("--tool grok overrides an agent's tool for this launch only", () => {
		const { config, row, tools, env } = connected("codex");
		const plan = launchPlan(config, row, tools, { env, tool: "grok", args: ["-x"] });
		expect(plan).toMatchObject({ tool: "grok", command: join(env.PATH, "grok") });
		expect(plan.codex).toBeUndefined();
		expect(plan.args).toEqual(["--no-leader", "-x"]);
		// The agent's own tool is untouched.
		expect(launchPlan(config, row, tools, { env })).toMatchObject({ tool: "codex" });
	});

	it("gives the memory section of the agent's store, in Grok's words, with the instructions after it", () => {
		const { config, row, tools, env } = connected("grok");
		const agentDir = config.agents.get("A")!.dir;
		mkdirSync(agentDir, { recursive: true });
		const store = MemoryStore.open(join(agentDir, "memory.sqlite"));
		new MemoryView(store).append("user", "remember the Cedar plan");
		store.saveNode(new Part(0, 0), "user: remember the Cedar plan");
		store.close();
		writeInstructions(agentDir, "Keep notes.\n");
		const plan = launchPlan(config, row, tools, { env });
		const rules = plan.args[2] as string;
		expect(plan.args.slice(0, 2)).toEqual(["--no-leader", "--rules"]);
		expect(rules.startsWith("# Memory")).toBe(true);
		expect(rules).toContain("look for the zoom, date and search tools");
		expect(rules).toContain("remember the Cedar plan");
		expect(rules).not.toContain("read-only");
		expect(rules.indexOf("# Agent: A")).toBeGreaterThan(rules.indexOf("remember the Cedar plan"));
		// Open in another session: asked first, and the section says this one records nothing.
		const open = { ...row, state: "open" as const, openIn: "omp" as const };
		const second = launchPlan(config, open, tools, { env });
		expect(second.steps).toEqual([{ text: "A is already open in OMP. A second session won't record. Launch anyway?", confirm: true, asAgent: true }]);
		expect(second.args[2]).toContain("This session is read-only, though: another session has the agent");
	});

	it("opens with no memory yet and no instructions: nothing added, only the person's arguments", () => {
		const { config, row, tools, env } = connected("grok");
		expect(launchPlan(config, row, tools, { env, args: ["-p", "hi"] }).args).toEqual(["--no-leader", "-p", "hi"]);
	});

	/** What the person is told when the session starts with the memory's newest lines, from line `from`. */
	const newestNotice = (from: string) => `Orrery: A's memory is too large for Grok's command line, so this session starts with its newest lines, from line ${from}; older lines are left out, and the zoom and search tools reach them.`;

	it("keeps every argument within Grok's limit for a large memory of multi-byte text: the instructions whole, the memory's newest lines", () => {
		const { config, row, tools, env } = connected("grok", undefined, "[agents.A.memory]\nview_bytes = 125000\n");
		const agentDir = config.agents.get("A")!.dir;
		mkdirSync(agentDir, { recursive: true });
		const store = MemoryStore.open(join(agentDir, "memory.sqlite"));
		const view = new MemoryView(store, 125_000);
		for (let i = 0; i < 30; i++) {
			view.append("user", `${i} ${"\u20ac".repeat(1400)}`);
			store.saveNode(new Part(0, i), `user: ${i} ${"\u20ac".repeat(1400)}`);
		}
		store.close();
		// Over 32 KB: cut there, as for every tool.
		writeInstructions(agentDir, "Instruction line with \u00e9 and more words.\n".repeat(850));
		const plan = launchPlan(config, row, tools, { env });
		expect(plan.args).toHaveLength(3);
		const rules = plan.args[2] as string;
		expect(Buffer.byteLength(rules)).toBeLessThanOrEqual(GROK_ARG_MAX);
		// The instructions whole, at the 32 KB every tool gets; the memory's newest lines before them.
		expect(rules.endsWith(`|user: 29 ${"\u20ac".repeat(1400)}\n</chat>\n\n${instructionsSection("A", readInstructions(agentDir)!)}`)).toBe(true);
		const from = /\nThe view below starts at line (\d+\+1):/.exec(rules)?.[1] as string;
		expect(rules).toContain(`\n\n${grokLeftOut(from)}\n<chat>\n${from}|user: ${Number.parseInt(from, 10)} \u20ac`);
		expect(plan.steps.map((step) => step.text)).toEqual([newestNotice(from), cutNotice("A")]);
	});

	/** Short lines of multi-byte text, about 100 bytes each. */
	const line = (i: number) => `${i} ${"\u20ac".repeat(30)}`;
	const savedView = (agentDir: string) => {
		const store = MemoryStore.openReadOnly(join(agentDir, "memory.sqlite"));
		try {
			return store.savedView();
		} finally {
			store.close();
		}
	};

	it("starts at the default view_bytes with short multi-byte lines near the ceiling: a smaller view, whole on the command line, said first", async () => {
		const { config, row, tools, env, out } = connected("grok");
		fakeGrok(out, join(dirname(out), "bin"));
		const agentDir = config.agents.get("A")!.dir;
		expect(config.agents.get("A")!.memory.viewBytes).toBe(128_000);
		mkdirSync(agentDir, { recursive: true });
		// About 127 KB of lines, under the ceiling, as a summarizer that kept up leaves them; rendered, over Grok's limit.
		fillMemory(join(agentDir, "memory.sqlite"), 1250, line, true);
		writeInstructions(agentDir, "Keep notes.\n");
		const before = savedView(agentDir);
		const plan = launchPlan(config, row, checkTools({ root: orreryRoot(), env }), { env });
		expect(plan.blocked).toBeUndefined();
		expect(plan.steps).toEqual([{ text: "Orrery: A's memory view is too large for Grok's command line, so this session starts with a smaller view of it.", confirm: false }]);
		const rules = plan.args[2] as string;
		expect(plan.args.slice(0, 2)).toEqual(["--no-leader", "--rules"]);
		expect(Buffer.byteLength(rules)).toBeLessThanOrEqual(GROK_ARG_MAX);
		expect(rules.startsWith("# Memory\n\n")).toBe(true);
		expect(rules).toContain(`|user: ${line(1249)}\n</chat>\n\n# Agent: A\n\nKeep notes.`);
		// Read, never written: the agent's saved view is as it was.
		expect(savedView(agentDir)).toBe(before);
		// Grok starts with it.
		const token = plan.env.ORRERY_AGENT_TOKEN as string;
		expect(claimToken(plan.agentDir, token, 999_999)).toBe(true);
		expect(await runAgent(plan, (p) => runTool(p, { env }))).toEqual({ code: 0, signal: null, claimedBy: 999_999 });
		expect(readFileSync(out, "utf8")).toContain(`${rules}\n`);
	});

	it("gives the instructions their room first: 32 KB of them go in whole beside a smaller view near the ceiling", () => {
		const { config, row, tools, env } = connected("grok");
		const agentDir = config.agents.get("A")!.dir;
		mkdirSync(agentDir, { recursive: true });
		fillMemory(join(agentDir, "memory.sqlite"), 1250, line, true);
		// 32,759 bytes: under 32 KB, so whole for every tool.
		const text = "Instruction line with \u00e9 and more words.\n".repeat(799);
		writeInstructions(agentDir, text);
		const plan = launchPlan(config, row, tools, { env });
		const rules = plan.args[2] as string;
		expect(Buffer.byteLength(rules)).toBeLessThanOrEqual(GROK_ARG_MAX);
		expect(rules.startsWith("# Memory\n\n")).toBe(true);
		expect(rules).toContain("summary of 0+");
		expect(rules).not.toContain("are left out");
		expect(rules.endsWith(`|user: ${line(1249)}\n</chat>\n\n# Agent: A\n\n${text.trimEnd()}`)).toBe(true);
		expect(plan.steps).toEqual([{ text: "Orrery: A's memory view is too large for Grok's command line, so this session starts with a smaller view of it.", confirm: false }]);
	});

	it("starts with the memory's newest lines, saying so to the model and the person, when no smaller view fits for want of summaries", () => {
		const { config, row, tools, env } = connected("grok");
		const agentDir = config.agents.get("A")!.dir;
		mkdirSync(agentDir, { recursive: true });
		// Summaries stalled: about 127 KB of short lines kept word for word, none merged.
		fillMemory(join(agentDir, "memory.sqlite"), 1250, line, false);
		writeInstructions(agentDir, "Keep notes.\n");
		const before = savedView(agentDir);
		const plan = launchPlan(config, row, tools, { env });
		expect(plan.blocked).toBeUndefined();
		const rules = plan.args[2] as string;
		expect(plan.args).toEqual(["--no-leader", "--rules", rules]);
		expect(Buffer.byteLength(rules)).toBeLessThanOrEqual(GROK_ARG_MAX);
		// The normal section: Grok's words and its tool pointer.
		expect(rules.startsWith("# Memory\n\n")).toBe(true);
		expect(rules).toContain("look for the zoom, date and search tools");
		// The right first line: the oldest from which the section still fits beside the instructions (one by one here).
		const instructions = "\n\n# Agent: A\n\nKeep notes.";
		const store = MemoryStore.openReadOnly(join(agentDir, "memory.sqlite"));
		try {
			const view = new MemoryView(store, 128_000);
			const k = view.parts.findIndex((part, at) => at > 0 && Buffer.byteLength(memorySection(view, "grok", { from: part }) + instructions) <= GROK_ARG_MAX);
			expect(k).toBeGreaterThan(0);
			const from = view.parts[k]!.address;
			expect(from).toBe(`${k}+1`);
			expect(rules).toContain(`\n\n${grokLeftOut(from)}\n<chat>\n${from}|user: ${line(k)}\n`);
			expect(rules).not.toContain(`\n${k - 1}+1|`);
			expect(rules).toBe(`${memorySection(view, "grok", { from: view.parts[k] })}${instructions}`);
			expect(plan.steps).toEqual([{ text: newestNotice(from), confirm: false }]);
		} finally {
			store.close();
		}
		expect(rules.endsWith(`|user: ${line(1249)}\n</chat>${instructions}`)).toBe(true);
		expect(savedView(agentDir)).toBe(before);
	});

	it("starts without the memory, saying so, when not even its newest line fits", () => {
		const { config, row, tools, env } = connected("grok");
		const agentDir = config.agents.get("A")!.dir;
		mkdirSync(agentDir, { recursive: true });
		fillMemory(join(agentDir, "memory.sqlite"), 2, (i) => (i === 1 ? "x".repeat(140_000) : "hello"), false);
		writeInstructions(agentDir, "Keep notes.\n");
		const plan = launchPlan(config, row, tools, { env });
		expect(plan.args).toEqual(["--no-leader", "--rules", "# Agent: A\n\nKeep notes."]);
		expect(plan.steps).toEqual([{ text: "Orrery: A's memory doesn't fit on Grok's command line, not even its newest line, so this session starts without it.", confirm: false }]);
	});

	it("refuses the person's own --rules beside Orrery's, which Grok would refuse as a second one, naming what Orrery passes", () => {
		const { config, row, tools, env } = connected("grok");
		const agentDir = config.agents.get("A")!.dir;
		writeInstructions(agentDir, "Keep notes.\n");
		const plan = launchPlan(config, row, tools, { env, args: ["--rules", "be brief"] });
		expect(plan).toMatchObject({ steps: [], blocked: "Orrery gives Grok A's instructions as its --rules, which Grok takes once: put your rules in A's instructions.md, or open A without them." });
		fillMemory(join(agentDir, "memory.sqlite"), 1, () => "hello", false);
		expect(launchPlan(config, row, tools, { env, args: ["--rules=be brief"] }).blocked).toBe("Orrery gives Grok A's memory and instructions as its --rules, which Grok takes once: put your rules in A's instructions.md, or open A without them.");
	});

	it("refuses the person's own --leader (or Grok's `agent leader`): Orrery opens Grok with --no-leader", () => {
		const { config, row, tools, env } = connected("grok");
		const refusal = "Orrery opens Grok with --no-leader: in leader mode Grok runs every session's hooks and memory tools in one shared process, where one agent's session can't be told from another's. Open A without --leader.";
		for (const args of [["--leader"], ["-c", "--leader"]]) expect(launchPlan(config, row, tools, { env, args }), args.join(" ")).toMatchObject({ steps: [], blocked: refusal });
		// Grok's own leader command is named as the command it is.
		expect(launchPlan(config, row, tools, { env, args: ["agent", "leader"] })).toMatchObject({ steps: [], blocked: refusal.replace("--leader.", "Grok's agent leader command.") });
		// The person's own --no-leader is given once (Grok refuses it twice).
		expect(launchPlan(config, row, tools, { env, args: ["--no-leader", "-p", "hi"] }).args).toEqual(["--no-leader", "-p", "hi"]);
	});
});

describe("opening an agent in a folder (orrery agent, the TUI)", () => {
	/** A folder outside the agent's folder and outside its default allowed root (the folder's parent). */
	const elsewhereDir = () => {
		const dir = tempDir("orrery-launch-elsewhere-");
		dirs.push(dir);
		return dir;
	};

	it("starts the tool there with ORRERY_AGENT, a fresh token and the arguments, and removes the token's claim after", async () => {
		const { config, row, tools, env, out } = setup("codex");
		writeFileSync(join(dirname(out), "bin", "codex"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0; exit 0; fi\nprintf '%s|%s|%s|%s\\n' "$ORRERY_AGENT" "$ORRERY_AGENT_TOKEN" "$(pwd)" "$*" > ${JSON.stringify(out)}\n`, { mode: 0o755 });
		const elsewhere = elsewhereDir();
		const plan = launchPlan(config, row, tools, { cwd: elsewhere, args: ["--model", "m"], orrery: ["/opt/orrery/bin/orrery"] });
		expect(plan.cwd).toBe(elsewhere);
		// Orrery's flags for Codex come first, the person's arguments last.
		expect(plan.args.slice(-2)).toEqual(["--model", "m"]);
		expect(plan.agentDir).toBe(config.agents.get("A")!.dir);
		const token = plan.env.ORRERY_AGENT_TOKEN as string;
		expect(token).toMatch(/^[0-9a-f]{32}$/);
		// Each plan has its own token.
		expect(launchPlan(config, row, tools).env.ORRERY_AGENT_TOKEN).not.toBe(token);
		// What the tool's extension does at its start: it claims the token.
		expect(claimToken(plan.agentDir, token, 999_999)).toBe(true);
		expect(readdirSync(join(plan.agentDir, "claims"))).toEqual([token]);
		// It says which process had claimed the token (the tool, as the agent) before it removes the claim.
		expect(await runAgent(plan, (p) => runTool(p, { env }))).toEqual({ code: 0, signal: null, claimedBy: 999_999 });
		const [agent, seen, cwd, args] = readFileSync(out, "utf8").trim().split("|");
		expect([agent, seen, realpathSync(cwd as string)]).toEqual(["A", token, realpathSync(elsewhere)]);
		expect(args?.startsWith("--no-daemon -c hooks.SessionStart=")).toBe(true);
		expect(args?.endsWith(" --model m")).toBe(true);
		expect(readdirSync(join(plan.agentDir, "claims"))).toEqual([]);
	});

	it("removes the claim when the tool fails to start too", async () => {
		const { config, row, tools } = setup("codex");
		const plan = launchPlan(config, row, tools, { cwd: elsewhereDir() });
		const token = plan.env.ORRERY_AGENT_TOKEN as string;
		claimToken(plan.agentDir, token, 999_999);
		await expect(runAgent(plan, async () => { throw new Error("no spawn"); })).rejects.toThrow("no spawn");
		expect(readdirSync(join(plan.agentDir, "claims"))).toEqual([]);
	});

	it("takes the tool for this session, and passes the arguments after Ori's own", () => {
		const { config, row, tools, env } = setup("pi", undefined, 'launcher = "ori"\nori_model = "vendor/model"\n');
		const plan = launchPlan(config, row, tools, { env, tool: "omp", args: ["--resume"] });
		expect(plan.tool).toBe("omp");
		expect(plan.args).toEqual(["omp", "--model", "vendor/model", "--resume"]);
		const direct = setup("pi");
		const codex = launchPlan(direct.config, direct.row, direct.tools, { tool: "codex", args: ["-x"] });
		expect(codex).toMatchObject({ tool: "codex", command: join(direct.env.PATH, "codex"), codex: { plainArgs: ["-x"] } });
		expect([codex.args[0], codex.args.at(-1)]).toEqual(["--no-daemon", "-x"]);
	});

	it("offers to create the folder it opens in, and creates that folder", () => {
		const { config, row, tools } = setup("codex");
		const missing = join(elsewhereDir(), "new", "place");
		const plan = launchPlan(config, row, tools, { cwd: missing });
		expect(plan.steps[0]).toEqual({ text: `The folder ${missing} does not exist. Create it?`, confirm: true, fix: "create-folder" });
		expect(applyFix("create-folder", config, row, tools, { cwd: plan.cwd })).toBe(`Created ${missing}.`);
		expect(existsSync(missing)).toBe(true);
	});

	it("Claude Code outside the agent's folder: opened through the mod, refused only for the file setup", () => {
		const { config, row, tools, ws } = setup("claude-code");
		const elsewhere = elsewhereDir();
		// No setup: the mod, which needs no setup step in any folder.
		const plan = launchPlan(config, row, tools, { cwd: elsewhere });
		expect(plan.blocked).toBeUndefined();
		expect(plan.steps.map((s) => s.fix)).toEqual(["install-claude-code"]);
		// Set up the file way, for its own folder: refused elsewhere.
		writeSetupMarker(config.agents.get("A")!.dir, ws, "CLAUDE.md");
		expect(launchPlan(config, row, tools, { cwd: elsewhere }).blocked).toBe(
			"Claude Code opens A outside its folder only through the Orrery mod: run orrery claude-setup A --mod (Claude Code 2.1.287 or newer), then open it again.",
		);
		expect(launchPlan(config, row, tools, { cwd: ws }).blocked).toBeUndefined();
		writeSetupMarker(config.agents.get("A")!.dir, ws, "mod");
		expect(launchPlan(config, row, tools, { cwd: elsewhere }).blocked).toBeUndefined();
	});

	it("the claude-setup-mod fix switches a file-setup agent to the mod, after which it opens elsewhere", () => {
		const { config, row, tools, ws } = setup("claude-code");
		const elsewhere = elsewhereDir();
		writeSetupMarker(config.agents.get("A")!.dir, ws, "CLAUDE.md");
		expect(launchPlan(config, row, tools, { cwd: elsewhere }).blocked).toContain("only through the Orrery mod");
		expect(applyFix("claude-setup-mod", config, row, tools)).toContain("A: mod mode.");
		expect(agentMode(config.agents.get("A")!)).toBe("mod");
		expect(launchPlan(config, row, tools, { cwd: elsewhere }).blocked).toBeUndefined();
	});

	it("Claude Code in another agent's folder, whose CLAUDE.md loads that agent's memory view: refused", () => {
		const parent = tempDir("orrery-launch-b-");
		dirs.push(parent);
		const other = join(parent, "agent-B");
		mkdirSync(join(other, "sub"), { recursive: true });
		const { config, row, tools, ws } = setup("claude-code", undefined, `\n[agents.B]\nfolder = ${JSON.stringify(other)}\ncompactor_model = "openai/gpt-6.1-sol"\n`);
		writeSetupMarker(config.agents.get("A")!.dir, ws, "mod");
		writeSetupMarker(config.agents.get("B")!.dir, other, "CLAUDE.md");
		expect(launchPlan(config, row, tools, { cwd: other }).blocked).toBe(`${other} is B's folder, where Claude Code loads B's memory through CLAUDE.md; open A in another folder.`);
		// Claude Code loads every ancestor's CLAUDE.md too.
		expect(launchPlan(config, row, tools, { cwd: join(other, "sub") }).blocked).toBe(`${join(other, "sub")} is inside B's folder, where Claude Code loads B's memory through CLAUDE.md; open A in another folder.`);
		// B in mod mode writes no view file: A opens there.
		writeSetupMarker(config.agents.get("B")!.dir, other, "mod");
		expect(launchPlan(config, row, tools, { cwd: other }).blocked).toBeUndefined();
		// pi has no such rule: its guard keeps it out of B's view.
		writeSetupMarker(config.agents.get("B")!.dir, other, "CLAUDE.local.md");
		expect(launchPlan(config, row, tools, { cwd: other }).blocked).toBe(`${other} is B's folder, where Claude Code loads B's memory through CLAUDE.local.md; open A in another folder.`);
		expect(launchPlan(config, row, tools, { cwd: other, tool: "pi" }).blocked).toBeUndefined();
	});
});

describe("Ori launch plans", () => {
	it.each(["pi", "omp", "claude-code", "codex"])("launches %s through Ori with and without a model, preserving setup", (tool) => {
		for (const model of [undefined, "vendor/model"]) {
			const { config, row, tools, env, ws } = setup(tool, undefined, `launcher = "ori"\n${model ? `ori_model = "${model}"\n` : ""}`);
			const plan = launchPlan(config, row, tools, { env });
			expect(plan.command).toBe(join(env.PATH, "ori"));
			const ori = [tool === "claude-code" ? "claude" : tool, ...(model ? ["--model", model] : [])];
			// Codex gets Orrery's flags after Ori's own; the hook check asks the codex on PATH.
			expect(plan.args.slice(0, ori.length)).toEqual(ori);
			if (tool === "codex") expect(plan.codex).toMatchObject({ path: join(env.PATH, "codex"), plainArgs: ori });
			else expect(plan.args).toEqual(ori);
			expect(plan.cwd).toBe(ws);
			expect(plan.steps.at(-1)?.text).toBe(`Launching ${tool === "claude-code" ? "Claude Code" : tool === "omp" ? "OMP" : tool === "codex" ? "Codex" : tool} through Ori in ${ws}`);
		}
	});

	it("refuses a missing Ori without running the underlying tool", async () => {
		const { config, row, tools, env } = setup("codex", undefined, 'launcher = "ori"\n');
		rmSync(join(env.PATH, "ori"));
		const plan = launchPlan(config, row, tools, { env });
		expect(plan.blocked).toBe('Ori isn\'t installed: see docs/ori.md (or set launcher = "direct")');
		expect(plan.command).toBeUndefined();
		await expect(runTool(plan)).rejects.toThrow("Ori isn't installed");
	});
});


it("reports missing Ori even when the underlying agent is missing too", () => {
	const { config, row } = setup("pi", undefined, 'launcher = "ori"\n');
	expect(launchPlan(config, row, [], { env: { PATH: "/nonexistent" } }).blocked).toBe('Ori isn\'t installed: see docs/ori.md (or set launcher = "direct")');
});


it("warns before Ori launches OMP and names Ori when it fails", () => {
	const { config, row, tools, env } = setup("omp", undefined, 'launcher = "ori"\n');
	const plan = launchPlan(config, row, tools, { env });
	expect(plan.steps).toContainEqual({ text: expect.stringMatching(/Ori 0\.15\.7 can't start OMP/), confirm: false });
	expect(exitText(launchLabel(plan), { code: 1, signal: null })).toContain("OMP through Ori");
});

describe("Codex launch plans", () => {
	it("puts Orrery's flags before the person's arguments, says when the instructions were cut, and checks the hooks first", async () => {
		const { config, row, tools, env } = setup("codex");
		const agent = config.agents.get("A")!;
		writeInstructions(agent.dir, `${"x".repeat(33 * 1024)}\n`);
		const orrery = ["/opt/orrery/bin/orrery"];
		const plan = launchPlan(config, row, tools, { env, args: ["resume", "--last"], orrery });
		const launch = codexLaunch(agent, orrery);
		expect(plan.command).toBe(join(env.PATH, "codex"));
		// resume is a session subcommand: Orrery's flags go after it, where Codex applies them, with its own --no-daemon.
		expect(plan.args).toEqual(["--no-daemon", "resume", "--no-daemon", ...launch.config, "--last"]);
		expect(plan.steps).toEqual([{ text: cutNotice("A"), confirm: false }]);
		expect(plan.codex).toEqual({ path: join(env.PATH, "codex"), config: launch.config, plainArgs: ["resume", "--last"], notices: [cutNotice("A")] });
		expect(plan.env.ORRERY_AGENT).toBe("A");
		// The fake answers --version with "1.0": no version number, so the check runs at every launch.
		const asked: [string, readonly string[]][] = [];
		const said: string[] = [];
		const home = join(env.HOME, ".orrery");
		const probe = async (path: string, flags: readonly string[]) => (asked.push([path, flags]), { ok: false as const, why: "Codex lists no Stop hook from Orrery" });
		const gate = await checkCodexHooks(plan, { env: { ...env, ORRERY_HOME: home }, probe, onCheck: (text) => said.push(text) });
		expect(asked).toEqual([[join(env.PATH, "codex"), launch.config]]);
		expect(said).toEqual(["Checking that Orrery's hooks load in Codex…"]);
		expect(gate).toEqual({ ok: false, text: "Orrery's hooks don't load in Codex (its version is unknown): Codex lists no Stop hook from Orrery. Without them a session has no memory and no guard." });
		// A yes to starting without Orrery: plain Codex with the person's arguments, not as the agent.
		const plain = withoutOrrery(plan);
		expect(plain).toMatchObject({ command: join(env.PATH, "codex"), args: ["resume", "--last"], env: {}, unsetEnv: ["ORRERY_AGENT", "ORRERY_AGENT_TOKEN"], withoutOrrery: true });
		expect(plain.codex).toBeUndefined();
		// Plain Codex gets no instructions: the notice about cutting them is not said.
		expect(plain.steps).toEqual([]);
		expect(await runAgent(plain, async () => ({ code: 0, signal: null }))).toEqual({ code: 0, signal: null });
		// An ORRERY_AGENT and token this process inherited are taken out too, not only left unset by the plan.
		const seen: unknown[] = [];
		const fake = ((_c: string, _a: string[], o: { env?: unknown }) => {
			seen.push(o.env);
			const h: Record<string, (...a: unknown[]) => void> = {};
			setTimeout(() => h.exit?.(0, null), 0);
			return { on: (n: string, f: (...a: unknown[]) => void) => { h[n] = f; } };
		}) as never;
		await runTool(plain, { env: { PATH: "/bin", ORRERY_AGENT: "Other", ORRERY_AGENT_TOKEN: "e".repeat(32), ORRERY_CONFIG: "/x.toml" }, spawn: fake });
		expect(seen).toEqual([{ PATH: "/bin", ORRERY_CONFIG: "/x.toml" }]);
	});

	it("then checks, at every launch, that the shell Codex runs the hooks in starts without a word, with Codex's environment", async () => {
		const { config, row, tools, env } = setup("codex");
		const plan = launchPlan(config, row, tools, { env, orrery: ["/opt/orrery/bin/orrery"] });
		const ok = async () => ({ ok: true as const });
		const seen: [NodeJS.ProcessEnv, string][] = [];
		const quiet = (shellEnv: NodeJS.ProcessEnv, cwd: string) => (seen.push([shellEnv, cwd]), { quiet: true as const });
		expect(await checkCodexHooks(plan, { env: { ...env, ORRERY_AGENT: "Other" }, probe: ok, shellCheck: quiet })).toEqual({ ok: true });
		expect(await checkCodexHooks(plan, { env, probe: ok, shellCheck: quiet })).toEqual({ ok: true });
		expect(seen).toHaveLength(2);
		// The shell gets what Codex's hooks get: the launch's variables over this process's.
		expect(seen[0]?.[0]).toMatchObject({ PATH: env.PATH, ORRERY_AGENT: "A", ORRERY_AGENT_TOKEN: plan.env.ORRERY_AGENT_TOKEN });
		expect(seen[0]?.[1]).toBe(plan.cwd);
		const shell = { path: "/bin/bash", kind: "bash" as const };
		const noisy = await checkCodexHooks(plan, { env, probe: ok, shellCheck: () => ({ quiet: false, shell, source: "$BASH_ENV (/home/u/env.sh)" }) });
		expect(noisy).toEqual({
			ok: false,
			noisyShell: true,
			question: "Start Codex anyway?",
			text: "Codex runs Orrery's hooks through /bin/bash -c, which prints when it starts (most likely from $BASH_ENV (/home/u/env.sh)). Codex then can't read the hooks' answers, so A's memory won't load and its status won't show until that shell prints nothing when it isn't interactive; its turns are still recorded and the guard still works.",
		});
		// Hooks that don't load are said first; the shell is not asked.
		const notLoaded = await checkCodexHooks(plan, { env, probe: async () => ({ ok: false as const, why: "x" }), shellCheck: () => { throw new Error("must not ask"); } });
		expect(notLoaded).toMatchObject({ ok: false });
		expect("noisyShell" in notLoaded).toBe(false);
	});

	it("refuses a session subcommand after other arguments, where Codex would not apply Orrery's flags, and says how to write it", () => {
		const { config, row, tools, env } = setup("codex");
		for (const [args, fixed] of [
			[["-m", "gpt-x", "exec", "fix it"], "exec -m gpt-x 'fix it'"],
			[["-c", "k=v", "resume", "--last"], "resume -c k=v --last"],
			// The subcommand is the first word that is no option's value, wherever the same word comes again.
			[["-p", "exec", "exec", "go"], "exec -p exec go"],
		] as const) {
			const plan = launchPlan(config, row, tools, { env, args: [...args] });
			expect(plan.blocked).toBe(`Put Codex's subcommand first, or Codex won't apply Orrery's flags to the session (no memory, no guard): orrery agent A --tool codex -- ${fixed}`);
			expect(plan.steps).toEqual([]);
		}
		// An option's value named like a subcommand is no subcommand: the TUI opens, with Orrery's flags first.
		const folder = launchPlan(config, row, tools, { env, args: ["-C", "review"] });
		expect(folder.blocked).toBeUndefined();
		expect(folder.args.slice(-2)).toEqual(["-C", "review"]);
		// Other tools take their arguments as they are.
		const pi = setup("pi");
		expect(launchPlan(pi.config, pi.row, pi.tools, { env: pi.env, args: ["-m", "x", "exec"] }).blocked).toBeUndefined();
	});

	it("leaves every other tool's plan alone: no check, nothing to take away", async () => {
		for (const tool of ["pi", "omp", "claude-code"]) {
			const { config, row, tools, env } = setup(tool);
			const plan = launchPlan(config, row, tools, { env, args: ["-x"] });
			expect(plan.codex).toBeUndefined();
			expect(plan.args).toEqual(["-x"]);
			expect(withoutOrrery(plan)).toBe(plan);
			expect(await checkCodexHooks(plan, { probe: async () => { throw new Error("must not ask"); } })).toEqual({ ok: true });
			expect(plan.opencode).toBeUndefined();
			expect(await checkOpenCodePlugin(plan, { probe: async () => { throw new Error("must not ask"); } })).toEqual({ ok: true });
		}
	});
});

describe("OpenCode launch plans", () => {
	/** Orrery's home in the setup's scratch HOME. */
	const homeOf = (env: { HOME: string }) => join(env.HOME, ".orrery");

	it("runs opencode --standalone in the folder with Orrery's plugin in OPENCODE_CONFIG_CONTENT, and the token only in a file", async () => {
		const { config, row, env, ws } = setup("opencode");
		const fake = fakeOpenCode(env.PATH);
		const tools = checkTools({ root: orreryRoot(), env });
		expect(tools.find((t) => t.id === "opencode")).toMatchObject({ wiring: "memory", version: "opencode v2.0.30" });
		const plan = launchPlan(config, row, tools, { env, root: orreryRoot(), args: ["--continue"] });
		expect(plan.blocked).toBeUndefined();
		expect(plan.command).toBe(fake.path);
		expect(plan.args).toEqual(["--standalone", ws, "--continue"]);
		const opencode = plan.opencode!;
		const token = opencode.token;
		expect(token).toMatch(/^[0-9a-f]{32}$/);
		expect(opencode.tokenFile.startsWith(join(homeOf(env), "tokens", `opencode-${process.pid}-`))).toBe(true);
		expect(opencode.folder).toBe(join(orreryRoot(), "src", "opencode", "plugin"));
		expect(JSON.parse(opencode.content)).toEqual({ plugins: [{ package: opencode.folder, options: { agent: "A", tokenFile: opencode.tokenFile } }] });
		expect(opencode.version).toBe("2.0.30");
		expect(opencode.plainArgs).toEqual(["--continue"]);
		// The token is in no variable: OpenCode's environment reaches the model's shell and MCP servers.
		expect(plan.env).toEqual({ OPENCODE_CONFIG_CONTENT: opencode.content });
		expect(plan.unsetEnv).toEqual(["ORRERY_AGENT", "ORRERY_AGENT_TOKEN"]);
		expect(opencode.content).not.toContain(token);
		// The plugin claims the token while OpenCode runs, as pi's extension does.
		const result = await runAgent(plan, async (p) => {
			claimToken(plan.agentDir, token, 999_999);
			return runTool(p, { env: { ...env, ORRERY_AGENT: "Other", ORRERY_AGENT_TOKEN: "e".repeat(32) } });
		});
		expect(result).toEqual({ code: 0, signal: null, claimedBy: 999_999 });
		const run = fake.runs().find((r) => r.args[0] === "--standalone");
		expect(run?.args).toEqual(["--standalone", ws, "--continue"]);
		expect(realpathSync(run?.cwd as string)).toBe(realpathSync(ws));
		expect(run?.env.OPENCODE_CONFIG_CONTENT).toBe(opencode.content);
		expect([run?.env.ORRERY_AGENT, run?.env.ORRERY_AGENT_TOKEN]).toEqual([undefined, undefined]);
		expect(Object.values(run?.env ?? {}).some((value) => value.includes(token))).toBe(false);
		// While OpenCode ran, the token was in its file: 0600, in a 0700 folder.
		expect(run?.tokenFile).toEqual({ mode: 0o600, folderMode: 0o700, text: token });
		// Once it exited, the file and the claim are gone.
		expect(existsSync(opencode.tokenFile)).toBe(false);
		expect(readdirSync(join(plan.agentDir, "claims"))).toEqual([]);
		// Each plan has its own token and file.
		const again = launchPlan(config, row, tools, { env, root: orreryRoot() }).opencode!;
		expect(again.token).not.toBe(token);
		expect(again.tokenFile).not.toBe(opencode.tokenFile);
	});

	it("keeps the person's own OPENCODE_CONFIG_CONTENT, with Orrery's plugin added, and says so plainly when it can't be read", () => {
		const { config, row, env } = setup("opencode");
		fakeOpenCode(env.PATH);
		const tools = checkTools({ root: orreryRoot(), env });
		const theirs = { ...env, OPENCODE_CONFIG_CONTENT: '{\n  // mine\n  "model": "x/y",\n  "plugins": ["their-plugin"],\n}' };
		const plan = launchPlan(config, row, tools, { env: theirs, root: orreryRoot() });
		const opencode = plan.opencode!;
		const entry = JSON.parse(opencode.content).plugins[0];
		expect(JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT as string)).toEqual({ model: "x/y", plugins: ["their-plugin", entry] });
		// The plugin check loads Orrery's plugin alone.
		expect(JSON.parse(opencode.content)).toEqual({ plugins: [entry] });
		expect(plan.steps.map((step) => step.text).join("\n")).not.toMatch(/OPENCODE_CONFIG_CONTENT/);
		const unread = launchPlan(config, row, tools, { env: { ...env, OPENCODE_CONFIG_CONTENT: "{model: x}" }, root: orreryRoot() });
		expect(unread.env.OPENCODE_CONFIG_CONTENT).toBe(unread.opencode?.content);
		expect(unread.steps).toContainEqual({ text: expect.stringMatching(/^Your OPENCODE_CONFIG_CONTENT isn't JSON or JSONC \(.+\), so OpenCode starts with Orrery's plugin config alone, without yours\.$/), confirm: false });
	});

	it("removes the token file and the claim when OpenCode fails to start, and starts nothing when the file can't be written", async () => {
		const { config, row, tools, env } = setup("opencode");
		const plan = launchPlan(config, row, tools, { env, root: orreryRoot() });
		const { tokenFile, token } = plan.opencode!;
		await expect(
			runAgent(plan, async () => {
				expect(readFileSync(tokenFile, "utf8")).toBe(token);
				claimToken(plan.agentDir, token, 999_999);
				throw new Error("no spawn");
			}),
		).rejects.toThrow("no spawn");
		expect(existsSync(tokenFile)).toBe(false);
		expect(readdirSync(join(plan.agentDir, "claims"))).toEqual([]);
		// Orrery's token folder is a file: no token file, and OpenCode is not started.
		rmSync(join(homeOf(env), "tokens"), { recursive: true, force: true });
		writeFileSync(join(homeOf(env), "tokens"), "");
		let ran = false;
		await expect(runAgent(launchPlan(config, row, tools, { env, root: orreryRoot() }), async () => ((ran = true), { code: 0, signal: null }))).rejects.toThrow(/^OpenCode was not started: the token file for A could not be written \(/);
		expect(ran).toBe(false);
	});

	it("puts --standalone after run or mini, and refuses --server, other subcommands and Ori", () => {
		const { config, row, tools, env, ws } = setup("opencode");
		expect(launchPlan(config, row, tools, { env, args: ["run", "fix it"] }).args).toEqual(["run", "--standalone", "fix it"]);
		expect(launchPlan(config, row, tools, { env, args: ["--server", "http://127.0.0.1:4096"] }).blocked).toBe("OpenCode's --server connects to another server, which doesn't load Orrery's plugin (no memory, no guard): open A without it.");
		expect(launchPlan(config, row, tools, { env, args: ["acp"] }).blocked).toContain("opencode acp opens no session for A");
		const ori = setup("opencode", ws, 'launcher = "ori"\n');
		expect(launchPlan(ori.config, ori.row, ori.tools, { env: ori.env }).blocked).toBe('Orrery doesn\'t open OpenCode through Ori yet: open A with launcher = "direct" (orrery agent set A launcher direct), or in another tool.');
	});

	it("checks that the plugin loads with the plan's own config content and folder, and says so", async () => {
		const { config, row, tools, env } = setup("opencode");
		const plan = launchPlan(config, row, tools, { env, root: orreryRoot() });
		const asked: string[][] = [];
		const said: string[] = [];
		const probe = async (path: string, content: string, folder: string) => (asked.push([path, content, folder]), { ok: false as const, why: "OpenCode could not load Orrery's plugin (x)" });
		const gate = await checkOpenCodePlugin(plan, { env: { ...env, ORRERY_HOME: homeOf(env) }, probe, onCheck: (text) => said.push(text) });
		expect(asked).toEqual([[join(env.PATH, "opencode"), plan.opencode!.content, plan.opencode!.folder]]);
		// The fake says "1.0": no version number, so the check runs at every launch.
		expect(said).toEqual(["Checking that Orrery's plugin loads in OpenCode…"]);
		expect(gate).toEqual({ ok: false, text: "Orrery's plugin doesn't load in OpenCode (its version is unknown): OpenCode could not load Orrery's plugin (x). Without it a session has no memory and no guard." });
	});

	it("as plain OpenCode (a yes to starting without Orrery): the person's arguments, no plugin, no token, no agent", async () => {
		const { config, row, tools, env } = setup("opencode");
		const open = { ...row, state: "open" as const, openIn: "pi" as const };
		const plan = launchPlan(config, open, tools, { env, root: orreryRoot(), args: ["--continue"] });
		expect(plan.steps.map((step) => step.asAgent)).toEqual([true]);
		const plain = withoutOrrery(plan);
		expect(plain).toMatchObject({ command: join(env.PATH, "opencode"), args: ["--continue"], env: {}, unsetEnv: ["ORRERY_AGENT", "ORRERY_AGENT_TOKEN"], withoutOrrery: true, steps: [] });
		expect(plain.opencode).toBeUndefined();
		// No token file is written.
		expect(await runAgent(plain, async () => ({ code: 0, signal: null }))).toEqual({ code: 0, signal: null });
		expect(existsSync(join(homeOf(env), "tokens"))).toBe(false);
		// Started from the shell of an OpenCode that Orrery opened: that session's plugin config is not taken along,
		// while a config of the person's own is.
		const outer = { ...env, OPENCODE_CONFIG_CONTENT: plan.opencode!.content };
		const nested = withoutOrrery(launchPlan(config, row, tools, { env: outer, root: orreryRoot() }));
		expect(nested.unsetEnv).toEqual(["ORRERY_AGENT", "ORRERY_AGENT_TOKEN", "OPENCODE_CONFIG_CONTENT"]);
		const seen: unknown[] = [];
		const fake = ((_c: string, _a: string[], o: { env?: unknown }) => {
			seen.push(o.env);
			const h: Record<string, (...a: unknown[]) => void> = {};
			setTimeout(() => h.exit?.(0, null), 0);
			return { on: (n: string, f: (...a: unknown[]) => void) => { h[n] = f; } };
		}) as never;
		await runTool(nested, { env: outer, spawn: fake });
		expect(seen).toEqual([{ PATH: env.PATH, HOME: env.HOME }]);
		const own = { ...env, OPENCODE_CONFIG_CONTENT: '{"model":"x/y"}' };
		expect(withoutOrrery(launchPlan(config, row, tools, { env: own, root: orreryRoot() })).unsetEnv).toEqual(["ORRERY_AGENT", "ORRERY_AGENT_TOKEN"]);
	});
});
