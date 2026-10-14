/**
 * Opening a lane in its tool (spec 2026-10-08-orrery-tui-design §4.5; spec 2026-10-13-orrery-agents-design §4): what
 * runs and where, what to ask first, fixing what can be fixed, and running the tool with the terminal attached, as the
 * agent (ORRERY_AGENT and a fresh ORRERY_AGENT_TOKEN, src/lane/pick.ts). `orrery agent` and the TUI's Enter and L use
 * it. Node only.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { claudeSetup, claudeSetupMod, modSetupReport, setupReport } from "../claude/setup.ts";
import { laneMode, markedHere, readSetupMarker } from "../claude/view-file.ts";
import { buildRunning, readBuild } from "./build.ts";
import { findLane, type HarnessConfig, inWorkspace, type LaneConfig, type LaneLauncher, type LaneTool } from "./config.ts";
import { type LaneRow, TOOL_LABELS } from "./overview.ts";
import { AGENT_ENV, newToken, releaseClaim, TOKEN_ENV, workArea } from "./pick.ts";
import { BINARIES, findOnPath, installSteps, wiringRoot, type Runner, realRunner, runInstall, type ToolCheck } from "./tools.ts";

const HINTS: Record<LaneTool, string> = { pi: "Get it at https://pi.dev", "claude-code": "Get it at https://claude.com/claude-code", codex: "Get it at https://github.com/openai/codex", omp: "Get it at https://omp.sh" };

export type LaunchFix = "create-folder" | "install-pi" | "install-omp" | "install-claude-code" | "claude-setup" | "claude-setup-mod";

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
	/** Added to the tool's environment: ORRERY_AGENT and ORRERY_AGENT_TOKEN (src/lane/pick.ts). */
	readonly env: Readonly<Record<string, string>>;
	/** The lane's folder in Orrery's home, where the tool's extension claims the token, and runAgent removes the claim. */
	readonly laneDir: string;
	readonly steps: readonly LaunchStep[];
	/** Why it cannot launch at all. */
	readonly blocked?: string;
	/** Blocked only because Claude Code opens this lane here through the Orrery mod alone: claude-setup-mod opens it. */
	readonly needsMod?: true;
}

export interface LaunchOptions {
	/** Where the install steps look (tests). */
	readonly root?: string;
	readonly env?: NodeJS.ProcessEnv;
	/** The folder the tool starts in: default the lane's workspace, else this process's folder. */
	readonly cwd?: string;
	/** The tool for this session only (orrery agent --tool). */
	readonly tool?: LaneTool;
	/** Handed to the tool as they are (orrery agent … -- <tool arguments>). */
	readonly args?: readonly string[];
	/** How the person picks another tool where they are, ending the not-on-PATH text (default: the TUI's C). */
	readonly changeTool?: string;
}

/** "<what>. Installing it will:\n  <step>\n  <step>\nInstall it now?": an install question that lists what a yes does first (spec §4.6). */
function installQuestion(what: string, check: ToolCheck, options: { root?: string; env?: NodeJS.ProcessEnv }): string {
	const steps = installSteps(check, options.root ?? wiringRoot(options.env).root, options.env ?? process.env);
	return `${what}. Installing it will:\n${steps.map((step) => `  ${step.describe}`).join("\n")}\nInstall it now?`;
}

/**
 * Why Claude Code cannot open `lane` in `cwd`, or undefined when it can. Outside its folder it gets the lane's memory only
 * from the Orrery mod (`needsMod`). In a folder that another lane, set up the file way, holds (its own folder or an
 * ancestor's: Claude Code loads every ancestor's CLAUDE.md and CLAUDE.local.md), that file loads the other lane's memory
 * view into the session; the plugin refuses such a session too (src/claude/pick.ts).
 */
function claudeCodeRefusal(config: HarnessConfig, lane: LaneConfig, cwd: string, inFolder: boolean): { readonly text: string; readonly needsMod?: true } | undefined {
	for (const host of config.lanes.values()) {
		if (host.name === lane.name || !inWorkspace(host, cwd) || laneMode(host) !== "file") continue;
		const file = readSetupMarker(host.dir)?.file ?? "CLAUDE.md";
		const where = host.workspace !== undefined && resolve(host.workspace) === cwd ? "" : "inside ";
		return { text: `${cwd} is ${where}${host.name}'s folder, where Claude Code loads ${host.name}'s memory through ${file}; open ${lane.name} in another folder.` };
	}
	if (!inFolder && laneMode(lane) !== "mod") {
		return { text: `Claude Code opens ${lane.name} outside its folder only through the Orrery mod: run orrery claude-setup ${lane.name} --mod (Claude Code 2.1.287 or newer), then open it again.`, needsMod: true };
	}
	return undefined;
}

