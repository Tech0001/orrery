/**
 * Opening an agent in its tool (spec 2026-10-08-orrery-tui-design §4.5; spec 2026-10-13-orrery-agents-design §4): what
 * runs and where, what to ask first, fixing what can be fixed, and running the tool with the terminal attached, as the
 * agent (ORRERY_AGENT and a fresh ORRERY_AGENT_TOKEN, src/agent/pick.ts). `orrery agent` and the TUI's Enter and L use
 * it. No tool gets a coding tool's variables (toolEnv), even ones this process inherited.
 * Codex gets Orrery's hooks, memory tools and instructions on its command line (src/codex/launch.ts), after the hook
 * check (src/codex/check.ts). OpenCode gets Orrery's plugin through OPENCODE_CONFIG_CONTENT and the agent's token as a
 * file, never in its environment (src/opencode/launch.ts, src/opencode/token-file.ts), after the plugin check
 * (src/opencode/check.ts). Node only.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { claudeSetup, claudeSetupMod, modSetupReport, setupReport } from "../claude/setup.ts";
import { agentMode, markedHere, readSetupMarker } from "../claude/view-file.ts";
import { type CodexGate, codexHookGate, type probeHooks } from "../codex/check.ts";
import { codexArgs, codexLaunch, misplacedSubcommand, orreryCommand, subcommandFirst } from "../codex/launch.ts";
import { checkHookShell, NOISY_SHELL_QUESTION, noisyShellText, type ShellCheck } from "../codex/shell.ts";
import { type OpenCodeGate, opencodePluginGate, type probePlugin } from "../opencode/check.ts";
import { argsRefusal, inheritsOrreryPlugin, launchConfigContent, opencodeArgs, pluginFolder } from "../opencode/launch.ts";
import { configContent } from "../opencode/options.ts";
import { removeOnSignals, removeTokenFile, tokenFilePath, writeTokenFile } from "../opencode/token-file.ts";
import { buildRunning, readBuild } from "./build.ts";
import { findAgent, type HarnessConfig, insideFolder, type AgentConfig, type AgentLauncher, type AgentTool } from "./config.ts";
import { type AgentRow, TOOL_LABELS } from "./overview.ts";
import { AGENT_ENV, claimedBy, newToken, releaseClaim, TOKEN_ENV, workArea } from "./pick.ts";
import { TOOL_MARKERS } from "./sessions.ts";
import { BINARIES, codexVersion, findOnPath, installSteps, orreryVersion, wiringRoot, type Runner, realRunner, runInstall, type ToolCheck } from "./tools.ts";

const HINTS: Record<AgentTool, string> = { pi: "Get it at https://pi.dev", "claude-code": "Get it at https://claude.com/claude-code", codex: "Get it at https://github.com/openai/codex", omp: "Get it at https://omp.sh", opencode: "Get it at https://opencode.ai" };

export type LaunchFix = "create-folder" | "install-pi" | "install-omp" | "install-claude-code" | "claude-setup" | "claude-setup-mod";

export interface LaunchStep {
	readonly text: string;
	/** Needs a yes; a no cancels the launch. */
	readonly confirm: boolean;
	/** What a yes does before launching. */
	readonly fix?: LaunchFix;
	/** A question about opening the agent itself (it is open elsewhere): plain Codex (withoutOrrery), which opens no agent, skips it. */
	readonly asAgent?: true;
}

