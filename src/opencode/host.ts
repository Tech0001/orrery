/**
 * The part of OpenCode 2.0.30's server plugin context (@opencode/plugin's Promise API, packages/plugin/src/promise) that
 * Orrery's plugin uses, typed as far as Orrery reads it. OpenCode supplies the real one; tests give a stand-in. What
 * OpenCode hands over is checked before use.
 */

import type { PermissionEvent, ToolCallEvent } from "./guard.ts";

/** A system prompt part, as the context hook takes them. */
export interface SystemPart {
	readonly type: "text";
	readonly text: string;
}

/** The prompt hook: a user prompt at its admission, once (not for synthetic, shell or compaction messages). */
export interface PromptEvent {
	readonly sessionID: string;
	readonly messageID: string;
	readonly prompt: { readonly text?: unknown };
}

/** The context hook: before every model request of the agent loop, tool continuations and subagents included. */
export interface ContextEvent {
	readonly sessionID: string;
	system: SystemPart[];
}

/** The compaction hook: setting `result` records that compaction and skips its model request. */
export interface CompactionEvent {
	readonly sessionID: string;
	result?: { summary: string };
}

/** The title hook: setting `result` names the session and skips its model request. */
export interface TitleEvent {
	readonly sessionID: string;
	result?: string;
}

/**
 * The generate hook: before a session.generate request (a summary's, src/opencode/summaries.ts), with its system parts,
 * messages, tool definitions and request options, which a hook may replace. The model is the session's.
 */
export interface GenerateEvent {
	readonly sessionID: string;
	system: unknown[];
	messages: unknown[];
	tools: Record<string, unknown>;
	options: Record<string, unknown>;
}

export interface SessionHooks {
	readonly prompt: PromptEvent;
	readonly context: ContextEvent;
	readonly compaction: CompactionEvent;
	readonly title: TitleEvent;
	readonly generate: GenerateEvent;
}

/** A plugin tool, as ctx.tool.transform's editor adds it. */
export interface PluginTool {
	readonly name: string;
	readonly description: string;
	/** A JSON Schema object. */
	readonly input: object;
	/** codemode false: the model sees the tool itself, not behind Code Mode's execute. */
	readonly options: { readonly codemode: false };
	execute(input: Record<string, unknown>, context: { readonly sessionID?: string }): Promise<{ content: string }>;
}

export interface ToolEditor {
	add(tool: PluginTool): void;
}

export interface OpenCodeContext {
	readonly options?: unknown;
	/** The folder this plugin instance serves (OpenCode makes one per folder). */
	readonly location?: { readonly directory?: unknown };
	readonly session: {
		hook<K extends keyof SessionHooks>(name: K, callback: (event: SessionHooks[K]) => Promise<void> | void): Promise<unknown>;
		/** A session's info: its parentID (subagents) among it. */
		get(input: { sessionID: string }): Promise<unknown>;
		/** A session's messages as the model's context has them. */
		context(input: { sessionID: string }): Promise<unknown>;
		/** Makes a session (`{location, title, model, metadata}`): its info, `{id, …}`. */
		create(input: object): Promise<unknown>;
		/** One request from a session's context, through its generate hook, its model the session's: `{text}`. */
		generate(input: { sessionID: string; prompt: string }, options?: { signal?: AbortSignal }): Promise<unknown>;
		remove(input: { sessionID: string }): Promise<unknown>;
	};
	/** The models OpenCode's providers have: `{data: [{providerID, id, name, cost, variants, enabled, limit}]}`. */
	readonly model: { list(input?: object): Promise<unknown> };
	/** The plugin's RPC, which its TUI entry calls (the summary-model picker: src/opencode/summary-menu.ts). */
	readonly rpc?: { register(definition: object, handlers: Record<string, (input: unknown) => Promise<unknown>>): Promise<unknown> };
	/** The server's event stream: every session's, of every folder. */
	readonly event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown> };
	readonly tool: {
		transform(callback: (editor: ToolEditor) => void): Promise<unknown>;
		/**
		 * execute.before: before every tool call (built-in, plugin, MCP, Code Mode's execute and each tool a Code Mode
		 * program calls), `{tool, sessionID, agent, messageID, id, input}`. A throw refuses the call; the model gets its
		 * message.
		 */
		hook(name: "execute.before", callback: (event: ToolCallEvent) => Promise<void> | void): Promise<unknown>;
	};
	/**
	 * OpenCode's permission checks: evaluate runs as a tool asks leave (`{action, resources, effect, message…}`); setting
	 * effect "deny" with a message refuses it.
	 */
	readonly permission?: { hook(name: "evaluate", callback: (event: PermissionEvent) => Promise<void> | void): Promise<unknown> };
}

/** What OpenCode loads from a plugin's server entry. Cleanup runs when OpenCode stops, and before a reload's setup. */
export interface OpenCodePlugin {
	readonly id: string;
	setup(ctx: OpenCodeContext): Promise<() => Promise<void>>;
}
