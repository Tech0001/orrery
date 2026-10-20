/**
 * Orrery inside OpenCode (spec 2026-10-16-opencode-design, "The plugin"), in OpenCode's server process (Bun) for the
 * whole session, as pi's and OMP's extension is in theirs: it opens the agent's memory with the writer lock (one writer;
 * held elsewhere, the session reads memory but is not recorded; remote memory as pi has it), records, runs summaries on
 * Orrery's own logins or through one of OpenCode's paid or own-key models (src/opencode/summaries.ts), and keeps the
 * view. Its /compactor picker (the TUI entry's) asks it through OpenCode's plugin RPC (src/opencode/summary-menu.ts).
 * - Which agent: the one the launch's options name (src/opencode/options.ts), with the token from the token file (only
 *   one in Orrery's tokens folder: a project's opencode.json can name this plugin with options of its own) claimed for
 *   this OpenCode server's process (src/agent/pick.ts). A token another live process claimed (an OpenCode started from
 *   the model's shell inherits the launch's config) is refused, and the session is no agent's, in an agent's folder
 *   too: only the launch's token makes a session the agent's.
 * - Recording: the user's words at the prompt hook; at session.execution.succeeded, the run's final reply, read from
 *   the session's context (src/opencode/turns.ts). Subagent sessions (a parentID) are not memory.
 * - The context hook appends the agent's instructions, then the memory section, as the last system parts. They are the
 *   same bytes on every request of a session (its subagents get its parts), made at its first request and again after
 *   each compaction, so the provider's cache of the system prompt and the history after it holds.
 * - The compaction hook answers from memory (a short pointer, no model call) while the session is recorded; otherwise
 *   OpenCode's own compaction runs. The title hook names the session, so no title request goes to a model.
 * - zoom, date and search (and, for readers, agents and agent_memory) are plugin tools the model sees directly.
 * - Status: status.json as pi writes it, and the feed for the TUI entry's footer and toasts (src/opencode/feed.ts).
 * - One memory per agent in a server: OpenCode makes a plugin for each folder it serves (a session moved with
 *   opencode_session_move gets its new folder's), and they share the agent's memory, its status and its feed
 *   (AgentInServer), so recording goes on wherever the session runs.
 * - Sessions (spec 2026-10-18-agent-permissions §2, §3b): the agent's memory in this server records the server as the
 *   agent's session host (the process that runs the model's shell commands) and leaves its pid to their environment
 *   (HOST_ENV), until the last plugin lets go. An OpenCode started inside an agent's session (a recorded ancestor, or
 *   markers such as an inherited launch config whose token another live process holds) opens no memory, claims and
 *   records nothing, says why once, and keeps the guard with the outer agent's rules (src/agent/nested-rules.ts). So does
 *   one started from a coding tool's session that is no agent's (spec 2026-10-19-no-agent-sessions §4c,
 *   src/agent/plain-nested.ts; its TUI, the server's parent, is its own), with no agent's rules.
 * Every hook body is wrapped: a failure says so in a notice and the turn goes on (a throw in the context hook would fail
 * the person's turn). The last plugin's cleanup releases the writer lock: a reload runs cleanup, then setup again, in the
 * same process.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { compactorCommand } from "../agent/agent-commands.ts";
import { type AgentConfig, defaultConfigPath, type HarnessConfig, loadConfig, type ModelChoice } from "../agent/config.ts";
import { openElsewhere, openYielding } from "../agent/handover.ts";
import { cutNotice, instructionsSection, readInstructions } from "../agent/instructions.ts";
import { AgentHeld, MemoryAgent } from "../agent/memory-agent.ts";
import { memoryTools, readerTools, type ViewAccess, withAgentView } from "../agent/memory-tools.ts";
import { agentModelSource } from "../agent/model-source.ts";
import { noticeKey, noticeText, type TroubleState } from "../agent/notices.ts";
import { compactorCommandIn, isOpenCodeChoice } from "../agent/opencode-source.ts";
import { COMPACTOR_MODEL_KEY, storedChoice } from "../agent/choices.ts";
import { leaveHostEnv } from "../agent/host-env.ts";
import { nestedRules } from "../agent/nested-rules.ts";
import { AGENT_ENV, pickAgent, TOKEN_ENV } from "../agent/pick.ts";
import { type PlainDeps, plainNested } from "../agent/plain-nested.ts";
import { forgetSession, type Inside, insideSession, nestedNotice, recordSession } from "../agent/sessions.ts";
import { runningVersion } from "../agent/running.ts";
import { statusVersion } from "../agent/status-file.ts";
import { takeRequest } from "../agent/settings-request.ts";
import { safeText } from "../agent/source-labels.ts";
import { openSummarySources, type SummarySources } from "../agent/summary-sources.ts";
import { updateNotices } from "../agent/update-notices.ts";
import { memorySection } from "../agent/view-text.ts";
import { cachedUpdate, refreshUpdateCache } from "../install/update.ts";
import { localIso, MemoryStore, MemoryView } from "../memory/index.ts";
import { remoteOpenNotice } from "../remote/checkout.ts";
import type { LockState, Storage } from "../remote/types.ts";
import { FEED_NOTICES, type FeedLevel, type FeedNotice, writeFeed } from "./feed.ts";
import { type OpenCodeAccess, OpenCodeSummaries, summarySession, withOpenCode } from "./summaries.ts";
import { type MenuData, type MenuModel, SUMMARY_RPC, type SwitchResult } from "./summary-menu.ts";
import { menuData, orreryModels, switchTo } from "./summary-picker.ts";
import { CONFIG_UNREADABLE, OpenCodeGuardHook, openCodeGuardOptions } from "./guard.ts";
import type { CompactionEvent, ContextEvent, OpenCodeContext, OpenCodePlugin, PluginTool, PromptEvent, TitleEvent } from "./host.ts";
import { PLUGIN_ID, readPluginOptions } from "./options.ts";
import { feedFileOf, launchTokenFile, readTokenFile } from "./token-file.ts";
import { finalReply } from "./turns.ts";

export interface OpenCodePluginOptions {
	/** Orrery's config; default: read from its file (ORRERY_CONFIG, else <Orrery's home>/config.toml). Tests pass one. */
	readonly config?: HarnessConfig;
	/** The environment that says where Orrery's home and config are (default process.env). Tests pass a scratch one. */
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * The process the token is claimed for, and the session's host (default this one, OpenCode's server, which runs the
	 * model's shell commands). Tests pass another.
	 */
	readonly owner?: number;
	/** The environment OpenCode's shell commands inherit, where the session leaves its host pid (default process.env). */
	readonly shellEnv?: NodeJS.ProcessEnv;
	/** The TUI this server serves (default its parent: --standalone starts the server from the TUI). */
	readonly tui?: number;
	/** orrery's logins and models for summaries; default openSummarySources. Tests pass a faux one. */
	readonly summarySources?: (config: HarnessConfig, agent: AgentConfig) => Promise<SummarySources>;
	/** Remote transport for tests; production opens the configured storage. */
	readonly remoteStorage?: (config: HarnessConfig, remote: string) => Storage;
	/** How often the status, notices and summary-model requests are looked at (default 5000 ms). */
	readonly tickMs?: number;
	/** The longest a session's first request waits for pending summaries (default 60 s, as pi's messages). */
	readonly memoryWaitMs?: number;
	/** The longest cleanup waits for a reply being recorded (default 3 s). */
	readonly closeWaitMs?: number;
	/** Update notices (spec 2026-10-15-update-notices): the environment of Orrery's home; left out, none are shown. */
	readonly updates?: { readonly env: NodeJS.ProcessEnv; readonly running?: () => string | undefined };
	/** Says a line where a person running OpenCode with --print-logs sees it (default stderr). */
	readonly log?: (line: string) => void;
	/** How long the guard may take to answer a tool call (default GUARD_MS, 4 s); past it the call is refused. */
	readonly guardMs?: number;
	/** How long the memory's opening waits for OpenCode to list the OpenCode model its summaries use (default 15 s). */
	readonly openCodeWaitMs?: number;
	/** The Orrery version this plugin is (default the running one's): plugins of other versions don't share a memory. */
	readonly version?: string;
	/** How a coding tool's session that is no agent's is looked for (src/agent/plain-nested.ts); tests pass their own. */
	readonly plain?: PlainDeps;
}