export interface LaunchPlan {
	readonly agent: string;
	readonly tool: AgentTool;
	readonly launcher?: AgentLauncher;
	readonly command?: string;
	readonly args: readonly string[];
	readonly cwd: string;
	/** Added to the tool's environment: ORRERY_AGENT and ORRERY_AGENT_TOKEN (src/agent/pick.ts). */
	readonly env: Readonly<Record<string, string>>;
	/** Taken out of the tool's environment, even when this process inherited them (withoutOrrery). */
	readonly unsetEnv?: readonly string[];
	/** The agent's data folder in Orrery's home, where the tool's extension claims the token, and runAgent removes the claim. */
	readonly agentDir: string;
	readonly steps: readonly LaunchStep[];
	/** Why it cannot launch at all. */
	readonly blocked?: string;
	/** Blocked only because Claude Code opens this agent here through the Orrery mod alone: claude-setup-mod opens it. */
	readonly needsMod?: true;
	/**
	 * Codex with Orrery: the Codex the hook check asks (on PATH, also under Ori), its version number, Orrery's `-c` flags,
	 * the arguments Codex would get without Orrery, and the steps' notices about Orrery's flags (withoutOrrery drops both).
	 */
	readonly codex?: { readonly path: string; readonly version?: string; readonly config: readonly string[]; readonly plainArgs: readonly string[]; readonly notices: readonly string[] };
	/**
	 * OpenCode with Orrery: the OpenCode the plugin check asks, its version number, the launch's config content and
	 * plugin folder (the check is given the same), the file the plugin reads the agent's token from (runAgent writes it
	 * just before OpenCode starts and removes it when OpenCode exits) and that token, and the arguments OpenCode would
	 * get without Orrery (withoutOrrery), which also drops an Orrery plugin config this process inherited
	 * (`inherited`). The token is in no environment: `env` carries only the config content.
	 */
	readonly opencode?: {
		readonly path: string;
		readonly version?: string;
		readonly content: string;
		readonly folder: string;
		readonly tokenFile: string;
		readonly token: string;
		readonly plainArgs: readonly string[];
		readonly inherited?: true;
	};
	/** Codex or OpenCode started without Orrery, after the person said yes (withoutOrrery): not recorded, no guard. */
	readonly withoutOrrery?: true;
}

export interface LaunchOptions {
	/** Where the install steps look (tests). */
	readonly root?: string;
	readonly env?: NodeJS.ProcessEnv;
	/** The folder the tool starts in: default the agent's folder, else this process's folder. */
	readonly cwd?: string;
	/** The tool for this session only (orrery agent --tool). */
	readonly tool?: AgentTool;
	/** Handed to the tool as they are (orrery agent … -- <tool arguments>). */
	readonly args?: readonly string[];
	/** How the person picks another tool where they are, ending the not-on-PATH text (default: the TUI's C). */
	readonly changeTool?: string;
	/** The command words that run this Orrery's CLI, for Codex's hooks and MCP server (default orreryCommand; tests). */
	readonly orrery?: readonly string[];
}

/** Ori starts OpenCode its own way (with config of its own, unchecked): an OpenCode agent opens directly. */
const ORI_OPENCODE = (name: string) => `Orrery doesn't open OpenCode through Ori yet: open ${name} with launcher = "direct" (orrery agent set ${name} launcher direct), or in another tool.`;

/** "<what>. Installing it will:\n  <step>\n  <step>\nInstall it now?": an install question that lists what a yes does first (spec §4.6). */
function installQuestion(what: string, check: ToolCheck, options: { root?: string; env?: NodeJS.ProcessEnv }): string {
	const steps = installSteps(check, options.root ?? wiringRoot(options.env).root, options.env ?? process.env);
	return `${what}. Installing it will:\n${steps.map((step) => `  ${step.describe}`).join("\n")}\nInstall it now?`;
}

/**
 * Why Claude Code cannot open `agent` in `cwd`, or undefined when it can. Outside its folder it gets the agent's memory only
 * from the Orrery mod (`needsMod`). In a folder that another agent, set up the file way, holds (its own folder or an
 * ancestor's: Claude Code loads every ancestor's CLAUDE.md and CLAUDE.local.md), that file loads the other agent's memory
 * view into the session; the plugin refuses such a session too (src/claude/pick.ts).
 */
function claudeCodeRefusal(config: HarnessConfig, agent: AgentConfig, cwd: string, inFolder: boolean): { readonly text: string; readonly needsMod?: true } | undefined {
	for (const host of config.agents.values()) {
		if (host.name === agent.name || !insideFolder(host, cwd) || agentMode(host) !== "file") continue;
		const file = readSetupMarker(host.dir)?.file ?? "CLAUDE.md";
		const where = host.folder !== undefined && resolve(host.folder) === cwd ? "" : "inside ";
		return { text: `${cwd} is ${where}${host.name}'s folder, where Claude Code loads ${host.name}'s memory through ${file}; open ${agent.name} in another folder.` };
	}
	if (!inFolder && agentMode(agent) !== "mod") {
		return { text: `Claude Code opens ${agent.name} outside its folder only through the Orrery mod: run orrery claude-setup ${agent.name} --mod (Claude Code 2.1.287 or newer), then open it again.`, needsMod: true };
	}
	return undefined;
}

