/**
 * Page 1, Agents (spec §3.1): one row per agent. Enter (or L) opens the agent in its tool (spec 2026-10-13-orrery-agents-design
 * §4), i shows its page. Actions are added in agent-actions.ts.
 */

import { join } from "node:path";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type AgentTool, readBy } from "../../agent/config.ts";
import { ago, type AgentRow, summaryText, TOOL_LABELS } from "../../agent/overview.ts";
import { needsRestart } from "../../install/update.ts";
import { safeText } from "../../agent/source-labels.ts";
import { localIso } from "../../memory/index.ts";
import type { UsageRow } from "../../memory/types.ts";
import type { App, Page } from "../app.ts";
import { type Column, compactCount, fit, renderTable } from "../table.ts";
import { archiveAgentAction, browseAgent, chooseSummaryModel, editInstructions, editAgent, launchAgent, readsText } from "./agent-actions.ts";
import { newAgent } from "./new-agent.ts";

/**
 * The full row needs exactly 100 columns (with the 2-column gutter and 2-space gaps): the summary model drops below
 * 100, the last message below 82, the view below 72. Summaries takes all spare width.
 */
const COLUMNS: readonly Column[] = [
	{ title: "Agent", width: 10 },
	{ title: "Tool", width: 6 },
	{ title: "State", width: 9 },
	{ title: "Msgs", width: 6, align: "right" },
	{ title: "View", width: 10, drop: 3 },
	{ title: "Summaries", width: 11, grow: true },
	{ title: "Memory", width: 6 },
	{ title: "Summary model", width: 16, drop: 1 },
	{ title: "Last msg", width: 8, drop: 2 },
];

/** Tool names short enough for the table; the agent's page and the filter use the full ones. */
const SHORT_TOOL: Record<AgentTool, string> = { pi: "pi", "claude-code": "Claude", codex: "Codex", omp: "OMP", opencode: "OpenCode" };

const NO_AGENTS = "No agents yet. Press N to add one.";
const kb = (bytes: number) => Math.round(bytes / 1000);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** "openai/gpt-6.1-sol" → "gpt-6.1-sol": the provider is everything before the first slash. */
const modelId = (ref: string) => ref.slice(ref.indexOf("/") + 1);

/** The table's model cell drops a leading "claude-" too ("claude-sonnet-5-5" → "sonnet-5-5"). */
const tableModelId = (ref: string) => modelId(ref).replace(/^claude-/, "");

/** The list's orders, in the order `s` cycles through them, by the name the hint shows. */
const ORDERS = ["config", "name", "last msg", "attention"] as const;
type Order = (typeof ORDERS)[number];

/** Each App's order (an index into ORDERS); it lasts for the TUI session and is never saved. */
const orders = new WeakMap<App, number>();
const orderOf = (app: App): Order => ORDERS[orders.get(app) ?? 0];

