/**
 * `orrery agent <Name> [--tool pi|omp|claude-code|codex] [--yes] [-- <tool arguments>]` opens an agent in this folder,
 * and `orrery agent edit <Name>` opens its instructions in $EDITOR (spec 2026-10-13-orrery-agents-design §4, §5). The
 * checks are the TUI's (src/agent/launch.ts): the tool is installed and wired, the agent is not open on another machine
 * or is taken over, Claude Code opens outside the agent's folder only through the Orrery mod, and Orrery's hooks load in
 * the Codex installed (src/codex/check.ts; only a person at a terminal may start Codex without them).
 */

import { resolve } from "node:path";
import { findAgent, type AgentTool, loadConfig } from "../agent/config.ts";
import { editInstructionsFile, runEditor } from "../agent/editor.ts";
import { applyFix, checkCodexHooks, exitText, launchLabel, launchPlan, type LaunchPlan, remoteGate, runAgent, runTool, type ToolExit, withoutOrrery } from "../agent/launch.ts";
import { type AgentRow, agentOverview, OverviewCache, TOOL_LABELS } from "../agent/overview.ts";
import { checkTools } from "../agent/tools.ts";
import { type CodexGate, WITHOUT_ORRERY_QUESTION, WITHOUT_ORRERY_SAID } from "../codex/check.ts";

export interface AgentIo {
	say(line: string): void;
	/** A yes/no question on the terminal (`--yes` answers yes). */
	confirm(question: string): Promise<boolean>;
	/**
	 * A question only a person answers, default no (`--yes` does not answer it): starting Codex without Orrery's memory
	 * and guard. Absent without a terminal.
	 */
	askPerson?(question: string): Promise<boolean>;
}

/** The tools an agent opens in. */
const OPENED_IN: readonly AgentTool[] = ["pi", "omp", "claude-code", "codex"];

export async function openAgentCommand(
	configPath: string | undefined,
	name: string,
	options: { readonly tool?: string; readonly args: readonly string[]; readonly cwd: string },
	io: AgentIo,
	deps: {
		readonly takeover: (name: string) => Promise<string>;
		readonly run?: (plan: LaunchPlan) => Promise<ToolExit>;
		readonly codexGate?: (plan: LaunchPlan) => Promise<CodexGate>;
		/** Where the agents' rows and remotes are read (tests give one with their own storage). */
		readonly cache?: OverviewCache;
	},
): Promise<number> {
	const config = loadConfig(configPath);
	const agent = findAgent(config, name);
	if (options.tool !== undefined && !OPENED_IN.includes(options.tool as AgentTool)) throw new Error(`--tool takes pi, omp, claude-code or codex (not ${options.tool}).`);
	const cache = deps.cache ?? new OverviewCache();
	const row = agentOverview(config, { cache }).find((r) => r.name === agent.name);
	if (row === undefined) throw new Error(`No agent named ${agent.name}.`);
	// Without --tool, the agent's own (the TUI's guess when the config names none).
	const tool = (options.tool as AgentTool | undefined) ?? row.tool;
	const gate = await remoteGate(config, row, { refreshRemote: (c, n) => cache.refreshRemote(c, n), overview: (c) => agentOverview(c, { cache }), say: io.say });
	if (!gate.go) throw new Error(gate.text);
	const tools = checkTools();
	const changeTool = `open ${agent.name} in another tool: --tool for this session, orrery agent set ${agent.name} --tool T for good`;
	const plan = launchPlan(config, gate.row, tools, { cwd: options.cwd, tool, args: options.args, changeTool });
	if (plan.blocked !== undefined) throw new Error(plan.blocked);
	// Codex's hook check comes first: a no to it must leave no lock taken over and no step done.
	const launching = await codexHooksOrPlain(plan, agent.name, io, deps.codexGate ?? ((p) => checkCodexHooks(p, { onCheck: (text) => io.say(text) })));
	if (launching === undefined) {
		io.say("Not opened.");
		return 1;
	}
	// Plain Codex opens no agent: it takes no lock over (nor asks about a second session, withoutOrrery).
	if (gate.takeover !== undefined && launching.withoutOrrery !== true) {
		if (!(await io.confirm(gate.takeover))) {
			io.say("Not opened.");
			return 1;
		}
		io.say((await deps.takeover(agent.name)).trimEnd());
	}
	for (const step of launching.steps) {
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
	const exit = await runAgent(launching, run);
	const text = exitText(launchLabel(plan), exit);
	if (text !== undefined) io.say(text);
	return exit.code ?? 1;
}

/**
 * The plan to run after the Codex checks: as it is when they pass; when the hooks don't load, plain Codex if the person
 * says yes; when the hooks' shell prints, the plan as it is if they say yes (undefined on no). Without a terminal it
 * refuses with what the check said.
 */
async function codexHooksOrPlain(plan: LaunchPlan, name: string, io: AgentIo, gate: (plan: LaunchPlan) => Promise<CodexGate>): Promise<LaunchPlan | undefined> {
	if (plan.codex === undefined) return plan;
	const checked = await gate(plan);
	if (checked.ok) return plan;
	const noisy = "noisyShell" in checked;
	if (io.askPerson === undefined) {
		const choice = noisy ? "start Codex anyway" : "start Codex without them";
		throw new Error(`${checked.text} ${name} was not opened: only a person at a terminal can choose to ${choice} (run orrery agent ${name} there).`);
	}
	io.say(checked.text);
	if (noisy) return (await io.askPerson(checked.question)) ? plan : undefined;
	if (!(await io.askPerson(WITHOUT_ORRERY_QUESTION))) return undefined;
	io.say(WITHOUT_ORRERY_SAID);
	return withoutOrrery(plan);
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
