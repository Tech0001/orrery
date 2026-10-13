import { describe, expect, it } from "vitest";
import { interleave, splitNote } from "../../src/import/merge.ts";
import type { ImportTurn } from "../../src/import/turns.ts";
import { byteSize } from "../../src/memory/index.ts";

const turn = (source: string, start: string, text: string): ImportTurn => ({
	source,
	start,
	messages: [
		{ kind: "user", text, date: start },
		{ kind: "talk", text: `re ${text}`, date: start },
	],
});

describe("interleave", () => {
	it("orders turns by start time, keeps each turn whole, and breaks ties by source group then position", () => {
		const claude = [turn("claude", "2026-08-01T10:00:00.000Z", "c1"), turn("claude", "2026-08-01T12:00:00.000Z", "c2")];
		const codex = [turn("codex", "2026-08-01T11:00:00.000Z", "x1"), turn("codex", "2026-08-01T12:00:00.000Z", "x2")];
		const merged = interleave(claude, codex);
		expect(merged.map((t) => t.messages[0].text)).toEqual(["c1", "x1", "c2", "x2"]);
		expect(merged.flatMap((t) => t.messages.map((m) => m.text))).toEqual(["c1", "re c1", "x1", "re x1", "c2", "re c2", "x2", "re x2"]);
		expect(interleave(codex, claude).map((t) => t.messages[0].text)).toEqual(["c1", "x1", "x2", "c2"]);
	});
});

describe("splitNote", () => {
	it("keeps a small note whole", () => {
		expect(splitNote("board.md", "# Board\nshort", "2026-10-01T00:00:00.000Z")).toEqual([
			{ kind: "note", text: "board.md\n\n# Board\nshort", date: "2026-10-01T00:00:00.000Z" },
		]);
	});

	it("splits a large note at headings into labeled parts under the byte limit", () => {
		const section = (n: number) => `## Section ${n}\n${"detail line\n".repeat(60)}`;
		const text = [1, 2, 3, 4, 5].map(section).join("\n");
		const parts = splitNote("board.md", text, "2026-10-01T00:00:00.000Z", 1_600);
		expect(parts.length).toBeGreaterThan(2);
		parts.forEach((part, i) => {
			expect(part.kind).toBe("note");
			expect(part.text.startsWith(`board.md (part ${i + 1} of ${parts.length})\n\n`)).toBe(true);
			expect(byteSize(part.text)).toBeLessThanOrEqual(1_600 + 64);
		});
		expect(parts.at(-1)?.text).toContain("## Section 5");
	});
});
