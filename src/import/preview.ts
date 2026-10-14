/** The import preview: a JSONL of exactly what would be appended, a report for review, and the commit (spec §7). */

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { byteSize, isKind, type Kind, type MemoryStore, type NewMessage, StoreError, validDate } from "../memory/index.ts";
import { scrub } from "./scrub.ts";
import { type SplitResult, splitToMessages } from "./split.ts";
import type { ImportTurn } from "./turns.ts";

export interface PreviewLine {
	readonly kind: Kind;
	readonly text: string;
	readonly date: string;
	readonly source: string;
}

export interface PreviewOptions {
	readonly turns: readonly ImportTurn[];
	readonly notes: readonly { readonly source: string; readonly message: NewMessage }[];
	readonly split?: (text: string) => Promise<SplitResult>;
	/** History the extractors left out on purpose, one line each. */
	readonly omitted?: readonly string[];
	/** Called after each turn with how many are done of how many; it may wait (to let a TUI draw). */
	readonly progress?: (done: number, total: number) => void | Promise<void>;
}

/** The preview in numbers, for a short report (the TUI's import, spec 2026-10-13-orrery-agents-design §6). */
export interface PreviewSummary {
	readonly messages: number;
	/** The earliest and latest message dates (ISO), when any message has one. */
	readonly first?: string;
	readonly last?: string;
	/** Secrets taken out, by kind. */
	readonly redactions: Readonly<Record<string, number>>;
	/** Long pastes split from the person's words, and those kept whole for review. */
	readonly splits: number;
	readonly unsplit: number;
}

function excerpt(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
}

export async function buildPreview(options: PreviewOptions): Promise<{ lines: PreviewLine[]; report: string; summary: PreviewSummary }> {
	const lines: PreviewLine[] = [];
	const redactions = new Map<string, number>();
	const redactedSources = new Set<string>();
	const splits: string[] = [];
	const unsplit: string[] = [];
	const clean = (text: string, source: string): string => {
		const result = scrub(text);
		for (const kind of result.kinds) redactions.set(kind, (redactions.get(kind) ?? 0) + 1);
		if (result.kinds.length > 0) redactedSources.add(source);
		return result.text;
	};
	let done = 0;
	for (const turn of options.turns) {
		for (const message of turn.messages) {
			const date = message.date ?? turn.start;
			const text = clean(message.text, turn.source);
			if (message.kind !== "user" || options.split === undefined || text.startsWith("[subagent] ")) {
				lines.push({ kind: message.kind, text, date, source: turn.source });
				continue;
			}
			const result = await options.split(text);
			if (result.status === "split") {
				const parts = result.segments.map((s) => `  - ${s.kind === "paste" ? `paste [${s.source ?? "?"}]` : "director"}: ${excerpt(s.text)}`);
				splits.push(`- ${turn.source} @ ${date}\n${parts.join("\n")}`);
			} else if (result.status === "unsplit") {
				unsplit.push(`- ${turn.source} @ ${date} (${result.note ?? "unsplit"}): ${excerpt(text)}`);
			}
			for (const piece of splitToMessages(result, date)) lines.push({ kind: piece.kind, text: piece.text, date, source: turn.source });
		}
		await options.progress?.(++done, options.turns.length);
	}
	for (const note of options.notes) {
		lines.push({ kind: note.message.kind, text: clean(note.message.text, note.source), date: note.message.date ?? "", source: note.source });
	}
	const bySource = new Map<string, number>();
	const byKind = new Map<string, number>();
	let bytes = 0;
	for (const line of lines) {
		const prefix = line.source.split(":")[0];
		bySource.set(prefix, (bySource.get(prefix) ?? 0) + 1);
		byKind.set(line.kind, (byKind.get(line.kind) ?? 0) + 1);
		bytes += byteSize(line.text);
	}
	const list = (map: Map<string, number>) => [...map].map(([key, count]) => `${key}: ${count}`).join(", ") || "none";
	const report = [
		"# Import preview",
		"",
		`${lines.length} messages, ${Math.round(bytes / 1000)} KB. By source: ${list(bySource)}. By kind: ${list(byKind)}.`,
		"",
		`## Paste splits (Split: ${splits.length}, needs review: ${unsplit.length})`,
		"",
		...(splits.length > 0 ? splits : ["none"]),
		"",
		"### Kept whole (could not split: review these)",
		"",
		...(unsplit.length > 0 ? unsplit : ["none"]),
		"",
		"## Left out",
		"",
		...(options.omitted?.length ? options.omitted.map((line) => `- ${line}`) : ["none"]),
		"",
		"## Redactions",
		"",
		[...redactions].map(([kind, count]) => `- ${kind}: ${count}`).join("\n") || "none",
		redactedSources.size > 0 ? `\nIn: ${[...redactedSources].join(", ")}` : "",
		"",
	].join("\n");
	// A loop, not Math.min(...dates): a long history has more dates than a call can take as arguments.
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	for (const line of lines) {
		const at = Date.parse(line.date);
		if (Number.isNaN(at)) continue;
		if (at < first) first = at;
		if (at > last) last = at;
	}
	const summary: PreviewSummary = {
		messages: lines.length,
		...(first === Number.POSITIVE_INFINITY ? {} : { first: new Date(first).toISOString(), last: new Date(last).toISOString() }),
		redactions: Object.fromEntries(redactions),
		splits: splits.length,
		unsplit: unsplit.length,
	};
	return { lines, report, summary };
}

function writePrivate(path: string, content: string): void {
	const fd = openSync(path, "w", 0o600);
	try {
		writeSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	chmodSync(path, 0o600); // A file left by an earlier run keeps its old mode otherwise.
}

export function writePreview(dir: string, lines: readonly PreviewLine[], report: string): { previewPath: string; reportPath: string } {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const previewPath = join(dir, "preview.jsonl");
	const reportPath = join(dir, "report.md");
	writePrivate(previewPath, lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length > 0 ? "\n" : ""));
	writePrivate(reportPath, report);
	return { previewPath, reportPath };
}

export function readPreview(path: string): PreviewLine[] {
	const lines: PreviewLine[] = [];
	const errors: string[] = [];
	readFileSync(path, "utf8")
		.split("\n")
		.forEach((raw, index) => {
			if (!raw.trim()) return;
			try {
				const value = JSON.parse(raw) as Partial<PreviewLine>;
				if (!isKind(value.kind)) throw new Error(`unsupported kind ${String(value.kind)}`);
				if (typeof value.text !== "string") throw new Error("text must be a string");
				if (typeof value.source !== "string") throw new Error("source must be a string");
				validDate(value.date as string);
				lines.push({ kind: value.kind, text: value.text, date: value.date as string, source: value.source });
			} catch (error) {
				errors.push(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	if (errors.length > 0) throw new Error(`Invalid preview ${path}:\n${errors.slice(0, 10).join("\n")}`);
	return lines;
}

/** Appends the whole preview in one transaction; refused once the lane's memory has any message. */
export function commitPreview(store: MemoryStore, lines: readonly PreviewLine[]): number {
	if (store.root.length > 0) {
		throw new StoreError(`This lane's memory already has ${store.root.length} messages; import must happen before the lane is used.`);
	}
	store.appendBatch(lines.map(({ kind, text, date }) => ({ kind, text, date })));
	return lines.length;
}
