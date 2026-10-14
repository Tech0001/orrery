import { describe, expect, it } from "vitest";
import { markCachePrefix, once, prefixMark, summaryCallHooks } from "../../src/agent/cache-marks.ts";
import type { ChatTurn } from "../../src/memory/index.ts";

const MARK = { type: "ephemeral" };
const payload = () => ({
	system: [{ type: "text", text: "system", cache_control: MARK }],
	messages: [
		{
			role: "user",
			content: [
				{ type: "text", text: "<chat>\na\nb\nc\nd\n" },
				{ type: "text", text: "</chat>" },
				{ type: "text", text: "task", cache_control: MARK },
			],
		},
	],
});
const turns: ChatTurn[] = [{ role: "user", blocks: ["<chat>\na\nb\nc\nd\n", "</chat>", "task"], mark: 0 }];

describe("cache marks", () => {
	it("copies pi-ai's system mark onto the compaction view's last whole block", () => {
		const sent = payload();
		expect(markCachePrefix(sent, { index: 0, text: "<chat>\na\nb\nc\nd\n" })).toBe(sent);
		expect(sent.messages[0].content[0]).toEqual({ type: "text", text: "<chat>\na\nb\nc\nd\n", cache_control: MARK });
	});

	it("finds the block by its text if the index moved, and leaves the payload alone otherwise", () => {
		const sent = payload();
		expect(markCachePrefix(sent, { index: 2, text: "<chat>\na\nb\nc\nd\n" })).toBe(sent);
		expect(sent.messages[0].content[0]).toHaveProperty("cache_control");
		const unmarked = { ...payload(), system: [{ type: "text", text: "system" }] };
		expect(markCachePrefix(unmarked, { index: 0, text: "<chat>\na\nb\nc\nd\n" })).toBeUndefined();
		expect(unmarked.messages[0].content[0]).not.toHaveProperty("cache_control");
		expect(markCachePrefix(payload(), { index: 0, text: "absent" })).toBeUndefined();
		expect(markCachePrefix("not an object", { index: 0, text: "x" })).toBeUndefined();
	});

	it("marks only Anthropic requests that name a block, and signals a response start once", () => {
		expect(prefixMark(turns, "anthropic-messages")).toEqual({ index: 0, text: "<chat>\na\nb\nc\nd\n" });
		expect(prefixMark(turns, "openai-responses")).toBeUndefined();
		expect(prefixMark([{ role: "user", blocks: ["x"], mark: -1 }], "anthropic-messages")).toBeUndefined();
		expect(prefixMark([{ role: "user", blocks: ["x"] }], "anthropic-messages")).toBeUndefined();
		let starts = 0;
		const hooks = summaryCallHooks("openai-responses", turns, () => starts++);
		hooks.onProviderStreamEvent?.();
		hooks.onProviderStreamEvent?.();
		expect(starts).toBe(1);
		expect(hooks.onPayload).toBeUndefined();
		expect(summaryCallHooks("openai-responses", turns, undefined)).toEqual({});
		const fn = once(() => starts++);
		fn();
		fn();
		expect(starts).toBe(2);
	});
});
