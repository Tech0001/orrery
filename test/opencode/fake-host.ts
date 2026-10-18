/**
 * A stand-in for OpenCode 2.0.30's server plugin context (src/opencode/host.ts), as far as Orrery's plugin uses it: its
 * hooks run when a test says (a prompt, a model request, a compaction, a title), its sessions answer get and context
 * from what the test put there, its event stream yields what the test emits, and the tools the plugin adds are kept. Its
 * tool calls and permission checks go through the plugin's guard hooks (call, ask).
 */

import type { PermissionEvent, ToolCallEvent } from "../../src/opencode/guard.ts";
import type { CompactionEvent, ContextEvent, GenerateEvent, OpenCodeContext, PluginTool, PromptEvent, SessionHooks, TitleEvent } from "../../src/opencode/host.ts";

type Hook = (event: never) => Promise<void> | void;

interface FakeSession {
	readonly parentID?: string;
	/** What ctx.session.context answers: the session's messages. */
	messages: unknown[];
}

/** OpenCode's base system parts, before any plugin's. */
export const BASE = { type: "text" as const, text: "You are OpenCode." };

let ids = 0;
const nextId = (prefix: string) => `${prefix}_${String(++ids).padStart(6, "0")}`;

export class FakeHost implements OpenCodeContext {
	readonly options: unknown;
	readonly location: { readonly directory: string };
	readonly hooks = new Map<keyof SessionHooks, Hook[]>();
	readonly sessions = new Map<string, FakeSession>();
	readonly tools: PluginTool[] = [];
	/** Makes ctx.session.get or ctx.session.context throw, as a broken OpenCode might. */
	failing: { get?: boolean; context?: boolean } = {};
	/** What ctx.model.list answers (OpenCode's model list). */
	modelList: unknown = { data: [] };
	/** Sessions made through ctx.session.create (their input), and those removed. */
	readonly made: { id: string; input: Record<string, unknown> }[] = [];
	readonly removed: string[] = [];
	/** Each session.generate request as the generate hooks left it, with its session's model. */
	readonly generated: { sessionID: string; model: unknown; system: unknown[]; messages: unknown[]; tools: Record<string, unknown>; options: Record<string, unknown> }[] = [];
	/** What a session.generate request answers (default: a short line). */
	answer: (request: FakeHost["generated"][number]) => string | Promise<string> = () => "a summary line";
	#queue: unknown[] = [];
	#wake: (() => void) | undefined;
	#subscribed = 0;

	constructor(options: unknown, directory: string) {
		this.options = options;
		this.location = { directory };
	}