/** What a compaction of a recorded session is: memory has the conversation, and the view comes back with it. */
export const COMPACTION_SUMMARY =
	"The earlier conversation is kept in Orrery's memory: see the Memory section at the end of the system prompt, which is refreshed with this compaction. Use zoom, date and search for its detail.";

/** The agent's memory in this session. */
type Memory =
	| { readonly kind: "opening" }
	| { readonly kind: "recording"; readonly memory: MemoryAgent }
	/** Another session has the agent: memory is read, not written. `where`: openElsewhere's words. */
	| { readonly kind: "read-only"; readonly where: string }
	/** The memory could not be opened, or was lost or closed. */
	| { readonly kind: "off" };

/**
 * The memory meta key that marks a main session as the agent's own: OpenCode made it while this agent's memory opened
 * or recorded, or nothing came before its first recorded prompt. Memory has such a session's turns from its start, so its
 * compaction is answered from memory. Another session (`opencode -c` or `-s <id>` resumes any session of OpenCode's
 * database: a plain one, another agent's, one made while the memory was read-only) has turns memory never had, and keeps
 * OpenCode's own compaction.
 */
const sessionKey = (sessionID: string) => `opencode.session.${sessionID}`;

/** The most sessions whose parts are kept; the oldest goes first, and makes its parts again if it asks. */
const KEPT_SESSIONS = 64;
/** The most parents followed up to a session's root. */
const MAX_DEPTH = 8;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** An error's first line, without its final period: for a reason the model reads in one line. */
const firstLine = (error: unknown) => (errorText(error).split("\n")[0] as string).trim().replace(/\.+$/, "");

/** The summary trouble as notices see it (never the raw provider text). */
function troubleState(memory: MemoryAgent): TroubleState | null {
	const trouble = memory.summaryTrouble();
	return trouble === undefined ? null : { state: trouble.state, plain: trouble.plain };
}

