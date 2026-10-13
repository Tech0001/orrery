import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatHits, MemoryStore, searchLog } from "../../src/memory/index.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function store(): MemoryStore {
	dir = mkdtempSync(join(tmpdir(), "orrery-search-"));
	const s = MemoryStore.open(join(dir, "memory.sqlite"));
	s.appendBatch([
		{ kind: "user", text: "In February we chose garden-plants as a plant group.", date: "2026-02-10T10:00:00.000Z" },
		{ kind: "talk", text: "Noted: garden-plants is a sample plant group.", date: "2026-02-10T10:01:00.000Z" },
		{ kind: "user", text: "Unrelated: fix the bridge.", date: "2026-05-01T10:00:00.000Z" },
		{ kind: "echo", text: `${"x".repeat(400)} Garden-Plants appears late in a long tool output ${"y".repeat(400)}`, date: "2026-09-01T10:00:00.000Z" },
	]);
	return s;
}

describe("searchLog", () => {
	it("finds every message containing all the words, newest first, with ids, dates and short snippets", () => {
		const s = store();
		const hits = searchLog(s, "garden-plants group");
		expect(hits.map((h) => h.id)).toEqual([1, 0]);
		expect(searchLog(s, "GARDEN-PLANTS").map((h) => h.id)).toEqual([3, 1, 0]);
		const long = searchLog(s, "garden-plants")[0];
		expect(long.snippet.length).toBeLessThanOrEqual(310);
		expect(long.snippet).toContain("Garden-Plants appears late");
		expect(long.date).toBe("2026-09-01T10:00:00.000Z");
		s.close();
	});

	it("supports /regex/ queries and a limit, and formats hits for the model", () => {
		const s = store();
		expect(searchLog(s, "/fix the (bridge|cell)/").map((h) => h.id)).toEqual([2]);
		expect(searchLog(s, "garden-plants", { limit: 1 })).toHaveLength(1);
		expect(formatHits(searchLog(s, "bridge"), "bridge")).toBe(
			'1 match for "bridge" (newest first; read more with zoom(id, 1) or date(id)):\n#2 2026-05-01 user: Unrelated: fix the bridge.',
		);
		expect(formatHits([], "nothing")).toBe('No message matches "nothing".');
		expect(() => searchLog(s, "/(unclosed/")).toThrow(/Invalid search pattern/);
		s.close();
	});

	it("treats a /path-like query whose flags are not regex flags as keywords, and drops the g and y flags", () => {
		const s = store();
		s.appendBatch([{ kind: "user", text: "the file lives at /src/memory/store.ts", date: "2026-09-02T10:00:00.000Z" }]);
		expect(searchLog(s, "/src/memory").map((h) => h.id)).toEqual([4]);
		expect(searchLog(s, "/bridge/y").map((h) => h.id)).toEqual([2]);
		expect(searchLog(s, "/bridge/g").map((h) => h.id)).toEqual([2]);
		expect(() => searchLog(s, "/(unclosed/i")).toThrow(/Invalid search pattern/);
		s.close();
	});
});
