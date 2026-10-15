import { describe, expect, it } from "vitest";
import { cacheKey, locateSegments, type SplitResult, splitMessage, splitToMessages } from "../../src/import/split.ts";

const TEXT =
	"Aspen finished; please check the result below and tell Maple.\n\n" +
	"Willow report: SAMPLE-REPORT-COMPLETE at marker 0042. Notes in examples/map/REPORT.md.\n\n" +
	"After that, plan the next relay.";
const ANSWER = JSON.stringify({
	segments: [
		{ kind: "user", source: null, first: "Aspen finished; please check the result" },
		{ kind: "paste", source: "Willow", first: "Willow report: SAMPLE-REPORT-COMPLETE" },
		{ kind: "user", source: null, first: "After that, plan the next relay." },
	],
});

const model = (answer: string | Error) => ({
	calls: 0,
	async complete() {
		this.calls++;
		if (answer instanceof Error) throw answer;
		return answer;
	},
});

const options = () => ({ threshold: 100, agents: ["Willow", "Maple"], cache: new Map<string, SplitResult>() });

describe("locateSegments", () => {
	it("cuts the original text at the snippets, covering every character", () => {
		const segments = locateSegments(TEXT, `Sure:\n${ANSWER}`);
		expect(segments?.map((s) => [s.kind, s.source])).toEqual([
			["user", null],
			["paste", "Willow"],
			["user", null],
		]);
		expect(segments?.map((s) => s.text).join("\n\n")).toBe(TEXT);
	});

	it("accepts a short final remark and never cuts inside a paste when the snippet reaches back across the boundary", () => {
		const report = `Cedar report: the demo startup is green. ${"Detail line. ".repeat(40)}Next review is scheduled.`;
		const text = `${report}\n\nThanks.`;
		const short = locateSegments(
			text,
			JSON.stringify({ segments: [{ kind: "paste", source: "Cedar", first: "Cedar report: the demo startup" }, { kind: "user", source: null, first: "Thanks." }] }),
		);
		expect(short?.map((s) => [s.kind, s.text])).toEqual([
			["paste", report],
			["user", "Thanks."],
		]);
		const padded = locateSegments(
			text,
			JSON.stringify({ segments: [{ kind: "paste", source: "Cedar", first: "Cedar report: the demo startup" }, { kind: "user", source: null, first: "scheduled.\n\nThanks." }] }),
		);
		expect(padded?.map((s) => s.text)).toEqual([report, "Thanks."]);
	});

	it("rejects snippets that are not in the text, out of order, too short, or malformed", () => {
		const invented = JSON.stringify({ segments: [{ kind: "paste", source: "Cedar", first: "words the user never wrote" }] });
		expect(locateSegments(TEXT, invented)).toBeUndefined();
		const reversed = JSON.stringify({
			segments: [
				{ kind: "user", source: null, first: "After that, plan the next relay." },
				{ kind: "paste", source: "Willow", first: "Willow report: SAMPLE-REPORT-COMPLETE" },
			],
		});
		expect(locateSegments(TEXT, reversed)).toBeUndefined();
		expect(locateSegments(TEXT, JSON.stringify({ segments: [{ kind: "user", source: null, first: "Asp" }] }))).toBeUndefined();
		expect(locateSegments(TEXT, "not json")).toBeUndefined();
	});
});

