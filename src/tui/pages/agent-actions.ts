/**
 * The Agents page's actions (spec §3.1). Each runs as one App action and asks through dialogs; the rules live in src/agent.
 * N is in new-agent.ts, which uses emptyAgent, addFromRemote and wireAgent from here.
 */

import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { type Picked, pickSummaryModel } from "../../agent/compactor-menu.ts";
import { addAgent, archiveAgent, type EditableKey, readOnlyConfigText, setAgentKey } from "../../agent/config-edit.ts";
import { COMPACT_AT_MIN, findAgent, type HarnessConfig, AGENT_TOOLS, agentNameProblem, type ModelChoice } from "../../agent/config.ts";
import { editInstructionsFile } from "../../agent/editor.ts";
import { instructionsTemplate, readInstructions } from "../../agent/instructions.ts";
import { summaryLine } from "../../agent/agent-commands.ts";
import { exitText, launchLabel, type LaunchPlan, launchPlan, remoteGate, runAgent, withoutOrrery } from "../../agent/launch.ts";
import { withoutOrreryQuestion } from "../../agent/load-check.ts";
import type { CodexGate } from "../../codex/check.ts";
import { archiveRefusal, type AgentRow, TOOL_LABELS } from "../../agent/overview.ts";
import { workArea } from "../../agent/pick.ts";
import { safeText } from "../../agent/source-labels.ts";
import { switchSummaryModel } from "../../agent/summary-text.ts";
import { shortHome } from "../../agent/tools.ts";
import { localIso } from "../../memory/index.ts";
import type { App } from "../app.ts";
import { ConfirmModal, hardWrap, InputModal, MessageModal, menuUI, SelectModal } from "../dialogs.ts";

export const NO_LOGINS = "No summary logins saved yet. Add one on the Logins page (2), then try again.";
const kb = (bytes: number) => Math.round(bytes / 1000);

/** "~/x" becomes "/home/me/x"; other paths stay as they are. */
export function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

/** The picker's result as a choice, an Error saying why there is none, or undefined (cancelled, or an extra entry). */
export function pickedChoice(picked: Picked | { readonly extra: string } | undefined): ModelChoice | Error | undefined {
	if (picked === undefined || "extra" in picked) return undefined;
	if ("none" in picked) return new Error(picked.none.startsWith("No summary logins") ? NO_LOGINS : picked.none);
	return picked.choice;
}

/** Text for a dialog with control characters removed line by line; newlines stay. */
export function safeLines(text: string): string {
	return text.split(/\r?\n/).map(safeText).join("\n");
}

/** Runs a wiring fix; a failure shows its full text (exit code and output) in a "Failed" dialog. True when it worked. */
async function runFix(app: App, fix: () => string): Promise<boolean> {
	let text: string;
	try {
		text = fix();
	} catch (error) {
		await app.host.open(new MessageModal("Failed", safeLines(error instanceof Error ? error.message : String(error))));
		return false;
	}
	await app.host.open(new MessageModal("Done", safeLines(text)));
	return true;
}

/**
 * After an agent is added: the fixes a launch would ask for (folder, pi extension, Claude Code plugin and memory import),
 * each after a yes. A Claude Code agent with no folder opens only through the Orrery mod: when that alone stops it, the
 * switch to the mod is offered first. Any other block is said when the agent is opened.
 */
export async function wireAgent(app: App, name: string): Promise<void> {
	app.refresh();
	const row = app.agents.find((r) => r.name === name);
	const config = app.config;
	if (row === undefined || config === undefined) return;
	const tools = app.deps.tools();
	// An agent with no folder opens here, where Orrery was started, as Enter opens it.
	const where = row.folder === undefined ? { cwd: app.deps.cwd } : {};
	let plan = launchPlan(config, row, tools, where);
	if (plan.needsMod === true) {
		const question = `Claude Code opens ${name} only through the Orrery mod (Claude Code 2.1.287 or newer). Switch ${name} to the mod now?`;
		if (!(await app.host.open(new ConfirmModal(safeLines(hardWrap(question, 56).join("\n")))))) return;
		if (!(await runFix(app, () => app.deps.applyFix("claude-setup-mod", config, row, tools)))) return;
		plan = launchPlan(config, row, tools, where);
	}
	for (const step of plan.steps) {
		if (step.fix === undefined) continue;
		// The folder an agent with none opens in is the person's own: it is not made here.
		if (step.fix === "create-folder" && row.folder === undefined) continue;
		if (!(await app.host.open(new ConfirmModal(safeLines(step.text))))) continue;
		const { fix } = step;
		await runFix(app, () => app.deps.applyFix(fix, config, row, tools, plan.cwd));
	}
}

