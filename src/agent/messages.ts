/** Turns one pi-ai message into memory messages and usage rows (spec §5.2). No pi-durable here. */

import type { Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { capText, localIso, type NewMessage, type UsageRow } from "../memory/index.ts";

export function contentText(content: UserMessage["content"] | ToolResultMessage["content"]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

export function messageItems(message: Message, toolCap: number): { messages: NewMessage[]; usage: UsageRow[] } {
	const messages: NewMessage[] = [];
	const usage: UsageRow[] = [];
	const date = localIso(new Date(message.timestamp));
	if (message.role === "user") {
		messages.push({ kind: "user", text: contentText(message.content), date });
	} else if (message.role === "assistant") {
		const ok = message.stopReason !== "error" && message.stopReason !== "aborted";
		usage.push({
			at: date,
			role: "agent",
			model: `${message.provider}/${message.model}`,
			input: message.usage.input,
			cacheRead: message.usage.cacheRead,
			cacheWrite: message.usage.cacheWrite,
			output: message.usage.output,
			ok,
		});
		if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse") {
			let talk = "";
			const flush = () => {
				if (talk.trim()) messages.push({ kind: "talk", text: talk, date });
				talk = "";
			};
			for (const block of message.content) {
				if (block.type === "text") talk += block.text;
				else if (block.type === "toolCall") {
					flush();
					messages.push({ kind: "tool", text: `${block.name} ${JSON.stringify(block.arguments)}`, date });
				}
			}
			flush();
		}
	} else if (message.role === "toolResult") {
		messages.push({ kind: "echo", text: capText(contentText(message.content), toolCap), date });
	}
	return { messages, usage };
}
