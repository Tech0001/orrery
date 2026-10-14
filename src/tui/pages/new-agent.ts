/**
 * N on the Lanes page (spec 2026-10-13-orrery-agents-design §6): an empty agent, one made from an existing Claude Code or
 * Codex chat, or (with remotes) one from a remote. Each asks through dialogs and writes nothing before its last step.
 */

import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { Chat } from "../../import/chats.ts";
import { type DryRunResult, newPreviewFolder } from "../../import/dry-run.ts";
import { storeRefusal } from "../../import/create-agent.ts";
import { suggestName } from "../../import/name.ts";
import { pickSummaryModel } from "../../lane/compactor-menu.ts";
import { readOnlyConfigText } from "../../lane/config-edit.ts";
import { type HarnessConfig, laneNameProblem, type LaneTool } from "../../lane/config.ts";
import { TOOL_LABELS } from "../../lane/overview.ts";
import { localIso } from "../../memory/index.ts";
import type { App } from "../app.ts";
import { ChatListModal, ConfirmModal, hardWrap, InputModal, MessageModal, menuUI, ProgressModal, ReportModal, SelectModal } from "../dialogs.ts";
import { addFromRemote, emptyLane, expandHome, pickedChoice, safeLines, wireLane } from "./lane-actions.ts";

/** The tools an imported chat continues in: Codex has no Orrery memory yet. */
const CONTINUES_IN: readonly LaneTool[] = ["pi", "omp", "claude-code"];

const NOT_IMPORTED = "Not imported; nothing was written.";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The day of an ISO date, in this machine's time ("?" when there is none). */
const day = (iso?: string) => (iso === undefined ? "?" : localIso(new Date(iso)).slice(0, 10));

/** The preview in a few lines: messages and dates, the chats, the secrets taken out, the pastes split. */
export function shortReport(result: DryRunResult, chats: readonly Chat[]): string {
	const s = result.summary;
	const secrets = Object.entries(s.redactions).map(([kind, count]) => `${kind} ${count}`).join(", ");
	const skipped = result.claude.skipped + result.codex.skipped;
	return [
		`${s.messages} messages, ${day(s.first)} to ${day(s.last)}`,
		`Chats: ${chats.map((chat) => chat.title).join("; ")}`,
		`Secrets removed: ${secrets === "" ? "none" : secrets}`,
		`Large pastes split: ${s.splits}${s.unsplit > 0 ? ` (${s.unsplit} kept whole: see the full report)` : ""}`,
		...(skipped > 0 ? [`Unreadable lines skipped: ${skipped} (a chat still being written ends in a half line)`] : []),
		...result.omitted.map((line) => `Left out: ${line}`),
	].join("\n");
}

/**
 * From an existing chat: the chats, a yes for any in use, the agent's name, tool, summary model and default folder; then
 * the dry run with a progress line, the short report, and on Enter the new agent, its memory committed and its build
 * started. Until Enter only the preview's own temporary folder is written, and it is always removed.
 */
