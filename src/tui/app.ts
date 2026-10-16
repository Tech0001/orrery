/**
 * The orrery TUI (spec 2026-10-08-orrery-tui-design §3): one component that draws a page (or the top dialog), a
 * status line and the keys, and routes input. Pages hold no rules: they call AppDeps, which are orrery's shared
 * functions. Quitting never stops an agent.
 */

import type { RemoteAddResult, RemoteInteraction, RemoteOptions } from "../cli/remote.ts";
import type { ChatList } from "../import/chats.ts";
import type { NewAgentFromChat } from "../import/create-agent.ts";
import type { DryRunInput, DryRunResult } from "../import/dry-run.ts";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { type Component, decodeKittyPrintable, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { HarnessConfig, AgentConfig, ModelChoice } from "../agent/config.ts";
import type { LaunchFix, LaunchPlan, ToolExit } from "../agent/launch.ts";
import type { CodexGate } from "../codex/check.ts";
import type { LoginRow } from "../agent/logins.ts";
import type { AgentRow, AgentUsage, RemoteRow } from "../agent/overview.ts";
import { safeText } from "../agent/source-labels.ts";
import type { SummarySources, TestResult } from "../agent/summary-sources.ts";
import type { CompactorTarget } from "../agent/summary-text.ts";
import type { InstallStep, ToolCheck } from "../agent/tools.ts";
import type { LaneEntry } from "../remote/types.ts";
import { LOGO_WIDTH, orreryLogo } from "./art.ts";
import { ModalHost } from "./dialogs.ts";
import { fit } from "./table.ts";
import type { Theme } from "./theme.ts";

export type PageId = "agents" | "logins" | "usage" | "tools";

/** What the TUI asks of orrery. deps.ts wires the real functions; tests pass fakes. */
export interface AppDeps {
	readonly configPath: string;
	/** The folder orrery was started in (the new-agent default). */
	readonly cwd: string;
	readonly theme: Theme;
	loadConfig(): HarnessConfig;
	configWritable(): boolean;
	editConfig(edit: (text: string, configDir: string) => string): HarnessConfig;
	overview(config: HarnessConfig): AgentRow[];
	/** Optional in the read-only demo. The terminal shares this cache with overview(). */
	remotes?(config: HarnessConfig): readonly RemoteRow[];
	refreshRemote?(config: HarnessConfig, name: string): Promise<void>;
	/** The caller has confirmed taking over a stale lock; this takes and releases it. */
	takeoverAgent?(name: string): Promise<string>;
	addRemote?(name: string, options: RemoteOptions, interaction: RemoteInteraction): Promise<RemoteAddResult>;
	remoteAgents?(config: HarnessConfig, name: string): Promise<readonly LaneEntry[]>;
	/** Without a folder the pulled agent has no default folder. */
	pullAgent?(name: string, remote: string, folder?: string): Promise<string>;
	pushAgent?(name: string, remote: string): Promise<string>;
	localAgent?(name: string): Promise<string>;
	/** Token use over the last `days` days, for every agent with memory, or only `only`. */
	usage(config: HarnessConfig, days: number, only?: string): AgentUsage[];
	tools(options?: { probeWrangler?: boolean }): ToolCheck[];
	ori?(): Promise<ToolCheck>;
	sources(config: HarnessConfig, agent?: Pick<AgentConfig, "launcher">): Promise<SummarySources>;
	target(config: HarnessConfig, agent: string, report?: (message: string) => void): CompactorTarget;
	loginRows(sources: SummarySources, rows: readonly AgentRow[]): Promise<LoginRow[]>;
	saveKey(sources: SummarySources, name: string, key: string, notice?: (text: string) => void): Promise<string>;
	signIn(sources: SummarySources, interaction: AuthInteraction, name?: string): Promise<void>;
	removeLogin(sources: SummarySources, request: { readonly signin?: string; readonly key?: string }): Promise<string>;
	testChoice(sources: SummarySources, choice: ModelChoice): Promise<TestResult>;
	/** Gives the terminal to the tool and takes it back when the tool exits. */
	launch(plan: LaunchPlan): Promise<ToolExit>;
	/** Before Codex opens: whether Orrery's hooks load in it (src/codex/check.ts); `say` hears when Codex is asked. */
	codexCheck(plan: LaunchPlan, say: (text: string) => void): Promise<CodexGate>;
	/** `cwd`: the folder the launch opens in (create-folder makes it). */
	applyFix(fix: LaunchFix, config: HarnessConfig, row: AgentRow, tools: readonly ToolCheck[], cwd?: string): string;
	/** Gives the terminal to $EDITOR on `path` and takes it back (src/agent/editor.ts). Absent in the read-only demo. */
	edit?(path: string): Promise<ToolExit>;
	installSteps(check: ToolCheck): InstallStep[];
	install(steps: readonly InstallStep[]): { ok: boolean; output: string };
	/** Opens a link in the browser; the opener's name, or undefined without a display. */
	openUrl(url: string): string | undefined;
	browse(config: HarnessConfig, agent: string): { path: string; opened?: string };
	/** The Claude Code and Codex chats to turn into an agent (src/import/chats.ts). */
	chats(): ChatList;
	/** The import's dry run (src/import/dry-run.ts): writes only into `input.out`. */
	importPreview(input: DryRunInput): Promise<DryRunResult>;
	/** Adds the agent and commits the reviewed preview into its memory (src/import/create-agent.ts). */
	importCommit(request: NewAgentFromChat): { readonly agentDir: string; readonly messages: number };
	/** Starts the agent's memory build in the background (src/agent/build.ts). */
	startBuild(name: string, agentDir: string): void;
	/** Writes the agent's instructions.md (src/agent/instructions.ts). */
	writeInstructions(agentDir: string, text: string): void;
	/** orrery's own version and folder, for the Tools page. */
	about(): { readonly version: string; readonly root: string; /** The installed version folder running, or "checkout". */ readonly running?: string };
	/** The version `app/current` names (what a restarted agent would run), or undefined when none is installed. */
	installedVersion(): string | undefined;
	/** The text of the daily update notice ("0.6.1 available · run orrery update"), or undefined. Never throws on a network failure. */
	updateNotice(): Promise<string | undefined>;
	rows(): number;
	now(): number;
	quit(): void;
	requestRender(): void;
}

export interface Page {
	readonly id: PageId;
	readonly title: string;
	/** The page's own keys, for the bottom line (a function when they show the page's state). */
	readonly hints: string | ((app: App) => string);
	/** When the user switches to the page (not on the timer's refreshes). */
	show?(app: App): void;
	/** When the page is shown, and on every refresh while it is. */
	refresh?(app: App): void;
	/** How many rows the page lists now (after the filter). */
	count(app: App): number;
	render(app: App, width: number, height: number): string[];
	enter?(app: App): void;
	/** When the selection moves (arrows, a filter change, or the page itself). */
	onSelect?(app: App): void;
	/** Esc: true when the page handled it (left a detail view). */
	back?(app: App): boolean;
	/** A one-letter action; false when the page has no such key. */
	key(app: App, data: string): boolean;
}

const MIN_WIDTH = 60;
const MIN_ROWS = 12;
/** From this many rows the header is the logo with the name and tabs beside it; below, one line. */
const LOGO_ROWS = 18;
/** Columns before the logo, and between the logo and the name and tabs. */
const LOGO_PAD = 1;
const LOGO_GAP = 2;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const HELP = [
	"Keys",
	"",
	"1-4 or ← →   switch pages",
	"↑ ↓ or k j   select",
	"Enter        open             Esc   back",
	"/            filter the list   ?     this help",
	"q            quit (agents keep running in their tools)",
	"",
	"Agents:  Enter or L open · i details · N new agent · M summary model · E instructions · C settings",
	"        B browse memory · A archive · s sort (config, name, last message, needs attention)",
	"Logins: A add or replace · T test · D remove · R add remote",
	"Usage:  + more days · - fewer days",
	"Tools:  I install or repair",
	"",
	"Press any key to close.",
];

const WELCOME = [
	"Welcome to Orrery.",
	"",
	"Orrery keeps each agent's instructions and memory, and opens it in any folder, in pi, OMP or Claude Code.",
	"Setting up… Esc at any step leaves without writing a config.",
];

/** The word for an agent that needs attention ("failing", "stopped", "unreadable"), or undefined when it needs none. */
function troubleWord(row: AgentRow): string | undefined {
	if (row.unreadable !== undefined) return "unreadable";
	return row.summary.state === "failing" || row.summary.state === "stopped" ? row.summary.state : undefined;
}

/**
 * The header's warning in at most `room` columns: "⚠ Birch summaries failing", or "⚠ 3 agents need attention (Birch,
 * Cedar, …)" with as many names as fit. "" when no agent needs attention, or when it does not fit (cut with an ellipsis
 * instead when `cut`).
 */
function attentionText(agents: readonly AgentRow[], room: number, cut: boolean): string {
	const troubled = agents.filter((row) => troubleWord(row) !== undefined);
	if (troubled.length === 0 || room < 1) return "";
	const names = troubled.map((row) => safeText(row.name));
	let text: string;
	if (troubled.length === 1) text = `⚠ ${names[0]} summaries ${troubleWord(troubled[0])}`;
	else {
		const head = `⚠ ${troubled.length} agents need attention`;
		text = head;
		for (let k = names.length; k >= 1; k--) {
			const listed = `${head} (${names.slice(0, k).join(", ")}${k < names.length ? ", …" : ""})`;
			if (visibleWidth(listed) <= room) {
				text = listed;
				break;
			}
		}
	}
	if (visibleWidth(text) <= room) return text;
	return cut ? fit(text, room).trimEnd() : "";
}

export class App implements Component {
	readonly deps: AppDeps;
	readonly host = new ModalHost();
	readonly pages: readonly Page[];
	config: HarnessConfig | undefined;
	configError: string | undefined;
	agents: AgentRow[] = [];
	/** The installed current version, read on each refresh; agents on an older one get a restart marker. */
	installed: string | undefined;
	/** The agent whose page is open (Agents page only). */
	detail: string | undefined;
	/** First run: no config yet; only setup's dialogs take keys. */
	setup = false;
	#page = 0;
	readonly #selected = new Map<PageId, number>();
	readonly #filter = new Map<PageId, string>();
	#filtering = false;
	#help = false;
	#status: { text: string; tone: "info" | "error" } | undefined;
	#action: Promise<void> | undefined;
	#version: string | undefined;
	#update: string | undefined;

	constructor(deps: AppDeps, pages: readonly Page[]) {
		this.deps = deps;
		this.pages = pages;
		this.host.onChange = () => deps.requestRender();
		// Once, in the background: the notice appears in the header when the answer comes.
		void Promise.resolve()
			.then(() => deps.updateNotice())
			.then((text) => {
				if (text === undefined) return;
				this.#update = safeText(text);
				deps.requestRender();
			})
			.catch(() => {});
	}

	get current(): Page {
		return this.pages[this.#page];
	}

	/** Reads the config and every agent again (every 2 s, and after each action). */
	refresh(): void {
		if (this.setup) return;
		try {
			this.config = this.deps.loadConfig();
			this.configError = undefined;
			this.agents = this.deps.overview(this.config);
			try {
				this.installed = this.deps.installedVersion();
			} catch {
				this.installed = undefined;
			}
		} catch (error) {
			this.config = undefined;
			this.configError = safeText(errorText(error));
			this.agents = [];
			this.#filtering = false;
		}
		try {
			if (this.config !== undefined) this.current.refresh?.(this);
		} catch (error) {
			this.say(errorText(error), "error");
		}
	}

	/** Switches to page `id` (its list, not a detail view). */
	showPage(id: PageId): void {
		const at = this.pages.findIndex((p) => p.id === id);
		if (at === -1) return;
		this.#page = at;
		this.detail = undefined;
		this.#filtering = false;
		if (this.config !== undefined) {
			this.current.show?.(this);
			this.current.refresh?.(this);
		}
	}

	/** The current page's selected row, kept inside its list. */
	sel(): number {
		const count = this.current.count(this);
		return Math.max(0, Math.min(this.#selected.get(this.current.id) ?? 0, count - 1));
	}

	/** Selects row `index` on the current page. */
	select(index: number): void {
		this.#selected.set(this.current.id, Math.max(0, index));
		this.current.onSelect?.(this);
	}

	/** The current page's filter words ("" when none). */
	filterText(): string {
		return this.#filter.get(this.current.id) ?? "";
	}

	/** Runs an action, one at a time; its text (first line) or its error, in plain words, goes on the status line. */
	run(label: string, action: () => Promise<string | undefined>): void {
		if (this.#action !== undefined) return;
		this.#status = { text: `${label}…`, tone: "info" };
		this.#action = action()
			.then(
				(text) => {
					this.#status = text === undefined || text === "" ? undefined : { text: safeText(text.split("\n")[0]), tone: "info" };
				},
				(error: unknown) => {
					this.#status = { text: safeText(errorText(error)), tone: "error" };
				},
			)
			.finally(() => {
				this.#action = undefined;
				this.refresh();
				this.deps.requestRender();
			});
		this.deps.requestRender();
	}

	/** Resolves when no action runs (tests). */
	idle(): Promise<void> {
		return this.#action ?? Promise.resolve();
	}

	/** Puts `text` (made safe) on the status line. */
	say(text: string, tone: "info" | "error" = "info"): void {
		this.#status = { text: safeText(text), tone };
	}

	render(width: number): string[] {
		const height = this.deps.rows();
		if (width < MIN_WIDTH || height < MIN_ROWS) return [fit("Orrery needs a window at least 60 columns wide and 12 rows tall.", width).trimEnd()];
		const { theme } = this.deps;
		const header = this.#header(width, height);
		const bodyHeight = height - header.length - 2;
		let body: string[];
		const modal = this.host.current;
		// The header's logo is the only artwork: dialogs, the welcome and help are text alone.
		if (modal !== undefined) body = modal.render(width, bodyHeight, theme);
		else if (this.setup) body = WELCOME.map((l) => fit(l, width));
		else if (this.#help) body = HELP.map((line) => fit(line, width));
		else if (this.configError !== undefined) {
			body = ["The config has a problem:", "", this.configError, "", `File: ${safeText(this.deps.configPath)}`, "Fix it in an editor; Orrery reads it again every 2 seconds. q quits."].map((l) => fit(l, width));
		} else body = this.current.render(this, width, bodyHeight);
		body = [...body.slice(0, bodyHeight), ...Array.from({ length: Math.max(0, bodyHeight - body.length) }, () => " ".repeat(width))];
		const status = this.#status === undefined ? "" : this.#status.tone === "error" ? theme.red(fit(this.#status.text, width)) : fit(this.#status.text, width);
		const hints =
			modal !== undefined
				? ""
				: this.configError !== undefined
					? "q quit"
					: this.#filtering
						? `/${this.filterText()}   Enter keep · Esc clear`
						: `${typeof this.current.hints === "function" ? this.current.hints(this) : this.current.hints} · / filter · ? help · q quit`;
		return [...header, ...body, fit(status, width), theme.dim(fit(hints, width))];
	}

	/**
	 * The header: the logo in the top-left corner with "Orrery" and the version beside its first line and the page
	 * tabs beside its second, then a blank line. One line (the name and the tabs) when the window is too short or
	 * too narrow for that.
	 */
	#header(width: number, height: number): string[] {
		const { theme } = this.deps;
		const tabs = this.pages.map((p, i) => (i === this.#page ? theme.inverse(` ${i + 1} ${p.title} `) : ` ${i + 1} ${p.title} `)).join(" ");
		const version = this.#versionText();
		// The name starts one column in, over the first tab's number.
		const beside = [` ${theme.bold("Orrery")}${version === "" ? "" : ` ${theme.dim(`v${version}`)}`}`, tabs];
		const left = LOGO_PAD + LOGO_WIDTH + LOGO_GAP;
		if (height < LOGO_ROWS || left + Math.max(...beside.map((line) => visibleWidth(line))) > width) {
			// One line: the warning follows the tabs when it fits whole, else it is left out.
			const line = `${theme.bold(" Orrery ")}  ${tabs}`;
			const warning = attentionText(this.agents, width - visibleWidth(line) - 1, false);
			return [fit(warning === "" ? line : `${line} ${theme.red(warning)}`, width)];
		}
		const warning = attentionText(this.agents, width - left - visibleWidth(beside[0]) - 2, true);
		if (warning !== "") beside[0] = `${beside[0]}  ${theme.red(warning)}`;
		// The update notice follows only when the whole line still fits; it never cuts the version or the warning.
		if (this.#update !== undefined && left + visibleWidth(beside[0]) + 2 + visibleWidth(this.#update) <= width) beside[0] = `${beside[0]}  ${theme.yellow(this.#update)}`;
		const logo = orreryLogo(theme).map((line, i) => fit(`${" ".repeat(LOGO_PAD)}${line}${" ".repeat(LOGO_GAP)}${beside[i] ?? ""}`, width));
		return [...logo, fit("", width)];
	}

	/** Orrery's version for the header, read once ("" when it cannot be read). */
	#versionText(): string {
		if (this.#version === undefined) {
			try {
				this.#version = safeText(this.deps.about().version);
			} catch {
				this.#version = "";
			}
		}
		return this.#version;
	}

	/**
	 * One key: a page or dialog that throws puts its error on the status line; the TUI keeps running. A letter or digit
	 * a terminal sends Kitty-encoded (CSI u, e.g. "\x1b[113u" for q) is read as the plain key first.
	 */
	handleInput(data: string): void {
		try {
			this.#handle(decodeKittyPrintable(data) ?? data);
		} catch (error) {
			this.say(errorText(error), "error");
		}
		this.deps.requestRender();
	}

	#handle(data: string): void {
		if (matchesKey(data, "ctrl+c")) return this.deps.quit();
		if (this.host.handleInput(data)) return;
		if (this.setup) return;
		if (this.#help) {
			this.#help = false;
			return;
		}
		if (this.#filtering) return this.#filterKey(data);
		if (data === "q") return this.deps.quit();
		if (this.configError !== undefined || this.#action !== undefined) return;
		if (data === "?") {
			this.#help = true;
			return;
		}
		if (/^[1-9]$/.test(data) && Number(data) <= this.pages.length) return this.showPage(this.pages[Number(data) - 1].id);
		if (matchesKey(data, "right")) return this.showPage(this.pages[(this.#page + 1) % this.pages.length].id);
		if (matchesKey(data, "left")) return this.showPage(this.pages[(this.#page + this.pages.length - 1) % this.pages.length].id);
		const up = matchesKey(data, "up") || data === "k";
		const down = matchesKey(data, "down") || data === "j";
		// An agent's page has no list: the arrows leave the list's selection as it was.
		if ((up || down) && this.detail !== undefined) return;
		if (up) return this.select(this.sel() - 1);
		if (down) return this.select(Math.min(this.sel() + 1, this.current.count(this) - 1));
		if (data === "/") {
			this.#filtering = true;
			return;
		}
		if (matchesKey(data, "enter")) return this.current.enter?.(this);
		if (matchesKey(data, "escape")) {
			this.current.back?.(this);
			return;
		}
		this.current.key(this, data);
	}

	#filterKey(data: string): void {
		const id = this.current.id;
		if (matchesKey(data, "escape")) {
			this.#filter.delete(id);
			this.#filtering = false;
		} else if (matchesKey(data, "enter")) this.#filtering = false;
		else if (matchesKey(data, "backspace") || data === "\x7f") this.#filter.set(id, this.filterText().slice(0, -1));
		else if (data.length > 0 && !data.startsWith("\x1b") && !/[\x00-\x1f]/.test(data)) this.#filter.set(id, this.filterText() + data);
		this.select(0);
	}

	invalidate(): void {}
}
