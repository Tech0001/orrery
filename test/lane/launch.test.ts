import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/lane/config.ts";
import { applyFix, exitText, launchLabel, launchPlan, runTool } from "../../src/lane/launch.ts";
import { laneOverview } from "../../src/lane/overview.ts";
import { checkTools, ompExtensionFile, orreryRoot, piExtensionFile } from "../../src/lane/tools.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(tool: string, workspace?: string, extra = "") {
	const dir = tempDir("orrery-launch-");
	dirs.push(dir);
	const ws = workspace ?? join(dir, `my "odd" folder ünï`);
	mkdirSync(ws, { recursive: true });
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const out = join(dir, "out.txt");
	for (const name of ["pi", "claude", "codex", "omp", "ori"]) {
		writeFileSync(join(bin, name), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0; exit 0; fi\nif [ "$1" = "plugin" ]; then echo '[]'; exit 0; fi\npwd > ${JSON.stringify(out)}\nexit 3\n`);
		chmodSync(join(bin, name), 0o755);
	}
	const env = { PATH: bin, HOME: dir };
	const config = parseConfig(`data_dir = ${JSON.stringify(join(dir, "data"))}\n[lanes.A]\nworkspace = ${JSON.stringify(ws)}\ntool = "${tool}"\ncompactor_model = "openai/gpt-6.1-sol"\n${extra}`, dir);
	const row = laneOverview(config)[0];
	const tools = checkTools({ root: orreryRoot(), env });
	return { config, row, tools, env, ws, out };
}

describe("launchPlan and runTool", () => {
	it("runs the tool in the lane's folder (spaces, quotes, non-ASCII) and reports its exit code", async () => {
		const { config, row, tools, env, ws, out } = setup("codex");
		const plan = launchPlan(config, row, tools);
		expect(plan.blocked).toBeUndefined();
		expect(plan.steps).toEqual([{ text: "Codex has no Orrery memory yet: this session won't be recorded.", confirm: false }]);
		const exit = await runTool(plan, { env });
		expect(readFileSync(out, "utf8").trim()).toBe(ws);
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

	it("blocks when the tool is not on PATH, and offers to create a missing folder", () => {
		const { config, row, env } = setup("pi");
		const noTools = checkTools({ root: orreryRoot(), env: { ...env, PATH: "/nonexistent" } });
		expect(launchPlan(config, row, noTools).blocked).toBe('pi is not on PATH (looked for "pi"). Get it at https://pi.dev, or change the lane\'s tool with E.');
		const gone = { ...row, workspace: join(row.workspace, "missing") };
		const plan = launchPlan(config, gone, checkTools({ root: orreryRoot(), env }));
		expect(plan.steps[0]).toEqual({ text: `The folder ${gone.workspace} does not exist. Create it?`, confirm: true, fix: "create-folder" });
		applyFix("create-folder", config, gone, []);
		expect(existsSync(gone.workspace)).toBe(true);
	});

	it("warns that a second session won't record when the lane is open", () => {
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
		await runTool(plan, { env: { ORRERY_CONFIG: "/x.toml" }, spawn: fake });
		expect(seen).toEqual([{ ORRERY_CONFIG: "/x.toml" }]);
	});

	it("asks before launching OMP without its extension, saying the file it writes, and installs it on yes; omp gets no arguments", () => {
		const { config, row, tools, env } = setup("omp");
		const plan = launchPlan(config, row, tools, { root: orreryRoot(), env });
		const describe = `write ${ompExtensionFile(env)} (a relative re-export of ${join(orreryRoot(), "src", "omp", "index.ts")})`;
		expect(plan.steps).toEqual([{ text: `Orrery's OMP extension is not installed, so this session won't record. Installing it will:\n  ${describe}\nInstall it now?`, confirm: true, fix: "install-omp" }]);
		expect(plan.args).toEqual([]);
		expect(applyFix("install-omp", config, row, tools, { root: orreryRoot(), env })).toContain("wrote ");
	});

	it("blocks when OMP is not on PATH, and names OMP when a lane is open in it", () => {
		const { config, row, env } = setup("omp");
		const noTools = checkTools({ root: orreryRoot(), env: { ...env, PATH: "/nonexistent" } });
		expect(launchPlan(config, row, noTools).blocked).toBe('OMP is not on PATH (looked for "omp"). Get it at https://omp.sh, or change the lane\'s tool with E.');
		const codex = setup("codex");
		const open = { ...codex.row, state: "open" as const, openIn: "omp" as const };
		expect(launchPlan(codex.config, open, codex.tools).steps[0]).toEqual({ text: "A is already open in OMP. A second session won't record. Launch anyway?", confirm: true });
	});
});


describe("Ori launch plans", () => {
	it.each(["pi", "omp", "claude-code", "codex"])("launches %s through Ori with and without a model, preserving setup", (tool) => {
		for (const model of [undefined, "vendor/model"]) {
			const { config, row, tools, env, ws } = setup(tool, undefined, `launcher = "ori"\n${model ? `ori_model = "${model}"\n` : ""}`);
			const plan = launchPlan(config, row, tools, { env });
			expect(plan.command).toBe(join(env.PATH, "ori"));
			expect(plan.args).toEqual([tool === "claude-code" ? "claude" : tool, ...(model ? ["--model", model] : [])]);
			expect(plan.cwd).toBe(ws);
			expect(plan.steps.at(-1)?.text).toBe(`Launching ${tool === "claude-code" ? "Claude Code" : tool === "omp" ? "OMP" : tool === "codex" ? "Codex" : tool} through Ori in ${ws}`);
			if (tool === "claude-code") expect(plan.steps.some((s) => s.fix === "claude-setup")).toBe(true);
			if (tool === "codex") expect(plan.steps[0].text).toContain("no Orrery memory yet");
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
