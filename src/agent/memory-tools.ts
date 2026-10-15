/**
 * The memory tools, defined once for every agent (spec §4 "Memory tools"). pi registers them as its tools
 * (src/pi/tools.ts), and Claude Code calls them through orrery's MCP server (src/claude/mcp.ts).
 * - zoom, date and search read the agent's own memory.
 * - Readers (`reads` in the config, like Birch) also get agents and agent_memory, which read other agents' memory,
 *   read-only.
 * Each tool returns text; a thrown error is the tool's error.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type TSchema, Type } from "typebox";
import { formatHits, MemoryStore, MemoryView, searchLog } from "../memory/index.ts";
import { findAgent, type HarnessConfig, type AgentConfig } from "./config.ts";
import { openStorage } from "../remote/index.ts";
import { agentOpenHere, readCopyPath } from "../remote/read-copy.ts";
import type { LaneEntry } from "../remote/types.ts";

/** One memory tool, independent of the agent that calls it. */
export interface ReaderTool {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	/** Its result can be long (a whole message, a whole view): Claude Code is told to keep it inline, not in a file. */
	readonly long: boolean;
	run(params: Record<string, unknown>): string | Promise<string>;
}

/** Runs `use` on a view of the agent's own memory: pi's live view, or a read-only snapshot (Claude Code). */
export type ViewAccess = (use: (view: MemoryView) => string) => string | Promise<string>;

/** A read-only snapshot of an agent's memory for one use; safe while the agent's writer runs (the store uses WAL). */
export function withAgentView<T>(agent: AgentConfig, use: (view: MemoryView) => T): T;
export function withAgentView(agent: AgentConfig, use: (view: MemoryView) => string, config: HarnessConfig): string | Promise<string>;
export function withAgentView(agent: AgentConfig, use: (view: MemoryView) => unknown, config?: HarnessConfig): unknown {
	if (agent.remote !== undefined && config !== undefined) {
		return readCopyPath(config, agent).then(({ path, asOf }) => {
			const text = withPathView(agent, path, use);
			return asOf === undefined ? text : `(as of ${asOf})\n${text}`;
		});
	}
	return withPathView(agent, join(agent.dir, "memory.sqlite"), use);
}

function withPathView<T>(agent: AgentConfig, file: string, use: (view: MemoryView) => T): T {
	if (!existsSync(file)) throw new Error(`${agent.name} has no memory yet`);
	const store = MemoryStore.openReadOnly(file);
	try {
		return use(new MemoryView(store, agent.memory.viewBytes));
	} finally {
		store.close();
	}
}

/** zoom, date and search over the agent's own memory, reached through `access`. */
export function memoryTools(access: ViewAccess): ReaderTool[] {
	return [
		{
			name: "zoom",
			label: "zoom",
			description: "Open the line id+n of the memory view into the two lines of n/2 under it; n = 1 gives the message whole.",
			parameters: Type.Object({ id: Type.Integer(), n: Type.Integer() }),
			long: true,
			run: (p) => access((view) => view.zoom(p.id, p.n)),
		},
		{
			name: "date",
			label: "date",
			description: "The date and time of memory message id.",
			parameters: Type.Object({ id: Type.Integer() }),
			long: false,
			run: (p) => access((view) => view.date(p.id)),
		},
		{
			name: "search",
			label: "search",
			description: "Search the full memory log by keywords (all must appear) or /regex/; newest first. Then zoom(id, 1) or date(id).",
			parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
			long: false,
			run: (p) => access((view) => formatHits(searchLog(view.store, p.query as string, { limit: p.limit as number | undefined }), p.query as string)),
		},
	];
}

interface CachedList {
	readonly signature: string;
	readonly result: Promise<LaneEntry[] | undefined>;
	checkedAt?: number;
}
const remoteLists = new WeakMap<HarnessConfig, Map<string, CachedList>>();
const LIST_REFRESH_MS = 30_000;

/** Share in-flight requests and cache successes or failures briefly across tool calls for this config. */
function remoteList(config: HarnessConfig, remote: string): Promise<LaneEntry[] | undefined> {
	let remotes = remoteLists.get(config);
	if (remotes === undefined) { remotes = new Map(); remoteLists.set(config, remotes); }
	const signature = JSON.stringify([config.dataDir, config.sshDir, config.remotes.get(remote)]);
	const cached = remotes.get(remote);
	const now = Date.now();
	if (cached?.signature === signature && (cached.checkedAt === undefined || (now >= cached.checkedAt && now - cached.checkedAt < LIST_REFRESH_MS))) return cached.result;
	const entry: CachedList = {
		signature,
		result: Promise.resolve().then(() => openStorage(config, remote).list()).catch(() => undefined).finally(() => { entry.checkedAt = Date.now(); }),
	};
	remotes.set(remote, entry);
	return entry.result;
}

