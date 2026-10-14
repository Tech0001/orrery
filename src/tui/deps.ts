/** The TUI's real dependencies: orrery's shared functions, and the terminal hand-off for launching. */

import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { addRemoteCommand, laneRemoteCommand, pullLaneCommand } from "../cli/remote.ts";
import { browseCommand } from "../cli/commands.ts";
import { listChats } from "../import/chats.ts";
import { createFromPreview } from "../import/create-agent.ts";
import { dryRun } from "../import/dry-run.ts";
import { startBuild } from "../lane/build.ts";
import { laneCompactorTarget } from "../lane/compactor-target.ts";
import { defaultConfigPath, loadConfig } from "../lane/config.ts";
import { configWritable, editConfigFile } from "../lane/config-edit.ts";
import { configureHttp } from "../lane/http.ts";
import { pageOpener } from "../lane/lane-commands.ts";
import { runEditor } from "../lane/editor.ts";
import { writeInstructions } from "../lane/instructions.ts";
import { applyFix, runTool } from "../lane/launch.ts";
import { loginRows, removeLogin, saveKey, signIn } from "../lane/logins.ts";
import { laneOverview, laneUsage, OverviewCache } from "../lane/overview.ts";
import { versionNumber } from "../lane/running.ts";
import { openSummarySources, testChoice } from "../lane/summary-sources.ts";
import { checkTools, probeOri, installSteps, runningRoot, runningVersion, wiringRoot, runInstall } from "../lane/tools.ts";
import { installedVersion, updateCheck } from "../install/update.ts";
import { openStorage } from "../remote/index.ts";
import type { AppDeps } from "./app.ts";
import { colorWanted, makeTheme } from "./theme.ts";

/** AppDeps for a real terminal. */
export function realDeps(options: { configPath: string; tui: TUI; quit: () => void }): AppDeps {
	configureHttp();
	const cache = new OverviewCache({ changed: () => options.tui.requestRender() });
	const { tui } = options;
	return {
		configPath: options.configPath,
		cwd: process.cwd(),
		theme: makeTheme(colorWanted()),
		loadConfig: () => loadConfig(options.configPath),
		configWritable: () => configWritable(options.configPath),
		editConfig: (edit) => editConfigFile(options.configPath, edit),
		overview: (config) => laneOverview(config, { cache }),
		remotes: (config) => cache.remotes(config),
		refreshRemote: (config, name) => cache.refreshRemote(config, name),
		takeoverLane: (name) => laneRemoteCommand(options.configPath, ["takeover", name], { yes: true }),
		addRemote: (name, request, interaction) => addRemoteCommand(options.configPath, name, request, interaction),
		remoteLanes: (config, name) => openStorage(config, name).list(),
		pullLane: (name, remote, folder) => pullLaneCommand(options.configPath, name, remote, folder),
		pushLane: (name, remote) => laneRemoteCommand(options.configPath, ["push", name], { to: remote }),
		localLane: (name) => laneRemoteCommand(options.configPath, ["local", name]),
		usage: (config, days, only) => laneUsage(config, days, only),
		tools: (options) => checkTools(options),
		ori: () => probeOri(),
		sources: (config, lane) => openSummarySources(config, lane),
		target: (config, lane, report = () => {}) => laneCompactorTarget(config, lane, { report }),
		loginRows,
		saveKey,
		signIn,
		removeLogin,
		testChoice: (sources, choice) => testChoice(sources, choice),
		launch: async (plan) => {
			// Leave the alternate screen without printing the last frame above the tool.
			tui.stop({ preserveScreen: true });
			try {
				return await runTool(plan);
			} finally {
				tui.start();
				tui.requestRender(true);
			}
		},
		applyFix: (fix, config, row, tools, cwd) => applyFix(fix, config, row, tools, cwd === undefined ? {} : { cwd }),
		edit: async (path) => {
			// As launch does: the editor gets the terminal, and the TUI comes back when it exits.
			tui.stop({ preserveScreen: true });
			try {
				return await runEditor(path);
			} finally {
				tui.start();
				tui.requestRender(true);
			}
		},
		installSteps: (check) => installSteps(check, wiringRoot().root),
		install: (steps) => runInstall(steps),
		browse: (config, lane) => {
			const laneDir = config.lanes.get(lane)?.dir ?? "";
			const path = browseCommand(config, lane, join(laneDir, "memory.html"));
			const opener = process.env.ORRERY_NO_OPEN === "1" ? undefined : pageOpener();
			opener?.open(path);
			return { path, ...(opener === undefined ? {} : { opened: opener.command }) };
		},
		chats: () => listChats(),
		importPreview: (input) => dryRun(input),
		importCommit: (request) => createFromPreview(options.configPath, request),
		startBuild: (name, laneDir) => startBuild(name, laneDir, { configPath: options.configPath }),
		writeInstructions,
		openUrl: (url) => {
			const opener = process.env.ORRERY_NO_OPEN === "1" ? undefined : pageOpener();
			opener?.open(url);
			return opener?.command;
		},
		installedVersion: () => installedVersion(process.env),
		updateNotice: async () => {
			let enabled = true;
			try {
				enabled = loadConfig(defaultConfigPath(process.env)).updates.check;
			} catch {
				// no config yet (first run) or one that does not load: the TUI says that elsewhere; check anyway
			}
			return updateCheck(process.env, Date.now(), { enabled, running: versionNumber() });
		},
		about: () => ({ version: versionNumber(), root: runningRoot(), running: runningVersion() }),
		rows: () => tui.terminal.rows,
		now: () => Date.now(),
		quit: options.quit,
		requestRender: () => tui.requestRender(),
	};
}
