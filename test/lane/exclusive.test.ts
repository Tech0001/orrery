/**
 * removeStale (src/lane/exclusive.ts) on its own: each outcome, and what another process can do to the graveyard
 * between the move and the judgment. The second process runs inside the first's rename (a file-local mock).
 */

import { existsSync, mkdtempSync, type PathLike, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeStale } from "../../src/lane/exclusive.ts";

/** Runs once, before or after the next rename (cleared first, so a rename inside it is a plain one). */
const hook = vi.hoisted(() => ({
	beforeRename: undefined as ((source: string, target: string) => void) | undefined,
	afterRename: undefined as ((source: string, target: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		default: fs,
		renameSync: (source: PathLike, target: PathLike) => {
			const before = hook.beforeRename;
			hook.beforeRename = undefined;
			before?.(String(source), String(target));
			fs.renameSync(source, target);
			const after = hook.afterRename;
			hook.afterRename = undefined;
			after?.(String(source), String(target));
		},
	};
});

const dirs: string[] = [];
afterEach(() => {
	hook.beforeRename = undefined;
	hook.afterRename = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stale(content: string) {
	const dir = mkdtempSync(join(tmpdir(), "orrery-exclusive-"));
	dirs.push(dir);
	const file = join(dir, "claim");
	writeFileSync(file, content);
	return { dir, file };
}

/** Stale when it holds "stale", or is gone (a swept graveyard). */
const judge = (file: string) => !existsSync(file) || readFileSync(file, "utf8") === "stale";

describe("removeStale", () => {
	it("removes a file still stale in the graveyard, and keeps one that was replaced between the judgment and the move", () => {
		const { dir, file } = stale("stale");
		expect(removeStale(file, judge)).toBe("removed");
		expect(readdirSync(dir)).toEqual([]);
		writeFileSync(file, "fresh");
		expect(removeStale(file, judge)).toBe("kept");
		expect(readFileSync(file, "utf8")).toBe("fresh");
		expect(readdirSync(dir)).toEqual(["claim"]);
	});

	it("loses when another mover's rename wins: the file is gone, and nothing of this mover's is left", () => {
		const { dir, file } = stale("stale");
		let other: string | undefined;
		hook.beforeRename = () => {
			other = removeStale(file, judge);
		};
		expect(removeStale(file, judge)).toBe("lost");
		expect(other).toBe("removed");
		expect(readdirSync(dir)).toEqual([]);
	});

	it("a graveyard swept by a pruner between the move and the judgment: removed, whatever the judgment would have said", () => {
		const { dir, file } = stale("fresh");
		// Another process's prune takes the old graveyard file for a stray.
		hook.afterRename = (_source, target) => rmSync(target);
		expect(removeStale(file, judge)).toBe("removed");
		expect(readdirSync(dir)).toEqual([]);
		// Swept after the judgment, before the put-back: the same.
		writeFileSync(file, "fresh");
		expect(removeStale(file, (grave) => {
			rmSync(grave);
			return false;
		})).toBe("removed");
		expect(readdirSync(dir)).toEqual([]);
	});
});