function mayRead(reader: AgentConfig, agent: AgentConfig): boolean {
	return reader.reads.includes("*") || reader.reads.includes(agent.name) || agent.name === reader.name;
}

/** Message counts for readable agents; other remote agents expose only their cached public listing. */
function agentsText(config: HarnessConfig, reader: AgentConfig): string | Promise<string> {
	const line = (agent: AgentConfig, file: string, state: string) => {
		if (!existsSync(file)) return `${agent.name}: no memory yet${agent.remote === undefined ? "" : `, ${state}`}`;
		const store = MemoryStore.openReadOnly(file);
		try { return `${agent.name}: ${store.root.length} messages, last ${store.root.at(-1)?.date.slice(0, 10) ?? "never"}, ${state}`; }
		finally { store.close(); }
	};
	const lines = [...config.agents.values()].map((agent) => {
		const file = join(agent.dir, "memory.sqlite");
		if (agent.remote !== undefined) {
			return (async () => {
				const entries = await remoteList(config, agent.remote!);
				const entry = entries?.find((entry) => entry.lane === agent.name);
				const held = entry?.lock;
				const remoteState = held?.held && !held.stale ? `open on ${held.holder.machine}` : entries === undefined ? "remote status unavailable" : "closed";
				if (!mayRead(reader, agent)) {
					if (entries === undefined) return `${agent.name}: remote status unavailable`;
					if (entry === undefined) return `${agent.name}: no memory on remote`;
					return `${agent.name}: ${entry.newestSave} ${entry.newestSave === 1 ? "save" : "saves"}, ${remoteState}`;
				}
				const state = held?.held && !held.stale ? remoteState : agentOpenHere(agent) ? "open" : remoteState;
				try {
					const copy = await readCopyPath(config, agent);
					return `${copy.asOf === undefined ? "" : `(as of ${copy.asOf}) `}${line(agent, copy.path, state)}`;
				} catch (error) {
					return `${agent.name}: unreadable (${error instanceof Error ? error.message : String(error)}), ${state}`;
				}
			})();
		}
		try {
			return line(agent, file, agentOpenHere(agent) ? "open" : "closed");
		} catch (error) {
			return `${agent.name}: unreadable (${error instanceof Error ? error.message : String(error)})`;
		}
	});
	return lines.some((line) => line instanceof Promise) ? Promise.all(lines).then((all) => all.join("\n")) : lines.join("\n");
}

/** `reader()` is the agent asking; it throws when there is none (pi without memory). */
export function readerTools(reader: () => AgentConfig, config: HarnessConfig): ReaderTool[] {
	const readable = (name: string) => {
		const self = reader();
		const agent = findAgent(config, name);
		if (!mayRead(self, agent)) throw new Error(`${self.name} may not read ${agent.name}`);
		return agent;
	};
	return [
		{
			name: "agents",
			label: "agents",
			description: "Every agent: memory or remote save counts, last message date when available, and where it is open now.",
			parameters: Type.Object({}),
			long: false,
			run: () => agentsText(config, reader()),
		},
		{
			name: "agent_memory",
			label: "agent memory",
			description:
				"Read another agent's memory, read-only. action: view (its whole memory view), zoom (id, n), date (id), search (query[, limit]).",
			parameters: Type.Object({
				agent: Type.String(),
				action: Type.Union([Type.Literal("view"), Type.Literal("zoom"), Type.Literal("date"), Type.Literal("search")]),
				id: Type.Optional(Type.Integer()),
				n: Type.Optional(Type.Integer()),
				query: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			}),
			long: true,
			run: (p) =>
				withAgentView(readable(p.agent as string), (view) => {
					const query = (p.query as string | undefined) ?? "";
					if (p.action === "view") return view.render();
					if (p.action === "zoom") return view.zoom(p.id, p.n);
					if (p.action === "date") return view.date(p.id);
					return formatHits(searchLog(view.store, query, { limit: p.limit as number | undefined }), query);
				}, config),
		},
	];
}
