/** The Lanes page's actions (spec §3.1). Each runs as one App action and asks through dialogs; the rules live in src/lane. */

import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { type Picked, pickSummaryModel } from "../../lane/compactor-menu.ts";
import { addLane, archiveLane, type EditableKey, readOnlyConfigText, setLaneKey } from "../../lane/config-edit.ts";
import { COMPACT_AT_MIN, LANE_TOOLS, type ModelChoice } from "../../lane/config.ts";
import { summaryLine } from "../../lane/lane-commands.ts";
import { exitText, launchLabel, launchPlan } from "../../lane/launch.ts";
import { archiveRefusal, type LaneRow, TOOL_LABELS } from "../../lane/overview.ts";
import { safeText } from "../../lane/source-labels.ts";
import { switchSummaryModel } from "../../lane/summary-text.ts";
import { localIso } from "../../memory/index.ts";
import type { App } from "../app.ts";
import { ConfirmModal, hardWrap, InputModal, MessageModal, menuUI, SelectModal } from "../dialogs.ts";

export const NO_LOGINS = "No summary logins saved yet. Add one on the Logins page (2), then try again.";
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const kb = (bytes: number) => Math.round(bytes / 1000);

/** "~/x" becomes "/home/me/x"; other paths stay as they are. */
export function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

