/**
 * Orrery inside OpenCode (spec 2026-10-16-opencode-design, "The plugin"), in OpenCode's server process (Bun) for the
 * whole session, as pi's and OMP's extension is in theirs: it opens the agent's memory with the writer lock (one writer;
 * held elsewhere, the session reads memory but is not recorded; remote memory as pi has it), records, runs summaries on
 * Orrery's own logins and keeps the view.
 * - Which agent: the one the launch's options name (src/opencode/options.ts), with the token from the token file (only
 *   one in Orrery's tokens folder: a project's opencode.json can name this plugin with options of its own) claimed for
 *   this OpenCode server's process (src/agent/pick.ts). A token another live process claimed (an OpenCode started from
 *   the model's shell inherits the launch's config) is refused: the session is the folder's agent's, as pi's would be,
 *   or no agent's.
 * - Recording: the user's words at the prompt hook; at session.execution.succeeded, the run's final reply, read from
 *   the session's context (src/opencode/turns.ts). Subagent sessions (a parentID) are not memory.
 * - The context hook appends the agent's instructions, then the memory section, as the last system parts. They are the
 *   same bytes on every request of a session (its subagents get its parts), made at its first request and again after
 *   each compaction, so the provider's cache of the system prompt and the history after it holds.
 * - The compaction hook answers from memory (a short pointer, no model call) while the session is recorded; otherwise
 *   OpenCode's own compaction runs. The title hook names the session, so no title request goes to a model.
 * - zoom, date and search (and, for readers, agents and agent_memory) are plugin tools the model sees directly.
 * - Status: status.json as pi writes it, and the feed for the TUI entry's footer and toasts (src/opencode/feed.ts).
 * Every hook body is wrapped: a failure says so in a notice and the turn goes on (a throw in the context hook would fail
 * the person's turn). Cleanup releases the writer lock: a reload runs cleanup, then setup again, in the same process.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { compactorCommand } from "../agent/agent-commands.ts";
import { type AgentConfig, defaultConfigPath, type HarnessConfig, loadConfig } from "../agent/config.ts";
import { openElsewhere, openYielding } from "../agent/handover.ts";
import { cutNotice, instructionsSection, readInstructions } from "../agent/instructions.ts";
import { AgentHeld, MemoryAgent } from "../agent/memory-agent.ts";
import { memoryTools, readerTools, type ViewAccess, withAgentView } from "../agent/memory-tools.ts";
import { agentModelSource } from "../agent/model-source.ts";
import { noticeKey, noticeText, type TroubleState } from "../agent/notices.ts";
import { AGENT_ENV, pickAgent, TOKEN_ENV } from "../agent/pick.ts";
import { runningVersion } from "../agent/running.ts";
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
import type { CompactionEvent, ContextEvent, OpenCodeContext, OpenCodePlugin, PluginTool, PromptEvent, TitleEvent } from "./host.ts";
import { PLUGIN_ID, readPluginOptions } from "./options.ts";
import { feedFileOf, launchTokenFile, readTokenFile } from "./token-file.ts";
import { finalReply } from "./turns.ts";

export interface OpenCodePluginOptions {
	/** Orrery's config; default: read from its file (ORRERY_CONFIG, else <Orrery's home>/config.toml). Tests pass one. */
	readonly config?: HarnessConfig;
	/** The environment that says where Orrery's home and config are (default process.env). Tests pass a scratch one. */
	readonly env?: NodeJS.ProcessEnv;
	/** The process the token is claimed for (default this one, OpenCode's server). Tests pass another. */
	readonly owner?: number;
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

/** The most sessions whose parts are kept; the oldest goes first, and makes its parts again if it asks. */
const KEPT_SESSIONS = 64;
/** The most parents followed up to a session's root. */
const MAX_DEPTH = 8;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

