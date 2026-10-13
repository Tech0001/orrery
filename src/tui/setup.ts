/** First run (spec §3.5): no config yet. Asks where memory lives, a first lane, a summary login and model, then wires the tool. */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pickSummaryModel } from "../lane/compactor-menu.ts";
import { LANE_TOOLS, type ModelChoice, parseConfig } from "../lane/config.ts";
import { addLane, newConfigText } from "../lane/config-edit.ts";
import { TOOL_LABELS } from "../lane/overview.ts";
import { explainFailure, safeText } from "../lane/source-labels.ts";
import { listSources, usable } from "../lane/summary-sources.ts";
import type { App } from "./app.ts";
import { InputModal, MessageModal, menuUI, SecretModal, SelectModal } from "./dialogs.ts";
import { expandHome, wireLane } from "./pages/lane-actions.ts";
import { signInInteraction } from "./signin.ts";

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const WAYS = ["Sign in to ChatGPT", "Add an Anthropic key", "Add an OpenAI key", "Add an OpenRouter key", "Sign in to OpenRouter"] as const;
const KEY_NAMES: Record<string, string> = { "Add an Anthropic key": "anthropic", "Add an OpenAI key": "openai", "Add an OpenRouter key": "openrouter" };
const errorText = (error: unknown) => safeText(error instanceof Error ? error.message : String(error));

/** The answer for data_dir, or undefined when it is the config's own folder (memory then lives beside the config). */
function dataFor(answer: string, configPath: string): string | undefined {
	return resolve(expandHome(answer)) === dirname(resolve(configPath)) ? undefined : answer;
}

/** Runs setup in the open TUI; true once the config is written. */
export async function firstRun(app: App): Promise<boolean> {
	app.setup = true;
	app.deps.requestRender();
	try {
		if (!app.deps.configWritable()) {
			await app.host.open(new MessageModal("Can't write the config", `Orrery can't write its config at ${safeText(app.deps.configPath)}. Make that folder writable, or set ORRERY_CONFIG to a config path you can write, then run orrery again.`));
			return false;
		}
		let dataText: string | undefined;
		let draft: ReturnType<typeof parseConfig> | undefined;
		while (draft === undefined) {
			dataText = await app.host.open(new InputModal("Welcome to Orrery. It keeps a long memory for each agent folder (a lane).\n\nWhere should memory live? (Esc leaves without writing anything)", "~/.orrery"));
			if (dataText === undefined) return false;
			if (dataText.trim() === "") continue;
			try {
				draft = parseConfig(newConfigText(dataFor(dataText, app.deps.configPath)), dirname(resolve(app.deps.configPath)));
				mkdirSync(draft.dataDir, { recursive: true, mode: 0o700 });
			} catch (error) {
				draft = undefined;
				await app.host.open(new MessageModal("Memory folder", `That folder won't do: ${errorText(error)}`));
			}
		}
		const data = dataText ?? "";
		let name: string | undefined;
		for (;;) {
			name = await app.host.open(new InputModal("Your first lane's name (letters, digits, - and _):"));
			if (name === undefined) return false;
			if (NAME.test(name)) break;
			await app.host.open(new MessageModal("Lane name", "Lane names use letters, digits, - and _ (at most 32), starting with a letter."));
		}
		const folder = await app.host.open(new InputModal("Its folder:", app.deps.cwd));
		if (folder === undefined) return false;
		const found = app.deps.tools().filter((t) => t.id !== "ori" && t.path !== undefined);
		if (found.length === 0) {
			await app.host.open(new MessageModal("No tools found", "None of pi, OMP, Claude Code or Codex is on PATH. Install one, then run orrery again."));
			return false;
		}
		const toolLabel = await app.host.open(new SelectModal("Its tool:", found.map((t) => t.label)));
		const tool = LANE_TOOLS.find((t) => TOOL_LABELS[t] === toolLabel);
		if (tool === undefined) return false;
		const sources = await app.deps.sources(draft);
		let choice: ModelChoice | undefined;
		let addLogin = false;
		while (choice === undefined) {
			if (addLogin || !(await listSources(sources)).some(usable)) {
				addLogin = false;
				const way = await app.host.open(new SelectModal("Orrery needs one way to make summaries. Pick one:", [...WAYS]));
				if (way === undefined) return false;
				try {
					if (way === WAYS[0] || way === "Sign in to OpenRouter") {
						const provider = way === WAYS[0] ? "openai" : "openrouter";
						const { interaction, close } = signInInteraction(app, provider === "openai" ? "ChatGPT" : "OpenRouter");
						try {
							await app.deps.signIn(sources, interaction, provider);
						} catch (error) {
							throw new Error(explainFailure(provider, error instanceof Error ? error.message : String(error)));
						} finally {
							close();
						}
					} else {
						const label = way.replace(/^Add an? /, "").replace(/ key$/, "");
						const key = await app.host.open(new SecretModal(`${label} API key (paste it; it is not shown):`));
						if (key !== undefined) await app.deps.saveKey(sources, KEY_NAMES[way], key);
					}
				} catch (error) {
					await app.host.open(new MessageModal("That didn't work", errorText(error)));
				}
				continue;
			}
			const picked = await pickSummaryModel(menuUI(app.host), sources, { heading: `${name}'s summaries`, thinking: "low", askThinking: true, extra: ["Add another login"] });
			if (picked === undefined) return false;
			if ("extra" in picked) {
				addLogin = true;
				continue;
			}
			if ("none" in picked) {
				await app.host.open(new MessageModal("Summaries", picked.none));
				continue;
			}
			app.say(`Testing ${picked.choice.provider}/${picked.choice.modelId}…`);
			app.deps.requestRender();
			const test = await app.deps.testChoice(sources, picked.choice);
			app.say("");
			if (!test.ok) {
				await app.host.open(new MessageModal("That model didn't answer", `${test.reason}. Pick another.`));
				continue;
			}
			choice = picked.choice;
		}
		const chosen = choice;
		const laneName = name;
		try {
			app.deps.editConfig((text, dir) =>
				addLane(text.trim() === "" || text === newConfigText() ? newConfigText(dataFor(data, app.deps.configPath)) : text, dir, {
					name: laneName,
					workspace: resolve(expandHome(folder)),
					tool,
					compactorModel: `${chosen.provider}/${chosen.modelId}`,
					compactorThinking: chosen.thinking,
				}),
			);
		} catch (error) {
			await app.host.open(new MessageModal("Can't write the config", `${errorText(error)}\nThe login you saved stays saved. Fix that and run orrery again.`));
			return false;
		}
		app.setup = false;
		await wireLane(app, laneName);
		app.showPage("lanes");
		app.say(`Orrery is set up. ${laneName} is ready: press L to launch it.`);
		return true;
	} finally {
		app.setup = false;
		app.refresh();
		app.deps.requestRender();
	}
}
