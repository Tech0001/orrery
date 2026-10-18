import { describe, expect, it } from "vitest";
import { byteSize, cutBytes } from "../../src/memory/bytes.ts";
import type { SummaryTask } from "../../src/memory/compactor.ts";
import { COMPACT } from "../../src/memory/prompts.ts";
import {
	aboutWords,
	type ChatTurn,
	type CompactorModel,
	type CompactorReply,
	fill,
	fitSource,
	ModelSummarizer,
	ruler,
	sentNoRequest,
	sentNothing,
} from "../../src/memory/summarizer.ts";
import { Part, type TokenUsage } from "../../src/memory/types.ts";

const USAGE: TokenUsage = { input: 100, cacheRead: 80, cacheWrite: 0, output: 20 };

class FakeModel implements CompactorModel {
	readonly id = "fake";
	readonly calls: Array<{ system: string; turns: ChatTurn[]; onStart?: () => void }> = [];
	readonly replies: Array<string | Error>;

	constructor(replies: Array<string | Error>) {
		this.replies = [...replies];
	}

	async complete(system: string, turns: readonly ChatTurn[], _signal?: AbortSignal, onStart?: () => void): Promise<CompactorReply> {
		this.calls.push({ system, turns: structuredClone([...turns]), onStart });
		const reply = this.replies.shift() ?? "";
		if (reply instanceof Error) throw reply;
		return { text: reply, usage: USAGE };
	}
}

const signal = new AbortController().signal;
const EMPTY = { blocks: ["<chat>\n</chat>"], mark: -1 };
const leaf = (i: number, source = "user: whole\nmessage", context = EMPTY): SummaryTask => ({ part: new Part(0, i), context, source });
const firstTurn = (model: FakeModel): Extract<ChatTurn, { role: "user" }> => {
	const turn = model.calls[0].turns[0];
	if (turn.role !== "user") throw new Error("unreachable");
	return turn;
};

