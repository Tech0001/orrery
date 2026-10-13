/**
 * What a summary call adds to its request (Taelin §3.3; spec 2026-10-07-cache-view §2): a signal when the response
 * begins (one writer per prefix) and, for Anthropic, a cache mark on the compaction view's last whole 4-line block.
 */

import type { ChatTurn } from "../memory/index.ts";

/**
 * pi-ai marks the system prompt and the request's last block. This adds a mark on `block` of the first user message,
 * so the next summary call reads the view up to there from the cache. It copies pi-ai's own system mark (same
 * lifetime, 5 minutes by default) and adds none when pi-ai set none. The block is found by its index, checked by its
 * text. Returns undefined, which leaves the payload unchanged, when there is nothing to mark.
 */
export function markCachePrefix(payload: unknown, block: { readonly index: number; readonly text: string }): unknown {
	if (typeof payload !== "object" || payload === null) return undefined;
	const request = payload as { system?: unknown; messages?: unknown };
	const system = Array.isArray(request.system) ? (request.system as Array<{ cache_control?: unknown }>) : [];
	const marker = system.at(-1)?.cache_control;
	const first = Array.isArray(request.messages) ? (request.messages[0] as { role?: unknown; content?: unknown } | undefined) : undefined;
	if (marker === undefined || first?.role !== "user" || !Array.isArray(first.content)) return undefined;
	const blocks = first.content as Array<{ type?: unknown; text?: unknown; cache_control?: unknown }>;
	const at = blocks[block.index]?.text === block.text ? block.index : blocks.findIndex((b) => b.type === "text" && b.text === block.text);
	if (at < 0) return undefined;
	blocks[at].cache_control = marker;
	return payload;
}

/** The block to mark in a summary call's first turn: only for Anthropic's API, and only if the turn names one. */
export function prefixMark(turns: readonly ChatTurn[], api: string): { index: number; text: string } | undefined {
	const first = turns[0];
	if (api !== "anthropic-messages" || first?.role !== "user" || first.mark === undefined || first.mark < 0) return undefined;
	const text = first.blocks[first.mark];
	return text === undefined ? undefined : { index: first.mark, text };
}

/** `fn`, called at most once. */
export function once(fn: () => void): () => void {
	let called = false;
	return () => {
		if (called) return;
		called = true;
		fn();
	};
}

/** The stream options a summary call adds: the response-start signal, and the prefix mark for Anthropic. */
export function summaryCallHooks(
	api: string,
	turns: readonly ChatTurn[],
	onStart: (() => void) | undefined,
): { onProviderStreamEvent?: () => void; onPayload?: (payload: unknown) => unknown } {
	const mark = prefixMark(turns, api);
	return {
		...(onStart === undefined ? {} : { onProviderStreamEvent: once(onStart) }),
		...(mark === undefined ? {} : { onPayload: (payload: unknown) => markCachePrefix(payload, mark) }),
	};
}
