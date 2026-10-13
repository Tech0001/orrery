import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompactionView, contextBlocks } from "../../src/memory/compaction-view.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { Part } from "../../src/memory/types.ts";
import { MemoryView } from "../../src/memory/view.ts";

let dir: string;
let store: MemoryStore;
let view: MemoryView;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "orrery-cview-"));
	store = MemoryStore.open(join(dir, "memory.sqlite"));
	view = new MemoryView(store);
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

/** Saves message i's leaf and every parent it completes, telling both views, as the compactor does. */
function build(i: number, compaction: CompactionView, text = "x".repeat(40)): void {
	for (let part = new Part(0, i); ; part = new Part(part.l + 1, part.i >> 1)) {
		store.saveNode(part, text);
		view.built(part);
		compaction.built(part);
		if (part.i % 2 === 0) return;
	}
}

const body = (blocks: readonly string[]) => blocks.join("").slice(0, -"</chat>".length);

describe("contextBlocks", () => {
	it("groups lines by 4, marks the last whole block, and joins back to the <chat> text", () => {
		expect(contextBlocks([])).toEqual({ blocks: ["<chat>\n</chat>"], mark: -1 });
		expect(contextBlocks(["a", "b", "c"])).toEqual({ blocks: ["<chat>\na\nb\nc\n</chat>"], mark: -1 });
		expect(contextBlocks(["a", "b", "c", "d"])).toEqual({ blocks: ["<chat>\na\nb\nc\nd\n", "</chat>"], mark: 0 });
		const nine = Array.from({ length: 9 }, (_, k) => `line ${k}`);
		const { blocks, mark } = contextBlocks(nine);
		expect(blocks).toHaveLength(3);
		expect(mark).toBe(1);
		expect(blocks.join("")).toBe(`<chat>\n${nine.join("\n")}\n</chat>`);
	});
});

describe("CompactionView", () => {
	it("gives each node the built lines before it, with id+n heads, stopping at the first unbuilt line", () => {
		const compaction = new CompactionView(view, 2_000);
		for (let i = 0; i < 5; i++) view.append("user", `m${i}`);
		for (const i of [0, 1, 3]) {
			store.saveNode(new Part(0, i), `user: m${i}`);
			view.built(new Part(0, i));
			compaction.built(new Part(0, i));
		}
		expect(compaction.context(new Part(0, 4)).blocks.join("")).toBe("<chat>\n0+1|user: m0\n1+1|user: m1\n</chat>");
		expect(compaction.context(new Part(0, 1)).blocks.join("")).toBe("<chat>\n0+1|user: m0\n</chat>");
		expect(compaction.context(new Part(0, 0)).blocks.join("")).toBe("<chat>\n</chat>");
	});

	it("runs its own sawtooth (ceiling to half), and contexts between merges extend each other", () => {
		const compaction = new CompactionView(view, 2_000); // floor 1,000; each line is 40 bytes
		let previous: readonly string[] = [];
		let epoch = compaction.epoch;
		let extended = 0;
		for (let i = 0; i < 600; i++) {
			view.append("user", `message ${i}`);
			const context = compaction.context(new Part(0, i)).blocks;
			if (compaction.epoch === epoch && i > 0) {
				expect(body(context).startsWith(body(previous))).toBe(true);
				extended++;
			}
			previous = context;
			epoch = compaction.epoch;
			build(i, compaction);
			expect(compaction.size).toBeLessThanOrEqual(2_000);
			if (i >= 100) expect(compaction.size).toBeGreaterThan(1_000 - 80);
		}
		expect(compaction.epoch).toBeGreaterThan(5); // it batched many times
		expect(extended).toBeGreaterThan(500);
	});

	it("starts from the chat's view merged further down to its floor", () => {
		for (let i = 0; i < 64; i++) store.append("user", `m${i}`);
		for (let level = 0; 2 ** level <= 64; level++) {
			for (let i = 0; (i + 1) * 2 ** level <= 64; i++) store.saveNode(new Part(level, i), "x".repeat(40));
		}
		view = new MemoryView(store, 100_000); // the chat view keeps all 64 lines
		expect(view.parts).toHaveLength(64);
		const compaction = new CompactionView(view, 400);
		expect(compaction.size).toBeLessThanOrEqual(200);
		for (const line of compaction.parts) expect(view.parts.some((chat) => chat.start === line.start)).toBe(true);
	});
});
