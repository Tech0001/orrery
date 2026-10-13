/** Tables that fit a width: columns drop out in a set order, cells are cut with an ellipsis, the selected row is marked. */

import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Style, Theme } from "./theme.ts";

export interface Column {
	readonly title: string;
	readonly width: number;
	/** Takes the spare width. */
	readonly grow?: boolean;
	/** Dropped when the row does not fit; the lowest number goes first. Columns without one always stay. */
	readonly drop?: number;
	/** Middle truncation keeps the end of a long path visible. */
	readonly truncate?: "end" | "middle";
	readonly align?: "left" | "right";
}

const GAP = 2;
/** The selection marker's gutter. */
const GUTTER = 2;

/** `text` cut or padded to exactly `width` columns. */
export function fit(text: string, width: number, align: "left" | "right" = "left", truncate: "end" | "middle" = "end"): string {
	if (width <= 0) return "";
	let cut = text;
	const size = visibleWidth(text);
	if (size > width) {
		const left = Math.ceil((width - 1) / 2);
		const right = width - 1 - left;
		cut = truncate === "middle"
			? `${sliceByColumn(text, 0, left, true)}…${sliceByColumn(text, size - right, right, true)}`
			: truncateToWidth(text, width, "…");
	}
	// pi-tui puts style resets around the ellipsis; plain text stays plain.
	if (!text.includes("\x1b")) cut = cut.replaceAll("\x1b[0m", "");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(cut)));
	return align === "right" ? pad + cut : cut + pad;
}

/** A token count in few characters: 999, 16.0K, 177.8M, 1.2B. */
export function compactCount(n: number): string {
	if (Math.abs(n) < 1000) return String(n);
	const units = ["K", "M", "B"];
	let value = n;
	let unit = -1;
	do {
		value /= 1000;
		unit++;
	} while (unit < units.length - 1 && Math.abs(Number(value.toFixed(1))) >= 1000);
	return `${value.toFixed(1)}${units[unit]}`;
}

/** The indexes of the columns that fit in `width`, after dropping in `drop` order. */
export function fitColumns(columns: readonly Column[], width: number): number[] {
	const kept = columns.map((_, i) => i);
	const need = () => GUTTER + kept.reduce((sum, i) => sum + columns[i].width, 0) + GAP * (kept.length - 1);
	const droppable = columns
		.map((c, i) => ({ i, drop: c.drop }))
		.filter((c): c is { i: number; drop: number } => c.drop !== undefined)
		.sort((a, b) => a.drop - b.drop);
	for (const { i } of droppable) {
		if (need() <= width) break;
		kept.splice(kept.indexOf(i), 1);
	}
	return kept;
}

/** A header line and the rows that fit in `height` (scrolled to keep the selection in view). */
export function renderTable(
	columns: readonly Column[],
	rows: readonly (readonly string[])[],
	width: number,
	options: { selected?: number; height: number; theme: Theme; rowStyle?: (row: number) => Style | undefined },
): string[] {
	const kept = fitColumns(columns, width);
	const widths = kept.map((i) => columns[i].width);
	const spare = width - GUTTER - widths.reduce((a, b) => a + b, 0) - GAP * (kept.length - 1);
	const grow = kept.findIndex((i) => columns[i].grow === true);
	if (grow !== -1 && spare > 0) widths[grow] += spare;
	const line = (cells: readonly string[]) => kept.map((i, k) => fit(cells[i] ?? "", widths[k], columns[i].align, columns[i].truncate)).join(" ".repeat(GAP));
	const header = options.theme.bold(fit(`  ${line(columns.map((c) => c.title))}`, width));
	const room = Math.max(0, options.height - 1);
	const selected = options.selected ?? -1;
	const start = selected >= room ? selected - room + 1 : 0;
	const body = rows.slice(start, start + room).map((cells, k) => {
		const index = start + k;
		const text = fit(`${index === selected ? "› " : "  "}${line(cells)}`, width);
		if (index === selected) return options.theme.inverse(text);
		const style = options.rowStyle?.(index);
		return style === undefined ? text : style(text);
	});
	return [header, ...body];
}