/** Orrery's plugin for one OpenCode location (folder), from setup to cleanup. */
class OrreryInOpenCode {
	readonly #ctx: OpenCodeContext;
	readonly #options: OpenCodePluginOptions;
	#agent: AgentConfig | undefined;
	#config: HarnessConfig | undefined;
	#memory: Memory = { kind: "opening" };
	#opening: Promise<void> = Promise.resolve();
	readonly #openAbort = new AbortController();
	readonly #stopping = new AbortController();
	#stopped = false;
	#timer: ReturnType<typeof setInterval> | undefined;
	/** The feed for this launch's TUI; only the OpenCode that claimed the launch's token writes it. */
	#feed: string | undefined;
	#line = "Orrery";
	#notices: FeedNotice[] = [];
	#count = 0;
	#written = "";
	/** Notices said once per plugin (keys), and texts of failures said already. */
	readonly #said = new Set<string>();
	/** Main sessions this location's hooks have seen: the event stream is the whole server's. */
	readonly #ours = new Set<string>();
	/** Sessions whose run is going on. */
	readonly #busy = new Set<string>();
	/** Prompts recorded (their message ids): OpenCode may run a prompt hook twice for one prompt. */
	readonly #prompts = new Set<string>();
	readonly #parents = new Map<string, Promise<string | null>>();
	/** Each main session's system parts, made once (and again after its compaction). */
	readonly #parts = new Map<string, Promise<readonly string[]>>();
	readonly #pending = new Set<Promise<void>>();
	#summarizing = 0;
	#trouble: string | undefined;
	readonly #updatesShown = new Set<string>();

	constructor(ctx: OpenCodeContext, options: OpenCodePluginOptions) {
		this.#ctx = ctx;
		this.#options = options;
	}

