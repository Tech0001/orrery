import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { fit, fitColumns, renderTable } from "../../src/tui/table.ts";
import { PLAIN } from "../../src/tui/theme.ts";

const COLUMNS = [
	{ title: "Name", width: 6 },
	{ title: "Size", width: 5, align: "right" as const },
	{ title: "Note", width: 8, grow: true },
	{ title: "Model", width: 10, drop: 1 },
	{ title: "Last", width: 6, drop: 2 },
];

describe("tables", () => {
	it("pads, truncates with an ellipsis, and aligns", () => {
		expect(fit("abc", 5)).toBe("abc  ");
		expect(fit("abcdefgh", 5)).toBe("abcd…");
		expect(fit("12", 4, "right")).toBe("  12");
	});

	it("drops columns in their drop order until the row fits", () => {
		expect(fitColumns(COLUMNS, 60)).toEqual([0, 1, 2, 3, 4]);
		expect(fitColumns(COLUMNS, 40)).toEqual([0, 1, 2, 4]);
		expect(fitColumns(COLUMNS, 30)).toEqual([0, 1, 2]);
	});

	it("renders a header, rows with a selection marker, and never a line wider than asked", () => {
		const lines = renderTable(COLUMNS, [["a", "1", "x", "m", "now"], ["b", "22", "y", "m", "1 h"]], 50, { selected: 1, height: 10, theme: PLAIN });
		expect(lines[0].startsWith("  Name")).toBe(true);
		expect(lines[1].startsWith("  a")).toBe(true);
		expect(lines[2].startsWith("› b")).toBe(true);
		expect(lines.every((l) => l.length <= 50)).toBe(true);
	});

	it("scrolls to keep the selected row in view", () => {
		const rows = Array.from({ length: 20 }, (_, i) => [`r${i}`, "", "", "", ""]);
		const lines = renderTable(COLUMNS, rows, 50, { selected: 15, height: 6, theme: PLAIN });
		expect(lines).toHaveLength(6);
		expect(lines.at(-1)?.startsWith("› r15")).toBe(true);
	});
});


it("truncates only opted-in table cells in the middle, keeping the path end", () => {
	const columns = [{ title: "Found", width: 14, truncate: "middle" as const }, { title: "Other", width: 8 }];
	const lines = renderTable(columns, [["~/long/path/to/orrery.ts", "unchanged ending"]], 26, { height: 2, theme: PLAIN });
	expect(lines[1]).toContain("~/long/…ery.ts");
	expect(lines[1]).toContain("unchang…");
});

it("middle truncation respects wide characters and tiny widths", () => {
	const path = "~/資料/長いディレクトリ/末尾.ts";
	for (const width of [0, 1, 2, 18, 40]) {
		const columns = [{ title: "Path", width, truncate: "middle" as const }];
		const line = renderTable(columns, [[path]], width + 2, { height: 2, theme: PLAIN })[1];
		expect(visibleWidth(line)).toBe(width + 2);
		if (width === 18) expect(line.trimEnd()).toMatch(/….*末尾\.ts$/);
	}
});
