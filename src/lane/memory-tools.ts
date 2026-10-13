/**
 * The memory tools, defined once for every agent (spec §4 "Memory tools"). pi registers them as its tools
 * (src/pi/tools.ts), and Claude Code calls them through orrery's MCP server (src/claude/mcp.ts).
 * - zoom, date and search read the lane's own memory.
 * - Readers (`reads` in the config, like Birch) also get lanes and lane_memory, which read other lanes' memory,
 *   read-only.
 * Each tool returns text; a thrown error is the tool's error.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type TSchema, Type } from "typebox";
import { formatHits, MemoryStore, MemoryView, searchLog } from "../memory/index.ts";
import { findLane, type HarnessConfig, type LaneConfig } from "./config.ts";
import { openStorage } from "../remote/index.ts";
import { laneOpenHere, readCopyPath } from "../remote/read-copy.ts";
import type { LaneEntry } from "../remote/types.ts";

/** One memory tool, independent of the agent that calls it. */
export interface LaneTool {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	/** Its result can be long (a whole message, a whole view): Claude Code is told to keep it inline, not in a file. */
	readonly long: boolean;
	run(params: Record<string, unknown>): string | Promise<string>;
}

/** Runs `use` on a view of the lane's own memory: pi's live view, or a read-only snapshot (Claude Code). */
export type ViewAccess = (use: (view: MemoryView) => string) => string | Promise<string>;

/** A read-only snapshot of a lane's memory for one use; safe while the lane's writer runs (the store uses WAL). */
export function withLaneView<T>(lane: LaneConfig, use: (view: MemoryView) => T): T;
export function withLaneView(lane: LaneConfig, use: (view: MemoryView) => string, config: HarnessConfig): string | Promise<string>;
export function withLaneView(lane: LaneConfig, use: (view: MemoryView) => unknown, config?: HarnessConfig): unknown {
	if (lane.remote !== undefined && config !== undefined) {
		return readCopyPath(config, lane).then(({ path, asOf }) => {
			const text = withPathView(lane, path, use);
			return asOf === undefined ? text : `(as of ${asOf})\n${text}`;
		});
	}
	return withPathView(lane, join(lane.dir, "memory.sqlite"), use);
}

function withPathView<T>(lane: LaneConfig, file: string, use: (view: MemoryView) => T): T {
	if (!existsSync(file)) throw new Error(`${lane.name} has no memory yet`);
	const store = MemoryStore.openReadOnly(file);
	try {
		return use(new MemoryView(store, lane.memory.viewBytes));
	} finally {
		store.close();
	}
}

/** zoom, date and search over the lane's own memory, reached through `access`. */
export function memoryTools(access: ViewAccess): LaneTool[] {
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

function mayRead(reader: LaneConfig, lane: LaneConfig): boolean {
	return reader.reads.includes("*") || reader.reads.includes(lane.name) || lane.name === reader.name;
}

/** Message counts for readable lanes; other remote lanes expose only their cached public listing. */
function lanesText(config: HarnessConfig, reader: LaneConfig): string | Promise<string> {
	const line = (lane: LaneConfig, file: string, state: string) => {
		if (!existsSync(file)) return `${lane.name}: no memory yet${lane.remote === undefined ? "" : `, ${state}`}`;
		const store = MemoryStore.openReadOnly(file);
		try { return `${lane.name}: ${store.root.length} messages, last ${store.root.at(-1)?.date.slice(0, 10) ?? "never"}, ${state}`; }
		finally { store.close(); }
	};
	const lines = [...config.lanes.values()].map((lane) => {
		const file = join(lane.dir, "memory.sqlite");
		if (lane.remote !== undefined) {
			return (async () => {
				const entries = await remoteList(config, lane.remote!);
				const entry = entries?.find((entry) => entry.lane === lane.name);
				const held = entry?.lock;
				const remoteState = held?.held && !held.stale ? `open on ${held.holder.machine}` : entries === undefined ? "remote status unavailable" : "closed";
				if (!mayRead(reader, lane)) {
					if (entries === undefined) return `${lane.name}: remote status unavailable`;
					if (entry === undefined) return `${lane.name}: no memory on remote`;
					return `${lane.name}: ${entry.newestSave} ${entry.newestSave === 1 ? "save" : "saves"}, ${remoteState}`;
				}
				const state = held?.held && !held.stale ? remoteState : laneOpenHere(lane) ? "open" : remoteState;
				try {
					const copy = await readCopyPath(config, lane);
					return `${copy.asOf === undefined ? "" : `(as of ${copy.asOf}) `}${line(lane, copy.path, state)}`;
				} catch (error) {
					return `${lane.name}: unreadable (${error instanceof Error ? error.message : String(error)}), ${state}`;
				}
			})();
		}
		try {
			return line(lane, file, laneOpenHere(lane) ? "open" : "closed");
		} catch (error) {
			return `${lane.name}: unreadable (${error instanceof Error ? error.message : String(error)})`;
		}
	});
	return lines.some((line) => line instanceof Promise) ? Promise.all(lines).then((all) => all.join("\n")) : lines.join("\n");
}

/** `reader()` is the lane asking; it throws when there is none (pi without memory). */
export function readerTools(reader: () => LaneConfig, config: HarnessConfig): LaneTool[] {
	const readable = (name: string) => {
		const self = reader();
		const lane = findLane(config, name);
		if (!mayRead(self, lane)) throw new Error(`${self.name} may not read ${lane.name}`);
		return lane;
	};
	return [
		{
			name: "lanes",
			label: "lanes",
			description: "Every lane: memory or remote save counts, last message date when available, and where it is open now.",
			parameters: Type.Object({}),
			long: false,
			run: () => lanesText(config, reader()),
		},
		{
			name: "lane_memory",
			label: "lane memory",
			description:
				"Read another lane's memory, read-only. action: view (its whole memory view), zoom (id, n), date (id), search (query[, limit]).",
			parameters: Type.Object({
				lane: Type.String(),
				action: Type.Union([Type.Literal("view"), Type.Literal("zoom"), Type.Literal("date"), Type.Literal("search")]),
				id: Type.Optional(Type.Integer()),
				n: Type.Optional(Type.Integer()),
				query: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			}),
			long: true,
			run: (p) =>
				withLaneView(readable(p.lane as string), (view) => {
					const query = (p.query as string | undefined) ?? "";
					if (p.action === "view") return view.render();
					if (p.action === "zoom") return view.zoom(p.id, p.n);
					if (p.action === "date") return view.date(p.id);
					return formatHits(searchLog(view.store, query, { limit: p.limit as number | undefined }), query);
				}, config),
		},
	];
}