async function fromChat(app: App, config: HarnessConfig): Promise<string | undefined> {
	const { chats } = app.deps.chats();
	if (chats.length === 0) return "No Claude Code or Codex chats were found.";
	const picked = await app.host.open(new ChatListModal("Turn which chat into an agent?", chats, { home: homedir(), now: app.deps.now() }));
	if (picked === undefined || picked.length === 0) return undefined;
	const live = picked.filter((chat) => chat.inUse);
	if (live.length > 0) {
		const question = `In use: ${live.map((chat) => `"${chat.title}"`).join(", ")} ${live.length === 1 ? "was" : "were"} written to in the last 10 minutes. The import is a snapshot: anything said after it is not in the agent. Import anyway?`;
		if (!(await app.host.open(new ConfirmModal(safeLines(hardWrap(question, 56).join("\n")))))) return undefined;
	}
	const first = picked[0] as Chat;
	const taken = [...config.lanes.keys()];
	const stored = (candidate: string) => storeRefusal(config.dataDir, candidate) !== undefined;
	const name = await app.host.open(new InputModal("Agent name (letters, digits, - and _):", suggestName(first.title, taken, stored)));
	if (!name) return undefined;
	const problem = laneNameProblem(name);
	if (problem !== undefined) throw new Error(problem);
	if (taken.some((other) => other.toLowerCase() === name.toLowerCase())) throw new Error(`A lane named ${name} already exists.`);
	// Said now, not after the preview: the import would refuse this folder at the end.
	const refusal = storeRefusal(config.dataDir, name);
	if (refusal !== undefined) throw new Error(refusal);
	const continues = await app.host.open(new SelectModal("It continues in (Codex has no Orrery memory yet):", CONTINUES_IN.map((id) => TOOL_LABELS[id])));
	const tool = CONTINUES_IN.find((id) => TOOL_LABELS[id] === continues);
	if (tool === undefined) return undefined;
	const sources = await app.deps.sources(config);
	const choice = pickedChoice(await pickSummaryModel(menuUI(app.host), sources, { heading: `${name}'s summaries`, thinking: "low", askThinking: true }));
	if (choice instanceof Error) throw choice;
	if (choice === undefined) return undefined;
	const test = await app.deps.testChoice(sources, choice);
	if (!test.ok) throw new Error(`Not added: ${test.reason}.`);
	const folderText = await app.host.open(new InputModal("Its default folder (empty: none, it opens wherever you open it):", ""));
	if (folderText === undefined) return undefined;
	const folder = folderText === "" ? undefined : expandHome(folderText);
	if (folder !== undefined && !isAbsolute(folder)) throw new Error("The folder must be an absolute path.");
	// The preview holds the chats' text: a private folder of its own (0700) in Orrery's data folder, removed however this
	// ends (one a killed TUI leaves is swept by a later preview).
	const out = newPreviewFolder(config.dataDir);
	try {
		const progress = new ProgressModal(`Preparing ${name}'s memory`);
		const shown = app.host.open(progress);
		let result: DryRunResult;
		try {
			result = await app.deps.importPreview({
				config,
				name,
				names: [...taken, name],
				summaryModel: choice,
				savedLoginsOnly: sources.savedLoginsOnly === true,
				claudeFiles: picked.filter((chat) => chat.tool === "claude-code").map((chat) => chat.file),
				codexFiles: picked.filter((chat) => chat.tool === "codex").map((chat) => chat.file),
				notes: [],
				pasteThreshold: 1200,
				split: true,
				out,
				signal: progress.signal,
				progress: (line) => {
					progress.say(line);
					app.deps.requestRender();
				},
			});
		} catch (error) {
			if (progress.signal.aborted) return NOT_IMPORTED;
			throw error;
		} finally {
			progress.close();
			await shown;
		}
		// Esc after the work's last look at its signal.
		if (progress.signal.aborted) return NOT_IMPORTED;
		for (;;) {
			const answer = await app.host.open(new ReportModal(`Import preview for ${name}`, shortReport(result, picked)));
			if (answer === "full") {
				await app.host.open(new MessageModal("Full report", safeLines(result.report)));
				continue;
			}
			if (answer !== "import") return NOT_IMPORTED;
			break;
		}
		const made = app.deps.importCommit({ name, tool, ...(folder === undefined ? {} : { folder }), summary: choice, previewPath: result.previewPath, title: first.title });
		// Wired before the build starts (while it runs the agent does not open, so a launch plan offers no fix); the build
		// starts however the wiring ends: a failed fix, an error, or the TUI quitting during its questions.
		let setup: string | undefined;
		let build: string | undefined;
		try {
			await wireLane(app, name);
		} catch (error) {
			setup = errorText(error);
		} finally {
			try {
				app.deps.startBuild(name, made.laneDir);
			} catch (error) {
				build = errorText(error);
			}
		}
		if (build !== undefined) return `Imported ${made.messages} messages into ${name}, but its memory build did not start (${build}): run orrery compact ${name}.`;
		if (setup !== undefined) return `Imported ${made.messages} messages into ${name}; its memory is being built, but its setup stopped: ${setup}.`;
		return `Imported ${made.messages} messages into ${name}; its memory is being built (its row shows how far).`;
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

/** N: an empty agent, one from an existing chat, or one from a remote. */
export function newAgent(app: App): void {
	const config = app.config;
	if (config === undefined) return;
	if (!app.deps.configWritable()) {
		app.say(readOnlyConfigText(app.deps.configPath), "error");
		return;
	}
	app.run("New agent", async () => {
		const kinds = ["Empty agent", "From an existing chat", ...(config.remotes.size > 0 ? ["From a remote"] : [])];
		const kind = await app.host.open(new SelectModal("New agent:", kinds));
		if (kind === undefined) return undefined;
		if (kind === "From a remote") return addFromRemote(app);
		if (kind === "From an existing chat") return fromChat(app, config);
		return emptyLane(app, config);
	});
}