/**
 * Where Enter or L opens `row` (spec 2026-10-13-orrery-agents-design §4): its folder when Orrery runs there (or below),
 * here when it has none, else the person picks. Undefined when they leave the question.
 */
async function whereToOpen(app: App, row: AgentRow): Promise<string | undefined> {
	const here = app.deps.cwd;
	if (row.folder === undefined) return here;
	if (workArea(row, here) === row.folder) return row.folder;
	const options = [`here (${shortHome(here)})`, `its folder (${shortHome(row.folder)})`];
	const picked = await app.host.open(new SelectModal(`Open ${row.name} where?`, options));
	if (picked === undefined) return undefined;
	return picked === options[0] ? here : row.folder;
}

/**
 * Codex's checks (src/agent/launch.ts checkCodexHooks) and OpenCode's (checkOpenCodePlugin): the plan as it is when
 * they pass; when Orrery's hooks or plugin don't load, plain Codex or OpenCode after a yes; when Codex's hook shell
 * prints, the plan as it is after a yes (each question's default is no: n and Esc), else undefined.
 */
async function checkedOrPlain(app: App, plan: LaunchPlan): Promise<LaunchPlan | undefined> {
	if (plan.codex === undefined && plan.opencode === undefined) return plan;
	const say = (text: string) => app.say(text);
	const check = (p: LaunchPlan): Promise<CodexGate> => (p.opencode !== undefined ? app.deps.opencodeCheck(p, say) : app.deps.codexCheck(p, say));
	const gate = await check(plan);
	if (gate.ok) return plan;
	if ("noisyShell" in gate) return (await app.host.open(new ConfirmModal(safeLines(`${gate.text}\n\n${gate.question}`)))) ? plan : undefined;
	if (!(await app.host.open(new ConfirmModal(safeLines(`${gate.text}\n\n${withoutOrreryQuestion(TOOL_LABELS[plan.tool])}`))))) return undefined;
	return withoutOrrery(plan);
}

/**
 * Enter and L: open the agent in its tool as the agent (src/agent/launch.ts), where the person says, after what the launch
 * plan asks. A remote agent's remote is asked first, so an agent open on another machine is refused before any question.
 */
export function launchAgent(app: App, row: AgentRow | undefined): void {
	const config = app.config;
	if (row === undefined || config === undefined) return;
	app.run(`Launching ${row.name}`, async () => {
		const refresh = app.deps.refreshRemote;
		const gate = await remoteGate(config, row, { overview: (c) => app.deps.overview(c), say: (text) => app.say(text), ...(refresh === undefined ? {} : { refreshRemote: (c: HarnessConfig, name: string) => refresh(c, name) }) });
		if (!gate.go) throw new Error(gate.text);
		const cwd = await whereToOpen(app, gate.row);
		if (cwd === undefined) return undefined;
		const tools = app.deps.tools();
		const plan = launchPlan(config, gate.row, tools, { cwd });
		const label = launchLabel(plan);
		if (plan.blocked !== undefined) throw new Error(plan.blocked);
		// Codex's hook check and OpenCode's plugin check come first: a no to one must leave no lock taken over and no step done.
		const launching = await checkedOrPlain(app, plan);
		if (launching === undefined) return "Not launched.";
		// Plain Codex or OpenCode opens no agent: it takes no lock over (nor asks about a second session, withoutOrrery).
		if (gate.takeover !== undefined && launching.withoutOrrery !== true) {
			if (app.deps.takeoverAgent === undefined) throw new Error("Remote takeover is unavailable here.");
			if (!(await app.host.open(new ConfirmModal(safeLines(gate.takeover))))) return "Not launched.";
			await app.deps.takeoverAgent(row.name);
		}
		for (const step of launching.steps) {
			if (!step.confirm) {
				await app.host.open(new MessageModal(label, safeLines(step.text)));
				continue;
			}
			if (!(await app.host.open(new ConfirmModal(safeLines(step.text))))) return "Not launched.";
			const { fix } = step;
			if (fix !== undefined && !(await runFix(app, () => app.deps.applyFix(fix, config, gate.row, tools, plan.cwd)))) return "Not launched.";
		}
		const exit = await runAgent(launching, (p) => app.deps.launch(p));
		const plain = launching.withoutOrrery === true ? ", started without Orrery: that session was not recorded" : "";
		return exitText(label, exit) ?? `Back from ${label} (${row.name})${plain}.`;
	});
}

