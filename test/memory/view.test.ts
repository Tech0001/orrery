import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, VIEW_KEY } from "../../src/memory/store.ts";
import { Part } from "../../src/memory/types.ts";
import { MemoryView, PLACEHOLDER } from "../../src/memory/view.ts";

let dir: string;
let store: MemoryStore;
let view: MemoryView;
const savedTz = process.env.TZ;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "orrery-view-"));
	store = MemoryStore.open(join(dir, "memory.sqlite"));
	view = new MemoryView(store);
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
	if (savedTz === undefined) delete process.env.TZ;
	else process.env.TZ = savedTz;
});

/** Saves message i's leaf and every parent it completes, telling the view, as the compactor does. */
function build(i: number, text = "x".repeat(20)): void {
	for (let part = new Part(0, i); ; part = new Part(part.l + 1, part.i >> 1)) {
		store.saveNode(part, text);
		view.built(part);
		if (part.i % 2 === 0) return;
	}
}

/** Saves every node over the first `count` messages straight to `target`, without any view. */
function saveTree(target: MemoryStore, count: number, text = "x".repeat(20)): void {
	for (let level = 0; 2 ** level <= count; level++) {
		for (let i = 0; (i + 1) * 2 ** level <= count; i++) target.saveNode(new Part(level, i), text);
	}
}

const keys = (of: MemoryView = view) => of.parts.map((part) => part.key);

describe("MemoryView", () => {
	it("renders addresses, flattens newlines, and keeps unbuilt parts out of compactor context", () => {
		view.append("user", "a\nb");
		expect(view.render()).toBe(`<chat>\n0+1|${PLACEHOLDER}\n</chat>`);
		expect(() => view.render({ ids: false })).toThrow(/only built summaries/);
		store.saveNode(new Part(0, 0), "user: a\nb");
		expect(view.render()).toBe("<chat>\n0+1|user: a b\n</chat>");
		expect(view.render({ ids: false })).toBe("<chat>\nuser: a b\n</chat>");
		expect(view.render({ ids: false, end: 0 })).toBe("<chat>\n\n</chat>");
	});

	it("rejects malformed zoom and date arguments from the model without throwing", () => {
		view.append("user", "a\nb", "2026-01-01T12:00:00-07:00");
		const bad: Array<[unknown, unknown]> = [
			[-1, 1],
			[0, 0],
			[0, 3],
			[1, 2],
			[true, 1],
			[0, true],
			[0, 2],
			["0", 1],
			[0.5, 1],
			[2 ** 53, 1],
			[0, 2 ** 40],
			[null, undefined],
		];
		for (const [id, n] of bad) expect(view.zoom(id, n)).toMatch(/^No line/);
		expect(view.zoom(0, 1)).toBe("0+0|user: a\nb");
		for (const id of ["0", 5, -1, 1.5, null]) expect(view.date(id)).toMatch(/^No message/);
	});

	it("zooms a built parent into its two children", () => {
		for (const text of ["a", "b"]) view.append("user", text);
		store.saveNode(new Part(0, 0), "user: a");
		expect(view.zoom(0, 2)).toMatch(/^No line/);
		store.saveNode(new Part(0, 1), "user: b");
		expect(view.zoom(0, 2)).toBe("0+1|user: a\n1+1|user: b");
	});

	it("shows dates in the local timezone", () => {
		process.env.TZ = "UTC";
		view.append("user", "x", "2026-01-01T12:00:00-07:00");
		expect(view.date(0)).toBe("2026-01-01T19:00:00.000+00:00");
	});

	it("settles once every view line is built, and returns false when aborted", async () => {
		view.append("user", "pending");
		const controller = new AbortController();
		const waiting = view.settle(controller.signal);
		controller.abort();
		await expect(waiting).resolves.toBe(false);
		expect(store.root[0].text).toBe("pending");

		const settled = view.settle();
		store.saveNode(new Part(0, 0), "user: pending");
		view.fit();
		await expect(settled).resolves.toBe(true);
	});

	it("appends a batch with metadata and keeps parts contiguous", () => {
		const messages = view.appendBatch(
			[
				{ kind: "user", text: "one" },
				{ kind: "talk", text: "two" },
			],
			{ "projector.cursor": "e2" },
		);
		expect(messages.map((m) => m.i)).toEqual([0, 1]);
		expect(view.parts).toEqual([new Part(0, 0), new Part(0, 1)]);
		expect(store.getMeta("projector.cursor")).toBe("e2");
		expect(view.stats()).toEqual({
			messages: 2,
			nodes: 0,
			viewParts: 2,
			viewBytes: 0,
			viewBudget: 128_000,
			settled: false,
			firstUnsummarized: 0,
		});
	});

	it("passes usage rows through appendBatch", () => {
		const row = { at: "2026-10-05T12:00:00.000-05:00", role: "agent" as const, model: "m", input: 1, cacheRead: 0, cacheWrite: 0, output: 1, ok: true };
		view.appendBatch([{ kind: "talk", text: "hi" }], { c: "1" }, [row]);
		expect(store.usageRows()).toEqual([row]);
	});
});