describe("ModelSummarizer", () => {
	it("sends the fixed system prompt, the compaction view, and the leaf task with a 512-dash ruler", async () => {
		const model = new FakeModel(["user: short"]);
		const context = { blocks: ["<chat>\n0+1|a\n1+1|b\n2+1|c\n3+1|d\n", "</chat>"], mark: 0 };
		await new ModelSummarizer(model, { nodeBytes: 512, tries: 5 }).summarize(leaf(7, "user: whole\nmessage", context), signal);
		expect(model.calls[0].system).toBe(COMPACT);
		const turn = firstTurn(model);
		expect(turn.mark).toBe(0);
		expect(turn.blocks.slice(0, 2)).toEqual(context.blocks);
		expect(turn.blocks[2]).toBe(
			`Compaction: compress message 7 into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${"-".repeat(512)}\n<input>\nuser: whole\nmessage\n</input>`,
		);
	});

	it("names a merge's two lines and its messages", async () => {
		const model = new FakeModel(["user: a; user: b"]);
		await new ModelSummarizer(model, { nodeBytes: 512, tries: 5 }).summarize({ part: new Part(2, 3), context: EMPTY, source: "user: a\nuser: b" }, signal);
		expect(firstTurn(model).blocks[1]).toBe(
			`Compaction: merge lines 12+2 and 14+2, adjacent, into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n${"-".repeat(512)}\n<chat> may hold their messages, 12 to 15, in more detail: take details\nof them from there too.\n<input>\nuser: a\nuser: b\n</input>`,
		);
	});

	it("asks again in the same conversation with the cut, and keeps the shortest line", async () => {
		const model = new FakeModel(["é".repeat(300), "a".repeat(520), "b".repeat(540)]);
		const output = await new ModelSummarizer(model, { nodeBytes: 512, tries: 3 }).summarize(leaf(0), signal);
		expect(output).toBe("a".repeat(520));
		expect(model.calls).toHaveLength(3);
		expect(model.calls[1].turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
		const feedback = model.calls[1].turns[2];
		if (feedback.role !== "user") throw new Error("unreachable");
		expect(feedback.blocks[0]).toBe(
			`Too long: your line is 600 bytes, over the 512-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n${cutBytes("é".repeat(300), 512)}| ← LIMIT`,
		);
		expect(feedback.blocks[0]).not.toContain("�");
		expect(model.calls[2].turns).toHaveLength(5);
	});

	it("reads an oversized message as head and tail, and says so", async () => {
		const model = new FakeModel(["user: partial summary"]);
		const source = `user: HEAD ${"x".repeat(5000)} TAIL`;
		await new ModelSummarizer(model, { nodeBytes: 512, tries: 5, maxSourceBytes: 1000 }).summarize(leaf(0, source), signal);
		const step = firstTurn(model).blocks[1];
		expect(step).toMatch(/This message is too long to read whole: \d+ bytes in its middle are elided below\. Say in your line that it covers only its start and end\.\n<input>\nuser: HEAD/);
		expect(step).toContain("TAIL");
		expect(byteSize(step)).toBeLessThan(2000);
	});

	it("reports usage for every call that sent a request, a failed one included; an attempt that sent none is no row", async () => {
		const seen: Array<[TokenUsage | undefined, boolean]> = [];
		const onUsage = (usage: TokenUsage | undefined, ok: boolean) => seen.push([usage, ok]);
		const ok = new ModelSummarizer(new FakeModel(["user: fine"]), { nodeBytes: 512, tries: 5, onUsage });
		await ok.summarize(leaf(0, "src"), signal);
		const failing = new ModelSummarizer(new FakeModel([new Error("rate limited")]), { nodeBytes: 512, tries: 5, onUsage });
		await expect(failing.summarize(leaf(0, "src"), signal)).rejects.toThrow("rate limited");
		// No login saved, a model not offered: the attempt failed before any request left, and still fails as it did.
		const local = sentNothing(new Error("Provider is not configured: openrouter"));
		const unsent = new ModelSummarizer(new FakeModel([local]), { nodeBytes: 512, tries: 5, onUsage });
		await expect(unsent.summarize(leaf(0, "src"), signal)).rejects.toBe(local);
		expect(seen).toEqual([
			[USAGE, true],
			[undefined, false],
		]);
		expect([sentNoRequest(local), sentNoRequest(new Error("rate limited")), sentNoRequest("text"), sentNoRequest(undefined)]).toEqual([true, false, false, false]);
	});

	it("rejects an empty summary", async () => {
		const summarizer = new ModelSummarizer(new FakeModel(["   "]), { nodeBytes: 512, tries: 5 });
		await expect(summarizer.summarize(leaf(0, "src"), signal)).rejects.toThrow(/empty summary/);
	});

	it("passes the task's start signal to the model", async () => {
		const model = new FakeModel(["user: short"]);
		const onStart = () => {};
		await new ModelSummarizer(model, { nodeBytes: 512, tries: 5 }).summarize({ ...leaf(0), onStart }, signal);
		expect(model.calls[0].onStart).toBe(onStart);
	});
});

describe("ruler, fill and source fitting", () => {
	it("measure in bytes and fill fields once", () => {
		expect(ruler(512)).toBe("-".repeat(512));
		expect([aboutWords(512), aboutWords(256), aboutWords(100)]).toEqual([70, 35, 14]);
		expect(cutBytes("éé", 3)).toBe("é");
		expect(fill("a {x} {y}", { x: "{y}", y: 1 })).toBe("a {y} 1");
		expect(() => fill("{missing}", {})).toThrow(/missing/);
	});

	it("keeps short sources whole and elides the middle of long ones on character boundaries", () => {
		expect(fitSource("short", 100)).toEqual({ text: "short", elided: 0 });
		const fitted = fitSource("é".repeat(10), 7);
		expect(fitted.elided).toBe(16);
		expect(fitted.text).toBe("é\n[… 16 bytes elided; zoom for full text …]\né");
	});
});