/** The picker's result as a choice, an Error saying why there is none, or undefined (cancelled, or an extra entry). */
function pickedChoice(picked: Picked | { readonly extra: string } | undefined): ModelChoice | Error | undefined {
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

/** After a lane is added: the fixes a launch would ask for (folder, pi extension, Claude Code plugin and memory import), each after a yes. */
export async function wireLane(app: App, name: string): Promise<void> {
	app.refresh();
	const row = app.lanes.find((r) => r.name === name);
	if (row === undefined || app.config === undefined) return;
	const tools = app.deps.tools();
	const plan = launchPlan(app.config, row, tools);
	for (const step of plan.steps) {
		if (step.fix === undefined) continue;
		if (!(await app.host.open(new ConfirmModal(safeLines(step.text))))) continue;
		const { fix } = step;
		const config = app.config;
		await runFix(app, () => app.deps.applyFix(fix, config, row, tools));
	}
}

/** L: shows or asks what the launch plan says, then gives the terminal to the tool. */
export function launchLane(app: App, row: LaneRow | undefined): void {
	const config = app.config;
	if (row === undefined || config === undefined) return;
	app.run(`Launching ${row.name}`, async () => {
		let current = row;
		if (row.remote !== undefined) {
			if (app.deps.refreshRemote === undefined) throw new Error("Remote launch is unavailable here.");
			app.say(`Checking ${row.name} on ${row.remote}…`);
			await app.deps.refreshRemote(config, row.remote);
			const refreshed = app.deps.overview(config).find((lane) => lane.name === row.name);
			if (refreshed?.remoteReachable !== true) throw new Error(`Could not check remote ${row.remote}; ${row.name} was not launched. Try again when it is reachable.`);
			current = refreshed;
		}
		const held = current.heldElsewhere;
		const at = held === undefined ? undefined : new Date(held.lastSeen);
		const lastSeen = at === undefined ? "" : `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
		if (held !== undefined && !held.stale) throw new Error(`${row.name} is open on ${held.machine} (last seen ${lastSeen})`);
		const tools = app.deps.tools();
		const plan = launchPlan(config, current, tools);
		const label = launchLabel(plan);
		if (plan.blocked !== undefined) throw new Error(plan.blocked);
		if (held !== undefined) {
			if (app.deps.takeoverLane === undefined) throw new Error("Remote takeover is unavailable here.");
			const question = `${row.name} was open on ${held.machine}, last seen ${lastSeen}, saved up to save ${held.newestSave}. Take over?`;
			if (!(await app.host.open(new ConfirmModal(safeLines(question))))) return "Not launched.";
			await app.deps.takeoverLane(row.name);
		}
		for (const step of plan.steps) {
			if (!step.confirm) {
				await app.host.open(new MessageModal(label, safeLines(step.text)));
				continue;
			}
			if (!(await app.host.open(new ConfirmModal(safeLines(step.text))))) return "Not launched.";
			const { fix } = step;
			if (fix !== undefined && !(await runFix(app, () => app.deps.applyFix(fix, config, current, tools)))) return "Not launched.";
		}
		const exit = await app.deps.launch(plan);
		return exitText(label, exit) ?? `Back from ${label} (${row.name}).`;
	});
}

/** M: walks the summary picker, tests the pick, and switches the lane to it (or back to the config's model). */
export function chooseSummaryModel(app: App, row: LaneRow | undefined): void {
	const config = app.config;
	if (row === undefined || config === undefined) return;
	app.run(`Summary model for ${row.name}`, async () => {
		const sources = await app.deps.sources(config, row);
		const target = app.deps.target(config, row.name, (message) => app.say(message));
		const { choice: now, source } = target.current();
		const configured = target.configured();
		const reset = `Back to the config's model (${configured.provider}/${configured.modelId})`;
		const picked = await pickSummaryModel(menuUI(app.host), sources, { heading: summaryLine(now, source), thinking: now.thinking, askThinking: true, extra: source === "chat" ? [reset] : [] });
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

/** E: changes one of the lane's settings in the config file. */
export function editLane(app: App, row: LaneRow | undefined): void {
	if (row === undefined || app.config === undefined) return;
	if (!app.deps.configWritable()) {
		app.say(readOnlyConfigText(app.deps.configPath), "error");
		return;
	}
	app.run(`Editing ${row.name}`, async () => {
		const items = [`Tool: ${TOOL_LABELS[row.tool]}`, `Folder: ${row.workspace === undefined ? "none" : safeText(row.workspace)}`, `View size: ${kb(row.viewBudget)} KB`, `Summary-call size: ${kb(row.summaryContextBytes)} KB`, `Summary jobs: ${row.summaryJobs}`, `Claude Code compacts at: ${Math.round(row.compactAt / 1000)}K tokens`, `Launcher: ${row.launcher === "ori" ? "Ori" : "Direct"}`, `Ori model: ${safeText(row.oriModel ?? "default")}`, ...(row.remote !== undefined || (app.config?.remotes.size ?? 0) > 0 ? [`Memory home: ${row.remote ?? "local"}`] : [])];
		const picked = await app.host.open(new SelectModal(`${row.name}: change which setting?`, items));
		if (picked === undefined) return undefined;
		let key: EditableKey;
		let value: string | number;
		switch (items.indexOf(picked)) {
			case 0: {
				const label = await app.host.open(new SelectModal("Tool:", LANE_TOOLS.map((t) => TOOL_LABELS[t])));
				const tool = LANE_TOOLS.find((t) => TOOL_LABELS[t] === label);
				if (tool === undefined) return undefined;
				key = "tool";
				value = tool;
				break;
			}
			case 1: {
				const folder = await app.host.open(new InputModal("Folder (an absolute path; empty: none, it opens wherever it is opened):", row.workspace ?? ""));
				if (folder === undefined) return undefined;
				key = "workspace";
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
					if (app.deps.localLane === undefined) throw new Error("Changing memory home is unavailable here.");
					return app.deps.localLane(row.name);
				}
				if (app.deps.pushLane === undefined) throw new Error("Changing memory home is unavailable here.");
				return app.deps.pushLane(row.name, remote);
			}
			default:
				return undefined;
		}
		app.deps.editConfig((text, dir) => setLaneKey(text, dir, row.name, key, value));
		return key === "tool" || key === "workspace" ? `Saved. ${row.name} launches with it next time.` : `Saved. It applies when ${row.name} next opens.`;
	});
}

/** Imports a lane through the CLI's pull path; settings and memory come from the chosen remote. */
async function addFromRemote(app: App): Promise<string | undefined> {
	const config = app.config!;
	if (app.deps.remoteLanes === undefined || app.deps.pullLane === undefined) throw new Error("Remote lane import is unavailable here.");
	const remote = await app.host.open(new SelectModal("Remote:", [...config.remotes.keys()]));
	if (remote === undefined) return undefined;
	app.say(`Loading lanes from ${remote}…`);
	const existing = new Set([...config.lanes.keys()].map((name) => name.toLowerCase()));
	const lanes = (await app.deps.remoteLanes(config, remote)).filter((lane) => !existing.has(lane.lane.toLowerCase()));
	if (lanes.length === 0) return `No new lanes on remote ${remote}; any lanes there are already configured here.`;
	const labels = lanes.map((lane) => safeText(lane.lane));
	const selected = await app.host.open(new SelectModal(`Lane on ${remote}:`, labels));
	if (selected === undefined) return undefined;
	const folder = await app.host.open(new InputModal("Its folder:", app.deps.cwd));
	if (!folder) return undefined;
	app.say(`Pulling ${selected} from ${remote}…`);
	return app.deps.pullLane(lanes[labels.indexOf(selected)].lane, remote, expandHome(folder));
}

/** N: offers remote import, or asks for a new local lane's settings and then offers the wiring. */
export function newLane(app: App): void {
	const config = app.config;
	if (config === undefined) return;
	if (!app.deps.configWritable()) {
		app.say(readOnlyConfigText(app.deps.configPath), "error");
		return;
	}
	app.run("New lane", async () => {
		if (config.remotes.size > 0) {
			const kind = await app.host.open(new SelectModal("Add a lane:", ["New local lane", "Add a lane from a remote"]));
			if (kind === undefined) return undefined;
			if (kind === "Add a lane from a remote") return addFromRemote(app);
		}
		const name = await app.host.open(new InputModal("New lane's name (letters, digits, - and _):"));
		if (!name) return undefined;
		if (!NAME.test(name)) throw new Error("Lane names use letters, digits, - and _ (at most 32), starting with a letter.");
		if ([...config.lanes.keys()].some((n) => n.toLowerCase() === name.toLowerCase())) throw new Error(`A lane named ${name} already exists.`);
		const folderText = await app.host.open(new InputModal("Its folder:", app.deps.cwd));
		if (!folderText) return undefined;
		if (!isAbsolute(expandHome(folderText))) throw new Error("The folder must be an absolute path.");
		const checks = app.deps.tools();
		const tools = checks.filter((t) => t.id !== "ori");
		const found = tools.filter((t) => t.path !== undefined);
		const toolLabel = await app.host.open(new SelectModal("Its tool:", (found.length > 0 ? found : tools).map((t) => t.label)));
		const tool = LANE_TOOLS.find((t) => TOOL_LABELS[t] === toolLabel);
		if (tool === undefined) return undefined;
		const throughOri = checks.some((t) => t.id === "ori" && t.path !== undefined) ? await app.host.open(new SelectModal("Launch through Ori?", ["No", "Yes"])) : "No";
		if (throughOri === undefined) return undefined;
		const sources = await app.deps.sources(config, { launcher: throughOri === "Yes" ? "ori" : "direct" });
		const choice = pickedChoice(await pickSummaryModel(menuUI(app.host), sources, { heading: `${name}'s summaries`, thinking: "low", askThinking: true }));
		if (choice instanceof Error) throw choice;
		if (choice === undefined) return undefined;
		const test = await app.deps.testChoice(sources, choice);
		if (!test.ok) throw new Error(`Not added: ${test.reason}.`);
		const workspace = expandHome(folderText);
		app.deps.editConfig((text, dir) => addLane(text, dir, { name, workspace, tool, launcher: throughOri === "Yes" ? "ori" : "direct", compactorModel: `${choice.provider}/${choice.modelId}`, compactorThinking: choice.thinking }));
		await wireLane(app, name);
		return `Added ${name}. Press L to launch it.`;
	});
}

/** B: writes the lane's memory page and says where (and opens it when a display is there). */
export function browseLane(app: App, row: LaneRow | undefined): void {
	const config = app.config;
	if (row === undefined || config === undefined) return;
	app.run(`Writing ${row.name}'s memory page`, async () => {
		if (!row.hasMemory) throw new Error(`${row.name} has no memory yet.`);
		const { path, opened } = app.deps.browse(config, row.name);
		return opened === undefined ? `Wrote ${path} (no display here: open it yourself).` : `Wrote ${path} and opened it.`;
	});
}

/** A: takes the lane out of the config (its block kept as comments at the end); its memory stays where it is. */
export function archiveLaneAction(app: App, row: LaneRow | undefined): void {
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
		// The lane may have been opened while the question was up: look again before writing.
		app.refresh();
		const fresh = app.lanes.find((r) => r.name === row.name);
		if (fresh === undefined) throw new Error(`${row.name} is no longer in the config.`);
		const now = archiveRefusal(fresh);
		if (now !== undefined) throw new Error(now);
		const day = localIso(new Date(app.deps.now())).slice(0, 10);
		app.deps.editConfig((text, dir) => archiveLane(text, dir, row.name, day));
		return `Archived ${row.name}.`;
	});
}