/** E: the agent's instructions in $EDITOR (the template first, when it has none; src/agent/editor.ts). */
export function editInstructions(app: App, row: AgentRow | undefined): void {
	const config = app.config;
	if (row === undefined || config === undefined) return;
	app.run(`Editing ${row.name}'s instructions`, async () => {
		// Before the template is written: where nothing may be edited (the demo), nothing is written either.
		const editor = app.deps.edit;
		if (editor === undefined) throw new Error("Editing instructions is unavailable here.");
		const agent = findAgent(config, row.name);
		const done = await editInstructionsFile(agent, () => app.deps.overview(config).find((r) => r.name === row.name), (path) => editor(path));
		if (done.failed !== undefined) throw new Error(`The editor ${done.failed}; the file is as it left it.`);
		return done.readsAt === undefined ? `Saved ${row.name}'s instructions.` : `Saved. ${row.name} reads them at its ${done.readsAt}.`;
	});
}

/** M: walks the summary picker, tests the pick, and switches the agent to it (or back to the config's model). */
export function chooseSummaryModel(app: App, row: AgentRow | undefined): void {
	const config = app.config;
	if (row === undefined || config === undefined) return;
	app.run(`Summary model for ${row.name}`, async () => {
		const sources = await app.deps.sources(config, row);
		const target = app.deps.target(config, row.name, (message) => app.say(message));
		const { choice: now, source } = target.current();
		const configured = target.configured();
		const reset = `Back to the config's model (${configured.provider}/${configured.modelId})`;
		// OpenCode's models are OpenCode's to list (its providers, its logins): the TUI can't know them, so it says where.
		const inside = "OpenCode's models (chosen inside OpenCode)";
		const picked = await pickSummaryModel(menuUI(app.host), sources, { heading: summaryLine(now, source), thinking: now.thinking, askThinking: true, extra: [...(source === "chat" ? [reset] : []), inside] });
		if (picked !== undefined && "extra" in picked && picked.extra === inside) {
			return `OpenCode's models are picked inside OpenCode: open ${row.name} there, then /compactor.`;
		}
		const choice = pickedChoice(picked);
		if (choice instanceof Error) throw choice;
		if (choice === undefined && !(picked !== undefined && "extra" in picked)) return undefined;
		return switchSummaryModel(sources, target, choice, app.deps.testChoice);
	});
}

async function askKb(app: App, title: string, bytes: number): Promise<number | undefined> {
	const text = await app.host.open(new InputModal(title, String(kb(bytes))));
	if (text === undefined) return undefined;
	const n = Number(text);
	if (!Number.isInteger(n) || n < 1) throw new Error("Enter a whole number of KB.");
	return n * 1000;
}