/**
 * What opening `row` runs, where, and what to say or ask first. The tool starts in `options.cwd` (default: the agent's
 * folder, else this process's folder) as the agent: ORRERY_AGENT and a fresh token in its environment.
 */
export function launchPlan(config: HarnessConfig, row: AgentRow, tools: readonly ToolCheck[], options: LaunchOptions = {}): LaunchPlan {
	const agent = findAgent(config, row.name);
	const tool = options.tool ?? row.tool;
	const label = TOOL_LABELS[tool];
	const check = tools.find((t) => t.id === tool);
	// An agent with no default folder opens here.
	const cwd = resolve(options.cwd ?? row.folder ?? process.cwd());
	const base = {
		agent: row.name,
		tool,
		...(agent.launcher === "ori" ? { launcher: "ori" as const } : {}),
		args: [...(options.args ?? [])],
		cwd,
		env: { [AGENT_ENV]: agent.name, [TOKEN_ENV]: newToken() },
		agentDir: agent.dir,
	};
	if (tool === "opencode" && agent.launcher === "ori") return { ...base, steps: [], blocked: ORI_OPENCODE(agent.name) };
	const ori = agent.launcher === "ori" ? findOnPath("ori", options.env ?? process.env) : undefined;
	if (agent.launcher === "ori" && ori === undefined) return { ...base, steps: [], blocked: 'Ori isn\'t installed: see docs/ori.md (or set launcher = "direct")' };
	if (check?.path === undefined) return { ...base, steps: [], blocked: `${label} is not on PATH (looked for "${BINARIES[tool]}"). ${HINTS[tool]}, or ${options.changeTool ?? "change the agent's tool with C"}.` };
	// An imported agent's memory is built in the background (src/agent/build.ts): a session now would summarize alongside it.
	const build = readBuild(agent.dir);
	if (build !== undefined && buildRunning(build)) {
		return { ...base, steps: [], blocked: `${agent.name}'s memory is still being built (${build.summaries} summaries for ${build.messages} messages); open it when the build finishes.` };
	}
	const inFolder = agent.folder !== undefined && workArea(agent, cwd) === agent.folder;
	const refused = tool === "claude-code" ? claudeCodeRefusal(config, agent, cwd, inFolder) : undefined;
	if (refused !== undefined) return { ...base, steps: [], blocked: refused.text, ...(refused.needsMod === true ? { needsMod: true as const } : {}) };
	// Codex would not apply Orrery's flags to a session subcommand they can't follow: no memory, no guard.
	const misplaced = tool === "codex" ? misplacedSubcommand(base.args) : undefined;
	if (misplaced !== undefined) {
		return { ...base, steps: [], blocked: `Put Codex's subcommand first, or Codex won't apply Orrery's flags to the session (no memory, no guard): ${subcommandFirst(agent.name, base.args)}` };
	}
	const badArgs = tool === "opencode" ? argsRefusal(agent.name, base.args) : undefined;
	if (badArgs !== undefined) return { ...base, steps: [], blocked: badArgs };
	const steps: LaunchStep[] = [];
	if (!existsSync(cwd)) steps.push({ text: `The folder ${cwd} does not exist. Create it?`, confirm: true, fix: "create-folder" });
	if ((row.state === "open" || row.state === "working") && row.openIn !== undefined) {
		steps.push({ text: `${row.name} is already open in ${TOOL_LABELS[row.openIn]}. A second session won't record. Launch anyway?`, confirm: true, asAgent: true });
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
		if (inFolder && !markedHere(agent)) steps.push({ text: `Claude Code does not load ${row.name}'s memory in this folder yet. Set it up now (orrery claude-setup)?`, confirm: true, fix: "claude-setup" });
	}
	// Codex: Orrery's hooks, memory tools and instructions go on its command line, before the person's arguments.
	const codex = tool === "codex" ? codexLaunch(agent, options.orrery ?? orreryCommand(options.env ?? process.env)) : undefined;
	for (const notice of codex?.notices ?? []) steps.push({ text: notice, confirm: false });
	// The tool's arguments: for Codex, Orrery's flags where Codex reads them (codexArgs), around the person's; for
	// OpenCode, --standalone and the folder (opencodeArgs).
	const toolArgs = codex !== undefined ? codexArgs(codex, base.args) : tool === "opencode" ? opencodeArgs(cwd, base.args) : base.args;
	const version = codexVersion(check.version);
	const codexPlan = (prefix: readonly string[]) => (codex === undefined ? {} : { codex: { path: check.path as string, ...(version === undefined ? {} : { version }), config: codex.config, plainArgs: [...prefix, ...base.args], notices: codex.notices } });
	if (tool === "opencode") {
		// The token goes to the plugin as a file, so neither it nor ORRERY_AGENT is in OpenCode's environment, not even
		// inherited: a tool the model starts there (pi, another OpenCode) is not the agent by this launch. Another OpenCode
		// inherits OPENCODE_CONFIG_CONTENT, token file and all, but finds the token claimed by this one's server
		// (src/opencode/plugin.ts).
		const env = options.env ?? process.env;
		const token = base.env[TOKEN_ENV] as string;
		const tokenFile = tokenFilePath(env);
		const folder = pluginFolder(env, options.root ?? wiringRoot(env).root);
		const content = configContent(folder, { agent: agent.name, tokenFile });
		// The person's own config content stays, with Orrery's plugin added; the plugin check loads Orrery's alone.
		const launched = launchConfigContent(env.OPENCODE_CONFIG_CONTENT, content);
		if (launched.unread !== undefined) steps.push({ text: `Your OPENCODE_CONFIG_CONTENT ${launched.unread}, so OpenCode starts with Orrery's plugin config alone, without yours.`, confirm: false });
		const opencode = { path: check.path, ...(version === undefined ? {} : { version }), content, folder, tokenFile, token, plainArgs: [...base.args], ...(inheritsOrreryPlugin(env) ? { inherited: true as const } : {}) };
		return { ...base, command: check.path, args: toolArgs, env: { OPENCODE_CONFIG_CONTENT: launched.content }, unsetEnv: [AGENT_ENV, TOKEN_ENV], steps, opencode };
	}
	if (ori !== undefined) {
		if (tool === "omp") steps.push({ text: 'Ori 0.15.7 can\'t start OMP: its model registration fails before startup. See docs/ori.md, or set launcher = "direct".', confirm: false });
		steps.push({ text: `Launching ${label} through Ori in ${cwd}`, confirm: false });
		const prefix = [BINARIES[tool], ...(agent.oriModel === undefined ? [] : ["--model", agent.oriModel])];
		return { ...base, command: ori, args: [...prefix, ...toolArgs], steps, ...codexPlan(prefix) };
	}
	return { ...base, command: check.path, args: toolArgs, steps, ...codexPlan([]) };
}

