import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/memory/store.ts";
import { Part } from "../../src/memory/types.ts";

// A writer that appends between a read-only open's two reads (messages, then the tree): the store's own SQL, with the
// read-only connection's tree query delayed until the writer has committed.
const hook = vi.hoisted(() => ({ beforeTreeRead: undefined as undefined | (() => void) }));
vi.mock("../../src/memory/sqlite.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../src/memory/sqlite.ts")>();
	return {
		...real,
		openDatabase: (path: string, options: { readOnly?: boolean } = {}) => {
			const db = real.openDatabase(path, options);
			if (options.readOnly !== true) return db;
			return {
				...db,
				prepare: (sql: string) => {
					if (sql.startsWith("SELECT l, i, text, size FROM tree")) {
						const run = hook.beforeTreeRead;
						hook.beforeTreeRead = undefined;
						run?.();
					}
					return db.prepare(sql);
				},
			};
		},
	};
});

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a read-only open", () => {
	it("loads one snapshot: a writer's append between its reads is not half-seen", () => {
		dir = mkdtempSync(join(tmpdir(), "orrery-snapshot-"));
		const path = join(dir, "memory.sqlite");
		const writer = MemoryStore.open(path);
		writer.append("user", "first");
		hook.beforeTreeRead = () => {
			writer.append("talk", "second");
			writer.saveNode(new Part(0, 1), "talk: second");
		};
		const reader = MemoryStore.openReadOnly(path);
		expect(hook.beforeTreeRead).toBeUndefined(); // the writer did run between the two reads
		expect([reader.root.length, reader.nodeCount]).toEqual([1, 0]);
		reader.close();
		const later = MemoryStore.openReadOnly(path);
		expect([later.root.length, later.nodeCount]).toEqual([2, 1]);
		later.close();
		writer.close();
	});
});