/** C: changes one of the agent's settings in the config file. */
export function editAgent(app: App, row: AgentRow | undefined): void {
	if (row === undefined || app.config === undefined) return;
	if (!app.deps.configWritable()) {
		app.say(readOnlyConfigText(app.deps.configPath), "error");
		return;
	}
	app.run(`Editing ${row.name}`, async () => {
		const items = [`Tool: ${TOOL_LABELS[row.tool]}`, `Folder: ${row.folder === undefined ? "none" : safeText(row.folder)}`, `View size: ${kb(row.viewBudget)} KB`, `Summary-call size: ${kb(row.summaryContextBytes)} KB`, `Summary jobs: ${row.summaryJobs}`, `Claude Code compacts at: ${Math.round(row.compactAt / 1000)}K tokens`, `Launcher: ${row.launcher === "ori" ? "Ori" : "Direct"}`, `Ori model: ${safeText(row.oriModel ?? "default")}`, ...(row.remote !== undefined || (app.config?.remotes.size ?? 0) > 0 ? [`Memory home: ${row.remote ?? "local"}`] : [])];
		const picked = await app.host.open(new SelectModal(`${row.name}: change which setting?`, items));
		if (picked === undefined) return undefined;
		let key: EditableKey;
		let value: string | number;
		switch (items.indexOf(picked)) {
			case 0: {
				const label = await app.host.open(new SelectModal("Tool:", AGENT_TOOLS.map((t) => TOOL_LABELS[t])));
				const tool = AGENT_TOOLS.find((t) => TOOL_LABELS[t] === label);
				if (tool === undefined) return undefined;
				key = "tool";
				value = tool;
				break;
			}
			case 1: {
				const folder = await app.host.open(new InputModal("Folder (an absolute path; empty: none, it opens wherever it is opened):", row.folder ?? ""));
				if (folder === undefined) return undefined;
				key = "folder";
				value = folder === "" ? "" : expandHome(folder);
				break;
			}
			case 2: {
				const bytes = await askKb(app, "View size in KB (the memory view's ceiling):", row.viewBudget);
				if (bytes === undefined) return undefined;
				key = "view_bytes";
				value = bytes;
				break;
			}
			case 3: {
				const bytes = await askKb(app, "Summary-call size in KB (context per summary call):", row.summaryContextBytes);
				if (bytes === undefined) return undefined;
				key = "compactor_context_bytes";
				value = bytes;
				break;
			}
			case 4: {
				const text = await app.host.open(new InputModal("Summary jobs (summaries made at once):", String(row.summaryJobs)));
				if (text === undefined) return undefined;
				const n = Number(text);
				if (!Number.isInteger(n) || n < 1) throw new Error("Enter a whole number, at least 1.");
				key = "compactor_jobs";
				value = n;
				break;
			}
			case 5: {
				const least = COMPACT_AT_MIN / 1000;
				const text = await app.host.open(new InputModal(`Compact Claude Code's conversation at how many thousand tokens (at least ${least}):`, String(Math.round(row.compactAt / 1000))));
				if (text === undefined) return undefined;
				const n = Number(text);
				if (!Number.isInteger(n) || n < least) throw new Error(`Enter a whole number of thousands, at least ${least}.`);
				key = "compact_at";
				value = n * 1000;
				break;
			}
			case 6: {
				const launcher = await app.host.open(new SelectModal("Launcher:", ["Direct", "Ori"]));
				if (launcher === undefined) return undefined;
				key = "launcher";
				value = launcher.toLowerCase();
				break;
			}
			case 7: {
				const model = await app.host.open(new InputModal("Ori model (empty clears):", row.oriModel ?? ""));
				if (model === undefined) return undefined;
				key = "ori_model";
				value = model;
				break;
			}
			case 8: {
				const remotes = [...app.config!.remotes.keys()];
				const homes = ["local (this machine)", ...remotes];
				const home = await app.host.open(new SelectModal("Memory home:", homes));
				if (home === undefined) return undefined;
				const remote = homes.indexOf(home) === 0 ? undefined : home;
				if (remote === row.remote) return "Memory home is unchanged.";
				if (remote !== undefined && row.remote !== undefined) throw new Error(`${row.name} uses remote ${row.remote}; make it local first.`);
				if (remote === undefined) {
					if (app.deps.localAgent === undefined) throw new Error("Changing memory home is unavailable here.");
					return app.deps.localAgent(row.name);
				}
				if (app.deps.pushAgent === undefined) throw new Error("Changing memory home is unavailable here.");
				return app.deps.pushAgent(row.name, remote);
			}
			default:
				return undefined;
		}
		app.deps.editConfig((text, dir) => setAgentKey(text, dir, row.name, key, value));
		return key === "tool" || key === "folder" ? `Saved. ${row.name} launches with it next time.` : `Saved. It applies when ${row.name} next opens.`;
	});
}

/** Imports an agent through the CLI's pull path; settings and memory come from the chosen remote. */
export async function addFromRemote(app: App): Promise<string | undefined> {
	const config = app.config!;
	if (app.deps.remoteAgents === undefined || app.deps.pullAgent === undefined) throw new Error("Remote agent import is unavailable here.");
	const remote = await app.host.open(new SelectModal("Remote:", [...config.remotes.keys()]));
	if (remote === undefined) return undefined;
	app.say(`Loading agents from ${remote}…`);
	const existing = new Set([...config.agents.keys()].map((name) => name.toLowerCase()));
	const agents = (await app.deps.remoteAgents(config, remote)).filter((entry) => !existing.has(entry.lane.toLowerCase()));
	if (agents.length === 0) return `No new agents on remote ${remote}; any agents there are already configured here.`;
	const labels = agents.map((entry) => safeText(entry.lane));
	const selected = await app.host.open(new SelectModal(`Agent on ${remote}:`, labels));
	if (selected === undefined) return undefined;
	const folder = await app.host.open(new InputModal("Its default folder (empty: none, it opens wherever you open it):", ""));
	if (folder === undefined) return undefined;
	app.say(`Pulling ${selected} from ${remote}…`);
	return app.deps.pullAgent(agents[labels.indexOf(selected)].lane, remote, folder === "" ? undefined : expandHome(folder));
}

/**
 * N, Empty agent (src/tui/pages/new-agent.ts): asks its name, default folder (none: it opens wherever it is opened),
 * tool and summary model, writes it and its instructions' template, then offers the wiring.
 */