/**
 * The checks before a Codex launch: ok at once for any other plan. First the hook check (src/codex/check.ts; at once
 * for a Codex this Orrery verified before), `onCheck` hearing when Codex is asked (it may take a few seconds). Then,
 * at every launch since a startup file may change any day, the shell Codex runs the hooks in must start without a
 * word (src/codex/shell.ts), run with the environment Codex will have (`env` and the plan's variables).
 */
export async function checkCodexHooks(
	plan: LaunchPlan,
	options: { readonly env?: NodeJS.ProcessEnv; readonly probe?: typeof probeHooks; readonly onCheck?: (text: string) => void; readonly shellCheck?: (env: NodeJS.ProcessEnv, cwd: string) => ShellCheck } = {},
): Promise<CodexGate> {
	if (plan.codex === undefined) return { ok: true };
	const { path, version, config } = plan.codex;
	const hooks = await codexHookGate({ path, ...(version === undefined ? {} : { version }), config }, {
		orrery: orreryVersion(),
		...(options.env === undefined ? {} : { env: options.env }),
		...(options.probe === undefined ? {} : { probe: options.probe }),
		...(options.onCheck === undefined ? {} : { onCheck: () => options.onCheck?.(`Checking that Orrery's hooks load in Codex${version === undefined ? "" : ` ${version}`}…`) }),
	});
	if (!hooks.ok) return hooks;
	const shell = (options.shellCheck ?? checkHookShell)(toolEnv(plan, options.env ?? process.env), plan.cwd);
	return shell.quiet ? { ok: true } : { ok: false, text: noisyShellText(plan.agent, shell), noisyShell: true, question: NOISY_SHELL_QUESTION };
}

