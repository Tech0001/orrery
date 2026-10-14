import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPreview, commitPreview, readPreview, writePreview } from "../../src/import/preview.ts";
import type { SplitResult } from "../../src/import/split.ts";
import type { ImportTurn } from "../../src/import/turns.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { tempDir } from "../lane/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T = "2026-08-01T10:00:00.000Z";
const turns: ImportTurn[] = [
	{
		source: "claude:s1",
		start: T,
		messages: [
			{ kind: "user", text: "LONG: my words then a pasted Willow report", date: T },
			{ kind: "talk", text: "Done. Key was sk-ant-" + "oat01-AbCdEfGhIjKlMnOpQrStUvWxYz", date: T },
		],
	},
	{
		source: "codex:x1",
		start: "2026-08-01T11:00:00.000Z",
		messages: [{ kind: "user", text: "short ghp" + "_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", date: "2026-08-01T11:00:00.000Z" }],
	},
];

function fakeSplit() {
	const seen: string[] = [];
	const split = async (text: string): Promise<SplitResult> => {
		seen.push(text);
		return text.startsWith("LONG")
			? {
					status: "split",
					segments: [
						{ kind: "director", source: null, text: "LONG: my words" },
						{ kind: "paste", source: "Willow", text: "then a pasted Willow report" },
					],
				}
			: { status: "whole", segments: [{ kind: "director", source: null, text }] };
	};
	return { seen, split };
}

describe("import preview", () => {
	it("scrubs before splitting, and builds lines and a secret-free report", async () => {
		const { seen, split } = fakeSplit();
		const { lines, report } = await buildPreview({
			turns,
			notes: [{ source: "note:board.md", message: { kind: "note", text: "board.md\n\nstate", date: "2026-10-01T00:00:00.000Z" } }],
			split,
		});
		expect(lines.map((l) => [l.kind, l.text, l.source])).toEqual([
			["user", "LONG: my words", "claude:s1"],
			["user", "[Willow] then a pasted Willow report", "claude:s1"],
			["talk", "Done. Key was [REDACTED:anthropic-key]", "claude:s1"],
			["user", "short [REDACTED:github-token]", "codex:x1"],
			["note", "board.md\n\nstate", "note:board.md"],
		]);
		expect(seen.some((text) => text.includes("ghp_"))).toBe(false);
		expect(report).toContain("5 messages");
		expect(report).toContain("Split: 1");
		expect(report).toContain("anthropic-key: 1");
		expect(report).toContain("github-token: 1");
		expect(report).not.toContain("sk-ant");
		expect(report).not.toContain("ghp_");
	});

	it("sums the preview up: messages, first and last dates, secrets by kind, splits; progress after each turn", async () => {
		const seen: [number, number][] = [];
		const later = { source: "codex:x2", start: "2026-07-30T08:00:00.000Z", messages: [{ kind: "user" as const, text: "earlier, though listed last", date: "2026-07-30T08:00:00.000Z" }] };
		const { summary } = await buildPreview({
			turns: [...turns, later],
			// A note with no date counts as a message but not toward the dates.
			notes: [{ source: "note:a.md", message: { kind: "note", text: "no date" } }],
			split: fakeSplit().split,
			progress: (done, total) => {
				seen.push([done, total]);
			},
		});
		expect(summary).toEqual({ messages: 6, first: "2026-07-30T08:00:00.000Z", last: "2026-08-01T11:00:00.000Z", redactions: { "anthropic-key": 1, "github-token": 1 }, splits: 1, unsplit: 0 });
		expect(seen).toEqual([[1, 3], [2, 3], [3, 3]]);
		const none = await buildPreview({ turns: [], notes: [] });
		expect(none.summary).toEqual({ messages: 0, redactions: {}, splits: 0, unsplit: 0 });
	});

	it("finds the date range of more lines than Math.min(...dates) can take", async () => {
		const many = 160_000;
		const notes = Array.from({ length: many }, (_, i) => ({ source: "note:n", message: { kind: "note" as const, text: "n", date: new Date(Date.UTC(2026, 0, 1) + (i === 7 ? -86_400_000 : i * 1000)).toISOString() } }));
		const { summary } = await buildPreview({ turns: [], notes });
		expect(summary).toMatchObject({ messages: many, first: "2025-12-31T00:00:00.000Z", last: new Date(Date.UTC(2026, 0, 1) + (many - 1) * 1000).toISOString() });
	});

	it("writes private files, reads them back, and commits atomically into empty memory only", async () => {
		const dir = tempDir("orrery-preview-");
		dirs.push(dir);
		const { lines, report } = await buildPreview({ turns, notes: [], split: fakeSplit().split });
		const { previewPath, reportPath } = writePreview(join(dir, "out"), lines, report);
		expect(statSync(previewPath).mode & 0o777).toBe(0o600);
		expect(statSync(reportPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "out")).mode & 0o777).toBe(0o700);
		expect(readPreview(previewPath)).toEqual(lines);

		const store = MemoryStore.open(join(dir, "memory.sqlite"));
		expect(commitPreview(store, readPreview(previewPath))).toBe(4);
		expect(store.root.map((m) => m.text)[1]).toBe("[Willow] then a pasted Willow report");
		expect(() => commitPreview(store, lines)).toThrow(/already has 4 messages/);
		store.close();
	});

	it("rejects an edited preview with a bad kind or date before writing anything", () => {
		const dir = tempDir("orrery-preview-");
		dirs.push(dir);
		const file = join(dir, "preview.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({ kind: "user", text: "ok", date: T, source: "a" })}\n` +
				`${JSON.stringify({ kind: "thought", text: "x", date: T, source: "b" })}\n` +
				`${JSON.stringify({ kind: "user", text: "x", date: "yesterday", source: "c" })}\n`,
		);
		expect(() => readPreview(file)).toThrow(/line 2[\s\S]*line 3/);
		expect(readFileSync(file, "utf8")).toContain("thought");
	});
});