/** When the agent's last message was (ms), or -Infinity when it has none. */
function lastAt(row: AgentRow): number {
	const at = row.lastMessageAt === undefined ? Number.NaN : Date.parse(row.lastMessageAt);
	return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/** Newest last message first; agents without one go last. */
const byLastMessage = (a: AgentRow, b: AgentRow) => (lastAt(a) === lastAt(b) ? 0 : lastAt(a) > lastAt(b) ? -1 : 1);

/** 0: failing, stopped or unreadable; 1: catching up or waiting; 2: the rest. */
function attention(row: AgentRow): number {
	if (row.unreadable !== undefined || row.summary.state === "failing" || row.summary.state === "stopped") return 0;
	return row.summary.state === "catching up" || row.summary.state === "waiting" ? 1 : 2;
}

/** `rows` in `order` (a stable sort: ties keep the config's order). */
function sortAgents(rows: readonly AgentRow[], order: Order): AgentRow[] {
	const out = [...rows];
	if (order === "name") out.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
	else if (order === "last msg") out.sort(byLastMessage);
	else if (order === "attention") out.sort((a, b) => attention(a) - attention(b) || byLastMessage(a, b));
	return out;
}

/** The agents the filter leaves, in the list's order. */
export function visibleAgents(app: App): AgentRow[] {
	const words = app.filterText().toLowerCase().split(/\s+/).filter(Boolean);
	const rows = app.agents.filter((row) => words.every((w) => `${row.name} ${TOOL_LABELS[row.tool]} ${row.launcher ?? "direct"} ${row.state} ${row.remote ?? ""} ${row.heldElsewhere?.machine ?? ""} ${row.folder ?? ""}`.toLowerCase().includes(w)));
	return sortAgents(rows, orderOf(app));
}

/**
 * Each App's chosen agent, by name. The selection is a row number, and a refresh can re-sort the list (by last message,
 * by attention) or change it: the cursor follows the agent, so L never acts on an agent the user did not pick.
 */
const chosen = new WeakMap<App, string>();

/** Notes the agent under the cursor as the chosen one (not while an agent's page is open: the list is not shown). */
function remember(app: App): void {
	if (app.detail !== undefined) return;
	const name = visibleAgents(app)[app.sel()]?.name;
	if (name === undefined) chosen.delete(app);
	else chosen.set(app, name);
}

/** Puts the cursor back on the chosen agent; when it is gone, on the nearest row, whose agent becomes the chosen one. */
function follow(app: App): void {
	if (app.detail !== undefined) return;
	const name = chosen.get(app);
	const at = name === undefined ? -1 : visibleAgents(app).findIndex((row) => row.name === name);
	app.select(at === -1 ? app.sel() : at);
}

/** s: the next order; the cursor stays on the agent it was on. */
function nextOrder(app: App): void {
	orders.set(app, ((orders.get(app) ?? 0) + 1) % ORDERS.length);
	follow(app);
}

/** The agent the cursor (or the open agent page) is on. */
export function selectedAgent(app: App): AgentRow | undefined {
	if (app.detail !== undefined) return app.agents.find((row) => row.name === app.detail);
	return visibleAgents(app)[app.sel()];
}

/**
 * "on 0.6.0, restart for 0.6.1" when the agent's open tool runs another Orrery than the installed current one and not a
 * newer release (needsRestart: 0.6.0-aaa under a current 0.6.0-bbb is marked; an agent left newer by a rollback is not).
 * A checkout or an unknown version is never marked.
 */
function restartText(row: AgentRow, installed: string | undefined): string {
	if (!needsRestart(row.runsVersion, installed)) return "";
	return `on ${safeText(row.runsVersion ?? "")}, restart for ${safeText(installed ?? "")}`;
}

function remoteState(row: AgentRow, installed?: string): string {
	const restart = restartText(row, installed);
	const mark = restart === "" ? "" : ` · ${restart}`;
	if (row.remotePending) return `${row.state} · …`;
	if (row.remoteReachable === false) return `${row.state} · unreachable`;
	return row.heldElsewhere === undefined ? `${row.state}${mark}` : `${row.state} · open on ${safeText(row.heldElsewhere.machine)}${row.heldElsewhere.stale ? " (stale)" : ""}${mark}`;
}

/** What the state cell adds about the agent's instructions. */
function instructionsNote(row: AgentRow): string {
	if (row.instructionsNewer === true) return " · new instructions: restart";
	if (row.instructions === "none") return " · no instructions";
	if (row.instructions === "too large") return " · instructions over 32 KB";
	return "";
}

/** The state cell: the agent's state and remote, a restart marker, a note on its instructions, and its memory build. */
const stateText = (row: AgentRow, installed?: string) => `${remoteState(row, installed)}${instructionsNote(row)}${row.building === undefined ? "" : ` · ${row.building}`}`;

function cells(row: AgentRow, now: number, withRemotes: boolean, installed?: string): string[] {
	return [
		row.name,
		`${SHORT_TOOL[row.tool]}${row.launcher === "ori" ? " · Ori" : ""}`,
		stateText(row, installed),
		row.hasMemory ? String(row.messages) : "—",
		row.hasMemory ? `${kb(row.viewBytes)}/${kb(row.viewBudget)} KB` : "—",
		row.unreadable !== undefined ? "unreadable" : summaryText(row),
		...(withRemotes ? [row.remote ?? "local"] : []),
		`${tableModelId(row.summaryModel.ref)} ${row.summaryModel.thinking}`,
		ago(row.lastMessageAt, now),
	];
}

/** A backup older than this many days is shown in yellow. */
const BACKUP_STALE_DAYS = 2;

/** Whole days from the backup's day to today (both local dates, as backups name their folders). */
function backupAge(day: string, now: number): number {
	return Math.round((Date.parse(localIso(new Date(now)).slice(0, 10)) - Date.parse(day)) / 86_400_000);
}

/** "2026-10-08  (<folder>)" or "never — run orrery backup", and whether it wants attention (yellow). */
function backupText(app: App, row: AgentRow): { text: string; stale: boolean } {
	if (row.lastBackup === undefined) return row.hasMemory ? { text: "never — run orrery backup", stale: true } : { text: "never (no memory yet)", stale: false };
	const folder = app.config === undefined ? "" : `  (${safeText(join(app.config.dataDir, "backups", row.lastBackup, row.name))})`;
	return { text: `${row.lastBackup}${folder}`, stale: backupAge(row.lastBackup, app.deps.now()) > BACKUP_STALE_DAYS };
}

/** The agent page's Instructions field. */
function instructionsField(row: AgentRow): string {
	if (row.instructions === "none") return "none yet";
	if (row.instructions === "too large") return "over 32 KB: only the first 32 KB reach the model";
	return `instructions.md${row.instructionsNewer === true ? " (newer than the open session's: it uses them at its next start)" : ""}`;
}

/** Each App's "Tokens, 7 days" text per agent, read when the agent's page opens. */
const pageUsage = new WeakMap<App, Map<string, string>>();

/** The agent page's Read by field: who lists the agent by name, and who reads every agent. */
function readByText(by: ReturnType<typeof readBy>): string {
	const names = by.names.map(safeText).join(", ");
	const everyone = by.everyone.length === 0 ? "" : `every agent that reads all: ${by.everyone.map(safeText).join(", ")}`;
	if (names === "") return everyone === "" ? "none" : everyone;
	return everyone === "" ? names : `${names} (and ${everyone})`;
}

function detailLines(app: App, row: AgentRow, width: number): string[] {
	const { theme } = app.deps;
	const field = (label: string, value: string) => wrapTextWithAnsi(`${label.padEnd(18)}${value}`, width).map((l) => fit(l, width));
	const reads = readsText(row.reads);
	const by = app.config === undefined ? undefined : readBy(app.config, row.name);
	const readByLine = by === undefined ? undefined : readByText(by);
	const usage = pageUsage.get(app)?.get(row.name);
	const backup = backupText(app, row);
	return [
		theme.bold(fit(`${row.name} · ${TOOL_LABELS[row.tool]} · ${stateText(row)}`, width)),
		"",
		...field("Folder", row.folder === undefined ? "none (it opens wherever it is opened)" : safeText(row.folder)),
		...field("Instructions", instructionsField(row)),
		...field("Data folder", safeText(row.dataDir)),
		...field("Tool", row.toolSet ? TOOL_LABELS[row.tool] : `${TOOL_LABELS[row.tool]} (guessed: the config has no tool key; set it with C)`),
		...field("Launcher", row.launcher === "ori" ? `Ori${row.oriModel === undefined ? "" : ` (model ${safeText(row.oriModel)})`}` : "Direct"),
		...(row.remote !== undefined || (app.config?.remotes.size ?? 0) > 0 ? field("Memory home", row.remote ?? "local") : []),
		...field("Memory", row.hasMemory ? `${row.messages} messages, ${row.summaries} summaries, view ${kb(row.viewBytes)}/${kb(row.viewBudget)} KB` : "no memory yet"),
		...field("Summary calls", `up to ${kb(row.summaryContextBytes)} KB of context, ${row.summaryJobs} at a time`),
		...field("Summaries", row.unreadable !== undefined ? `unreadable: ${row.unreadable}` : summaryText(row)),
		...(row.building === undefined ? [] : field("Memory build", row.building)),
		...field("Summary model", `${row.summaryModel.ref} ${row.summaryModel.thinking} (${row.summaryModel.source === "chat" ? "chosen in chat" : "from the config"})`),
		...field("Reads", reads),
		...(readByLine === undefined ? [] : field("Read by", readByLine)),
		...field("Last message", row.lastMessageAt === undefined ? "—" : `${ago(row.lastMessageAt, app.deps.now())} ago`),
		...field("Last backup", backup.text).map((line) => (backup.stale ? theme.yellow(line) : line)),
		...field("Tokens, 7 days", usage ?? "—"),
		"",
		theme.dim(fit("Enter or L open · M summary model · E instructions · C settings · B browse memory · A archive · Esc back", width)),
	];
}

/** "chat 5.2M in (81% cached), 41.8K out · summaries 900 in (10% cached), 30 out", or "unreadable: <reason>". */
function usageLine(app: App, agent: string): string {
	if (app.config === undefined) return "—";
	let rows: readonly UsageRow[];
	try {
		rows = app.deps.usage(app.config, 7, agent).find((u) => u.name === agent)?.rows ?? [];
	} catch (error) {
		return `unreadable: ${safeText(errorText(error))}`;
	}
	const part = (role: "agent" | "compactor", label: string) => {
		const mine = rows.filter((r) => r.role === role);
		if (mine.length === 0) return `${label} —`;
		const input = mine.reduce((s, r) => s + r.input + r.cacheRead, 0);
		const cached = mine.reduce((s, r) => s + r.cacheRead, 0);
		const out = mine.reduce((s, r) => s + r.output, 0);
		return `${label} ${compactCount(input)} in (${input === 0 ? 0 : Math.round((100 * cached) / input)}% cached), ${compactCount(out)} out`;
	};
	return `${part("agent", "chat")} · ${part("compactor", "summaries")}`;
}

/** i: the agent's page, with its token use read once as it opens. */
function showDetails(app: App): void {
	const row = selectedAgent(app);
	if (row === undefined) return;
	app.detail = row.name;
	const usage = pageUsage.get(app) ?? new Map<string, string>();
	usage.set(row.name, usageLine(app, row.name));
	pageUsage.set(app, usage);
}

export const agentsPage: Page = {
	id: "agents",
	title: "Agents",
	// Short words, so the order and "q quit" still fit at 120 columns: the list leaves B and A to the agent's page and ?.
	hints: (app) =>
		app.detail !== undefined ? "Esc back · Enter open · M model · E instructions · C settings · B browse · A archive" : `Enter open · i details · N new · M model · E instructions · C settings · s sort: ${orderOf(app)}`,
	refresh(app) {
		// An agent taken out of the config closes its page.
		if (app.detail !== undefined && !app.agents.some((r) => r.name === app.detail)) app.detail = undefined;
		follow(app);
	},
	onSelect: remember,
	count: (app) => (app.detail !== undefined ? 1 : visibleAgents(app).length),
	render(app, width, height) {
		const { theme } = app.deps;
		const open = app.detail === undefined ? undefined : app.agents.find((r) => r.name === app.detail);
		if (open !== undefined) return detailLines(app, open, width);
		const rows = visibleAgents(app);
		if (app.agents.length === 0) return [fit(NO_AGENTS, width)];
		const now = app.deps.now();
		const withRemotes = (app.config?.remotes.size ?? 0) > 0;
		const baseColumns = withRemotes ? COLUMNS : COLUMNS.filter((c) => c.title !== "Memory").map((c) => c.title === "Summaries" ? { ...c, width: c.width + 8 } : c);
		// Borrow six columns from summaries only when a launcher needs the wider tool cell.
		let columns = rows.some((r) => r.launcher === "ori") ? baseColumns.map((c) => c.title === "Tool" ? { ...c, width: 12 } : c.title === "Summaries" ? { ...c, width: c.width - 6 } : c) : [...baseColumns];
		const installed = app.installed;
		if (rows.some((r) => r.remote !== undefined || restartText(r, installed) !== "" || instructionsNote(r) !== "" || r.building !== undefined)) {
			// From 90 columns the restart marker always fits whole ("working · on 0.6.0-219a227, restart for 0.6.1"); notes after it may be cut at 42.
			const restart = Math.max(0, ...rows.map((r) => (restartText(r, installed) === "" ? 0 : remoteState(r, installed).length)));
			const stateWidth = Math.max(9, Math.min(width < 90 ? 24 : Math.max(42, restart), Math.max(...rows.map((r) => stateText(r, installed).length))));
			const memoryWidth = Math.max(6, Math.min(12, Math.max(...rows.map((r) => (r.remote ?? "local").length))));
			columns = columns.map((c) => c.title === "State" ? { ...c, width: stateWidth } : c.title === "Memory" ? { ...c, width: memoryWidth } : c.title === "Summaries" ? { ...c, drop: 4 } : c.title === "Msgs" ? { ...c, drop: 5 } : c);
		}
		return renderTable(columns, rows.map((r) => cells(r, now, withRemotes, installed)), width, {
			selected: app.sel(),
			height,
			theme,
			rowStyle: (i) => {
				const row = rows[i];
				if (row.unreadable !== undefined || row.summary.state === "failing" || row.summary.state === "stopped") return theme.red;
				if (row.summary.state === "catching up" || row.building !== undefined) return theme.yellow;
				// "waiting" is a closed agent with messages still to summarize: dim, like any closed agent.
				return row.state === "closed" || row.summary.state === "waiting" ? theme.dim : undefined;
			},
		});
	},
	enter(app) {
		launchAgent(app, selectedAgent(app));
	},
	back(app) {
		if (app.detail === undefined) return false;
		app.detail = undefined;
		follow(app);
		return true;
	},
	key(app, data) {
		const row = selectedAgent(app);
		switch (data.toLowerCase()) {
			case "l":
				launchAgent(app, row);
				return true;
			case "i":
				if (app.detail !== undefined) return false;
				showDetails(app);
				return true;
			case "n":
				newAgent(app);
				return true;
			case "m":
				chooseSummaryModel(app, row);
				return true;
			case "e":
				editInstructions(app, row);
				return true;
			case "c":
				editAgent(app, row);
				return true;
			case "b":
				browseAgent(app, row);
				return true;
			case "a":
				archiveAgentAction(app, row);
				return true;
			case "s":
				if (app.detail !== undefined) return false;
				nextOrder(app);
				return true;
			default:
				return false;
		}
	},
};