/**
 * Before OpenCode opens an agent: the plugin check (src/opencode/check.ts; at once for an OpenCode this Orrery verified
 * before), `onCheck` hearing when OpenCode is asked (a private server starts, about a second). Ok at once for any other plan.
 */
export async function checkOpenCodePlugin(plan: LaunchPlan, options: { readonly env?: NodeJS.ProcessEnv; readonly probe?: typeof probePlugin; readonly onCheck?: (text: string) => void } = {}): Promise<OpenCodeGate> {
	if (plan.opencode === undefined) return { ok: true };
	const { path, version, content, folder } = plan.opencode;
	return opencodePluginGate({ path, ...(version === undefined ? {} : { version }), content, folder }, {
		orrery: orreryVersion(),
		...(options.env === undefined ? {} : { env: options.env }),
		...(options.probe === undefined ? {} : { probe: options.probe }),
		...(options.onCheck === undefined ? {} : { onCheck: () => options.onCheck?.(`Checking that Orrery's plugin loads in OpenCode${version === undefined ? "" : ` ${version}`}…`) }),
	});
}

/**
 * The plan as plain Codex or OpenCode, after the person said yes to starting without Orrery: none of Orrery's flags or
 * config, and no ORRERY_AGENT or token, not even ones this process inherited (a session that records nothing must not
 * hand an agent to a tool it starts); OpenCode as `opencode [the person's arguments]` would start it. It opens no
 * agent, so it asks nothing about the agent (asAgent: a second session) and says nothing about Orrery's flags; its
 * callers skip a remote takeover too.
 */
export function withoutOrrery(plan: LaunchPlan): LaunchPlan {
	if (plan.opencode !== undefined) {
		const { opencode, ...rest } = plan;
		const unsetEnv = [AGENT_ENV, TOKEN_ENV, ...(opencode.inherited === true ? ["OPENCODE_CONFIG_CONTENT"] : [])];
		return { ...rest, args: [...opencode.plainArgs], env: {}, unsetEnv, steps: plan.steps.filter((step) => step.asAgent !== true), withoutOrrery: true };
	}
	if (plan.codex === undefined) return plan;
	const { codex, ...rest } = plan;
	const steps = plan.steps.filter((step) => step.asAgent !== true && (step.confirm || !codex.notices.includes(step.text)));
	return { ...rest, args: [...codex.plainArgs], env: {}, unsetEnv: [AGENT_ENV, TOKEN_ENV], steps, withoutOrrery: true };
}

/**
 * Does what a yes to a launch step asked; returns what it did, for showing. Throws when it fails. `cwd` is the folder the
 * plan opens in (create-folder makes it).
 */
export function applyFix(fix: LaunchFix, config: HarnessConfig, row: AgentRow, tools: readonly ToolCheck[], options: { root?: string; env?: NodeJS.ProcessEnv; run?: Runner; cwd?: string } = {}): string {
	if (fix === "create-folder") {
		const folder = options.cwd ?? row.folder ?? process.cwd();
		mkdirSync(folder, { recursive: true });
		return `Created ${folder}.`;
	}
	if (fix === "claude-setup") return setupReport(claudeSetup(findAgent(config, row.name)));
	if (fix === "claude-setup-mod") return modSetupReport(claudeSetupMod(findAgent(config, row.name)));
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
 * The variables coding tools give their shells (src/agent/sessions.ts TOOL_MARKERS). A tool started with one of them
 * counts as started inside that tool's session, and opens no memory (src/agent/plain-nested.ts): one left over in the
 * user's terminal (a tmux server first started from a tool's shell) must not reach a tool Orrery starts.
 */