	readonly session = {
		hook: async <K extends keyof SessionHooks>(name: K, callback: (event: SessionHooks[K]) => Promise<void> | void) => {
			this.hooks.set(name, [...(this.hooks.get(name) ?? []), callback as Hook]);
			return { dispose: async () => {} };
		},
		get: async ({ sessionID }: { sessionID: string }) => {
			if (this.failing.get) throw new Error("session service unavailable");
			const session = this.sessions.get(sessionID);
			return { id: sessionID, ...(session?.parentID === undefined ? {} : { parentID: session.parentID }) };
		},
		context: async ({ sessionID }: { sessionID: string }) => {
			if (this.failing.context) throw new Error("context unavailable");
			return this.sessions.get(sessionID)?.messages ?? [];
		},
		create: async (input: object) => {
			const id = nextId("ses");
			this.made.push({ id, input: input as Record<string, unknown> });
			this.sessions.set(id, { messages: [] });
			this.emit({ type: "session.created", data: { sessionID: id, ...("metadata" in input ? { metadata: (input as { metadata: unknown }).metadata } : {}) } });
			return { id, ...input };
		},
		generate: async ({ sessionID, prompt }: { sessionID: string; prompt: string }) => {
			const model = this.made.find((made) => made.id === sessionID)?.input.model;
			// OpenCode's own request first (its base prompt, the session's turns, the prompt, its tools), then the hooks.
			const event: GenerateEvent = { sessionID, system: [BASE, { type: "text", text: "# Your Model" }], messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], tools: { shell: { description: "x", input: {} } }, options: { textVerbosity: "low" } };
			await this.#run("generate", event);
			const request = { sessionID, model, system: event.system, messages: event.messages, tools: event.tools, options: event.options };
			this.generated.push(request);
			return { text: await this.answer(request) };
		},
		remove: async ({ sessionID }: { sessionID: string }) => {
			this.removed.push(sessionID);
			this.sessions.delete(sessionID);
		},
	};

	readonly model = { list: async () => this.modelList };

	/** The plugin's RPC handlers, by method (the TUI entry calls them). */
	rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> = {};
	readonly rpc = {
		register: async (definition: object, handlers: Record<string, (input: unknown) => Promise<unknown>>) => {
			if ((definition as { id?: unknown }).id !== "orrery.summaries") throw new Error("an RPC of another id");
			this.rpcHandlers = handlers;
			return { dispose: async () => {}, events: { emit: async () => {} } };
		},
	};

	/** A call of the plugin's RPC, as OpenCode's TUI makes one. */
	async callRpc(method: string, input: unknown = {}): Promise<unknown> {
		const handler = this.rpcHandlers[method];
		if (handler === undefined) throw new Error(`no RPC method ${method}`);
		return handler(input);
	}

	readonly event = {
		subscribe: (options?: { signal?: AbortSignal }): AsyncIterable<unknown> => {
			const host = this;
			host.#subscribed++;
			return {
				async *[Symbol.asyncIterator]() {
					while (options?.signal?.aborted !== true) {
						if (host.#queue.length > 0) {
							yield host.#queue.shift();
							continue;
						}
						await new Promise<void>((wake) => {
							host.#wake = wake;
							options?.signal?.addEventListener("abort", () => wake(), { once: true });
						});
					}
				},
			};
		},
	};

	/** The plugin's execute.before hooks (its guard), in the order registered. */
	readonly toolHooks: ((event: ToolCallEvent) => Promise<void> | void)[] = [];
	/** Its permission evaluate hooks (the guard's second layer). */
	readonly permissionHooks: ((event: PermissionEvent) => Promise<void> | void)[] = [];
	/** Makes ctx.tool.hook throw, as an OpenCode without it would. */
	missing: { toolHook?: boolean } = {};

	readonly tool = {
		transform: async (callback: (editor: { add(tool: PluginTool): void }) => void) => {
			callback({ add: (tool) => this.tools.push(tool) });
			return { dispose: async () => {} };
		},
		hook: async (name: "execute.before", callback: (event: ToolCallEvent) => Promise<void> | void) => {
			if (this.missing.toolHook || name !== "execute.before") throw new Error(`no tool hook ${name}`);
			this.toolHooks.push(callback);
			return { dispose: async () => {} };
		},
	};

	/** OpenCode's permission hooks; a test may take them away (undefined), as an OpenCode without them would. */
	permission: OpenCodeContext["permission"] = {
		hook: async (name: "evaluate", callback: (event: PermissionEvent) => Promise<void> | void) => {
			if (name !== "evaluate") throw new Error(`no permission hook ${name}`);
			this.permissionHooks.push(callback);
			return { dispose: async () => {} };
		},
	};

	/** Whether the plugin registered its memory's hooks or tools (the guard's hooks are apart: guarded). */
	get registered(): boolean {
		return this.hooks.size > 0 || this.tools.length > 0;
	}

	/** Whether the guard's hook is there. */
	get guarded(): boolean {
		return this.toolHooks.length > 0;
	}

	/** A tool call as OpenCode makes one: what a hook threw (the model sees its message), or undefined when it runs. */
	async call(tool: string, input: unknown, sessionID = "ses_call"): Promise<string | undefined> {
		for (const hook of this.toolHooks) {
			try {
				await hook({ tool, sessionID, input, agent: "build", messageID: "msg_call", id: "call_1" } as ToolCallEvent);
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		}
		return undefined;
	}

	/** A tool asking leave for `resources`: the effect and message after the hooks (OpenCode's own rules said `effect`). */
	async ask(action: string, resources: string[], effect = "allow"): Promise<{ effect: unknown; message?: unknown }> {
		const event: PermissionEvent = { action, resources, effect };
		for (const hook of this.permissionHooks) await hook(event);
		return { effect: event.effect, ...(event.message === undefined ? {} : { message: event.message }) };
	}

	/** How many event streams the plugin opened. */
	get subscribed(): number {
		return this.#subscribed;
	}

	emit(event: unknown): void {
		this.#queue.push(event);
		this.#wake?.();
	}

	/** A main session, or a subagent's (with `parentID`). */
	open(sessionID: string, parentID?: string): void {
		this.sessions.set(sessionID, { ...(parentID === undefined ? {} : { parentID }), messages: [] });
		this.emit({ type: "session.created", data: { sessionID, ...(parentID === undefined ? {} : { parentID }) } });
	}

	async #run<K extends keyof SessionHooks>(name: K, event: SessionHooks[K]): Promise<SessionHooks[K]> {
		for (const hook of this.hooks.get(name) ?? []) await (hook as (event: SessionHooks[K]) => Promise<void> | void)(event);
		return event;
	}

	/** The person's prompt, admitted: the prompt hook runs, and the session's context gets the user message. */
	async prompt(sessionID: string, text: string, messageID = nextId("msg")): Promise<void> {
		const event: PromptEvent = { sessionID, messageID, prompt: { text } };
		await this.#run("prompt", event);
		this.sessions.get(sessionID)?.messages.push({ id: messageID, type: "user", time: { created: Date.now() }, text });
	}

	/** One model request of the agent loop: the system parts it would carry, after the context hooks. */
	async request(sessionID: string): Promise<string[]> {
		const event: ContextEvent = { sessionID, system: [BASE] };
		await this.#run("context", event);
		return event.system.map((part) => part.text);
	}

	async compaction(sessionID: string): Promise<CompactionEvent["result"]> {
		return (await this.#run("compaction", { sessionID } as CompactionEvent)).result;
	}

	async title(sessionID: string): Promise<string | undefined> {
		return (await this.#run("title", { sessionID } as TitleEvent)).result;
	}

	/** The model's final reply to the session's run: an assistant message, the idle, and the run's success. */
	reply(sessionID: string, text: string, options: { readonly id?: string; readonly steps?: number } = {}): string {
		const session = this.sessions.get(sessionID);
		const id = options.id ?? nextId("msg");
		const step = (messageID: string, content: unknown[], finish: string) => ({
			id: messageID,
			type: "assistant",
			agent: "build",
			model: { id: "fake-model", providerID: "fake" },
			time: { created: Date.now(), completed: Date.now() },
			content,
			finish,
			tokens: { input: 900, output: 20, reasoning: 5, cache: { read: 100, write: 0 } },
		});
		for (let i = 1; i < (options.steps ?? 1); i++) session?.messages.push(step(nextId("msg"), [{ type: "text", text: "Looking." }, { type: "tool", name: "read" }], "tool-calls"));
		session?.messages.push(step(id, [{ type: "reasoning", text: "thinking it over" }, { type: "text", text }], "stop"), { id: nextId("msg"), type: "idle", outcome: "succeeded", time: { created: Date.now() } });
		this.emit({ type: "session.execution.succeeded", data: { sessionID } });
		return id;
	}
}