export async function emptyAgent(app: App, config: HarnessConfig): Promise<string | undefined> {
	const name = await app.host.open(new InputModal("New agent's name (letters, digits, - and _):"));
	if (!name) return undefined;
	const problem = agentNameProblem(name);
	if (problem !== undefined) throw new Error(problem);
	if ([...config.agents.keys()].some((n) => n.toLowerCase() === name.toLowerCase())) throw new Error(`An agent named ${name} already exists.`);
	const folderText = await app.host.open(new InputModal("Its default folder (empty: none, it opens wherever you open it):", app.deps.cwd));
	if (folderText === undefined) return undefined;
	const folder = folderText === "" ? undefined : expandHome(folderText);
	if (folder !== undefined && !isAbsolute(folder)) throw new Error("The folder must be an absolute path.");
	const checks = app.deps.tools();
	const tools = checks.filter((t) => t.id !== "ori");
	const found = tools.filter((t) => t.path !== undefined);
	const toolLabel = await app.host.open(new SelectModal("Its tool:", (found.length > 0 ? found : tools).map((t) => t.label)));
	const tool = AGENT_TOOLS.find((t) => TOOL_LABELS[t] === toolLabel);
	if (tool === undefined) return undefined;
	const throughOri = checks.some((t) => t.id === "ori" && t.path !== undefined) ? await app.host.open(new SelectModal("Launch through Ori?", ["No", "Yes"])) : "No";
	if (throughOri === undefined) return undefined;
	const sources = await app.deps.sources(config, { launcher: throughOri === "Yes" ? "ori" : "direct" });
	const choice = pickedChoice(await pickSummaryModel(menuUI(app.host), sources, { heading: `${name}'s summaries`, thinking: "low", askThinking: true }));
	if (choice instanceof Error) throw choice;
	if (choice === undefined) return undefined;
	const test = await app.deps.testChoice(sources, choice);
	if (!test.ok) throw new Error(`Not added: ${test.reason}.`);
	const added = app.deps.editConfig((text, dir) =>
		addAgent(text, dir, { name, ...(folder === undefined ? {} : { folder }), tool, launcher: throughOri === "Yes" ? "ori" : "direct", compactorModel: `${choice.provider}/${choice.modelId}`, compactorThinking: choice.thinking }),
	);
	// An archived agent's data folder, brought back under its name, keeps its instructions.
	const agent = added.agents.get(name);
	if (agent !== undefined && readInstructions(agent.dir) === undefined) app.deps.writeInstructions(agent.dir, instructionsTemplate(name));
	await wireAgent(app, name);
	return `Added ${name}. Press Enter to open it, E to write its instructions.`;
}

/** B: writes the agent's memory page and says where (and opens it when a display is there). */
export function browseAgent(app: App, row: AgentRow | undefined): void {
	const config = app.config;
	if (row === undefined || config === undefined) return;
	app.run(`Writing ${row.name}'s memory page`, async () => {
		if (!row.hasMemory) throw new Error(`${row.name} has no memory yet.`);
		const { path, opened } = app.deps.browse(config, row.name);
		return opened === undefined ? `Wrote ${path} (no display here: open it yourself).` : `Wrote ${path} and opened it.`;
	});
}

/** A: takes the agent out of the config (its block kept as comments at the end); its memory stays where it is. */
export function archiveAgentAction(app: App, row: AgentRow | undefined): void {
	if (row === undefined || app.config === undefined) return;
	const refusal = archiveRefusal(row);
	if (refusal !== undefined) {
		app.say(refusal, "error");
		return;
	}
	if (!app.deps.configWritable()) {
		app.say(readOnlyConfigText(app.deps.configPath), "error");
		return;
	}
	app.run(`Archiving ${row.name}`, async () => {
		const question = `Archive ${row.name}? It leaves the config; its memory stays in ${row.dataDir}. Its settings are kept as comments at the end of config.toml.`;
		if (!(await app.host.open(new ConfirmModal(safeLines(hardWrap(question, 56).join("\n")))))) return undefined;
		// The agent may have been opened while the question was up: look again before writing.
		app.refresh();
		const fresh = app.agents.find((r) => r.name === row.name);
		if (fresh === undefined) throw new Error(`${row.name} is no longer in the config.`);
		const now = archiveRefusal(fresh);
		if (now !== undefined) throw new Error(now);
		const day = localIso(new Date(app.deps.now())).slice(0, 10);
		app.deps.editConfig((text, dir) => archiveAgent(text, dir, row.name, day));
		return `Archived ${row.name}.`;
	});
}