/** A session title: "<Agent> · 2026-10-17 14:05". */
export function sessionTitle(agent: string, at: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${agent} · ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** How long the memory's opening waits for OpenCode to list the OpenCode model its summaries use. */
const OPENCODE_LIST_WAIT_MS = 15_000;

/**
 * The OpenCode model an agent's summaries use, if they use one: the one chosen in chat (in its memory), else the
 * config's. Read before the memory opens; a memory that can't be read has none.
 */
function openCodeChoiceOf(agent: AgentConfig): ModelChoice | undefined {
	let chosen: ModelChoice | undefined;
	const file = join(agent.dir, "memory.sqlite");
	if (existsSync(file)) {
		try {
			const store = MemoryStore.openReadOnly(file);
			try {
				chosen = storedChoice(store, COMPACTOR_MODEL_KEY, () => true).choice;
			} finally {
				store.close();
			}
		} catch {
			chosen = undefined;
		}
	}
	const choice = chosen ?? agent.compactor.model;
	return isOpenCodeChoice(choice) ? choice : undefined;
}

/** The plugin's line where a person running OpenCode with --print-logs sees it (default stderr). Never throws. */
function logLine(options: OpenCodePluginOptions, line: string): void {
	try {
		(options.log ?? ((text: string) => process.stderr.write(`${text}\n`)))(line);
	} catch {
		// nowhere to say it
	}
}

/**
 * The feed of one launch (its token file's), for its TUI: the status line and the latest notices. One per feed file in
 * this server, shared by the plugins that write it (src/opencode/feed.ts).
 */
class FeedWriter {
	readonly #file: string;
	readonly #tui: number;
	readonly #log: (line: string) => void;
	line = "Orrery";
	#notices: FeedNotice[] = [];
	#count = 0;
	#written = "";
	/** Notices said once (keys), and texts of failures said already. */
	readonly #said = new Set<string>();

	constructor(file: string, tui: number, log: (line: string) => void) {
		this.#file = file;
		this.#tui = tui;
		this.#log = log;
	}

	/** A notice for the person (a toast in the TUI), never for the model. */
	say(text: string, level: FeedLevel = "info"): void {
		this.#notices = [...this.#notices, { n: ++this.#count, text, level }].slice(-FEED_NOTICES);
		this.write();
	}

	/** A notice said once for `key` in this server's life. */
	once(key: string, text: string, level: FeedLevel = "warning"): void {
		if (this.#said.has(key)) return;
		this.#said.add(key);
		this.say(text, level);
	}

	write(): void {
		const feed = { tui: this.#tui, line: this.line, notices: this.#notices };
		const text = JSON.stringify(feed);
		if (text === this.#written) return;
		try {
			writeFeed(this.#file, feed);
			this.#written = text;
		} catch (error) {
			this.#log(`Orrery: the status for OpenCode's TUI could not be written: ${errorText(error)}`);
		}
	}
}

/**
 * What the plugins of this server share, kept on globalThis: OpenCode loads the plugin's module once per folder it
 * serves (a module of its own each time), so a module's own variables are not shared. Objects one module made are used
 * by another only through their methods and public fields (a class's private fields are its own module's).
 */
function shared<T>(name: string): Map<string, T> {
	const key = Symbol.for(`orrery.opencode.${name}`);
	const store = globalThis as unknown as Record<symbol, Map<string, T> | undefined>;
	store[key] ??= new Map<string, T>();
	return store[key];
}

/** The feeds this server writes, by file. */
function feedWriter(file: string, tui: number, log: (line: string) => void): FeedWriter {
	const feeds = shared<FeedWriter>("feeds");
	let writer = feeds.get(file);
	if (writer === undefined) {
		writer = new FeedWriter(file, tui, log);
		feeds.set(file, writer);
	}
	return writer;
}

/**
 * The agent's memory in this OpenCode server: one per agent (by its name and Orrery's data folder), shared by the
 * plugins of every folder the server serves (ruling 2026-10-17). OpenCode makes a plugin per folder, and a session moved
 * with opencode_session_move gets the plugin of its new folder, in the same process: that plugin takes this memory too,
 * so recording goes on (a second opening would find the writer lock held and read only). The plugins that use it are
 * counted; the last one's cleanup closes it, releasing the writer lock (a reload runs cleanup, then setup again).
 */
class AgentInServer {
	readonly config: HarnessConfig;
	readonly agent: AgentConfig;
	readonly feed: FeedWriter;
	readonly #key: string;
	readonly #options: OpenCodePluginOptions;
	memory: Memory = { kind: "opening" };
	opening: Promise<void> = Promise.resolve();
	readonly #openAbort = new AbortController();
	readonly stopping = new AbortController();
	stopped = false;
	#timer: ReturnType<typeof setInterval> | undefined;
	#users = 0;
	/** Sessions whose run is going on. */
	readonly busy = new Set<string>();
	summarizing = 0;
	#trouble: string | undefined;
	readonly #updatesShown = new Set<string>();
	/** OpenCode's models for this agent's summaries (src/opencode/summaries.ts), through the plugins' folders. */
	readonly opencode: OpenCodeSummaries;
	/** Orrery's own logins and models for summaries, once the memory has opened. */
	sources: SummarySources | undefined;
	/** Whether this server is recorded as the agent's session host (#recordHost). */
	#hosted = false;
	/** Takes back the HOST_ENV left in the shell's environment (#recordHost). */
	#hostEnv: (() => void) | undefined;

	private constructor(key: string, config: HarnessConfig, agent: AgentConfig, feed: FeedWriter, options: OpenCodePluginOptions) {
		this.#key = key;
		this.config = config;
		this.agent = agent;
		this.feed = feed;
		this.#options = options;
		// The summary sessions made and not yet removed are listed beside the memory, so a crash's are removed later.
		this.opencode = new OpenCodeSummaries(agent.name, { ledger: join(agent.dir, "opencode-summaries.json") });
	}

	/** The agent's memory in this server, opened by its first plugin; each plugin that takes it releases it at its cleanup. */
	static take(config: HarnessConfig, agent: AgentConfig, feed: FeedWriter, options: OpenCodePluginOptions): AgentInServer {
		const agents = shared<AgentInServer>("agents");
		// Only plugins of one Orrery version share it: a reload into another version opens the memory anew (read-only,
		// while this one holds it) rather than drive an object of other code.
		const key = `${options.version ?? statusVersion()}\u0000${agent.name}\u0000${resolve(config.dataDir)}`;
		const found = agents.get(key);
		if (found !== undefined) {
			found.join();
			return found;
		}
		const held = new AgentInServer(key, config, agent, feed, options);
		agents.set(key, held);
		held.join();
		held.#begin();
		return held;
	}

	/** Starts opening the memory, and the ticks. */
	#begin(): void {
		this.#recordHost();
		this.status();
		this.opening = this.#open();
		this.#timer = setInterval(() => this.tick(), this.#options.tickMs ?? 5000);
		this.#timer.unref?.();
	}

	/**
	 * Records this server as the agent's session host, whether or not the memory opens (held elsewhere, it is still the
	 * agent's session), and leaves its pid to the shell's environment (HOST_ENV), for a tool started from it and detached.
	 * One that can't be recorded is said.
	 */
	#recordHost(): void {
		const pid = this.#options.owner ?? process.pid;
		if (!recordSession(this.config.dataDir, { agent: this.agent.name, tool: "opencode", pid, config: this.config.file })) {
			this.feed.say(`Orrery: this session could not be recorded as ${this.agent.name}'s, so tools and commands started from it are not known as ${this.agent.name}'s.`, "warning");
			return;
		}
		this.#hosted = true;
		this.#hostEnv = leaveHostEnv(pid, this.#options.shellEnv ?? process.env);
	}

	/** One more plugin uses it. */
	join(): void {
		this.#users++;
	}

	/** Summaries may go through a folder's OpenCode (`access`) once its generate hook is there; a crash's sessions go then. */
	addSummaryHost(access: OpenCodeAccess): void {
		this.opencode.addHost(access);
		void this.opencode.cleanLeftovers();
	}

	/** One plugin is done with it; the last one closes the memory (the writer lock goes). Never throws. */
	async release(access: OpenCodeAccess | undefined): Promise<void> {
		if (access !== undefined) this.opencode.removeHost(access);
		if (--this.#users > 0) return;
		shared<AgentInServer>("agents").delete(this.#key);
		// No longer the agent's session: what the shell starts from now on is not the agent's.
		if (this.#hosted) forgetSession(this.config.dataDir, this.#options.owner ?? process.pid);
		this.#hosted = false;
		this.#hostEnv?.();
		this.#hostEnv = undefined;
		this.stopped = true;
		this.stopping.abort();
		this.#openAbort.abort(new Error("OpenCode closed the plugin"));
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
		try {
			await this.opening;
		} catch {
			// the memory closes all the same
		}
		const state = this.memory;
		if (state.kind !== "recording") return;
		this.memory = { kind: "off" };
		try {
			state.memory.writeStatus(false, false);
		} catch {
			// an agent left "open" in its status is old news within 30 s
		}
		try {
			await state.memory.close();
		} catch (error) {
			logLine(this.#options, `Orrery: closing ${state.memory.config.name}'s memory failed: ${errorText(error)}`);
		}
	}

	/** Opens the agent's memory, as pi does: recording, read-only (held elsewhere), or off. Never rejects. */
	async #open(): Promise<void> {
		const { agent, config } = this;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let asked: LockState | undefined;
		try {
			const sources = await (this.#options.summarySources ?? openSummarySources)(config, agent);
			this.sources = sources;
			// OpenCode's models, for an agent whose summaries use one: listed before the memory opens and checks its choice.
			const wanted = openCodeChoiceOf(agent);
			if (wanted === undefined) await this.opencode.refresh();
			else await this.opencode.waitFor(wanted.modelId, this.#options.openCodeWaitMs ?? OPENCODE_LIST_WAIT_MS, this.stopping.signal);
			const report = (message: string) => {
				this.feed.say(message, "warning");
				// A remote session says it was lost before it closes the store: stop recording at once.
				this.recording();
			};
			const memory = { agent, models: withOpenCode(agentModelSource(sources.models), this.opencode), host: "opencode" as const, report };
			let opened: MemoryAgent;
			if (agent.remote === undefined) opened = await openYielding(() => MemoryAgent.open(memory), agent.dir);
			else {
				deadline = setTimeout(() => this.#openAbort.abort(new Error("Remote checkout took longer than 25 seconds")), 25_000);
				// No one to ask in OpenCode's server: a remote agent held elsewhere stays there (orrery agent takeover).
				opened = await MemoryAgent.openChecked({
					...memory,
					config,
					signal: this.#openAbort.signal,
					storage: this.#options.remoteStorage?.(config, agent.remote),
					confirmTakeover: async (held) => {
						asked = held;
						return false;
					},
					open: (open) => openYielding(open, agent.dir),
				});
			}
			if (this.stopped) {
				await opened.close();
				return;
			}
			this.memory = { kind: "recording", memory: opened };
			// The open's own reports already said what is wrong now: notices start from here.
			this.#trouble = noticeKey(troubleState(opened));
		} catch (error) {
			if (this.stopped) return;
			if (error instanceof AgentHeld) {
				const where = openElsewhere(agent.dir, "opencode");
				this.memory = { kind: "read-only", where };
				this.feed.say(`Orrery: ${agent.name} is ${where}; this session reads memory but is not recorded.`, "warning");
			} else {
				this.memory = { kind: "off" };
				const why = agent.remote === undefined ? safeText(errorText(error)) : remoteOpenNotice(agent, error);
				this.feed.say(`Orrery: ${agent.name}: ${why}${asked === undefined ? "" : `; run orrery agent takeover ${agent.name} to open it here`}; this session runs without memory.`, "warning");
			}
		} finally {
			clearTimeout(deadline);
			this.status();
		}
	}

	/** The memory while it records; a remote memory moved elsewhere stops recording here (and closes). */
	recording(): MemoryAgent | undefined {
		const state = this.memory;
		if (state.kind !== "recording") return undefined;
		if (!state.memory.remote?.lost) return state.memory;
		this.memory = { kind: "off" };
		void state.memory.close().catch(() => {});
		this.status();
		return undefined;
	}

	/** The status line, status.json (while recording) and the feed, now. Never throws. */
	status(): void {
		const name = this.agent.name;
		try {
			const state = this.memory;
			if (state.kind === "recording" && !state.memory.remote?.lost) {
				state.memory.writeStatus(this.busy.size > 0);
				this.feed.line = this.summarizing > 0 ? `Orrery · ${name} · summarizing before this message…` : `${state.memory.statusLine()} · recording`;
			} else if (state.kind === "read-only") this.feed.line = `Orrery · ${name} · read-only: ${state.where}`;
			else if (state.kind === "off") this.feed.line = `Orrery · ${name} · no memory`;
			else this.feed.line = `Orrery · ${name} · opening memory…`;
		} catch (error) {
			this.feed.once("status", `Orrery: status update failed: ${safeText(errorText(error))}`);
		}
		this.feed.write();
	}

	/** Waits for pending summaries that can come (not when summaries are off, stopped or failing), at most memoryWaitMs. */
	async settle(memory: MemoryAgent): Promise<void> {
		if (memory.view.settled || memory.summaryTrouble() !== undefined) return;
		this.summarizing++;
		this.status();
		const wait = new AbortController();
		const timer = setTimeout(() => wait.abort(), this.#options.memoryWaitMs ?? 60_000);
		try {
			await memory.awaitSummaries(AbortSignal.any([wait.signal, this.stopping.signal]));
		} finally {
			clearTimeout(timer);
			this.summarizing--;
		}
		if (!memory.view.settled) {
			const trouble = memory.summaryTrouble();
			const why = trouble === undefined ? "summaries still pending" : `summaries are ${trouble.state} (${trouble.plain})`;
			this.feed.say(`Orrery: ${why}; this session's memory view has unsummarized lines (the model can zoom them).`, "warning");
		}
	}

	/** The summary-model picker's offer (src/opencode/summary-picker.ts). Never rejects. */
	async menu(): Promise<MenuData> {
		try {
			return await menuData(this.recording(), this.sources, this.opencode);
		} catch (error) {
			return { line: "", thinking: "off", groups: [], problem: `Orrery: the summary-model picker failed (${safeText(errorText(error))}).` };
		}
	}

	/** Orrery's models for a provider the picker names. Never rejects. */
	async menuModels(input: unknown): Promise<{ models: MenuModel[] }> {
		const memory = this.recording();
		const provider = (input as { provider?: unknown } | null)?.provider;
		if (memory === undefined || this.sources === undefined || typeof provider !== "string") return { models: [] };
		try {
			return { models: orreryModels(this.sources, provider, memory.compactorModel) };
		} catch {
			return { models: [] };
		}
	}

	/** A pick from the picker, tested, then switched to; the status says so at once. Never rejects. */
	async switchSummaries(input: unknown): Promise<SwitchResult> {
		let result: SwitchResult;
		try {
			result = await switchTo(this.recording(), this.sources, this.opencode, input);
		} catch (error) {
			result = { ok: false, text: `Not switched: ${safeText(errorText(error))}.` };
		}
		this.tick();
		return { ok: result.ok, text: safeText(result.text) };
	}

	/** Every tickMs: summary-model changes made from outside (the TUI's M), summary trouble, updates, the status. */
	tick(): void {
		try {
			const memory = this.recording();
			if (memory !== undefined) {
				const name = memory.config.name;
				try {
					const taken = takeRequest(memory.config.dir, name);
					if (taken.ignored !== undefined) this.feed.say(`Orrery: ignored ${taken.ignored}.`, "warning");
					if (taken.request !== undefined) this.feed.say(safeText(`Orrery: ${compactorCommand(memory, taken.request.args)} (changed from outside OpenCode)`));
				} catch (error) {
					this.feed.once("request", `Orrery: a summary-model change from outside OpenCode failed: ${safeText(errorText(error))}`);
				}
				this.#retryOpenCode(memory);
				const now = troubleState(memory);
				const message = noticeText(name, now, this.#trouble, compactorCommandIn("opencode", name));
				this.#trouble = noticeKey(now);
				if (message !== undefined) this.feed.say(message, now ? "warning" : "info");
			}
			this.#showUpdates();
		} catch (error) {
			this.feed.once("tick", `Orrery: status update failed: ${safeText(errorText(error))}`);
		}
		this.status();
	}

	/** A model list being read for #retryOpenCode. */
	#relisting = false;

	/**
	 * Summaries on an OpenCode model that OpenCode had not listed when the memory opened (it lists its config's providers
	 * late): on a tick, the list is read again, and once the model is there they start, with the choice they had (one
	 * chosen in chat, which the opening had to set aside, comes back). Never throws.
	 */
	#retryOpenCode(memory: MemoryAgent): void {
		if (this.#relisting) return;
		const waiting = memory.summariesOff !== undefined && isOpenCodeChoice(memory.compactorModel);
		const stored = memory.compactorSource === "config" ? storedChoice(memory.store, COMPACTOR_MODEL_KEY, () => true).choice : undefined;
		const chosen = stored !== undefined && isOpenCodeChoice(stored) ? stored : undefined;
		const setAside = chosen !== undefined && !isOpenCodeChoice(memory.compactorModel);
		if (!waiting && !setAside) return;
		const choice = waiting ? memory.compactorModel : (chosen as ModelChoice);
		this.#relisting = true;
		void this.opencode
			.refresh()
			.then(() => {
				if (this.stopped || this.recording() !== memory || this.opencode.find(choice.modelId) === undefined) return;
				if (waiting) memory.retrySummaries();
				else memory.setCompactorModel(choice);
				this.feed.say(`Orrery: OpenCode lists ${choice.provider}/${choice.modelId} now; ${memory.config.name}'s summaries use it.`, "info");
				this.status();
			})
			.catch(() => {})
			.finally(() => {
				this.#relisting = false;
			});
	}

	/** The update notices, each once (src/agent/update-notices.ts), and a refresh of the daily check when it is due. */
	#showUpdates(): void {
		const updates = this.#options.updates;
		if (updates === undefined) return;
		const enabled = this.config.updates.check;
		const show = () => {
			if (this.stopped) return;
			try {
				let running: string | undefined;
				try {
					running = updates.running === undefined ? runningVersion(updates.env) : updates.running();
				} catch {
					running = undefined;
				}
				for (const notice of updateNotices(updates.env, Date.now(), { enabled, running })) {
					if (this.#updatesShown.has(notice.key)) continue;
					this.#updatesShown.add(notice.key);
					this.feed.say(notice.text, "warning");
				}
			} catch {
				// a notice that cannot be read or shown is left out
			}
		};
		show();
		const now = Date.now();
		if (enabled && cachedUpdate(updates.env, now).stale) void refreshUpdateCache(updates.env, now).then(show, () => {});
	}
}

/** Orrery's plugin for one OpenCode location (folder), from setup to cleanup. */
class OrreryInOpenCode {
	readonly #ctx: OpenCodeContext;
	readonly #options: OpenCodePluginOptions;
	/** The agent's memory in this server, once the launch's agent is known; shared with the other folders' plugins. */
	#held: AgentInServer | undefined;
	/** What summaries through OpenCode's models ask of this folder's OpenCode (src/opencode/summaries.ts). */
	#access: OpenCodeAccess | undefined;
	readonly #stopping = new AbortController();
	#stopped = false;
	/** The feed for this launch's TUI; only the OpenCode that claimed the launch's token writes it. */
	#feed: FeedWriter | undefined;
	/** Main sessions this location's hooks have seen: the event stream is the whole server's. */
	readonly #ours = new Set<string>();
	/** Prompts recorded (their message ids): OpenCode may run a prompt hook twice for one prompt. */
	readonly #prompts = new Set<string>();
	readonly #parents = new Map<string, Promise<string | null>>();
	/** Each main session's system parts, made once (and again after its compaction). */
	readonly #parts = new Map<string, Promise<readonly string[]>>();
	readonly #pending = new Set<Promise<void>>();

	/** The guard on this folder's tool calls (src/opencode/guard.ts): its rules are set by start. */
	readonly #guard: OpenCodeGuardHook;
	/**
	 * The folder this plugin serves: OpenCode's location for it, which OpenCode's tools place a relative path from (and a
	 * session moved elsewhere runs in another location, with a plugin of its own). Undefined when OpenCode gave none.
	 */
	readonly #directory: string | undefined;

	constructor(ctx: OpenCodeContext, options: OpenCodePluginOptions) {
		this.#ctx = ctx;
		this.#options = options;
		this.#guard = new OpenCodeGuardHook(options.guardMs === undefined ? {} : { ms: options.guardMs });
		this.#directory = typeof ctx.location?.directory === "string" && isAbsolute(ctx.location.directory) ? ctx.location.directory : undefined;
	}

	/**
	 * The guard's hooks (src/opencode/guard.ts), registered before anything else, judging by the rules start sets: a call
	 * that comes first waits for them. Throws when OpenCode won't take the tool hook, so the plugin fails to load (and the
	 * launch's check says so) rather than run a session without its guard. The second layer (OpenCode's permission
	 * check) is said in the log when it can't be added: every call is still judged.
	 */
	async guard(): Promise<void> {
		await this.#ctx.tool.hook("execute.before", async (event) => {
			const refusal = await this.#guard.beforeTool(event);
			if (refusal !== undefined) throw new Error(refusal);
		});
		try {
			if (this.#ctx.permission === undefined) throw new Error("this OpenCode has no permission hooks");
			await this.#ctx.permission.hook("evaluate", (event) => this.#guard.onPermission(event));
		} catch (error) {
			this.#log(`Orrery: the guard's second layer (OpenCode's permission check) could not be added (${errorText(error)}); every tool call is still judged.`);
		}
	}

	/** After start: rules it did not set (it failed before it could) refuse every call, saying why. */
	settleGuard(why: string): void {
		if (!this.#guard.decided) this.#guard.decide({ blind: `Orrery's plugin could not start (${why}), so no call can be checked; nothing was run.` });
	}

	/**
	 * The guard's rules for `agent` (or no agent's; or, `nested`, the outer agent's), from `config`; rules that can't be
	 * made refuse every call.
	 */
	#guardRules(config: HarnessConfig, agent: AgentConfig | undefined, env: NodeJS.ProcessEnv, nested?: Inside): void {
		// Without the folder OpenCode places paths from, no path can be judged where it lands.
		if (this.#directory === undefined) {
			this.#guard.decide({ blind: "OpenCode did not say which folder this session works in, so no call can be checked; nothing was run." });
			return;
		}
		try {
			const configFile = this.#options.config === undefined ? resolve(defaultConfigPath(env)) : undefined;
			const rules = nested === undefined ? undefined : nestedRules(config, nested.agent, this.#directory);
			this.#guard.decide({ options: openCodeGuardOptions(config, agent, this.#directory, { env, ...(configFile === undefined ? {} : { configFile }), ...(rules === undefined ? {} : { rules }) }) });
		} catch (error) {
			this.#guard.decide({ blind: `the guard's rules could not be made (${firstLine(error)}), so no call can be checked; nothing was run.` });
		}
	}

	/** No agent's rules, from Orrery's config (or none that can be read: every call refused). */
	#noAgent(env: NodeJS.ProcessEnv): void {
		let config: HarnessConfig;
		try {
			config = this.#options.config ?? loadConfig(defaultConfigPath(env));
		} catch (error) {
			this.#guard.decide({ blind: CONFIG_UNREADABLE(firstLine(error)) });
			return;
		}
		this.#guardRules(config, undefined, env);
	}

	/**
	 * Reads the options, the config and the token, picks the agent, sets the guard's rules (the agent's, or no agent's),
	 * and, with an agent, takes its memory in this server (opening it if no other folder's plugin has) and registers the
	 * memory's hooks.
	 */
	async start(): Promise<void> {
		const env = this.#options.env ?? process.env;
		const options = readPluginOptions(this.#ctx.options);
		if ("problem" in options) {
			this.#log(`Orrery: loaded without an agent (${options.problem}).`);
			this.#noAgent(env);
			return;
		}
		this.#log(`Orrery: loaded for ${options.agent}.`);
		// Only a launch's own token file: OpenCode's config (a project's opencode.json among it) names this one, and the
		// feed is written beside it.
		if (!launchTokenFile(options.tokenFile, env)) {
			this.#log("Orrery: the plugin's token file is not one Orrery's launch wrote; this session runs without memory.");
			this.#noAgent(env);
			return;
		}
		const feed = feedWriter(feedFileOf(options.tokenFile), this.#options.tui ?? process.ppid, (line) => this.#log(line));
		let config: HarnessConfig;
		try {
			config = this.#options.config ?? loadConfig(defaultConfigPath(env));
		} catch (error) {
			this.#guard.decide({ blind: CONFIG_UNREADABLE(firstLine(error)) });
			this.#feed = feed;
			this.#refuse(`Orrery: Orrery's config could not be read (${safeText(errorText(error))}); this session runs without memory, and its guard refuses every tool call.`);
			return;
		}
		// Started inside an agent's session: before the token is read or claimed. No memory, no tools, nothing recorded; the
		// outer agent's guard (no agent's when whose session it is can't be told), and why, once in this server.
		const inside = this.#nestedIn(config, env);
		if (inside !== undefined) {
			this.#guardRules(config, undefined, env, inside);
			this.#feed = feed;
			feed.line = "Orrery · no memory";
			feed.once("nested", nestedNotice(inside));
			return;
		}
		let token: string;
		try {
			token = readTokenFile(options.tokenFile);
		} catch (error) {
			this.#guardRules(config, undefined, env);
			this.#feed = feed;
			this.#refuse(`Orrery: the launch token for ${safeText(options.agent)} could not be read (${safeText(errorText(error))}); this session runs without memory.`);
			return;
		}
		const pick = pickAgent(config, { env: { [AGENT_ENV]: options.agent, [TOKEN_ENV]: token }, cwd: this.#directory ?? process.cwd(), owner: this.#options.owner ?? process.pid });
		// The launch's agent, by its token, or no agent's: the guard runs either way.
		this.#guardRules(config, pick.kind === "agent" && pick.by === "env" ? pick.agent : undefined, env);
		if (pick.kind === "unknown" || pick.kind === "bad-token") {
			this.#feed = feed;
			this.#refuse(
				pick.kind === "unknown"
					? `Orrery: ${safeText(pick.name)} is not an agent in Orrery's config; this session runs without memory.`
					: `Orrery: the launch token for ${pick.name} is not one Orrery made; this session runs without memory.`,
			);
			return;
		}
		// The launch's token is another live OpenCode's: this one was started from it (from the model's shell, say), and is
		// plain OpenCode, whatever folder it runs in. Only the launch's token makes a session the agent's: by its folder, a
		// nested OpenCode in another agent's folder would become that agent's writer.
		if (pick.kind === "none" || pick.by !== "env") return;
		this.#feed = feed;
		// Taking the memory starts opening it (when no other folder's plugin has): a hook that runs while the others are
		// being registered waits for it.
		const ctx = this.#ctx;
		this.#access =
			this.#directory === undefined
				? undefined
				: {
						directory: this.#directory,
						listModels: () => ctx.model.list(),
						createSession: (input) => ctx.session.create(input),
						generate: (input, options) => ctx.session.generate(input, options),
						removeSession: (input) => ctx.session.remove(input),
					};
		this.#held = AgentInServer.take(config, pick.agent, feed, this.#options);
		await this.#register();
		void this.#listen();
	}

	/**
	 * The agent session this OpenCode was started inside (src/agent/sessions.ts, the server as `self`, so its own launch's
	 * config and HOST_ENV are its own), or with none the coding tool's session that is no agent's it was started from
	 * (src/agent/plain-nested.ts: past its own TUI, the server's parent); else undefined. A look that fails counts as one
	 * whose agent is unknown (fail closed).
	 * Decided once per server and data folder, in the state its plugins share: another folder's plugin, and a reload
	 * (cleanup, then setup in the same process), read it, so a server started inside a session stays without memory once
	 * that session ends.
	 */
	#nestedIn(config: HarnessConfig, env: NodeJS.ProcessEnv): Inside | undefined {
		const self = this.#options.owner ?? process.pid;
		const decided = shared<{ readonly inside: Inside | undefined }>("nested");
		const key = `${self}\u0000${resolve(config.dataDir)}`;
		const found = decided.get(key);
		if (found !== undefined) return found.inside;
		let inside: Inside | undefined;
		try {
			inside = insideSession([config.dataDir], env, config, { self }) ?? plainNested(config, env, { pid: self, tool: "opencode" }, this.#options.plain);
		} catch {
			inside = { agent: undefined, tool: undefined, via: "marker", dataDir: config.dataDir };
		}
		decided.set(key, { inside });
		return inside;
	}

	/** Cleanup: stops listening, waits a little for a reply being recorded, and lets go of the memory (the last plugin closes it). Never throws. */
	async stop(): Promise<void> {
		this.#stopped = true;
		this.#stopping.abort();
		const held = this.#held;
		if (held === undefined) return;
		try {
			await held.opening;
			const waited = new Promise<void>((done) => setTimeout(done, this.#options.closeWaitMs ?? 3000).unref?.());
			await Promise.race([Promise.allSettled([...this.#pending]), waited]);
		} catch {
			// the memory is let go all the same
		}
		await held.release(this.#access);
	}

	/** No agent: what the person is told, with a feed that says so. */
	#refuse(text: string): void {
		const feed = this.#feed;
		if (feed === undefined) return;
		feed.line = "Orrery · no memory";
		feed.say(text, "warning");
	}

	#log(line: string): void {
		logLine(this.#options, line);
	}

	/** The agent's memory in this server: set for every hook start registered. */
	get #agent(): AgentInServer {
		return this.#held as AgentInServer;
	}

	/**
	 * Runs a hook's body: a failure is said once (by its words) and the hook returns, so the request, prompt or
	 * compaction goes on without Orrery's part.
	 */
	async #guarded(what: string, run: () => Promise<void> | void): Promise<void> {
		try {
			await run();
		} catch (error) {
			const text = `Orrery: ${what} failed (${safeText(errorText(error))}); the session goes on without it.`;
			this.#feed?.once(text, text);
		}
	}

	async #register(): Promise<void> {
		const { session, tool } = this.#ctx;
		await session.hook("prompt", (event) => this.#guarded("recording a prompt", () => this.#onPrompt(event)));
		await session.hook("context", (event) => this.#guarded("the memory for this request", () => this.#onContext(event)));
		await session.hook("compaction", (event) => this.#guarded("answering the compaction from memory", () => this.#onCompaction(event)));
		await session.hook("title", (event) => this.#guarded("naming the session", () => this.#onTitle(event)));
		// A summary through one of OpenCode's models: its request is Orrery's (src/opencode/summaries.ts).
		const held = this.#agent;
		const summaries = held.opencode;
		try {
			await session.hook("generate", (event) => this.#guarded("making a summary's request", () => summaries.shape(event)));
			// Only a folder whose generate hook is there makes summaries: a request it didn't shape would go as OpenCode's own.
			if (this.#access !== undefined) held.addSummaryHost(this.#access);
		} catch (error) {
			summaries.disable(`this OpenCode has no generate hook (${errorText(error)})`);
		}
		// The summary-model picker, which the TUI entry's /compactor calls (src/opencode/summary-menu.ts).
		try {
			if (this.#ctx.rpc === undefined) throw new Error("this OpenCode has no plugin RPC");
			await this.#ctx.rpc.register(SUMMARY_RPC, {
				menu: () => held.menu(),
				models: (input) => held.menuModels(input),
				switch: (input) => held.switchSummaries(input),
			});
		} catch (error) {
			this.#log(`Orrery: OpenCode's /compactor could not be added (${errorText(error)}); in a shell: orrery compactor ${held.agent.name}.`);
		}
		await tool.transform((editor) => {
			try {
				for (const each of this.#tools()) editor.add(each);
			} catch (error) {
				this.#feed?.once("tools", `Orrery: the memory tools could not be added: ${safeText(errorText(error))}`);
			}
		});
	}

	/** A session's parent, or null for a main session (from session.created when seen, else OpenCode's session info). */
	#parentOf(sessionID: string): Promise<string | null> {
		let known = this.#parents.get(sessionID);
		if (known === undefined) {
			known = this.#ctx.session.get({ sessionID }).then((info) => {
				const value = info as { parentID?: unknown; data?: { parentID?: unknown } } | null;
				const parent = value?.parentID ?? value?.data?.parentID;
				return typeof parent === "string" && parent !== "" ? parent : null;
			});
			this.#parents.set(sessionID, known);
			known.catch(() => this.#parents.delete(sessionID));
		}
		return known;
	}

	/** The main session a session belongs to: itself, or the parent of its parents. */
	async #rootOf(sessionID: string): Promise<string> {
		let id = sessionID;
		for (let depth = 0; depth < MAX_DEPTH; depth++) {
			const parent = await this.#parentOf(id);
			if (parent === null) return id;
			id = parent;
		}
		return id;
	}

	async #onPrompt(event: PromptEvent): Promise<void> {
		if ((await this.#parentOf(event.sessionID)) !== null) return;
		this.#ours.add(event.sessionID);
		const held = this.#agent;
		await held.opening;
		const memory = held.recording();
		if (memory === undefined || this.#prompts.has(event.messageID)) return;
		this.#prompts.add(event.messageID);
		// A session this agent's memory has from its start is its own (sessionKey); one resumed with turns memory never had is not.
		const own = !this.#ownSession(memory, event.sessionID) && (await this.#fresh(event)) ? { [sessionKey(event.sessionID)]: "first prompt" } : {};
		// The session's parts are made before its prompt goes in: the request it starts has the prompt in its conversation,
		// not in its memory section too. One that fails is made again at the request, which says so.
		if (!this.#parts.has(event.sessionID)) await this.#partsOf(event.sessionID).catch(() => {});
		if (held.recording() !== memory) return;
		const text = typeof event.prompt?.text === "string" ? event.prompt.text : "";
		if (text.trim() === "") {
			for (const [key, value] of Object.entries(own)) memory.store.setMeta(key, value);
			return;
		}
		memory.view.appendBatch([{ kind: "user", text, date: localIso() }], own);
		held.busy.add(event.sessionID);
		held.status();
	}

	/** Whether the session is this agent's own: its memory has it from its start (sessionKey). */
	#ownSession(memory: MemoryAgent, sessionID: string): boolean {
		return memory.store.getMeta(sessionKey(sessionID)) !== undefined;
	}

	/** Whether nothing came before this prompt in its session (it may be there already); a session that can't be read is not. */
	async #fresh(event: PromptEvent): Promise<boolean> {
		try {
			const answer = await this.#ctx.session.context({ sessionID: event.sessionID });
			const list = Array.isArray(answer) ? answer : (answer as { data?: unknown } | null)?.data;
			return Array.isArray(list) && list.every((message) => (message as { id?: unknown } | null)?.id === event.messageID);
		} catch {
			return false;
		}
	}

	/** A main session OpenCode made while this agent's memory opens or records: once it records, the session is its own. */
	async #onCreated(sessionID: string): Promise<void> {
		await this.#agent.opening;
		const memory = this.#agent.recording();
		if (memory !== undefined && !this.#ownSession(memory, sessionID)) memory.store.setMeta(sessionKey(sessionID), "made");
	}

	async #onContext(event: ContextEvent): Promise<void> {
		const root = await this.#rootOf(event.sessionID);
		if (root === event.sessionID) this.#ours.add(root);
		const parts = await this.#partsOf(root);
		for (const text of parts) event.system.push({ type: "text", text });
	}

	/** A main session's system parts: made at its first request (or after its compaction), then the same each time. */
	#partsOf(root: string): Promise<readonly string[]> {
		let made = this.#parts.get(root);
		if (made === undefined) {
			made = this.#render();
			this.#parts.set(root, made);
			// A failed make is tried again at the next request.
			const mine = made;
			made.catch(() => {
				if (this.#parts.get(root) === mine) this.#parts.delete(root);
			});
			while (this.#parts.size > KEPT_SESSIONS) this.#parts.delete(this.#parts.keys().next().value as string);
		}
		return made;
	}

	/** The agent's instructions (if it has any), then its memory section (recording or read-only), as they are now. */
	async #render(): Promise<readonly string[]> {
		const held = this.#agent;
		await held.opening;
		const agent = held.agent;
		const parts: string[] = [];
		const found = readInstructions(agent.dir);
		if (found !== undefined) {
			parts.push(instructionsSection(agent.name, found));
			if (found.cut) held.feed.once("cut", cutNotice(agent.name));
		}
		const state = held.memory;
		const memory = held.recording();
		if (memory !== undefined) {
			memory.instructionsAt = found?.at;
			await held.settle(memory);
			parts.push(memorySection(memory.view, "opencode"));
		} else if (state.kind === "read-only") {
			const file = join(agent.dir, "memory.sqlite");
			if (existsSync(file)) {
				const store = MemoryStore.openReadOnly(file);
				try {
					parts.push(memorySection(new MemoryView(store, agent.memory.viewBytes), "opencode", { readOnly: true }));
				} finally {
					store.close();
				}
			}
		}
		held.status();
		return parts;
	}

	async #onCompaction(event: CompactionEvent): Promise<void> {
		if ((await this.#parentOf(event.sessionID)) !== null) return;
		await this.#agent.opening;
		// Not recorded, or not from its start (a resumed session): OpenCode's own summary keeps what memory doesn't have.
		const memory = this.#agent.recording();
		if (memory === undefined || !this.#ownSession(memory, event.sessionID)) return;
		event.result = { summary: COMPACTION_SUMMARY };
		this.#parts.delete(event.sessionID);
	}

	#onTitle(event: TitleEvent): void {
		event.result = sessionTitle(this.#agent.agent.name);
	}

	/** The event stream, for each run's start and end. Ends at cleanup. */
	async #listen(): Promise<void> {
		const signal = this.#stopping.signal;
		try {
			for await (const event of this.#ctx.event.subscribe({ signal })) {
				if (signal.aborted) break;
				this.#onEvent(event);
			}
		} catch (error) {
			if (!signal.aborted) this.#feed?.once("events", `Orrery: OpenCode's event stream stopped (${safeText(errorText(error))}); replies are not recorded from here on.`);
		}
	}

	#onEvent(event: unknown): void {
		const { type, data } = (event ?? {}) as { type?: unknown; data?: { sessionID?: unknown; parentID?: unknown } };
		const sessionID = data?.sessionID;
		if (typeof sessionID !== "string" || this.#stopped) return;
		// Orrery's own summary sessions (src/opencode/summaries.ts) are no agent's.
		if (type === "session.created" && summarySession(data)) return;
		if (type === "session.created") {
			const parent = typeof data?.parentID === "string" && data.parentID !== "" ? data.parentID : null;
			if (!this.#parents.has(sessionID)) this.#parents.set(sessionID, Promise.resolve(parent));
			if (parent === null) this.#track(this.#guarded("marking a new session as the agent's", () => this.#onCreated(sessionID)));
		} else if (type === "session.execution.started") {
			if (this.#ours.has(sessionID)) {
				this.#agent.busy.add(sessionID);
				this.#agent.status();
			}
		} else if (type === "session.execution.succeeded") {
			this.#track(this.#guarded("recording a reply", () => this.#onSucceeded(sessionID)));
		} else if (type === "session.execution.failed" || type === "session.execution.interrupted") {
			if (this.#agent.busy.delete(sessionID)) this.#agent.status();
		}
	}

	/** Work the event stream started, which cleanup waits a little for. */
	#track(work: Promise<void>): void {
		this.#pending.add(work);
		void work.finally(() => this.#pending.delete(work));
	}

	/**
	 * A run of one of this location's main sessions ended: its final reply goes to memory, once (every folder's plugin
	 * hears the server's events, and a moved session is in two folders' sessions).
	 */
	async #onSucceeded(sessionID: string): Promise<void> {
		const held = this.#agent;
		held.busy.delete(sessionID);
		try {
			if (!this.#ours.has(sessionID)) return;
			await held.opening;
			const memory = held.recording();
			if (memory === undefined) return;
			const answer = await this.#ctx.session.context({ sessionID });
			const reply = finalReply(Array.isArray(answer) ? answer : (answer as { data?: unknown } | null)?.data);
			if (reply === undefined) return;
			const key = `opencode.reply.${sessionID}`;
			if (held.recording() !== memory || memory.store.getMeta(key) === reply.id) return;
			memory.view.appendBatch(reply.text.trim() === "" ? [] : [{ kind: "talk", text: reply.text, date: reply.date }], { [key]: reply.id }, reply.usage);
			memory.afterTurn();
		} finally {
			held.status();
		}
	}

	/** The memory tools over the live view while recording, a read-only snapshot while read-only. */
	#tools(): PluginTool[] {
		const held = this.#agent;
		const { agent, config } = held;
		const access: ViewAccess = (use) => {
			const memory = held.recording();
			if (memory !== undefined) return use(memory.view);
			if (held.memory.kind === "read-only") return withAgentView(agent, use, config);
			throw new Error(`Orrery: ${agent.name}'s memory is not open in this OpenCode`);
		};
		const tools = [...memoryTools(access), ...(agent.reads.length > 0 ? readerTools(() => agent, config) : [])];
		return tools.map((each) => ({
			name: each.name,
			description: each.description,
			// A plain JSON Schema: TypeBox's own marks stay behind.
			input: JSON.parse(JSON.stringify(each.parameters)) as object,
			options: { codemode: false },
			execute: async (input: Record<string, unknown>) => {
				await held.opening;
				return { content: await each.run(input ?? {}) };
			},
		}));
	}
}

/**
 * Orrery's OpenCode plugin: `export default openCodePlugin(…)` in its server entry. Setup throws only when OpenCode won't
 * take the guard's hook (the plugin then fails to load, and the launch's check says so); anything else that fails is
 * said, and the guard refuses every call if its rules were not set.
 */
export function openCodePlugin(options: OpenCodePluginOptions = {}): OpenCodePlugin {
	return {
		id: PLUGIN_ID,
		async setup(ctx: OpenCodeContext) {
			const plugin = new OrreryInOpenCode(ctx, options);
			await plugin.guard();
			try {
				await plugin.start();
				plugin.settleGuard("it set no rules for its guard");
			} catch (error) {
				plugin.settleGuard(firstLine(error));
				try {
					(options.log ?? ((text: string) => process.stderr.write(`${text}\n`)))(`Orrery: the plugin could not start: ${errorText(error)}`);
				} catch {
					// nowhere to say it
				}
			}
			return () => plugin.stop();
		},
	};
}