const TOOL_VARIABLES: readonly string[] = TOOL_MARKERS.map((marker) => marker.variable);

/** The environment the plan's tool starts with: `env`, less the coding tools' variables, then the plan's (less unsetEnv). */
function toolEnv(plan: LaunchPlan, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const started: NodeJS.ProcessEnv = { ...env };
	for (const name of TOOL_VARIABLES) delete started[name];
	Object.assign(started, plan.env);
	for (const name of plan.unsetEnv ?? []) delete started[name];
	return started;
}

/**
 * Runs the tool in the plan's folder with this terminal attached, the plan's variables over `env`'s (less unsetEnv and
 * the coding tools' variables, toolEnv); Ctrl-C goes to the tool, not to orrery.
 */
export function runTool(plan: LaunchPlan, options: { spawn?: typeof spawn; env?: NodeJS.ProcessEnv } = {}): Promise<ToolExit> {
	if (plan.command === undefined) return Promise.reject(new Error(plan.blocked ?? "Nothing to run."));
	const ignore = () => {};
	process.on("SIGINT", ignore);
	return new Promise((done, fail) => {
		let child: ReturnType<typeof spawn>;
		try {
			const env = toolEnv(plan, options.env ?? process.env);
			child = (options.spawn ?? spawn)(plan.command as string, [...plan.args], { cwd: plan.cwd, stdio: "inherit", env });
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

/**
 * Runs the plan's tool, then removes the claim its token made (src/agent/pick.ts), however the tool ended. Says which
 * process had claimed it (`claimedBy`: the tool's own process, as the agent), when one had. For OpenCode the token is
 * written to its file first and the file removed after, and on SIGTERM or SIGHUP meanwhile (src/opencode/token-file.ts).
 */
export async function runAgent(plan: LaunchPlan, run: (plan: LaunchPlan) => Promise<ToolExit>): Promise<ToolExit & { readonly claimedBy?: number }> {
	const token = plan.opencode?.token ?? plan.env[TOKEN_ENV] ?? "";
	const tokenFile = plan.opencode?.tokenFile;
	let undo: (() => void) | undefined;
	try {
		if (tokenFile !== undefined) {
			undo = removeOnSignals(tokenFile);
			try {
				writeTokenFile(tokenFile, token);
			} catch (error) {
				throw new Error(`OpenCode was not started: the token file for ${plan.agent} could not be written (${error instanceof Error ? error.message : String(error)}).`);
			}
		}
		const exit = await run(plan);
		const by = claimedBy(plan.agentDir, token);
		return by === undefined ? exit : { ...exit, claimedBy: by };
	} finally {
		undo?.();
		if (tokenFile !== undefined) removeTokenFile(tokenFile);
		releaseClaim(plan.agentDir, token);
	}
}

export interface GateDeps {
	refreshRemote?(config: HarnessConfig, name: string): Promise<void>;
	overview(config: HarnessConfig): AgentRow[];
	say?(text: string): void;
}

/**
 * Before a remote agent opens (orrery agent, the TUI's Enter and L): its remote is asked now. An agent open on another
 * machine is refused; a stale one comes back with the takeover question, which the caller asks after the plan's own
 * checks.
 */
export async function remoteGate(config: HarnessConfig, row: AgentRow, deps: GateDeps): Promise<{ readonly go: true; readonly row: AgentRow; readonly takeover?: string } | { readonly go: false; readonly text: string }> {
	if (row.remote === undefined) return { go: true, row };
	if (deps.refreshRemote === undefined) return { go: false, text: "Remote launch is unavailable here." };
	deps.say?.(`Checking ${row.name} on ${row.remote}…`);
	await deps.refreshRemote(config, row.remote);
	const current = deps.overview(config).find((agent) => agent.name === row.name);
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
