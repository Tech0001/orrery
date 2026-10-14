/**
 * An OMP-shaped host for Orrery's extension, as OMP 18.8.7's API was read and probed (research omp-eval.md §5):
 * handlers by event name; the system prompt as a list of blocks; session_start with no reason; session_switch and
 * session_branch in place of a new session_start; no reason on session_before_compact; ctx.agent; `arktype` and `zod`
 * on the API (how Orrery tells OMP from pi). test/omp/real-omp.test.ts runs the real binary.
 */

import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { HarnessConfig } from "../../src/lane/config.ts";
import { createOrrery, type OrreryOptions } from "../../src/pi/index.ts";
import type { Notice } from "../pi/harness.ts";
import { scratchHome, summarySourcesFor } from "../pi/world.ts";

export interface Entry {
	readonly id: string;
	readonly type: string;
	readonly message?: unknown;
}

export interface OmpTool {
	readonly name: string;
	readonly loadMode?: string;
	execute(id: string, params: unknown): Promise<{ content: { type: string; text?: string }[] }>;
}

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

export interface FakeOmp {
	readonly notices: Notice[];
	readonly tools: Map<string, OmpTool>;
	readonly commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
	/** The events something listens to. */
	events(): string[];
	status(key: string): string | undefined;
	/** The current session (one branch). A test replaces it to act out /new, /resume, /fork or a rewind. */
	session: { id: string; parentSession?: string; entries: Entry[] };
	/** The session's folder, which ctx.cwd reads live as OMP's does. A test changes it to act out OMP's /resume of another folder's session, or /move. */
	cwd: string;
	/** Runs every handler for `event`, in the order they were added, and returns their results. */
	emit(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
	/** Runs a registered command, as typing `/<name> <args>` does. */
	run(name: string, args?: string): Promise<void>;
	/** Appends a user message, or a finished reply, to the current session. */
	say(role: "user" | "assistant", text: string): void;
}

let nextId = 0;

/** A fake OMP running `factories` in `cwd`, as its main session or as a subagent; `omp: false` gives pi's API shape. */
export function fakeOmp(cwd: string, factories: readonly ExtensionFactory[], options: { agent?: "main" | "sub"; omp?: boolean } = {}): FakeOmp {
	const handlers = new Map<string, Handler[]>();
	const statuses = new Map<string, string>();
	const agent = options.agent ?? "main";
	const host: FakeOmp = {
		notices: [],
		tools: new Map(),
		commands: new Map(),
		events: () => [...handlers.keys()],
		status: (key) => statuses.get(key),
		session: { id: "s1", entries: [] },
		cwd,
		emit: async (event, payload = {}) => {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx));
			return results;
		},
		run: async (name, args = "") => {
			const command = host.commands.get(name);
			if (command === undefined) throw new Error(`no command /${name}`);
			await command(args, ctx);
		},
		say: (role, text) => {
			const timestamp = Date.now();
			const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
			const message =
				role === "user"
					? { role, content: text, timestamp }
					: { role, content: [{ type: "text", text }], provider: "local", model: "m", usage, stopReason: "stop", timestamp };
			host.session.entries.push({ id: `e${++nextId}`, type: "message", message });
		},
	};
	const ctx = {
		get cwd() {
			return host.cwd;
		},
		hasUI: true,
		agent: { kind: agent, id: agent === "main" ? "Main" : "0-Task", name: agent === "main" ? "main" : "task", depth: agent === "main" ? 0 : 1 },
		isIdle: () => true,
		ui: {
			notify: (message: string, type?: Notice["type"]) => host.notices.push(type === undefined ? { message } : { message, type }),
			setStatus: (key: string, text: string | undefined) => (text === undefined ? statuses.delete(key) : statuses.set(key, text)),
			select: async () => undefined,
			input: async () => undefined,
		},
		sessionManager: {
			getSessionId: () => host.session.id,
			getHeader: () => ({ type: "session", id: host.session.id, ...(host.session.parentSession === undefined ? {} : { parentSession: host.session.parentSession }) }),
			getBranch: (fromId?: string) => {
				const entries = host.session.entries;
				if (fromId === undefined) return entries;
				const at = entries.findIndex((entry) => entry.id === fromId);
				return at === -1 ? [] : entries.slice(0, at + 1);
			},
		},
	};
	const api = {
		...(options.omp === false ? {} : { arktype: {}, zod: {} }),
		/** A method of the API, as in OMP: Orrery must call it through the API object, never detached. */
		on(this: unknown, event: string, handler: Handler) {
			if (this !== api) throw new Error(`on("${event}") was called detached from the extension API`);
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (tool: OmpTool) => host.tools.set(tool.name, tool),
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => host.commands.set(name, command.handler),
	};
	for (const factory of factories) factory(api as unknown as ExtensionAPI);
	return host;
}

const hosts: FakeOmp[] = [];

/** Ends `host`'s session at cleanup (ompCleanup), releasing its lane lock. */
export function track(host: FakeOmp): FakeOmp {
	hosts.push(host);
	return host;
}

/**
 * Orrery's OMP entry (createOrrery({ host: "omp" })) in a fake OMP, started; summaries use the world's faux. `session`:
 * the id of the session it starts in (default "s1").
 */
export async function ompOrrery(cwd: string, config: HarnessConfig, options: Omit<OrreryOptions, "config" | "host"> & { agent?: "main" | "sub"; session?: string } = {}): Promise<FakeOmp> {
	const { agent, session, ...rest } = options;
	const host = track(fakeOmp(cwd, [createOrrery({ summarySources: async (cfg) => summarySourcesFor(cfg), ...scratchHome(dirname(config.dataDir)), ...rest, config, host: "omp" })], { agent }));
	if (session !== undefined) host.session.id = session;
	await host.emit("session_start");
	return host;
}

/** Ends every tracked session; call it before test/pi/world.ts's cleanup removes the folders. */
export async function ompCleanup(): Promise<void> {
	for (const host of hosts.splice(0)) await host.emit("session_shutdown");
}