describe("splitMessage", () => {
	it("never calls the model for short untagged messages", async () => {
		const m = model(ANSWER);
		expect(await splitMessage("short", m, options())).toEqual({ status: "whole", segments: [{ kind: "user", source: null, text: "short" }] });
		expect(m.calls).toBe(0);
	});

	it("splits Claude Code's pasted_content tags exactly, without the model", async () => {
		const m = model(ANSWER);
		const text = 'Check this:\n<pasted_content id="f1">\nCedar report: demo green.\n</pasted_content>\nThoughts?';
		expect(await splitMessage(text, m, options())).toEqual({
			status: "split",
			segments: [
				{ kind: "user", source: null, text: "Check this:" },
				{ kind: "paste", source: null, text: "Cedar report: demo green." },
				{ kind: "user", source: null, text: "Thoughts?" },
			],
		});
		expect(m.calls).toBe(0);
	});

	it("accepts the closing tag with an id, as Claude Code writes it", async () => {
		const m = model(ANSWER);
		const text = 'See <pasted_content id="f876">\nreport one\n</pasted_content id="f876"> and <pasted_content id="a1">two</pasted_content id="a1">';
		const result = await splitMessage(text, m, options());
		expect(result.segments.map((s) => [s.kind, s.text])).toEqual([
			["user", "See"],
			["paste", "report one"],
			["user", "and"],
			["paste", "two"],
		]);
		expect(m.calls).toBe(0);
	});

	it("splits a long message with the model and caches the result", async () => {
		const m = model(ANSWER);
		const opts = options();
		const first = await splitMessage(TEXT, m, opts);
		expect(first.status).toBe("split");
		expect(await splitMessage(TEXT, m, opts)).toEqual(first);
		expect(m.calls).toBe(1);
		expect(opts.cache.has(cacheKey(TEXT))).toBe(true);
	});

	it("names the author, not the addressee: a source equal to this agent becomes a plain paste, and agent names keep their casing", async () => {
		const text =
			"Atlas: ▎ Cedar's rulings on your questions: ▎ (1) garden-plants becomes a real plant group.\n\n" +
			"BIRCH NOTE: map updated, plot 4 is next in the queue for review.\n\nGo ahead.";
		const answer = JSON.stringify({
			segments: [
				{ kind: "paste", source: "Atlas", first: "Atlas: ▎ Cedar's rulings on your questions" },
				{ kind: "paste", source: "BIRCH", first: "BIRCH NOTE: map updated, plot 4 is next" },
				{ kind: "user", source: null, first: "Go ahead." },
			],
		});
		let system = "";
		const result = await splitMessage(
			text,
			{ complete: async (s: string) => ((system = s), answer) },
			{ threshold: 10, agents: ["Atlas", "Birch", "Cedar"], agent: "Atlas", cache: new Map() },
		);
		expect(result.segments.map((s) => s.source)).toEqual([null, "Birch", null]);
		expect(system).toContain("This is Atlas's conversation: the user talks to Atlas.");
		expect(system).toContain("You separate one message the user typed into their own words");
		expect(system).toContain("reports, logs or outputs from other agents or from tools.");
		expect(system).toContain('{"segments":[{"kind":"user"|"paste","source":string|null,"first":string}]}');
		expect(system).toContain('"source" names the agent or tool that wrote a paste when the message shows it,\nnever the agent it is addressed to;');
		expect(system).toContain("If the whole message is the user's own words, return one\nuser segment.");
		expect(system).toContain("Known agents: Atlas, Birch, Cedar.");
	});

	it("splits again, and replaces, a cached entry with a kind this version does not write (an older version's, or a damaged one)", async () => {
		const m = model(ANSWER);
		const opts = options();
		const entry = (kind: string) => ({ status: "split", segments: [{ kind, source: null, text: "my words" }, { kind: "paste", source: "Willow", text: "their report" }] }) as unknown as SplitResult;
		opts.cache.set(cacheKey(TEXT), entry("older"));
		const split = await splitMessage(TEXT, m, opts);
		expect(m.calls).toBe(1);
		expect(split.segments.map((s) => s.kind)).toEqual(["user", "paste", "user"]);
		expect(opts.cache.get(cacheKey(TEXT))?.segments.map((s) => s.kind)).toEqual(["user", "paste", "user"]);
		// An entry in this version's kinds is used as it is.
		opts.cache.set(cacheKey(TEXT), entry("user"));
		expect(splitToMessages(await splitMessage(TEXT, m, opts), "2026-08-01T00:00:00.000Z").map((s) => s.text)).toEqual(["my words", "[Willow] their report"]);
		expect(m.calls).toBe(1);
		// An entry with no segments list at all is split again too, rather than stopping the import.
		opts.cache.set(cacheKey(TEXT), { status: "split" } as unknown as SplitResult);
		expect((await splitMessage(TEXT, m, opts)).segments.map((s) => s.kind)).toEqual(["user", "paste", "user"]);
		expect(m.calls).toBe(2);
	});

	it("keeps the message whole, flags it, and does not cache when the model fails or invents boundaries", async () => {
		for (const answer of [new Error("rate limited"), JSON.stringify({ segments: [{ kind: "paste", source: "X", first: "nonexistent text here" }] })]) {
			const opts = options();
			const result = await splitMessage(TEXT, model(answer), opts);
			expect(result.status).toBe("unsplit");
			expect(result.segments).toEqual([{ kind: "user", source: null, text: TEXT }]);
			expect(result.note).toBeTruthy();
			expect(opts.cache.size).toBe(0);
		}
	});
});

describe("splitToMessages", () => {
	it("keeps the user's words as user and labels pastes as reports", () => {
		const result: SplitResult = {
			status: "split",
			segments: [
				{ kind: "user", source: null, text: "my words" },
				{ kind: "paste", source: "Willow", text: "their report" },
				{ kind: "paste", source: null, text: "a log" },
			],
		};
		expect(splitToMessages(result, "2026-08-01T00:00:00.000Z")).toEqual([
			{ kind: "user", text: "my words", date: "2026-08-01T00:00:00.000Z" },
			{ kind: "user", text: "[Willow] their report", date: "2026-08-01T00:00:00.000Z" },
			{ kind: "user", text: "[paste] a log", date: "2026-08-01T00:00:00.000Z" },
		]);
	});
});
