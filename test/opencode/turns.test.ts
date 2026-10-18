import { describe, expect, it } from "vitest";
import { finalReply } from "../../src/opencode/turns.ts";

const user = (id: string, text: string) => ({ id, type: "user", text, time: { created: 1 } });
const idle = { id: "msg_idle", type: "idle", outcome: "succeeded" };
const assistant = (id: string, content: unknown[], finish = "stop", extra: object = {}) => ({
	id,
	type: "assistant",
	model: { id: "m", providerID: "p" },
	time: { created: Date.UTC(2026, 9, 17, 12), completed: Date.UTC(2026, 9, 17, 12, 0, 5) },
	content,
	finish,
	tokens: { input: 10, output: 3, reasoning: 2, cache: { read: 4, write: 1 } },
	...extra,
});

describe("finalReply: what memory keeps of an OpenCode run", () => {
	it("is the run's last assistant message's text (not its reasoning or tools), with every step's token use since the user's message", () => {
		const reply = finalReply([
			user("u0", "before"),
			assistant("a0", [{ type: "text", text: "an older reply" }]),
			idle,
			user("u1", "now"),
			assistant("a1", [{ type: "text", text: "Looking." }, { type: "tool", name: "read" }], "tool-calls"),
			assistant("a2", [{ type: "reasoning", text: "hm" }, { type: "text", text: "Found it." }, { type: "text", text: "Done." }]),
			idle,
		]);
		expect(reply).toMatchObject({ id: "a2", text: "Found it.\n\nDone." });
		expect(reply?.usage.map((row) => [row.model, row.input, row.cacheRead, row.cacheWrite, row.output, row.ok])).toEqual([
			["p/m", 10, 4, 1, 5, true],
			["p/m", 10, 4, 1, 5, true],
		]);
		expect(reply?.date).toMatch(/^2026-10-17T\d\d:00:05/);
	});

	it("is none for a compaction's run, a run that failed, or anything that is not a list of messages", () => {
		expect(finalReply([user("u1", "x"), assistant("a1", [{ type: "text", text: "y" }]), idle, { id: "c", type: "compaction" }, idle])).toBeUndefined();
		expect(finalReply([user("u1", "x"), assistant("a1", [{ type: "text", text: "partial" }], "error")])).toBeUndefined();
		expect(finalReply([])).toBeUndefined();
		expect(finalReply({ data: [] })).toBeUndefined();
		expect(finalReply(undefined)).toBeUndefined();
		expect(finalReply([user("u1", "x"), { type: "assistant", content: [] }])).toBeUndefined();
	});

	it("keeps a reply with no text (only tool calls) as its id and usage, with empty text", () => {
		const reply = finalReply([user("u1", "x"), assistant("a1", [{ type: "tool", name: "read" }], "stop", { tokens: undefined })]);
		expect(reply).toMatchObject({ id: "a1", text: "", usage: [] });
	});
});
