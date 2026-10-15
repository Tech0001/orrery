/**
 * Every agent at a glance (spec 2026-10-08-orrery-tui-design §4.2), for `orrery status` and the TUI. Read-only: it
 * reads status.json, Claude Code's holder.json and memory.sqlite (opened read-only), and never opens an agent to write.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openStorage } from "../remote/index.ts";
import type { LaneEntry, Storage } from "../remote/types.ts";
import { clean } from "../cli/printer.ts";
import { COMPACTION_VIEW_BYTES } from "../memory/compaction-view.ts";
import { MemoryStore, MemoryView, type UsageRow } from "../memory/index.ts";
import { backupFinder } from "./backup.ts";
import { type BuildState, buildRunning, readBuild } from "./build.ts";
import { COMPACTOR_MODEL_KEY, storedChoice } from "./choices.ts";
import { type HarnessConfig, type AgentConfig, type AgentLauncher, type AgentTool, type ModelChoice, THINKING_LEVELS, type ThinkingLevel } from "./config.ts";
import { holderFresh, readHolder } from "./handover.ts";
import { instructionsFacts, type InstructionsState } from "./instructions.ts";
import { processAlive } from "./process.ts";
import { safeText } from "./source-labels.ts";
import { readStatus } from "./status-file.ts";

export type AgentState = "working" | "open" | "finishing" | "closed";
export type SummaryState = "ok" | "catching up" | "waiting" | "failing" | "stopped";

export interface AgentRow {
	readonly name: string;
	readonly remote?: string;
	/** A remote cache miss; renders as … while list() runs in the background. */
	readonly remotePending?: boolean;
	readonly remoteReachable?: boolean;
	readonly heldElsewhere?: { readonly machine: string; readonly lastSeen: number; readonly stale: boolean; readonly newestSave: number };
	readonly tool: AgentTool;
	readonly launcher?: AgentLauncher;
	readonly oriModel?: string;
	/** False when the config has no `tool` key, so `tool` is a guess from the last status. */
	readonly toolSet: boolean;
	readonly state: AgentState;
	/** The tool that has the agent open, when one does. */
	readonly openIn?: "pi" | "omp" | "claude-code";
	/** The agent's default folder; absent: it opens wherever it is opened. */
	readonly folder?: string;
	readonly dataDir: string;
	readonly hasMemory: boolean;
	readonly messages: number;
	readonly summaries: number;
	readonly viewBytes: number;
	readonly viewBudget: number;
	readonly summaryContextBytes: number;
	readonly summaryJobs: number;
	readonly compactAt: number;
	readonly summary: { readonly state: SummaryState; readonly waiting: number; readonly plain?: string };
	/** thinking is "?" when a status.json names a level orrery does not know. */
	readonly summaryModel: { readonly ref: string; readonly thinking: ThinkingLevel | "?"; readonly source: "config" | "chat" };
	readonly lastMessageAt?: string;
	readonly reads: readonly string[];
	/** Why the agent's files could not be read; its counts are then zeros and its summaries "stopped". */
	readonly unreadable?: string;
	/** The day (YYYY-MM-DD) of the agent's newest backup under `<data_dir>/backups/`, when it has one. */
	readonly lastBackup?: string;
	/** The Orrery version the agent's open tool runs (its status file's version): a release, "checkout" or "unknown". Only while the agent is open or working. */
	readonly runsVersion?: string;
	/** instructions.md: "ok", "none" (missing or blank), or "too large" (only its first 32 KB are used). */
	readonly instructions: InstructionsState;
	/** The open session read older instructions than the file holds now (or had none): it uses them at its next start. */
	readonly instructionsNewer?: true;
	/** The memory build's state (src/agent/build.ts) while it runs, or after it stopped short while summaries still wait. */
	readonly building?: string;
}

/** A pi status older than this belongs to a pi that is gone: pi rewrites it every 5 s. */
export const STATUS_FRESH_MS = 30_000;

export const TOOL_LABELS: Record<AgentTool, string> = { pi: "pi", "claude-code": "Claude Code", codex: "Codex", omp: "OMP" };

interface MemoryFacts {
	readonly messages: number;
	readonly summaries: number;
	readonly viewBytes: number;
	readonly viewBudget: number;
	readonly settled: boolean;
	readonly firstUnsummarized: number;
	readonly lastMessageAt?: string;
	readonly chosen?: ModelChoice;
}

