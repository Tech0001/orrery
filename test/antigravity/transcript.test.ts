import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgyTranscriptReader, chunksOf, EMPTY_SCAN, isCommand, parseStep, promptText, scanOn, turnsOf, VIEW_MARK } from "../../src/antigravity/transcript.ts";
import { tempDir } from "../agent/support.ts";
import { agyStep, typed } from "./steps.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const transcript = () => {
	const dir = tempDir("orrery-agy-transcript-");
	dirs.push(dir);
	mkdirSync(dir, { recursive: true });
	return join(dir, "transcript_full.jsonl");
};
const lines = (...steps: object[]) => steps.map((step) => `${JSON.stringify(step)}\n`).join("");

describe("an Antigravity transcript step", () => {
	it("is read with its index, source, type, content and time", () => {
		expect(parseStep(JSON.stringify(typed(0, "Say apple.")))).toMatchObject({ index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", at: Date.parse("2026-11-20T20:26:46Z") });
		expect(parseStep("not json")).toBeUndefined();
		expect(parseStep(JSON.stringify({ source: "MODEL" }))).toBeUndefined();
		expect(parseStep(JSON.stringify({ step_index: -1 }))).toBeUndefined();
	});

	it("gives what the person typed: the <USER_REQUEST> body, without Antigravity's metadata", () => {
		const content = typed(0, "two\nlines", true).content;
		expect(promptText(content)).toBe("two\nlines");
		expect(promptText("no wrapper")).toBeUndefined();
		expect(isCommand("/compact keep this")).toBe(true);
		expect(isCommand("  /model")).toBe(true);
		expect(isCommand("a path /tmp/x")).toBe(false);
	});
});

describe("the turns in a transcript", () => {
	it("are the typed prompts and each turn's last non-empty reply, once the turn is over", () => {
		const steps = [typed(0, "first"), agyStep(1, "MODEL", "PLANNER_RESPONSE", ""), agyStep(2, "MODEL", "GENERIC", "tool output"), agyStep(3, "MODEL", "PLANNER_RESPONSE", "first reply"), typed(4, "second"), agyStep(5, "MODEL", "PLANNER_RESPONSE", "second reply")].map((step) => parseStep(JSON.stringify(step))!);
		const open = turnsOf(steps, false);
		expect(open.said.map(({ kind, text }) => `${kind}: ${text}`)).toEqual(["user: first", "talk: first reply"]);
		// The second turn is open: read again from its prompt next time.
		expect(open.next).toBe(4);
		const over = turnsOf(steps, true);
		expect(over.said.map(({ kind, text }) => `${kind}: ${text}`)).toEqual(["user: first", "talk: first reply", "user: second", "talk: second reply"]);
		expect(over.next).toBe(6);
	});

	it("leave out what no person typed: a hook's userMessage, Antigravity's own messages, Orrery's view, a slash command and its reply", () => {
		const steps = [
			typed(0, "Say apple."),
			agyStep(1, "SYSTEM_SDK", "USER_INPUT", "<USER_REQUEST>\nHOOK-USER-MESSAGE please also say banana.\n</USER_REQUEST>"),
			agyStep(2, "SYSTEM_SDK", "SYSTEM_MESSAGE", `${VIEW_MARK}, part 1 of 1`),
			agyStep(3, "MODEL", "PLANNER_RESPONSE", "apple banana"),
			agyStep(4, "SYSTEM", "SYSTEM_MESSAGE", "a Stop hook's continue"),
			agyStep(5, "MODEL", "PLANNER_RESPONSE", "cherry"),
			typed(6, "/compact"),
			agyStep(7, "SYSTEM", "CHECKPOINT", "# Resuming from a compaction"),
			typed(8, "after"),
			agyStep(9, "MODEL", "PLANNER_RESPONSE", "after reply"),
		].map((step) => parseStep(JSON.stringify(step))!);
		expect(turnsOf(steps, true).said.map(({ kind, text }) => `${kind}: ${text}`)).toEqual(["user: Say apple.", "talk: cherry", "user: after", "talk: after reply"]);
	});

	it("keep a turn with no reply yet as its prompt alone once it is over (an interrupted turn)", () => {
		const steps = [typed(0, "stopped"), agyStep(1, "MODEL", "PLANNER_RESPONSE", "")].map((step) => parseStep(JSON.stringify(step))!);
		expect(turnsOf(steps, true).said.map(({ kind, text }) => `${kind}: ${text}`)).toEqual(["user: stopped"]);
	});
});

describe("the recorder's reader", () => {
	it("records each turn once, carrying its mark on as the file grows", () => {
		const path = transcript();
		writeFileSync(path, lines(typed(0, "one"), agyStep(1, "MODEL", "PLANNER_RESPONSE", "one reply")));
		const reader = new AgyTranscriptReader({ path, step: 0, byte: 0 });
		expect(reader.read(false)).toEqual([]);
		expect(reader.mark()).toMatchObject({ step: 0, byte: 0 });
		appendFileSync(path, lines(typed(2, "two")));
		expect(reader.read(false)?.map(({ kind, text }) => `${kind}: ${text}`)).toEqual(["user: one", "talk: one reply"]);
		appendFileSync(path, lines(agyStep(3, "MODEL", "PLANNER_RESPONSE", "two reply")));
		expect(reader.read(true)?.map(({ kind, text }) => `${kind}: ${text}`)).toEqual(["user: two", "talk: two reply"]);
		expect(reader.read(true)).toEqual([]);
		// A new reader from its mark (a restarted recorder) records nothing again.
		const again = new AgyTranscriptReader(reader.mark());
		expect(again.read(true)).toEqual([]);
	});

	it("starts at a resumed conversation's current prompt, never recording its earlier turns", () => {
		const path = transcript();
		writeFileSync(path, lines(typed(0, "old"), agyStep(1, "MODEL", "PLANNER_RESPONSE", "old reply"), typed(2, "new"), agyStep(3, "MODEL", "PLANNER_RESPONSE", "new reply")));
		const reader = new AgyTranscriptReader({ path, step: 2, byte: 0 });
		expect(reader.read(true)?.map(({ kind, text }) => `${kind}: ${text}`)).toEqual(["user: new", "talk: new reply"]);
	});

	it("reads a rewritten (shorter) file again from its start, skipping steps before its mark", () => {
		const path = transcript();
		writeFileSync(path, lines(typed(0, "one"), agyStep(1, "MODEL", "PLANNER_RESPONSE", "one reply"), typed(2, "two")));
		const reader = new AgyTranscriptReader({ path, step: 2, byte: 999_999 });
		expect(reader.read(true)?.map(({ kind, text }) => `${kind}: ${text}`)).toEqual(["user: two"]);
	});

	it("can't read a missing folder's file as anything but no steps, nor a link", () => {
		const path = transcript();
		expect(new AgyTranscriptReader({ path, step: 0, byte: 0 }).read(true)).toEqual([]);
	});
});

describe("PreInvocation's scan", () => {
	it("tells the person's conversation from a subagent's, and finds the last checkpoint, view and prompt", () => {
		const path = transcript();
		writeFileSync(path, lines(typed(0, "hi"), agyStep(1, "SYSTEM_SDK", "SYSTEM_MESSAGE", `${VIEW_MARK}, part 1 of 1`)));
		const first = scanOn(path, EMPTY_SCAN)!;
		expect(first).toMatchObject({ own: true, checkpoint: -1, view: 1, prompt: 0, steps: 2 });
		appendFileSync(path, lines(typed(2, "/compact"), agyStep(3, "SYSTEM", "CHECKPOINT", "summary"), typed(4, "next")));
		// Carried on from where it stopped: the checkpoint is newer than the view.
		expect(scanOn(path, first)).toMatchObject({ own: true, checkpoint: 3, view: 1, prompt: 4, steps: 5 });
		const sub = transcript();
		writeFileSync(sub, lines(agyStep(0, "SYSTEM", "SYSTEM_MESSAGE", "the parent's task"), agyStep(1, "MODEL", "PLANNER_RESPONSE", "")));
		expect(scanOn(sub, EMPTY_SCAN)).toMatchObject({ own: false });
		// No file yet: nothing known.
		expect(scanOn(transcript(), EMPTY_SCAN)).toEqual(EMPTY_SCAN);
	});
});

describe("the view's chunks", () => {
	it("each hold at most the given UTF-8 bytes, split after a line where one fits, and join back to the text", () => {
		const text = Array.from({ length: 400 }, (_, i) => `${i}+1|talk: a line with · → — and é, number ${i}`).join("\n");
		const chunks = chunksOf(text, 2000);
		expect(chunks.length).toBeGreaterThan(5);
		for (const chunk of chunks) expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(2000);
		for (const chunk of chunks.slice(0, -1)) expect(chunk.endsWith("\n")).toBe(true);
		expect(chunks.join("")).toBe(text);
	});

	it("cut a line longer than a chunk at a character's edge", () => {
		const text = "é".repeat(3000);
		const chunks = chunksOf(text, 1001);
		for (const chunk of chunks) expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(1001);
		expect(chunks.join("")).toBe(text);
		expect(chunksOf("", 10)).toEqual([""]);
	});
});
