/** The TUI's real dependencies: orrery's shared functions, and the terminal hand-off for launching. */

import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { addRemoteCommand, agentRemoteCommand, pullAgentCommand } from "../cli/remote.ts";
import { browseCommand } from "../cli/commands.ts";
import { listChats } from "../import/chats.ts";
import { createFromPreview } from "../import/create-agent.ts";
import { dryRun } from "../import/dry-run.ts";
import { startBuild } from "../agent/build.ts";
import { agentCompactorTarget } from "../agent/compactor-target.ts";
import { type ConfigFile, configOf, readConfigFile, unchangedConfig } from "../agent/config.ts";
import { configWritable, editConfigOnce } from "../agent/config-edit.ts";
import { configureHttp } from "../agent/http.ts";
import { pageOpener } from "../agent/agent-commands.ts";
import { runEditor } from "../agent/editor.ts";
import { writeInstructions } from "../agent/instructions.ts";
import { applyFix, checkCodexHooks, checkOpenCodePlugin, runTool } from "../agent/launch.ts";
import { loginRows, removeLogin, saveKey, signIn } from "../agent/logins.ts";
import { agentOverview, agentUsage, OverviewCache } from "../agent/overview.ts";
import { versionNumber } from "../agent/running.ts";
import { openSummarySources, testChoice } from "../agent/summary-sources.ts";
import { checkTools, probeOri, installSteps, runningRoot, runningVersion, wiringRoot, runInstall } from "../agent/tools.ts";
import { installedVersion, updateCheck } from "../install/update.ts";
import { openStorage } from "../remote/index.ts";
import type { AppDeps } from "./app.ts";
import { colorWanted, makeTheme } from "./theme.ts";

/**
 * The config the TUI runs with: the file as its gate read and judged it (src/cli/gate.ts Gated.configFile), and how to
 * read and judge it again (the gate, run again for the same file).
 */
export interface JudgedConfig {
	readonly file: ConfigFile;
	readonly judge: () => ConfigFile;
}

/**
 * The TUI's config, read as the gate reads it: the file as last judged, while it is unchanged (unchangedConfig); once it
 * changed (another program wrote it, or this TUI did), judged again before it is used. Never a read the gate didn't
 * judge. Without `judged` (the TUI as a library, tests): `configPath`, read once each time it changed.
 */
export function judgedConfig(configPath: string, judged?: JudgedConfig): () => ConfigFile {
	const judge = judged?.judge ?? (() => readConfigFile(configPath));
	let file = judged?.file;
	return () => {
		if (file === undefined || !unchangedConfig(file)) file = judge();
		return file;
	};
}

/** AppDeps for a real terminal. */
export function realDeps(options: { configPath: string; tui: TUI; quit: () => void; config?: JudgedConfig }): AppDeps {
	configureHttp();
	const cache = new OverviewCache({ changed: () => options.tui.requestRender() });
	const { tui } = options;
	const current = judgedConfig(options.configPath, options.config);
	return {
		configPath: options.configPath,
		cwd: process.cwd(),
		theme: makeTheme(colorWanted()),
		loadConfig: () => configOf(current()),
		configWritable: () => configWritable(options.configPath),
		// What it wrote is judged too before it is used: the next read finds the file changed.
		editConfig: (edit) => {
			editConfigOnce(current(), edit);
			return configOf(current());
		},
		overview: (config) => agentOverview(config, { cache }),
		remotes: (config) => cache.remotes(config),
		refreshRemote: (config, name) => cache.refreshRemote(config, name),
		takeoverAgent: (name) => agentRemoteCommand(current(), ["takeover", name], { yes: true }),
		addRemote: (name, request, interaction) => addRemoteCommand(current(), name, request, interaction),
		remoteAgents: (config, name) => openStorage(config, name).list(),
		pullAgent: (name, remote, folder) => pullAgentCommand(current(), name, remote, folder),
		pushAgent: (name, remote) => agentRemoteCommand(current(), ["push", name], { to: remote }),
		localAgent: (name) => agentRemoteCommand(current(), ["local", name]),
		usage: (config, days, only) => agentUsage(config, days, only),
		tools: (options) => checkTools(options),
		ori: () => probeOri(),
		sources: (config, agent) => openSummarySources(config, agent),
		target: (config, agent, report = () => {}) => agentCompactorTarget(config, agent, { report }),
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
		codexCheck: (plan, say) => checkCodexHooks(plan, { onCheck: say }),
		opencodeCheck: (plan, say) => checkOpenCodePlugin(plan, { onCheck: say }),
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
		browse: (config, agent) => {
			const agentDir = config.agents.get(agent)?.dir ?? "";
			const path = browseCommand(config, agent, join(agentDir, "memory.html"));
			const opener = process.env.ORRERY_NO_OPEN === "1" ? undefined : pageOpener();
			opener?.open(path);
			return { path, ...(opener === undefined ? {} : { opened: opener.command }) };
		},
		chats: () => listChats(),
		importPreview: (input) => dryRun(input),
		importCommit: (request) => createFromPreview(current(), request),
		startBuild: (name, agentDir) => startBuild(name, agentDir, { configPath: options.configPath }),
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
				enabled = configOf(current()).updates.check;
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