/** Public remote reachability and the last listing. Undefined reachable means no result yet. */
export interface RemoteRow {
	readonly name: string;
	readonly kind: "server" | "cloudflare";
	readonly reachable?: boolean;
	readonly agents?: readonly LaneEntry[];
}

interface CachedRemote {
	readonly signature: string;
	row: RemoteRow;
	checkedAt?: number;
	pending?: Promise<void>;
}

/** Memory facts per agent, kept until memory.sqlite or its WAL changes, so a refresh every 2 s stays cheap. */
export class OverviewCache {
	readonly #facts = new Map<string, { readonly key: string; readonly facts: MemoryFacts }>();
	readonly #remotes = new Map<string, CachedRemote>();
	readonly #storage: (config: HarnessConfig, name: string) => Storage;
	readonly #now: () => number;
	readonly #changed: () => void;

	constructor(options: { storage?: (config: HarnessConfig, name: string) => Storage; now?: () => number; changed?: () => void } = {}) {
		this.#storage = options.storage ?? openStorage;
		this.#now = options.now ?? Date.now;
		this.#changed = options.changed ?? (() => {});
	}

	/** Starts at most one request per remote every 30 s; neither storage creation nor network work runs in this frame. */
	remotes(config: HarnessConfig): RemoteRow[] {
		for (const name of this.#remotes.keys()) if (!config.remotes.has(name)) this.#remotes.delete(name);
		return [...config.remotes.values()].map((remote) => {
			const hit = this.#remote(config, remote.name);
			if (hit.checkedAt === undefined || this.#now() - hit.checkedAt >= 30_000) void this.#refreshRemote(config, hit);
			return hit.row;
		});
	}

	/** Bypass the 30 s interval for a launch decision, sharing any request already in flight. */
	refreshRemote(config: HarnessConfig, name: string): Promise<void> {
		return this.#refreshRemote(config, this.#remote(config, name));
	}

	#remote(config: HarnessConfig, name: string): CachedRemote {
		const remote = config.remotes.get(name);
		if (remote === undefined) throw new Error(`No remote named ${name}.`);
		const signature = JSON.stringify([config.dataDir, config.sshDir, remote]);
		let entry = this.#remotes.get(name);
		if (entry === undefined || entry.signature !== signature) {
			entry = { signature, row: { name, kind: remote.kind } };
			this.#remotes.set(name, entry);
		}
		return entry;
	}

	#refreshRemote(config: HarnessConfig, entry: CachedRemote): Promise<void> {
		if (entry.pending !== undefined) return entry.pending;
		const { name, kind } = entry.row;
		entry.pending = Promise.resolve().then(() => this.#storage(config, name).list()).then(
			(agents) => { entry.row = { name, kind, reachable: true, agents }; },
			() => { entry.row = { name, kind, reachable: false }; },
		).then(() => {
			entry.pending = undefined;
			entry.checkedAt = this.#now();
			if (this.#remotes.get(name) === entry) this.#changed();
		});
		return entry.pending;
	}

	facts(file: string, read: () => MemoryFacts): MemoryFacts {
		const key = fileKey(file);
		const hit = this.#facts.get(file);
		if (hit !== undefined && hit.key === key) return hit.facts;
		const facts = read();
		this.#facts.set(file, { key, facts });
		return facts;
	}
}

function fileKey(file: string): string {
	const part = (path: string) => {
		try {
			const s = statSync(path);
			return `${s.mtimeMs}:${s.size}`;
		} catch {
			return "-";
		}
	};
	return `${part(file)}|${part(`${file}-wal`)}`;
}

function readFacts(agent: AgentConfig, file: string): MemoryFacts {
	const store = MemoryStore.openReadOnly(file);
	try {
		const stats = new MemoryView(store, agent.memory.viewBytes).stats();
		const last = store.root.at(-1);
		const { choice } = storedChoice(store, COMPACTOR_MODEL_KEY, () => true);
		return {
			messages: stats.messages,
			summaries: stats.nodes,
			viewBytes: stats.viewBytes,
			viewBudget: stats.viewBudget,
			settled: stats.settled,
			firstUnsummarized: stats.firstUnsummarized,
			...(last === undefined ? {} : { lastMessageAt: last.date }),
			...(choice === undefined ? {} : { chosen: choice }),
		};
	} finally {
		store.close();
	}
}

/** Text from status.json or an error, made safe to show: whole terminal escape sequences removed, then one clean line. */
const shown = (text: string) => safeText(clean(text));

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A thinking level from status.json, or "?" when it is not one orrery knows. */
const knownThinking = (level: string): ThinkingLevel | "?" => ((THINKING_LEVELS as readonly string[]).includes(level) ? (level as ThinkingLevel) : "?");

const configuredModel = (agent: AgentConfig) => ({ ref: `${agent.compactor.model.provider}/${agent.compactor.model.modelId}`, thinking: agent.compactor.model.thinking, source: "config" as const });

/** What an unreadable agent reports: no counts, and summaries stopped (never "ok") with the reason. */
function unreadableFields(agent: AgentConfig, reason: string) {
	return {
		hasMemory: true, messages: 0, summaries: 0, viewBytes: 0, viewBudget: agent.memory.viewBytes,
		summary: { state: "stopped" as const, waiting: 0, plain: `memory unreadable: ${reason}` }, summaryModel: configuredModel(agent), unreadable: reason,
	};
}

/** The row for an agent that threw while being read: closed, its config's facts, and the reason. */
function unreadableRow(agent: AgentConfig, error: unknown): AgentRow {
	return {
		name: agent.name, launcher: agent.launcher ?? "direct", ...(agent.oriModel === undefined ? {} : { oriModel: agent.oriModel }), tool: agent.tool ?? "pi", toolSet: agent.tool !== undefined, state: "closed", ...(agent.folder === undefined ? {} : { folder: agent.folder }), dataDir: agent.dir,
		summaryContextBytes: agent.compactor.contextBytes ?? COMPACTION_VIEW_BYTES, summaryJobs: agent.compactor.jobs, compactAt: agent.compactAt, reads: agent.reads, instructions: instructionsFacts(agent.dir).state,
		...unreadableFields(agent, shown(errorText(error))),
	};
}

function agentRow(agent: AgentConfig, now: number, cache: OverviewCache, alive: (pid: number) => boolean): AgentRow {
	const status = readStatus(agent.dir);
	const holder = readHolder(agent.dir);
	let state: AgentState = "closed";
	let openIn: "pi" | "omp" | "claude-code" | undefined;
	if (holderFresh(holder, now)) {
		openIn = "claude-code";
		state = holder.state === "finishing" ? "finishing" : status?.busy === true && status.model === "claude-code" ? "working" : "open";
	} else if (status !== undefined && status.open !== false && alive(status.pid) && now - Date.parse(status.updatedAt) < STATUS_FRESH_MS) {
		openIn = status.model === "claude-code" ? "claude-code" : status.model === "omp" ? "omp" : "pi";
		state = status.busy ? "working" : "open";
	}
	const instructions = instructionsFacts(agent.dir);
	const base = {
		name: agent.name,
		launcher: agent.launcher ?? "direct",
		...(agent.oriModel === undefined ? {} : { oriModel: agent.oriModel }),
		tool: agent.tool ?? (status?.model === "claude-code" || holder !== undefined ? "claude-code" : status?.model === "omp" ? "omp" : "pi"),
		toolSet: agent.tool !== undefined,
		state,
		...(openIn === undefined ? {} : { openIn }),
		...(openIn === undefined || (state !== "open" && state !== "working") || status?.version === undefined ? {} : { runsVersion: status.version }),
		...(agent.folder === undefined ? {} : { folder: agent.folder }),
		dataDir: agent.dir,
		summaryContextBytes: agent.compactor.contextBytes ?? COMPACTION_VIEW_BYTES,
		summaryJobs: agent.compactor.jobs,
		compactAt: agent.compactAt,
		reads: agent.reads,
		instructions: instructions.state,
		// Only an open session's status counts: a closed one starts afresh. A status from before the field existed says nothing.
		...(state !== "closed" && instructions.at !== undefined && status?.instructionsAt !== undefined && instructions.at > status.instructionsAt ? { instructionsNewer: true as const } : {}),
	} as const;
	const configured = configuredModel(agent);
	const file = join(agent.dir, "memory.sqlite");
	let facts: MemoryFacts | undefined;
	try {
		facts = existsSync(file) ? cache.facts(file, () => readFacts(agent, file)) : undefined;
	} catch (error) {
		return { ...base, ...unreadableFields(agent, shown(errorText(error))) };
	}
	// Trouble counts only while a tool runs the compactor; a closed agent's old status may be days old.
	const live = state === "closed" ? undefined : status;
	const waiting = facts !== undefined && !facts.settled ? Math.max(0, facts.messages - facts.firstUnsummarized) : 0;
	const summary = live?.trouble
		? { state: live.trouble.state, waiting, plain: shown(live.trouble.plain) }
		: { state: waiting === 0 ? ("ok" as const) : state === "closed" ? ("waiting" as const) : ("catching up" as const), waiting };
	// A build that stopped short is named only while summaries still wait: once memory is settled (by a later compact or
	// the agent's own sessions) there is nothing to say.
	const build = readBuild(agent.dir);
	const building = buildRunning(build, alive, now) || waiting > 0 ? buildText(build, alive, now) : undefined;
	const chosen = facts?.chosen;
	const summaryModel = live
		? { ref: shown(live.compactor.model), thinking: knownThinking(live.compactor.thinking), source: live.compactor.source === "chat" ? ("chat" as const) : ("config" as const) }
		: chosen !== undefined
			? { ref: shown(`${chosen.provider}/${chosen.modelId}`), thinking: chosen.thinking, source: "chat" as const }
			: configured;
	return {
		...base,
		hasMemory: facts !== undefined,
		messages: facts?.messages ?? 0,
		summaries: facts?.summaries ?? 0,
		viewBytes: facts?.viewBytes ?? 0,
		viewBudget: facts?.viewBudget ?? agent.memory.viewBytes,
		summary,
		summaryModel,
		...(facts?.lastMessageAt === undefined ? {} : { lastMessageAt: facts.lastMessageAt }),
		...(building === undefined ? {} : { building }),
	};
}

/**
 * One row per configured agent, in config order, with its newest backup's day. An agent that cannot be read is an
 * `unreadable` row; it never hides the others.
 */
export function agentOverview(config: HarnessConfig, options: { now?: number; cache?: OverviewCache; alive?: (pid: number) => boolean } = {}): AgentRow[] {
	const now = options.now ?? Date.now();
	const cache = options.cache ?? new OverviewCache();
	const backups = backupFinder(config);
	const remotes = new Map(cache.remotes(config).map((remote) => [remote.name, remote]));
	let device: string | undefined;
	if (remotes.size > 0) {
		try { device = readFileSync(config.deviceIdPath, "utf8").trim(); } catch { /* overview never creates credentials or device ids */ }
	}
	return [...config.agents.values()].map((agent) => {
		let row: AgentRow;
		try {
			row = agentRow(agent, now, cache, options.alive ?? processAlive);
		} catch (error) {
			row = unreadableRow(agent, error);
		}
		if (agent.remote !== undefined) {
			const remote = remotes.get(agent.remote);
			const entry = remote?.agents?.find((entry) => entry.lane === agent.name);
			const lock = entry?.lock;
			row = { ...row, remote: agent.remote, remotePending: remote?.reachable === undefined,
				...(remote?.reachable === undefined ? {} : { remoteReachable: remote.reachable }),
				...(lock?.held === true && lock.holder.device !== device ? { heldElsewhere: { machine: shown(lock.holder.machine), lastSeen: lock.lastSeen, stale: lock.stale, newestSave: entry!.newestSave } } : {}),
			};
		}
		const day = backups(agent.name)?.day;
		return day === undefined ? row : { ...row, lastBackup: day };
	});
}

/** Why an agent can't be archived now ("<Name> is open in <tool>; close it first."), or undefined when it can. */
export function archiveRefusal(row: AgentRow): string | undefined {
	return row.state === "closed" ? undefined : `${row.name} is open in ${TOOL_LABELS[row.openIn ?? row.tool]}; close it first.`;
}

/** The Agents page's words for a memory build (src/agent/build.ts), or undefined when there is none or it is done. */
export function buildText(state: BuildState | undefined, alive: (pid: number) => boolean = processAlive, now = Date.now()): string | undefined {
	if (state === undefined || state.done === true) return undefined;
	const cost = state.dollars === undefined ? "" : ` · ${dollarText(state.dollars)} so far`;
	if (buildRunning(state, alive, now)) return `building memory: ${state.summaries} summaries for ${state.messages} messages${cost}`;
	return `memory build stopped${state.error === undefined ? "" : ` (${shown(state.error)})`}: see build.log, or run orrery compact again`;
}

/** "ok", "catching up (12)", "waiting (3)", "failing: <reason>", "stopped: <reason>". */
export function summaryText(row: AgentRow): string {
	const { state, waiting, plain } = row.summary;
	if (state === "failing" || state === "stopped") return `${state}: ${plain ?? "no reason given"}`;
	return state === "ok" ? "ok" : `${state} (${waiting})`;
}

/** How long ago `iso` was, roughly: "just now", "5 min", "3 h", "2 d", or "—". */
export function ago(iso: string | undefined, now: number): string {
	const at = iso === undefined ? Number.NaN : Date.parse(iso);
	if (Number.isNaN(at)) return "—";
	const s = Math.max(0, (now - at) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)} min`;
	if (s < 86_400) return `${Math.floor(s / 3600)} h`;
	return `${Math.floor(s / 86_400)} d`;
}

export interface AgentUsage {
	readonly name: string;
	readonly rows: readonly UsageRow[];
}

/** Token use per agent over the last `days` days, for agents with memory (or only `only`). */
export function agentUsage(config: HarnessConfig, days: number, only?: string, now = Date.now()): AgentUsage[] {
	const since = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
	const out: AgentUsage[] = [];
	for (const agent of config.agents.values()) {
		if (only !== undefined && agent.name !== only) continue;
		const file = join(agent.dir, "memory.sqlite");
		if (!existsSync(file)) continue;
		const store = MemoryStore.openReadOnly(file);
		try {
			out.push({ name: agent.name, rows: store.usageRows().filter((row) => row.at.slice(0, 10) >= since) });
		} finally {
			store.close();
		}
	}
	return out;
}

/** A model's catalog price, in $ per million tokens (pi-ai's Model.cost). */
export interface ModelPrice {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

/**
 * What summaries cost, from the usage rows of one span: `plan` for the ChatGPT sign-in (its use is part of the
 * subscription), `local` for a server in `config.providers`, `unknown` for a model `price` doesn't know, else the
 * catalog price of what was sent and read back, in dollars.
 */
export type SummaryCost = { readonly kind: "api"; readonly dollars: number } | { readonly kind: "plan" } | { readonly kind: "local" } | { readonly kind: "unknown" };

/** The ChatGPT sign-in's provider id: summaries on it come out of the plan. */
export const SIGNIN_PROVIDER = "openai";

/** What one summaries usage row cost; `price` looks a model up in the catalog (undefined when it doesn't know it). */
export function usageCost(row: UsageRow, config: HarnessConfig, price: (provider: string, modelId: string) => ModelPrice | undefined): SummaryCost {
	const slash = row.model.indexOf("/");
	if (slash <= 0) return { kind: "unknown" };
	const provider = row.model.slice(0, slash);
	if (provider === SIGNIN_PROVIDER) return { kind: "plan" };
	if (config.providers.some((p) => p.id === provider)) return { kind: "local" };
	let cost: ModelPrice | undefined;
	try {
		cost = price(provider, row.model.slice(slash + 1));
	} catch {
		cost = undefined;
	}
	if (cost === undefined) return { kind: "unknown" };
	return { kind: "api", dollars: (row.input * cost.input + row.cacheRead * cost.cacheRead + row.cacheWrite * cost.cacheWrite + row.output * cost.output) / 1e6 };
}

/** Several rows' cost: unknown when any row is, else their API dollars when any; else plan, else local. */
export function totalCost(costs: readonly SummaryCost[]): SummaryCost | undefined {
	if (costs.length === 0) return undefined;
	if (costs.some((c) => c.kind === "unknown")) return { kind: "unknown" };
	const api = costs.filter((c): c is { kind: "api"; dollars: number } => c.kind === "api");
	if (api.length > 0) return { kind: "api", dollars: api.reduce((sum, c) => sum + c.dollars, 0) };
	return costs.some((c) => c.kind === "plan") ? { kind: "plan" } : { kind: "local" };
}

/** Dollars with two decimals ("$0.11"), "<$0.01" for less than a cent, "$0.00" for nothing. */
export function dollarText(dollars: number): string {
	return dollars > 0 && dollars < 0.01 ? "<$0.01" : `$${dollars.toFixed(2)}`;
}