/**
 * What opening `row` runs, where, and what to say or ask first. The tool starts in `options.cwd` (default: the lane's
 * folder, else this process's folder) as the agent: ORRERY_AGENT and a fresh token in its environment.
 */
export function launchPlan(config: HarnessConfig, row: LaneRow, tools: readonly ToolCheck[], options: LaunchOptions = {}): LaunchPlan {
	const lane = findLane(config, row.name);
	const tool = options.tool ?? row.tool;
	const label = TOOL_LABELS[tool];
	const check = tools.find((t) => t.id === tool);
	// A lane with no default folder opens here.
	const cwd = resolve(options.cwd ?? row.workspace ?? process.cwd());
	const base = {
		lane: row.name,
		tool,
		...(lane.launcher === "ori" ? { launcher: "ori" as const } : {}),
		args: [...(options.args ?? [])],
		cwd,
		env: { [AGENT_ENV]: lane.name, [TOKEN_ENV]: newToken() },
		laneDir: lane.dir,
	};
	const ori = lane.launcher === "ori" ? findOnPath("ori", options.env ?? process.env) : undefined;
	if (lane.launcher === "ori" && ori === undefined) return { ...base, steps: [], blocked: 'Ori isn\'t installed: see docs/ori.md (or set launcher = "direct")' };
	if (check?.path === undefined) return { ...base, steps: [], blocked: `${label} is not on PATH (looked for "${BINARIES[tool]}"). ${HINTS[tool]}, or ${options.changeTool ?? "change the lane's tool with C"}.` };
	// An imported agent's memory is built in the background (src/lane/build.ts): a session now would summarize alongside it.
	const build = readBuild(lane.dir);
	if (build !== undefined && buildRunning(build)) {
		return { ...base, steps: [], blocked: `${lane.name}'s memory is still being built (${build.summaries} summaries for ${build.messages} messages); open it when the build finishes.` };
	}
	const inFolder = lane.workspace !== undefined && workArea(lane, cwd) === lane.workspace;
	const refused = tool === "claude-code" ? claudeCodeRefusal(config, lane, cwd, inFolder) : undefined;
	if (refused !== undefined) return { ...base, steps: [], blocked: refused.text, ...(refused.needsMod === true ? { needsMod: true as const } : {}) };
	const steps: LaunchStep[] = [];
	if (!existsSync(cwd)) steps.push({ text: `The folder ${cwd} does not exist. Create it?`, confirm: true, fix: "create-folder" });
	if ((row.state === "open" || row.state === "working") && row.openIn !== undefined) {
		steps.push({ text: `${row.name} is already open in ${TOOL_LABELS[row.openIn]}. A second session won't record. Launch anyway?`, confirm: true });
	}
	// "update available" for pi or OMP: the file names Orrery's entry of the other install shape, which app/current lacks.
	const stale = (label: string) => (check.wiring === "missing" ? `Orrery's ${label} extension is not installed` : `Orrery's ${label} extension names the other install shape's entry`);
	if (tool === "pi" && (check.wiring === "missing" || check.wiring === "update available")) steps.push({ text: installQuestion(`${stale("pi")}, so this session won't record`, check, options), confirm: true, fix: "install-pi" });
	if (tool === "pi" && check.wiring === "other") steps.push({ text: `pi's Orrery extension ${check.detail}. Launch anyway?`, confirm: true });
	if (tool === "omp" && (check.wiring === "missing" || check.wiring === "update available")) steps.push({ text: installQuestion(`${stale("OMP")}, so this session won't record`, check, options), confirm: true, fix: "install-omp" });
	if (tool === "omp" && check.wiring === "other") steps.push({ text: `OMP's Orrery extension: ${check.detail}. Launch anyway?`, confirm: true });
	if (tool === "claude-code") {
		// "unknown" (a plugin list orrery cannot read) neither blocks nor offers an install: the plugin may well be there.
		if (check.wiring === "missing" || check.wiring === "update available") {
			steps.push({ text: installQuestion(`The Orrery plugin for Claude Code is ${check.wiring === "missing" ? "not installed" : "out of date"}`, check, options), confirm: true, fix: "install-claude-code" });
		}
		// Outside its folder only the mod opens it (claudeCodeRefusal), and the mod needs no file in any folder.
		if (inFolder && !markedHere(lane)) steps.push({ text: `Claude Code does not load ${row.name}'s memory in this folder yet. Set it up now (orrery claude-setup)?`, confirm: true, fix: "claude-setup" });
	}
	if (tool === "codex") steps.push({ text: "Codex has no Orrery memory yet: this session won't be recorded.", confirm: false });
	if (ori !== undefined) {
		if (tool === "omp") steps.push({ text: 'Ori 0.15.7 can\'t start OMP: its model registration fails before startup. See docs/ori.md, or set launcher = "direct".', confirm: false });
		steps.push({ text: `Launching ${label} through Ori in ${cwd}`, confirm: false });
		return { ...base, command: ori, args: [BINARIES[tool], ...(lane.oriModel === undefined ? [] : ["--model", lane.oriModel]), ...base.args], steps };
	}
	return { ...base, command: check.path, steps };
}

