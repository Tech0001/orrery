/**
 * Separates the user's own words from pasted reports (spec §7), so the compactor does not take a pasted agent
 * report for a ruling. Claude Code's <pasted_content> tags give exact boundaries. Otherwise a model names where
 * segments start (verbatim snippets) and the text is cut from the original, so nothing is ever rewritten. If the
 * snippets cannot be found, the message is kept whole and flagged; failures are not cached.
 */

import { createHash } from "node:crypto";
import { byteSize, type NewMessage } from "../memory/index.ts";

export interface SplitModel {
	complete(system: string, user: string): Promise<string>;
}

export interface Segment {
	readonly kind: "user" | "paste";
	readonly source: string | null;
	readonly text: string;
}

export interface SplitResult {
	readonly status: "whole" | "split" | "unsplit";
	readonly segments: Segment[];
	readonly note?: string;
}

export const SPLIT_SYSTEM = `You separate one message the user typed into their own words and material they pasted in:
reports, logs or outputs from other agents or from tools.

Reply with JSON only, in this shape:
{"segments":[{"kind":"user"|"paste","source":string|null,"first":string}]}

Segments are in order and together cover the whole message. "first" is the first 40 to 60 characters of the segment,
copied exactly from the message. "source" names the agent or tool that wrote a paste when the message shows it,
never the agent it is addressed to; otherwise null. If the whole message is the user's own words, return one
user segment.`;

const PASTED = /<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content\b[^>]*>/g;

export function cacheKey(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function tagSegments(text: string): Segment[] | undefined {
	const segments: Segment[] = [];
	let last = 0;
	let found = false;
	for (const match of text.matchAll(PASTED)) {
		found = true;
		const before = text.slice(last, match.index).trim();
		if (before) segments.push({ kind: "user", source: null, text: before });
		const pasted = (match[1] ?? "").trim();
		if (pasted) segments.push({ kind: "paste", source: null, text: pasted });
		last = match.index + match[0].length;
	}
	if (!found) return undefined;
	const after = text.slice(last).trim();
	if (after) segments.push({ kind: "user", source: null, text: after });
	return segments.length > 0 ? segments : undefined;
}

/**
 * A snippet that starts mid-line but spans a line break reached back across the boundary ("scheduled.\n\nThanks."):
 * the segment starts after its last blank line, or else after its first line break.
 */
function lineStart(text: string, at: number, first: string): number {
	if (at === 0 || text[at - 1] === "\n" || !first.includes("\n")) return at;
	const blank = first.lastIndexOf("\n\n");
	let offset = blank === -1 ? first.indexOf("\n") + 1 : blank + 2;
	while (offset < first.length && /\s/.test(first[offset])) offset++;
	return at + offset;
}

interface Answer {
	readonly segments?: ReadonlyArray<{ readonly kind?: unknown; readonly source?: unknown; readonly first?: unknown }>;
}

export function locateSegments(text: string, answer: string): Segment[] | undefined {
	const json = /\{[\s\S]*\}/.exec(answer)?.[0];
	if (json === undefined) return undefined;
	let parsed: Answer;
	try {
		parsed = JSON.parse(json) as Answer;
	} catch {
		return undefined;
	}
	const raw = parsed.segments;
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	const starts: Array<{ kind: Segment["kind"]; source: string | null; at: number }> = [];
	let cursor = 0;
	for (const [index, segment] of raw.entries()) {
		if ((segment.kind !== "user" && segment.kind !== "paste") || typeof segment.first !== "string") return undefined;
		const first = segment.first.trim();
		// Short snippets are ambiguous, except a final remark that is exactly how the message ends ("Thanks.").
		const tail = index === raw.length - 1 && first.length > 0 && text.trimEnd().endsWith(first);
		if (first.length < 8 && !tail) return undefined;
		let at = tail && first.length < 8 ? text.trimEnd().length - first.length : text.indexOf(first, cursor);
		if (at === -1 || at < cursor) return undefined;
		at = lineStart(text, at, first);
		const source = typeof segment.source === "string" && segment.source.trim() ? segment.source.trim() : null;
		starts.push({ kind: segment.kind, source, at });
		cursor = at + 1;
	}
	starts[0] = { ...starts[0], at: 0 };
	return starts
		.map((start, i) => ({
			kind: start.kind,
			source: start.source,
			text: text.slice(start.at, i + 1 < starts.length ? starts[i + 1].at : text.length).trim(),
		}))
		.filter((segment) => segment.text.length > 0);
}

export interface SplitOptions {
	readonly threshold: number;
	readonly agents: readonly string[];
	/** The agent whose history this is: a paste "from" it is really addressed to it. */
	readonly agent?: string;
	readonly cache: Map<string, SplitResult>;
}

/** Sources name configured agents in their configured casing; this agent itself is never a source. */
function normalize(result: SplitResult, options: SplitOptions): SplitResult {
	const canonical = (source: string | null): string | null => {
		if (source === null) return null;
		if (options.agent !== undefined && source.toLowerCase() === options.agent.toLowerCase()) return null;
		return options.agents.find((agent) => agent.toLowerCase() === source.toLowerCase()) ?? source;
	};
	return { ...result, segments: result.segments.map((segment) => ({ ...segment, source: canonical(segment.source) })) };
}

export async function splitMessage(text: string, model: SplitModel, options: SplitOptions): Promise<SplitResult> {
	const whole: Segment[] = [{ kind: "user", source: null, text }];
	const tagged = tagSegments(text);
	if (tagged !== undefined) return { status: "split", segments: tagged };
	if (byteSize(text) <= options.threshold) return { status: "whole", segments: whole };
	const key = cacheKey(text);
	const cached = options.cache.get(key);
	// A split-cache.json written before 0.6.1 names the user's own words with an older kind: whatever is not a paste is theirs.
	if (cached !== undefined) return normalize({ ...cached, segments: cached.segments.map((s) => ({ ...s, kind: s.kind === "paste" ? "paste" : "user" })) }, options);
	let answer: string;
	try {
		// Changing a model prompt's words is a decision of its own: keep them byte for byte unless one is made.
		const known = options.agents.length > 0 ? `\n\nKnown agents: ${options.agents.join(", ")}.` : "";
		const own =
			options.agent === undefined
				? ""
				: `\n\nThis is ${options.agent}'s conversation: the user talks to ${options.agent}. A block that starts "${options.agent}:" ` +
					`is addressed to ${options.agent}, so ${options.agent} is never its source.`;
		answer = await model.complete(`${SPLIT_SYSTEM}${known}${own}`, text);
	} catch (error) {
		return { status: "unsplit", segments: whole, note: `split failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	const segments = locateSegments(text, answer);
	if (segments === undefined) return { status: "unsplit", segments: whole, note: "the model's boundaries were not found in the text" };
	const result: SplitResult = segments.every((s) => s.kind === "user") ? { status: "whole", segments: whole } : { status: "split", segments };
	options.cache.set(key, result);
	return normalize(result, options);
}

export function splitToMessages(result: SplitResult, date: string): NewMessage[] {
	return result.segments.map((segment) => ({
		kind: "user",
		text: segment.kind === "user" ? segment.text : `[${segment.source ?? "paste"}] ${segment.text}`,
		date,
	}));
}
