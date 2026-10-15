/**
 * `orrery agent <Name> [--tool pi|omp|claude-code] [--yes] [-- <tool arguments>]` opens an agent in this folder, and
 * `orrery agent edit <Name>` opens its instructions in $EDITOR (spec 2026-10-13-orrery-agents-design §4, §5). The checks
 * are the TUI's (src/agent/launch.ts): the tool is installed and wired, the agent is not open on another machine or is
 * taken over, and Claude Code opens outside the agent's folder only through the Orrery mod.
 */

import { resolve } from "node:path";
import { findAgent, type AgentTool, loadConfig } from "../agent/config.ts";
import { editInstructionsFile, runEditor } from "../agent/editor.ts";
import { applyFix, exitText, launchLabel, launchPlan, type LaunchPlan, remoteGate, runAgent, runTool, type ToolExit } from "../agent/launch.ts";
import { type AgentRow, agentOverview, OverviewCache, TOOL_LABELS } from "../agent/overview.ts";
import { checkTools } from "../agent/tools.ts";

export interface AgentIo {
	say(line: string): void;
	/** A yes/no question on the terminal (`--yes` answers yes). */
	confirm(question: string): Promise<boolean>;
}

/** The tools an agent opens in: those with Orrery's memory. */
const OPENED_IN: readonly AgentTool[] = ["pi", "omp", "claude-code"];

function codexRefusal(name: string): string {
	return `Codex has no Orrery memory yet: open ${name} in pi, OMP or Claude Code (--tool).`;
}

export async function openAgentCommand(
	configPath: string | undefined,
	name: string,
	options: { readonly tool?: string; readonly args: readonly string[]; readonly cwd: string },
	io: AgentIo,
	deps: { readonly takeover: (name: string) => Promise<string>; readonly run?: (plan: LaunchPlan) => Promise<ToolExit> },
): Promise<number> {
	const config = loadConfig(configPath);
	const agent = findAgent(config, name);
	if (options.tool !== undefined && !OPENED_IN.includes(options.tool as AgentTool)) {
		throw new Error(options.tool === "codex" ? codexRefusal(agent.name) : `--tool takes pi, omp or claude-code (not ${options.tool}).`);
	}
	const cache = new OverviewCache();
	const row = agentOverview(config, { cache }).find((r) => r.name === agent.name);
	if (row === undefined) throw new Error(`No agent named ${agent.name}.`);
	// Without --tool, the agent's own (the TUI's guess when the config names none).
	const tool = (options.tool as AgentTool | undefined) ?? row.tool;
	if (!OPENED_IN.includes(tool)) throw new Error(codexRefusal(agent.name));
	const gate = await remoteGate(config, row, { refreshRemote: (c, n) => cache.refreshRemote(c, n), overview: (c) => agentOverview(c, { cache }), say: io.say });
	if (!gate.go) throw new Error(gate.text);
	const tools = checkTools();
	const changeTool = `open ${agent.name} in another tool: --tool for this session, orrery agent set ${agent.name} --tool T for good`;
	const plan = launchPlan(config, gate.row, tools, { cwd: options.cwd, tool, args: options.args, changeTool });
	if (plan.blocked !== undefined) throw new Error(plan.blocked);
	if (gate.takeover !== undefined) {
		if (!(await io.confirm(gate.takeover))) {
			io.say("Not opened.");
			return 1;
		}
		io.say((await deps.takeover(agent.name)).trimEnd());
	}
	for (const step of plan.steps) {
		if (!step.confirm) {
			io.say(step.text);
			continue;
		}
		if (!(await io.confirm(step.text))) {
			io.say("Not opened.");
			return 1;
		}
		if (step.fix !== undefined) io.say(applyFix(step.fix, config, gate.row, tools, { cwd: plan.cwd }));
	}
	const run = deps.run ?? ((p: LaunchPlan) => runTool(p, configPath === undefined ? {} : { env: { ...process.env, ORRERY_CONFIG: resolve(configPath) } }));
	const exit = await runAgent(plan, run);
	const text = exitText(launchLabel(plan), exit);
	if (text !== undefined) io.say(text);
	return exit.code ?? 1;
}

/**
 * `orrery agent edit`: only a person edits an agent's instructions (spec §2, call 2), so it needs a terminal on stdin and
 * stdout (`terminal`), checked before anything is written. An agent's shell would otherwise run it with an EDITOR of its
 * own making and rewrite its own rules. A seatbelt, as the guard's shell rules are: a shell can make a pseudo-terminal.
 */
export async function editAgentCommand(
	configPath: string | undefined,
	name: string,
	io: AgentIo,
	edit: (path: string) => Promise<ToolExit> = (path) => runEditor(path),
	terminal = process.stdin.isTTY === true && process.stdout.isTTY === true,
): Promise<number> {
	if (!terminal) throw new Error(`orrery agent edit needs a terminal: an agent's instructions are edited by a person, in a terminal (run orrery agent edit ${name} in yours).`);
	const config = loadConfig(configPath);
	const agent = findAgent(config, name);
	let row: AgentRow | undefined;
	const done = await editInstructionsFile(agent, () => (row = agentOverview(config).find((r) => r.name === agent.name)), edit);
	if (done.failed !== undefined) {
		io.say(`The editor ${done.failed}; ${done.path} is as it left it.`);
		return done.exit.code ?? 1;
	}
	io.say(`Saved ${done.path}.`);
	if (done.readsAt !== undefined && row !== undefined) io.say(`${agent.name} is open in ${TOOL_LABELS[row.openIn ?? row.tool]}: it reads them at its ${done.readsAt}.`);
	if (agent.remote !== undefined) io.say(`They travel with ${agent.name}'s memory the next time it opens on this machine.`);
	return 0;
}
