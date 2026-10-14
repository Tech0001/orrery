/**
 * Launching a lane in its tool (spec 2026-10-08-orrery-tui-design §4.5): what runs and where, what to ask first,
 * fixing what can be fixed, and running the tool with the terminal attached. Node only.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { claudeSetup, setupReport } from "../claude/setup.ts";
import { markedHere } from "../claude/view-file.ts";
import { findLane, type HarnessConfig, type LaneLauncher, type LaneTool } from "./config.ts";
import { type LaneRow, TOOL_LABELS } from "./overview.ts";
import { BINARIES, findOnPath, installSteps, wiringRoot, type Runner, realRunner, runInstall, type ToolCheck } from "./tools.ts";

const HINTS: Record<LaneTool, string> = { pi: "Get it at https://pi.dev", "claude-code": "Get it at https://claude.com/claude-code", codex: "Get it at https://github.com/openai/codex", omp: "Get it at https://omp.sh" };

export type LaunchFix = "create-folder" | "install-pi" | "install-omp" | "install-claude-code" | "claude-setup";

export interface LaunchStep {
	readonly text: string;
	/** Needs a yes; a no cancels the launch. */
	readonly confirm: boolean;
	/** What a yes does before launching. */
	readonly fix?: LaunchFix;
}

export interface LaunchPlan {
	readonly lane: string;
	readonly tool: LaneTool;
	readonly launcher?: LaneLauncher;
	readonly command?: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly steps: readonly LaunchStep[];
	/** Why it cannot launch at all. */
	readonly blocked?: string;
}

/** "<what>. Installing it will:\n  <step>\n  <step>\nInstall it now?": an install question that lists what a yes does first (spec §4.6). */
function installQuestion(what: string, check: ToolCheck, options: { root?: string; env?: NodeJS.ProcessEnv }): string {
	const steps = installSteps(check, options.root ?? wiringRoot(options.env).root, options.env ?? process.env);
	return `${what}. Installing it will:\n${steps.map((step) => `  ${step.describe}`).join("\n")}\nInstall it now?`;
}

/** What launching `row` runs, and what to say or ask first. `root` and `env` are where the install steps look (tests). */
export function launchPlan(config: HarnessConfig, row: LaneRow, tools: readonly ToolCheck[], options: { root?: string; env?: NodeJS.ProcessEnv } = {}): LaunchPlan {
	const lane = findLane(config, row.name);
	const label = TOOL_LABELS[row.tool];
	const check = tools.find((t) => t.id === row.tool);
	// A lane with no default folder opens here.
	const cwd = row.workspace ?? process.cwd();
	const base = { lane: row.name, tool: row.tool, ...(lane.launcher === "ori" ? { launcher: "ori" as const } : {}), args: [] as string[], cwd };
	const ori = lane.launcher === "ori" ? findOnPath("ori", options.env ?? process.env) : undefined;
	if (lane.launcher === "ori" && ori === undefined) return { ...base, steps: [], blocked: 'Ori isn\'t installed: see docs/ori.md (or set launcher = "direct")' };
	if (check?.path === undefined) return { ...base, steps: [], blocked: `${label} is not on PATH (looked for "${BINARIES[row.tool]}"). ${HINTS[row.tool]}, or change the lane's tool with E.` };
	const steps: LaunchStep[] = [];
	if (!existsSync(cwd)) steps.push({ text: `The folder ${cwd} does not exist. Create it?`, confirm: true, fix: "create-folder" });
	if ((row.state === "open" || row.state === "working") && row.openIn !== undefined) {
		steps.push({ text: `${row.name} is already open in ${TOOL_LABELS[row.openIn]}. A second session won't record. Launch anyway?`, confirm: true });
	}
	// "update available" for pi or OMP: the file names Orrery's entry of the other install shape, which app/current lacks.
	const stale = (label: string) => (check.wiring === "missing" ? `Orrery's ${label} extension is not installed` : `Orrery's ${label} extension names the other install shape's entry`);
	if (row.tool === "pi" && (check.wiring === "missing" || check.wiring === "update available")) steps.push({ text: installQuestion(`${stale("pi")}, so this session won't record`, check, options), confirm: true, fix: "install-pi" });
	if (row.tool === "pi" && check.wiring === "other") steps.push({ text: `pi's Orrery extension ${check.detail}. Launch anyway?`, confirm: true });
	if (row.tool === "omp" && (check.wiring === "missing" || check.wiring === "update available")) steps.push({ text: installQuestion(`${stale("OMP")}, so this session won't record`, check, options), confirm: true, fix: "install-omp" });
	if (row.tool === "omp" && check.wiring === "other") steps.push({ text: `OMP's Orrery extension: ${check.detail}. Launch anyway?`, confirm: true });
	if (row.tool === "claude-code") {
		// "unknown" (a plugin list orrery cannot read) neither blocks nor offers an install: the plugin may well be there.
		if (check.wiring === "missing" || check.wiring === "update available") {
			steps.push({ text: installQuestion(`The Orrery plugin for Claude Code is ${check.wiring === "missing" ? "not installed" : "out of date"}`, check, options), confirm: true, fix: "install-claude-code" });
		}
		if (!markedHere(lane)) steps.push({ text: `Claude Code does not load ${row.name}'s memory in this folder yet. Set it up now (orrery claude-setup)?`, confirm: true, fix: "claude-setup" });
	}
	if (row.tool === "codex") steps.push({ text: "Codex has no Orrery memory yet: this session won't be recorded.", confirm: false });
	if (ori !== undefined) {
		if (row.tool === "omp") steps.push({ text: 'Ori 0.15.7 can\'t start OMP: its model registration fails before startup. See docs/ori.md, or set launcher = "direct".', confirm: false });
		steps.push({ text: `Launching ${label} through Ori in ${cwd}`, confirm: false });
		return { ...base, command: ori, args: [BINARIES[row.tool], ...(lane.oriModel === undefined ? [] : ["--model", lane.oriModel])], steps };
	}
	return { ...base, command: check.path, steps };
}