/**
 * Does what a yes to a launch step asked; returns what it did, for showing. Throws when it fails. `cwd` is the folder the
 * plan opens in (create-folder makes it).
 */
export function applyFix(fix: LaunchFix, config: HarnessConfig, row: LaneRow, tools: readonly ToolCheck[], options: { root?: string; env?: NodeJS.ProcessEnv; run?: Runner; cwd?: string } = {}): string {
	if (fix === "create-folder") {
		const folder = options.cwd ?? row.workspace ?? process.cwd();
		mkdirSync(folder, { recursive: true });
		return `Created ${folder}.`;
	}
	if (fix === "claude-setup") return setupReport(claudeSetup(findLane(config, row.name)));
	if (fix === "claude-setup-mod") return modSetupReport(claudeSetupMod(findLane(config, row.name)));
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

/**
 * Runs the tool in the plan's folder with this terminal attached, the plan's variables over `env`'s; Ctrl-C goes to the
 * tool, not to orrery.
 */
export function runTool(plan: LaunchPlan, options: { spawn?: typeof spawn; env?: NodeJS.ProcessEnv } = {}): Promise<ToolExit> {
	if (plan.command === undefined) return Promise.reject(new Error(plan.blocked ?? "Nothing to run."));
	const ignore = () => {};
	process.on("SIGINT", ignore);
	return new Promise((done, fail) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = (options.spawn ?? spawn)(plan.command as string, [...plan.args], { cwd: plan.cwd, stdio: "inherit", env: { ...(options.env ?? process.env), ...plan.env } });
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

/** Runs the plan's tool, then removes the claim its token made (src/lane/pick.ts), however the tool ended. */
export async function runAgent(plan: LaunchPlan, run: (plan: LaunchPlan) => Promise<ToolExit>): Promise<ToolExit> {
	try {
		return await run(plan);
	} finally {
		releaseClaim(plan.laneDir, plan.env[TOKEN_ENV] ?? "");
	}
}

export interface GateDeps {
	refreshRemote?(config: HarnessConfig, name: string): Promise<void>;
	overview(config: HarnessConfig): LaneRow[];
	say?(text: string): void;
}

/**
 * Before a remote lane opens (orrery agent, the TUI's Enter and L): its remote is asked now. A lane open on another
 * machine is refused; a stale one comes back with the takeover question, which the caller asks after the plan's own
 * checks.
 */
export async function remoteGate(config: HarnessConfig, row: LaneRow, deps: GateDeps): Promise<{ readonly go: true; readonly row: LaneRow; readonly takeover?: string } | { readonly go: false; readonly text: string }> {
	if (row.remote === undefined) return { go: true, row };
	if (deps.refreshRemote === undefined) return { go: false, text: "Remote launch is unavailable here." };
	deps.say?.(`Checking ${row.name} on ${row.remote}…`);
	await deps.refreshRemote(config, row.remote);
	const current = deps.overview(config).find((lane) => lane.name === row.name);
	if (current === undefined || current.remoteReachable !== true) return { go: false, text: `Could not check remote ${row.remote}; ${row.name} was not launched. Try again when it is reachable.` };
	const held = current.heldElsewhere;
	if (held === undefined) return { go: true, row: current };
	const at = new Date(held.lastSeen);
	const lastSeen = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
	if (!held.stale) return { go: false, text: `${row.name} is open on ${held.machine} (last seen ${lastSeen})` };
	return { go: true, row: current, takeover: `${row.name} was open on ${held.machine}, last seen ${lastSeen}, saved up to save ${held.newestSave}. Take over?` };
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