	/** Reads the options, the config and the token, picks the agent, and, with one, registers the hooks and opens its memory. */
	async start(): Promise<void> {
		const options = readPluginOptions(this.#ctx.options);
		if ("problem" in options) {
			this.#log(`Orrery: loaded without an agent (${options.problem}).`);
			return;
		}
		this.#log(`Orrery: loaded for ${options.agent}.`);
		const env = this.#options.env ?? process.env;
		// Only a launch's own token file: OpenCode's config (a project's opencode.json among it) names this one, and the
		// feed is written beside it.
		if (!launchTokenFile(options.tokenFile, env)) {
			this.#log("Orrery: the plugin's token file is not one Orrery's launch wrote; this session runs without memory.");
			return;
		}
		const feed = feedFileOf(options.tokenFile);
		const directory = typeof this.#ctx.location?.directory === "string" ? this.#ctx.location.directory : process.cwd();
		let config: HarnessConfig;
		try {
			config = this.#options.config ?? loadConfig(defaultConfigPath(env));
		} catch (error) {
			this.#feed = feed;
			this.#refuse(`Orrery: Orrery's config could not be read (${safeText(errorText(error))}); this session runs without memory.`);
			return;
		}
		let token: string;
		try {
			token = readTokenFile(options.tokenFile);
		} catch (error) {
			this.#feed = feed;
			this.#refuse(`Orrery: the launch token for ${safeText(options.agent)} could not be read (${safeText(errorText(error))}); this session runs without memory.`);
			return;
		}
		const pick = pickAgent(config, { env: { [AGENT_ENV]: options.agent, [TOKEN_ENV]: token }, cwd: directory, owner: this.#options.owner ?? process.pid });
		if (pick.kind === "unknown" || pick.kind === "bad-token") {
			this.#feed = feed;
			this.#refuse(
				pick.kind === "unknown"
					? `Orrery: ${safeText(pick.name)} is not an agent in Orrery's config; this session runs without memory.`
					: `Orrery: the launch token for ${pick.name} is not one Orrery made; this session runs without memory.`,
			);
			return;
		}
		// The launch's token is another live OpenCode's: this one was started from it, and is plain OpenCode here.
		if (pick.kind === "none") return;
		// Only the OpenCode the launch made speaks to its TUI; one started from it, in an agent's folder, has no TUI of its own here.
		if (pick.by === "env") this.#feed = feed;
		this.#config = config;
		this.#agent = pick.agent;
		this.#status();
		await this.#register();
		this.#opening = this.#open();
		void this.#listen();
		this.#timer = setInterval(() => this.#tick(), this.#options.tickMs ?? 5000);
		this.#timer.unref?.();
	}

	/** Cleanup: stops listening, waits a little for a reply being recorded, and closes the memory (the writer lock goes). Never throws. */
	async stop(): Promise<void> {
		this.#stopped = true;
		this.#stopping.abort();
		this.#openAbort.abort(new Error("OpenCode closed the plugin"));
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
		try {
			await this.#opening;
			const waited = new Promise<void>((done) => setTimeout(done, this.#options.closeWaitMs ?? 3000).unref?.());
			await Promise.race([Promise.allSettled([...this.#pending]), waited]);
		} catch {
			// the memory closes all the same
		}
		const state = this.#memory;
		if (state.kind !== "recording") return;
		this.#memory = { kind: "off" };
		try {
			state.memory.writeStatus(false, false);
		} catch {
			// an agent left "open" in its status is old news within 30 s
		}
		try {
			await state.memory.close();
		} catch (error) {
			this.#log(`Orrery: closing ${state.memory.config.name}'s memory failed: ${errorText(error)}`);
		}
	}

	/** No agent: what the person is told, with a feed that says so. */
	#refuse(text: string): void {
		this.#line = "Orrery · no memory";
		this.#say(text, "warning");
	}

	#log(line: string): void {
		try {
			(this.#options.log ?? ((text: string) => process.stderr.write(`${text}\n`)))(line);
		} catch {
			// nowhere to say it
		}
	}

	/** A notice for the person (a toast in the TUI), never for the model. */
	#say(text: string, level: FeedLevel = "info"): void {
		this.#notices = [...this.#notices, { n: ++this.#count, text, level }].slice(-FEED_NOTICES);
		this.#writeFeed();
	}

	/** A notice said once for `key` in this plugin's life. */
	#once(key: string, text: string, level: FeedLevel = "warning"): void {
		if (this.#said.has(key)) return;
		this.#said.add(key);
		this.#say(text, level);
	}

	#writeFeed(): void {
		if (this.#feed === undefined) return;
		const feed = { tui: this.#options.tui ?? process.ppid, line: this.#line, notices: this.#notices };
		const text = JSON.stringify(feed);
		if (text === this.#written) return;
		try {
			writeFeed(this.#feed, feed);
			this.#written = text;
		} catch (error) {
			this.#log(`Orrery: the status for OpenCode's TUI could not be written: ${errorText(error)}`);
		}
	}

	/** The status line, status.json (while recording) and the feed, now. Never throws. */
	#status(): void {
		const name = this.#agent?.name ?? "";
		try {
			const state = this.#memory;
			if (state.kind === "recording" && !state.memory.remote?.lost) {
				state.memory.writeStatus(this.#busy.size > 0);
				this.#line = this.#summarizing > 0 ? `Orrery · ${name} · summarizing before this message…` : `${state.memory.statusLine()} · recording`;
			} else if (state.kind === "read-only") this.#line = `Orrery · ${name} · read-only: ${state.where}`;
			else if (state.kind === "off") this.#line = `Orrery · ${name} · no memory`;
			else this.#line = `Orrery · ${name} · opening memory…`;
		} catch (error) {
			this.#once("status", `Orrery: status update failed: ${safeText(errorText(error))}`);
		}
		this.#writeFeed();
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
			this.#once(text, text);
		}
	}

	async #register(): Promise<void> {
		const { session, tool } = this.#ctx;
		await session.hook("prompt", (event) => this.#guarded("recording a prompt", () => this.#onPrompt(event)));
		await session.hook("context", (event) => this.#guarded("the memory for this request", () => this.#onContext(event)));
		await session.hook("compaction", (event) => this.#guarded("answering the compaction from memory", () => this.#onCompaction(event)));
		await session.hook("title", (event) => this.#guarded("naming the session", () => this.#onTitle(event)));
		await tool.transform((editor) => {
			try {
				for (const each of this.#tools()) editor.add(each);
			} catch (error) {
				this.#once("tools", `Orrery: the memory tools could not be added: ${safeText(errorText(error))}`);
			}
		});
	}

	/** Opens the agent's memory, as pi does: recording, read-only (held elsewhere), or off. Never rejects. */
	async #open(): Promise<void> {
		const agent = this.#agent as AgentConfig;
		const config = this.#config as HarnessConfig;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let asked: LockState | undefined;
		try {
			const sources = await (this.#options.summarySources ?? openSummarySources)(config, agent);
			const report = (message: string) => {
				this.#say(message, "warning");
				// A remote session says it was lost before it closes the store: stop recording at once.
				this.#recording();
			};
			const memory = { agent, models: agentModelSource(sources.models), host: "opencode" as const, report };
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
			if (this.#stopped) {
				await opened.close();
				return;
			}
			this.#memory = { kind: "recording", memory: opened };
			// The open's own reports already said what is wrong now: notices start from here.
			this.#trouble = noticeKey(troubleState(opened));
		} catch (error) {
			if (this.#stopped) return;
			if (error instanceof AgentHeld) {
				const where = openElsewhere(agent.dir, "opencode");
				this.#memory = { kind: "read-only", where };
				this.#say(`Orrery: ${agent.name} is ${where}; this session reads memory but is not recorded.`, "warning");
			} else {
				this.#memory = { kind: "off" };
				const why = agent.remote === undefined ? safeText(errorText(error)) : remoteOpenNotice(agent, error);
				this.#say(`Orrery: ${agent.name}: ${why}${asked === undefined ? "" : `; run orrery agent takeover ${agent.name} to open it here`}; this session runs without memory.`, "warning");
			}
		} finally {
			clearTimeout(deadline);
			this.#status();
		}
	}

	/** The memory while it records; a remote memory moved elsewhere stops recording here (and closes). */
	#recording(): MemoryAgent | undefined {
		const state = this.#memory;
		if (state.kind !== "recording") return undefined;
		if (!state.memory.remote?.lost) return state.memory;
		this.#memory = { kind: "off" };
		void state.memory.close().catch(() => {});
		this.#status();
		return undefined;
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
		await this.#opening;
		const memory = this.#recording();
		if (memory === undefined || this.#prompts.has(event.messageID)) return;
		this.#prompts.add(event.messageID);
		const text = typeof event.prompt?.text === "string" ? event.prompt.text : "";
		if (text.trim() === "") return;
		memory.view.appendBatch([{ kind: "user", text, date: localIso() }]);
		this.#busy.add(event.sessionID);
		this.#status();
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
		await this.#opening;
		const agent = this.#agent as AgentConfig;
		const parts: string[] = [];
		const found = readInstructions(agent.dir);
		if (found !== undefined) {
			parts.push(instructionsSection(agent.name, found));
			if (found.cut) this.#once("cut", cutNotice(agent.name));
		}
		const state = this.#memory;
		const memory = this.#recording();
		if (memory !== undefined) {
			memory.instructionsAt = found?.at;
			await this.#settle(memory);
			parts.push(memorySection(memory.view, "opencode"));
		} else if (state.kind === "read-only") {
			const file = join(agent.dir, "memory.sqlite");
			if (existsSync(file)) {
				const store = MemoryStore.openReadOnly(file);
				try {
					parts.push(memorySection(new MemoryView(store, agent.memory.viewBytes), "opencode"));
				} finally {
					store.close();
				}
			}
		}
		this.#status();
		return parts;
	}

	/** Waits for pending summaries that can come (not when summaries are off, stopped or failing), at most memoryWaitMs. */
	async #settle(memory: MemoryAgent): Promise<void> {
		if (memory.view.settled || memory.summaryTrouble() !== undefined) return;
		this.#summarizing++;
		this.#status();
		const wait = new AbortController();
		const timer = setTimeout(() => wait.abort(), this.#options.memoryWaitMs ?? 60_000);
		try {
			await memory.awaitSummaries(AbortSignal.any([wait.signal, this.#stopping.signal]));
		} finally {
			clearTimeout(timer);
			this.#summarizing--;
		}
		if (!memory.view.settled) {
			const trouble = memory.summaryTrouble();
			const why = trouble === undefined ? "summaries still pending" : `summaries are ${trouble.state} (${trouble.plain})`;
			this.#say(`Orrery: ${why}; this session's memory view has unsummarized lines (the model can zoom them).`, "warning");
		}
	}

	async #onCompaction(event: CompactionEvent): Promise<void> {
		if ((await this.#parentOf(event.sessionID)) !== null) return;
		await this.#opening;
		// Not recorded: OpenCode's own summary keeps what memory doesn't have.
		if (this.#recording() === undefined) return;
		event.result = { summary: COMPACTION_SUMMARY };
		this.#parts.delete(event.sessionID);
	}

	#onTitle(event: TitleEvent): void {
		event.result = sessionTitle((this.#agent as AgentConfig).name);
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
			if (!signal.aborted) this.#once("events", `Orrery: OpenCode's event stream stopped (${safeText(errorText(error))}); replies are not recorded from here on.`);
		}
	}

	#onEvent(event: unknown): void {
		const { type, data } = (event ?? {}) as { type?: unknown; data?: { sessionID?: unknown; parentID?: unknown } };
		const sessionID = data?.sessionID;
		if (typeof sessionID !== "string") return;
		if (type === "session.created") {
			if (!this.#parents.has(sessionID)) this.#parents.set(sessionID, Promise.resolve(typeof data?.parentID === "string" && data.parentID !== "" ? data.parentID : null));
		} else if (type === "session.execution.started") {
			if (this.#ours.has(sessionID)) {
				this.#busy.add(sessionID);
				this.#status();
			}
		} else if (type === "session.execution.succeeded") {
			const recording = this.#guarded("recording a reply", () => this.#onSucceeded(sessionID));
			this.#pending.add(recording);
			void recording.finally(() => this.#pending.delete(recording));
		} else if (type === "session.execution.failed" || type === "session.execution.interrupted") {
			if (this.#busy.delete(sessionID)) this.#status();
		}
	}

	/** A run of one of this location's main sessions ended: its final reply goes to memory, once. */
	async #onSucceeded(sessionID: string): Promise<void> {
		this.#busy.delete(sessionID);
		try {
			if (!this.#ours.has(sessionID)) return;
			await this.#opening;
			const memory = this.#recording();
			if (memory === undefined) return;
			const answer = await this.#ctx.session.context({ sessionID });
			const reply = finalReply(Array.isArray(answer) ? answer : (answer as { data?: unknown } | null)?.data);
			if (reply === undefined) return;
			const key = `opencode.reply.${sessionID}`;
			if (this.#recording() !== memory || memory.store.getMeta(key) === reply.id) return;
			memory.view.appendBatch(reply.text.trim() === "" ? [] : [{ kind: "talk", text: reply.text, date: reply.date }], { [key]: reply.id }, reply.usage);
			memory.afterTurn();
		} finally {
			this.#status();
		}
	}

	/** The memory tools over the live view while recording, a read-only snapshot while read-only. */
	#tools(): PluginTool[] {
		const agent = this.#agent as AgentConfig;
		const config = this.#config as HarnessConfig;
		const access: ViewAccess = (use) => {
			const memory = this.#recording();
			if (memory !== undefined) return use(memory.view);
			if (this.#memory.kind === "read-only") return withAgentView(agent, use, config);
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
				await this.#opening;
				return { content: await each.run(input ?? {}) };
			},
		}));
	}

	/** Every tickMs: summary-model changes made from outside (the TUI's M), summary trouble, updates, the status. */
	#tick(): void {
		try {
			const memory = this.#recording();
			if (memory !== undefined) {
				const name = memory.config.name;
				try {
					const taken = takeRequest(memory.config.dir, name);
					if (taken.ignored !== undefined) this.#say(`Orrery: ignored ${taken.ignored}.`, "warning");
					if (taken.request !== undefined) this.#say(safeText(`Orrery: ${compactorCommand(memory, taken.request.args)} (changed from outside OpenCode)`));
				} catch (error) {
					this.#once("request", `Orrery: a summary-model change from outside OpenCode failed: ${safeText(errorText(error))}`);
				}
				const now = troubleState(memory);
				const message = noticeText(name, now, this.#trouble, `orrery compactor ${name}`);
				this.#trouble = noticeKey(now);
				if (message !== undefined) this.#say(message, now ? "warning" : "info");
			}
			this.#showUpdates();
		} catch (error) {
			this.#once("tick", `Orrery: status update failed: ${safeText(errorText(error))}`);
		}
		this.#status();
	}

	/** The update notices, each once (src/agent/update-notices.ts), and a refresh of the daily check when it is due. */
	#showUpdates(): void {
		const updates = this.#options.updates;
		const config = this.#config;
		if (updates === undefined || config === undefined) return;
		const enabled = config.updates.check;
		const show = () => {
			if (this.#stopped) return;
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
					this.#say(notice.text, "warning");
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

/** Orrery's OpenCode plugin: `export default openCodePlugin(…)` in its server entry. Setup never throws. */
export function openCodePlugin(options: OpenCodePluginOptions = {}): OpenCodePlugin {
	return {
		id: PLUGIN_ID,
		async setup(ctx: OpenCodeContext) {
			const plugin = new OrreryInOpenCode(ctx, options);
			try {
				await plugin.start();
			} catch (error) {
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
