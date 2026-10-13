import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore, MemoryView } from "../../src/memory/index.ts";
import { compactionDecision, memorySection, trimToRun } from "../../src/pi/turn.ts";

let dir: string;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("turn helpers", () => {
	it("keeps only the current run (from its first user message on), or everything when the start is missing", () => {
		const msgs = [
			{ role: "user", timestamp: 1 },
			{ role: "assistant", timestamp: 2 },
			{ role: "user", timestamp: 10 },
			{ role: "assistant", timestamp: 11 },
			{ role: "toolResult", timestamp: 12 },
			{ role: "user", timestamp: 13 },
		];
		expect(trimToRun(msgs, 10).map((m) => m.timestamp)).toEqual([10, 11, 12, 13]);
		// No user message at/after the start (a call not begun by a prompt): keep from the last user message only.
		expect(trimToRun(msgs, 99).map((m) => m.timestamp)).toEqual([13]);
		// No user message at all: the transcript is this run's tool traffic; keep it.
		const traffic = [{ role: "assistant", timestamp: 1 }, { role: "toolResult", timestamp: 2 }];
		expect(trimToRun(traffic, 99)).toEqual(traffic);
	});

	it("keeps the user's !cmd output run since the previous run ended, right before this run's first user message", () => {
		const ts = (list: { timestamp: number }[]) => list.map((m) => m.timestamp);
		const msgs = [
			{ role: "bashExecution", timestamp: 0 },
			{ role: "user", timestamp: 1 },
			{ role: "assistant", timestamp: 3 },
			{ role: "bashExecution", timestamp: 5 }, // ran during the previous run (it ended at 5), queued after it
			{ role: "bashExecution", timestamp: 6 },
			{ role: "bashExecution", timestamp: 7 },
			{ role: "user", timestamp: 10 },
			{ role: "assistant", timestamp: 11 },
		];
		expect(ts(trimToRun(msgs, 10, 5))).toEqual([6, 7, 10, 11]);
		// No previous end given: none.
		expect(ts(trimToRun(msgs, 10))).toEqual([10, 11]);
		// Only those directly before the user message: a reply in between ends them.
		const gap = [{ role: "bashExecution", timestamp: 6 }, { role: "assistant", timestamp: 7 }, { role: "user", timestamp: 10 }];
		expect(ts(trimToRun(gap, 10, 5))).toEqual([10]);
		// The fallback (no user message at/after the start) is still one run at most, with that run's !cmd output.
		expect(ts(trimToRun(msgs, 99, 5))).toEqual([6, 7, 10, 11]);
		expect(ts(trimToRun(msgs, 99, 8))).toEqual([10, 11]);
	});

	it("renders the memory section with ids, explains search, and shows placeholders when unsettled", () => {
		dir = mkdtempSync(join(tmpdir(), "orrery-turn-"));
		const store = MemoryStore.open(join(dir, "memory.sqlite"));
		const view = new MemoryView(store);
		view.append("user", `A long message ${"detail ".repeat(200)}`, "2026-10-06T10:00:00.000Z");
		const section = memorySection(view);
		expect(section).toContain("<chat>");
		expect(section).toContain("0+1|(not summarized yet: zoom it)");
		expect(section).toContain("search(query)");
		expect(section).toContain("never reconstruct it from a summary");
		expect(section).toContain("the source wins");
		store.close();
	});

	it("turns pi's own compaction off except as overflow recovery", () => {
		expect(compactionDecision("threshold")).toEqual({ cancel: true });
		expect(compactionDecision("manual")).toEqual({ cancel: true });
		expect(compactionDecision("overflow")).toBeUndefined();
	});
});
