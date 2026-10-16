import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentMode, writeSetupMarker } from "../../src/claude/view-file.ts";
import { parseConfig } from "../../src/agent/config.ts";
import { applyFix, checkCodexHooks, exitText, launchLabel, launchPlan, runAgent, runTool, withoutOrrery } from "../../src/agent/launch.ts";
import { cutNotice, writeInstructions } from "../../src/agent/instructions.ts";
import { codexLaunch } from "../../src/codex/launch.ts";
import { claimToken } from "../../src/agent/pick.ts";
import { agentOverview } from "../../src/agent/overview.ts";
import { checkTools, ompExtensionFile, orreryRoot, piExtensionFile } from "../../src/agent/tools.ts";
import { tempDir } from "./support.ts";

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
	for (const name of ["pi", "claude", "codex", "omp", "ori"]) {
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

	it("asks to set up Claude Code's memory import, and to install the plugin, listing the commands", () => {
		const { config, row, tools, env } = setup("claude-code");
		const plan = launchPlan(config, row, tools, { root: orreryRoot(), env });
		expect(plan.steps.map((s) => s.fix)).toEqual(["install-claude-code", "claude-setup"]);
		expect(plan.steps[0].text).toBe(`The Orrery plugin for Claude Code is not installed. Installing it will:\n  claude plugin marketplace add ${orreryRoot()}\n  claude plugin install orrery@orrery\nInstall it now?`);
	});

	it("neither blocks nor offers an install when Claude Code's plugin list is in a shape Orrery doesn't know", () => {
		const { config, row, tools } = setup("claude-code");
		const unknown = tools.map((t) => (t.id === "claude-code" ? { ...t, wiring: "unknown" as const, detail: "?" } : t));
		const plan = launchPlan(config, row, unknown);
		expect(plan.blocked).toBeUndefined();
		expect(plan.steps.map((s) => s.fix)).toEqual(["claude-setup"]);
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
		expect(launchPlan(config, open, tools).steps[0]).toEqual({ text: "A is already open in pi. A second session won't record. Launch anyway?", confirm: true });
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
		expect(launchPlan(codex.config, open, codex.tools).steps[0]).toEqual({ text: "A is already open in OMP. A second session won't record. Launch anyway?", confirm: true });
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
		expect(await runAgent(plan, (p) => runTool(p, { env }))).toEqual({ code: 0, signal: null });
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

	it("Claude Code outside the agent's folder: refused without the mod, opened with it", () => {
		const { config, row, tools, ws } = setup("claude-code");
		const elsewhere = elsewhereDir();
		expect(launchPlan(config, row, tools, { cwd: elsewhere }).blocked).toBe(
			"Claude Code opens A outside its folder only through the Orrery mod: run orrery claude-setup A --mod (Claude Code 2.1.287 or newer), then open it again.",
		);
		// Set up the file way, for its own folder: still refused elsewhere.
		writeSetupMarker(config.agents.get("A")!.dir, ws, "CLAUDE.md");
		expect(launchPlan(config, row, tools, { cwd: elsewhere }).blocked).toContain("only through the Orrery mod");
		expect(launchPlan(config, row, tools, { cwd: ws }).blocked).toBeUndefined();
		writeSetupMarker(config.agents.get("A")!.dir, ws, "mod");
		const plan = launchPlan(config, row, tools, { cwd: elsewhere });
		expect(plan.blocked).toBeUndefined();
		// The mod needs no setup step in any folder.
		expect(plan.steps.map((s) => s.fix)).not.toContain("claude-setup");
	});

	it("the claude-setup-mod fix switches the agent to the mod, after which it opens elsewhere", () => {
		const { config, row, tools } = setup("claude-code");
		const elsewhere = elsewhereDir();
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
			if (tool === "claude-code") expect(plan.steps.some((s) => s.fix === "claude-setup")).toBe(true);
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
		expect(plan.args).toEqual([...launch.args, "resume", "--last"]);
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

	it("leaves every other tool's plan alone: no check, nothing to take away", async () => {
		for (const tool of ["pi", "omp", "claude-code"]) {
			const { config, row, tools, env } = setup(tool);
			const plan = launchPlan(config, row, tools, { env, args: ["-x"] });
			expect(plan.codex).toBeUndefined();
			expect(plan.args).toEqual(["-x"]);
			expect(withoutOrrery(plan)).toBe(plan);
			expect(await checkCodexHooks(plan, { probe: async () => { throw new Error("must not ask"); } })).toEqual({ ok: true });
		}
	});
});