/** Does what a yes to a launch step asked; returns what it did, for showing. Throws when it fails. */
export function applyFix(fix: LaunchFix, config: HarnessConfig, row: LaneRow, tools: readonly ToolCheck[], options: { root?: string; env?: NodeJS.ProcessEnv; run?: Runner } = {}): string {
	if (fix === "create-folder") {
		const folder = row.workspace ?? process.cwd();
		mkdirSync(folder, { recursive: true });
		return `Created ${folder}.`;
	}
	if (fix === "claude-setup") return setupReport(claudeSetup(findLane(config, row.name)));
	const check = tools.find((t) => t.id === (fix === "install-pi" ? "pi" : fix === "install-omp" ? "omp" : "claude-code"));
	if (check === undefined) throw new Error("That tool was not checked.");
	const result = runInstall(installSteps(check, options.root ?? wiringRoot(options.env).root, options.env), options.run ?? realRunner);
	if (!result.ok) throw new Error(result.output);
	return result.output;
}

export interface ToolExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

/** Runs the tool in the lane's folder with this terminal attached; Ctrl-C goes to the tool, not to orrery. */
export function runTool(plan: LaunchPlan, options: { spawn?: typeof spawn; env?: NodeJS.ProcessEnv } = {}): Promise<ToolExit> {
	if (plan.command === undefined) return Promise.reject(new Error(plan.blocked ?? "Nothing to run."));
	const ignore = () => {};
	process.on("SIGINT", ignore);
	return new Promise((done, fail) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = (options.spawn ?? spawn)(plan.command as string, [...plan.args], { cwd: plan.cwd, stdio: "inherit", env: options.env ?? process.env });
		} catch (error) {
			process.off("SIGINT", ignore);
			fail(error);
			return;
		}
		child.on("error", (error) => {
			process.off("SIGINT", ignore);
			fail(error);
		});
		child.on("exit", (code, signal) => {
			process.off("SIGINT", ignore);
			done({ code, signal });
		});
	});
}

/** "pi exited with code 1." or "pi was stopped (SIGTERM)."; undefined for a clean exit. */
export function exitText(label: string, exit: ToolExit): string | undefined {
	if (exit.signal !== null) return `${label} was stopped (${exit.signal}).`;
	return exit.code === 0 ? undefined : `${label} exited with code ${exit.code}.`;
}

/** Names the launcher too, so an Ori startup failure is not blamed only on the agent. */
export function launchLabel(plan: LaunchPlan): string {
	return `${TOOL_LABELS[plan.tool]}${plan.launcher === "ori" ? " through Ori" : ""}`;
}
