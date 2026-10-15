/** Memory ChatTurns as pi-ai messages, for one-shot compactor completions. */

import type { Message } from "@earendil-works/pi-ai";
import type { ChatTurn } from "../memory/index.ts";

export function chatTurnsToMessages(turns: readonly ChatTurn[], model: { api: string; provider: string; id: string }): Message[] {
	return turns.map((turn) =>
		turn.role === "user"
			? { role: "user", content: turn.blocks.map((text) => ({ type: "text", text })), timestamp: Date.now() }
			: {
					role: "assistant",
					content: [{ type: "text", text: turn.text }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
	);
}
