/**
 * What memory keeps of an OpenCode turn (spec 2026-10-16-opencode-design, "Recording"): the user's words come from the
 * prompt hook; when the run ends (session.execution.succeeded) its final reply is read from the session's context
 * (ctx.session.context: user, assistant, idle, compaction… messages, OpenCode 2.0.30). A run's last message before its
 * idle is its final assistant message, one per model step; a compaction run ends without one, and records nothing.
 * Tool calls and their results are not kept, as in pi; each step's token use is (memory's usage rows).
 */

import { localIso, type UsageRow } from "../memory/index.ts";

/** A run's final reply: the assistant message's id (recorded once), its text, when, and its steps' token use. */
export interface FinalReply {
	readonly id: string;
	readonly text: string;
	readonly date: string;
	readonly usage: readonly UsageRow[];
}

interface Assistant {
	readonly id?: unknown;
	readonly type?: unknown;
	readonly time?: { readonly created?: unknown; readonly completed?: unknown };
	readonly model?: { readonly id?: unknown; readonly providerID?: unknown };
	readonly content?: unknown;
	readonly finish?: unknown;
	readonly tokens?: { readonly input?: unknown; readonly output?: unknown; readonly reasoning?: unknown; readonly cache?: { readonly read?: unknown; readonly write?: unknown } };
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/** When an assistant message was completed (or made), as memory dates it. */
function dateOf(message: Assistant): string {
	const at = typeof message.time?.completed === "number" ? message.time.completed : typeof message.time?.created === "number" ? message.time.created : Date.now();
	return localIso(new Date(at));
}

/** A step's token use as a usage row, if it says. OpenCode counts reasoning apart from output: both are output here. */
function usageOf(message: Assistant): UsageRow | undefined {
	const { tokens, model } = message;
	if (tokens === undefined || typeof model?.providerID !== "string" || typeof model.id !== "string") return undefined;
	return {
		at: dateOf(message),
		role: "agent",
		model: `${model.providerID}/${model.id}`,
		input: count(tokens.input),
		cacheRead: count(tokens.cache?.read),
		cacheWrite: count(tokens.cache?.write),
		output: count(tokens.output) + count(tokens.reasoning),
		ok: message.finish !== "error",
	};
}

/**
 * The final reply of the run `messages` (ctx.session.context's answer) ended with, or undefined: the run's last message
 * (idle ones aside) is not an assistant message (a compaction), or it ended in an error. Its text is the message's text
 * parts (not its reasoning or tool calls); its usage, every step since the last user message.
 */
export function finalReply(messages: unknown): FinalReply | undefined {
	if (!Array.isArray(messages)) return undefined;
	const list = messages as Assistant[];
	let end = list.length - 1;
	while (end >= 0 && list[end]?.type === "idle") end--;
	const last = list[end];
	if (last?.type !== "assistant" || typeof last.id !== "string" || last.finish === "error") return undefined;
	const text = (Array.isArray(last.content) ? (last.content as { type?: unknown; text?: unknown }[]) : [])
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n\n");
	const start = list.findLastIndex((message, i) => i < end && message?.type === "user") + 1;
	const usage = list.slice(start, end + 1).filter((message) => message?.type === "assistant").map(usageOf).filter((row): row is UsageRow => row !== undefined);
	return { id: last.id, text, date: dateOf(last), usage };
}