describe("MemoryView sawtooth", () => {
	it("batches from the ceiling to the floor in Taelin's order, saving each append and each finished batch", () => {
		view = new MemoryView(store, 100); // floor 50; every line is 20 bytes
		for (let i = 0; i < 5; i++) {
			view.append("user", `m${i}`);
			build(i);
		}
		expect(keys()).toEqual(["0:0", "0:1", "0:2", "0:3", "0:4"]);
		view.append("user", "m5");
		store.saveNode(new Part(0, 5), "x".repeat(20));
		view.built(new Part(0, 5)); // 120 bytes: merges 0-1, 2-3, then 0-3; 4-5 has no parent yet
		expect(keys()).toEqual(["2:0", "0:4", "0:5"]);
		expect(store.getMeta(VIEW_KEY)).toBe("[[0,0],[0,1],[0,2],[0,3],[0,4],[0,5]]"); // a short batch is not saved yet
		view.append("user", "m6"); // appending never merges, and saves the view as it is
		expect(keys()).toEqual(["2:0", "0:4", "0:5", "0:6"]);
		expect(store.getMeta(VIEW_KEY)).toBe("[[2,0],[0,4],[0,5],[0,6]]");
		store.saveNode(new Part(1, 2), "x".repeat(20));
		view.built(new Part(1, 2)); // the short batch reaches the floor and is saved
		expect(keys()).toEqual(["2:0", "1:2", "0:6"]);
		expect(store.getMeta(VIEW_KEY)).toBe("[[2,0],[1,2],[0,6]]");
		build(6);
		view.append("user", "m7");
		build(7);
		expect(keys()).toEqual(["2:0", "1:2", "0:6", "0:7"]); // 80 bytes: built parents wait for the next batch
		expect(view.size).toBe(80);
	});
});

describe("saved view", () => {
	it("reopens exactly as it was, and a read-only reader sees the same view", () => {
		view = new MemoryView(store, 100);
		for (let i = 0; i < 8; i++) {
			view.append("user", `m${i}`);
			build(i);
		}
		const before = keys();
		const rendered = view.render();
		store.close();
		store = MemoryStore.open(join(dir, "memory.sqlite"));
		view = new MemoryView(store, 100);
		expect(keys()).toEqual(before);
		const reader = MemoryStore.openReadOnly(join(dir, "memory.sqlite"));
		try {
			const seen = new MemoryView(reader, 100);
			expect(keys(seen)).toEqual(before);
			expect(seen.render()).toBe(rendered);
		} finally {
			reader.close();
		}
	});

	it("saves the view in the same transaction as appended messages, and not on a refused append", () => {
		view.appendBatch([
			{ kind: "user", text: "one" },
			{ kind: "talk", text: "two" },
		]);
		expect(store.getMeta(VIEW_KEY)).toBe("[[0,0],[0,1]]");
		expect(() => view.appendBatch([{ kind: "bogus" as never, text: "x" }])).toThrow(RangeError);
		expect(store.getMeta(VIEW_KEY)).toBe("[[0,0],[0,1]]");
		expect(keys()).toEqual(["0:0", "0:1"]);
	});

	it("builds an agent's first view once, merged down to the floor, and saves it", () => {
		const first = MemoryStore.open(join(dir, "first.sqlite"));
		try {
			for (let i = 0; i < 8; i++) first.append("user", `m${i}`);
			saveTree(first, 8);
			expect(first.savedView()).toBeUndefined();
			const opened = new MemoryView(first, 100); // 160 bytes of built lines: merged to at most 50
			expect(keys(opened)).toEqual(["2:0", "2:1"]);
			expect(first.getMeta(VIEW_KEY)).toBe("[[2,0],[2,1]]");
			expect(keys(new MemoryView(first, 100))).toEqual(["2:0", "2:1"]); // loaded, not rebuilt
		} finally {
			first.close();
		}
	});

	it("adds messages appended without the view (an import) as lines at the next open", () => {
		view.append("user", "m0");
		store.appendBatch([
			{ kind: "user", text: "m1" },
			{ kind: "user", text: "m2" },
		]); // what `orrery import --commit` does
		expect(keys(new MemoryView(store))).toEqual(["0:0", "0:1", "0:2"]);
		expect(store.getMeta(VIEW_KEY)).toBe("[[0,0],[0,1],[0,2]]");
	});

	it("rebuilds a saved view that does not fit the log; a read-only reader never writes", () => {
		for (let i = 0; i < 4; i++) view.append("user", `m${i}`);
		for (const bad of ["not json", "[[0,1]]", "[[1,0],[0,2],[0,3]]", "[[0,0],[0,1],[0,2],[0,3],[0,4]]", '[[0,"0"]]']) {
			store.setMeta(VIEW_KEY, bad);
			expect(keys(new MemoryView(store))).toEqual(["0:0", "0:1", "0:2", "0:3"]);
		}
		store.setMeta(VIEW_KEY, "not json");
		const reader = MemoryStore.openReadOnly(join(dir, "memory.sqlite"));
		try {
			expect(keys(new MemoryView(reader))).toEqual(["0:0", "0:1", "0:2", "0:3"]);
		} finally {
			reader.close();
		}
		expect(store.getMeta(VIEW_KEY)).toBe("not json");
	});

	it("gives a read-only reader the saved view as of its snapshot", () => {
		view.append("user", "m0");
		const reader = MemoryStore.openReadOnly(join(dir, "memory.sqlite"));
		try {
			view.append("user", "m1");
			expect(reader.savedView()).toBe("[[0,0]]");
			expect(reader.root).toHaveLength(1);
		} finally {
			reader.close();
		}
	});
});
