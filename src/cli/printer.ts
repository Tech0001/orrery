/** Plain streaming output for an agent: text and tool activity as normal lines (tmux scrollback keeps everything). */

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord, UsageState } from "@earendil-works/pi-durable";

const TOOL_OUTPUT_LIMIT = 2_000;

// Model and tool text is untrusted: a file an agent cats could carry escape sequences that write the clipboard
// (OSC 52), retitle or clear the screen. Strip ESC/CSI/OSC/DCS sequences, C1 controls and C0 controls except
// newline and tab before anything reaches the terminal.
const ESCAPE_SEQUENCES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\-_])/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function clean(text: string): string {
	return text.replace(ESCAPE_SEQUENCES, "").replace(CONTROLS, "");
}

export interface PrinterState {
	agent: string;
	model: string;
	busy: boolean;
	streaming: boolean;
	/** Text of the current assistant message already printed from deltas. */
	streamed: string;
	cost: number;
	toolOutput: Map<string, number>;
}

export function createPrinterState(agent: string, model: string): PrinterState {
	return { agent, model, busy: false, streaming: false, streamed: "", cost: 0, toolOutput: new Map() };
}

function oneLine(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function argSummary(args: Readonly<Record<string, unknown>>): string {
	if (typeof args.command === "string") return oneLine(args.command);
	if (typeof args.path === "string") return args.path;
	return oneLine(JSON.stringify(args));
}

function resultText(result: ToolResultMessage): string {
	return result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n")
		.replace(/<harness>[\s\S]*?<\/harness>/g, "");
}

function totalCost(usage: UsageState): number {
	let total = 0;
	for (const value of [...Object.values(usage.models), ...Object.values(usage.tools)]) total += value.cost.total;
	return total;
}

export function title(state: PrinterState): string {
	return clean(`${state.agent} · ${state.busy ? "busy" : "idle"} · ${state.model} · $${state.cost.toFixed(2)}`);
}

/** One finished entry, for the backlog shown on attach. */
export function renderEntry(entry: EntryRecord): string {
	const message = entry.model?.[0];
	if (message === undefined) return "";
	if (entry.kind === "pi.user" && message.role === "user") {
		const text = typeof message.content === "string" ? message.content : message.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("");
		return `› ${clean(text)}\n`;
	}
	if (entry.kind === "pi.assistant" && message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
		let out = "";
		for (const block of message.content) {
			if (block.type === "text" && block.text.trim()) out += `${block.text}\n`;
			else if (block.type === "toolCall") out += `→ ${block.name} ${argSummary(block.arguments)}\n`;
		}
		return clean(out);
	}
	if (entry.kind === "pi.tool-result" && message.role === "toolResult") return clean(`${message.isError ? "✗" : "✓"} ${message.toolName}`) + "\n";
	return "";
}

export function renderEvents(events: readonly AgentEvent[], state: PrinterState): { text: string; title?: string } {
	let text = "";
	let titleChanged = false;
	const endStream = () => {
		if (state.streaming) {
			text += "\n";
			state.streaming = false;
		}
	};
	for (const event of events) {
		switch (event.type) {
			case "snapshot":
				endStream();
				state.busy = event.run !== undefined;
				state.cost = totalCost(event.usage);
				if (event.agent.model) state.model = `${event.agent.model.provider}/${event.agent.model.modelId}`;
				for (const entry of event.entries) text += renderEntry(entry);
				titleChanged = true;
				break;
			case "run_start":
				state.busy = true;
				titleChanged = true;
				break;
			case "run_end":
				endStream();
				state.busy = false;
				titleChanged = true;
				break;
			case "message_start": {
				// pi's first partial commit already carries text; print it here or it is never streamed.
				const message = event.message;
				if (message.role !== "assistant") break;
				const initial = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
				state.streamed = initial;
				if (initial) {
					text += initial;
					state.streaming = true;
				}
				break;
			}
			case "message_update":
				for (const change of event.changes) {
					if (change.type === "text_delta") {
						text += change.delta;
						state.streamed += change.delta;
						state.streaming = true;
					}
				}
				break;
			case "message_end": {
				// Partials are committed at most every ~100 ms, so the tail (or all) of a reply can arrive only here.
				const message = event.entry.model?.[0];
				if (event.entry.kind === "pi.assistant" && message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
					const full = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
					const rest = full.startsWith(state.streamed) ? full.slice(state.streamed.length) : `${state.streamed ? "\n" : ""}${full}`;
					if (rest) {
						text += rest;
						state.streaming = true;
					}
				}
				state.streamed = "";
				endStream();
				break;
			}
			case "tool_execution_start":
				endStream();
				text += `→ ${event.toolName} ${argSummary(event.args)}\n`;
				state.toolOutput.set(event.toolCallId, 0);
				break;
			case "tool_execution_update": {
				const output = event.output;
				if (output === undefined || !("append" in output) || !output.append) break;
				const shown = state.toolOutput.get(event.toolCallId) ?? 0;
				if (shown < TOOL_OUTPUT_LIMIT) {
					text += output.append.slice(0, TOOL_OUTPUT_LIMIT - shown);
					if (shown + output.append.length >= TOOL_OUTPUT_LIMIT) text += "\n… (more output in the tool result)\n";
				}
				state.toolOutput.set(event.toolCallId, shown + output.append.length);
				break;
			}
			case "tool_execution_end": {
				if (!text.endsWith("\n") && text.length > 0) text += "\n";
				state.toolOutput.delete(event.toolCallId);
				const result = event.entry?.model?.[0];
				if (result === undefined || result.role !== "toolResult") text += `✗ ${event.toolName} (no result)\n`;
				else text += result.isError ? `✗ ${event.toolName}: ${oneLine(resultText(result), 160)}\n` : `✓ ${event.toolName}\n`;
				break;
			}
			case "inbox_update":
				if (event.items.length > 0) text += `[${event.items.length} queued]\n`;
				break;
			case "submission":
				if (event.record.status === "unanswered") {
					endStream();
					const record = event.record as { reason?: string; detail?: string };
					text += `! not answered: ${record.reason ?? "unknown"}${record.detail ? ` (${oneLine(record.detail)})` : ""}\n`;
				}
				break;
			case "auto_retry_start":
				endStream();
				text += `! retrying (attempt ${event.attempt}): ${oneLine(event.errorMessage)}\n`;
				break;
			case "compaction_start":
				endStream();
				text += "[compacting the current run…]\n";
				break;
			case "compaction_end":
				text += "[compacted]\n";
				break;
			case "task_failed":
				endStream();
				text += `! ${event.kind} failed: ${oneLine(event.message)}\n`;
				break;
			case "agent_changed":
				if (event.agent.model) state.model = `${event.agent.model.provider}/${event.agent.model.modelId}`;
				titleChanged = true;
				break;
			case "usage_changed":
				state.cost = totalCost(event.usage);
				titleChanged = true;
				break;
			default:
				break;
		}
	}
	text = clean(text);
	return titleChanged ? { text, title: title(state) } : { text };
}
