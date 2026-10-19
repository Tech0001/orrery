import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { confirmPrompt, projectsFolder, TranscriptReader, transcriptIn } from "../../src/claude/transcript.ts";
import { tempDir } from "../agent/support.ts";
import { cleanupDirs, testAgent } from "./support.ts";
import { line } from "./transcript-lines.ts";

afterEach(cleanupDirs);

const P = { promptId: "p-1", text: "Ship the bridge fix." };

describe("confirmPrompt: what Claude Code's own transcript says a spooled prompt was", () => {
	it("a typed prompt (interactive) and a -p prompt (sdk, no origin) are the user's", () => {
		expect(confirmPrompt([line.typed(P.promptId, P.text)], P)).toBe("user");
		expect(confirmPrompt([line.sdk(P.promptId, P.text)], P)).toBe("user");
		expect(confirmPrompt([line.typed(P.promptId, P.text, { promptSource: "queued" })], P)).toBe("user");
	});

	it("the same promptId with other words is not the user's (an injection mid-turn reuses the turn's promptId)", () => {
		expect(confirmPrompt([line.typed(P.promptId, "Something else.")], P)).toBe("wait");
		expect(confirmPrompt([line.typed("p-2", P.text)], P)).toBe("wait");
	});

	it("a tool result under the same promptId is not a prompt, nor is a meta line, a compact summary or an unknown source", () => {
		expect(confirmPrompt([line.toolResult(P.promptId)], P)).toBe("wait");
		expect(confirmPrompt([line.typed(P.promptId, P.text, { toolUseResult: { stdout: "" } })], P)).toBe("wait");
		expect(confirmPrompt([line.typed(P.promptId, P.text, { sourceToolAssistantUUID: "a-1" })], P)).toBe("wait");
		expect(confirmPrompt([line.typed(P.promptId, P.text, { isMeta: true })], P)).toBe("wait");
		expect(confirmPrompt([line.typed(P.promptId, P.text, { isCompactSummary: true })], P)).toBe("wait");
		expect(confirmPrompt([line.typed(P.promptId, P.text, { promptSource: "system" })], P)).toBe("wait");
		expect(confirmPrompt([line.typed(P.promptId, P.text, { origin: { kind: "remote" } })], P)).toBe("wait");
	});

	it("a peer's message (a queued command from the inbox, or a peer turn) is a report, never the user's words", () => {
		expect(confirmPrompt([line.peer(P.text)], P)).toBe("report");
		expect(confirmPrompt([line.typed(P.promptId, P.text, { promptSource: "system", turnOrigin: "peer", origin: { kind: "peer" }, isMeta: true })], P)).toBe("report");
		expect(confirmPrompt([line.peer("Other words.")], P)).toBe("wait");
	});

	it("a task notification is dropped", () => {
		expect(confirmPrompt([line.typed(P.promptId, P.text, { promptSource: "system", turnOrigin: "task_notification" })], P)).toBe("drop");
		expect(confirmPrompt([line.queued(P.text, { kind: "task_notification" })], P)).toBe("drop");
	});

	it("a human's command queued mid-turn is the user's; one of unknown origin is not", () => {
		expect(confirmPrompt([line.queued(P.text, { kind: "human" })], P)).toBe("user");
		expect(confirmPrompt([line.queued(P.text, undefined)], P)).toBe("wait");
	});

	it("waits while the line is not there, and skips what isn't JSON", () => {
		expect(confirmPrompt([], P)).toBe("wait");
		expect(confirmPrompt(["{not json", line.sdk("p-0", "Earlier.")], P)).toBe("wait");
	});
});

describe("transcriptIn: a transcript path only under Claude Code's projects folder", () => {
	it("is $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects", () => {
		expect(projectsFolder({ CLAUDE_CONFIG_DIR: "/x/conf" }, "/home/u")).toBe("/x/conf/projects");
		expect(projectsFolder({}, "/home/u")).toBe("/home/u/.claude/projects");
		expect(projectsFolder({ CLAUDE_CONFIG_DIR: "" }, "/home/u")).toBe("/home/u/.claude/projects");
	});

	it("takes a .jsonl under it, there or not yet, and refuses one elsewhere, a relative one, `..` and a link out", () => {
		const dir = tempDir("orrery-transcript-");
		const projects = join(dir, "conf", "projects");
		mkdirSync(join(projects, "p"), { recursive: true });
		expect(transcriptIn(join(projects, "p", "s1.jsonl"), projects)).toBe(join(projects, "p", "s1.jsonl"));
		// A new session's file, in a project folder Claude Code has not made yet.
		expect(transcriptIn(join(projects, "new", "s1.jsonl"), projects)).toBe(join(projects, "new", "s1.jsonl"));
		expect(transcriptIn(join(dir, "elsewhere.jsonl"), projects)).toBeUndefined();
		expect(transcriptIn("p/s1.jsonl", projects)).toBeUndefined();
		expect(transcriptIn(`${projects}/p/../../out.jsonl`, projects)).toBeUndefined();
		expect(transcriptIn(join(projects, "p", "s1.txt"), projects)).toBeUndefined();
		expect(transcriptIn(42, projects)).toBeUndefined();
		mkdirSync(join(dir, "outside"));
		symlinkSync(join(dir, "outside"), join(projects, "linked"));
		expect(transcriptIn(join(projects, "linked", "s1.jsonl"), projects)).toBeUndefined();
		writeFileSync(join(dir, "outside", "real.jsonl"), "");
		symlinkSync(join(dir, "outside", "real.jsonl"), join(projects, "p", "link.jsonl"));
		expect(transcriptIn(join(projects, "p", "link.jsonl"), projects)).toBeUndefined();
	});

	it("follows a projects folder that is itself a link (a ~/.claude kept elsewhere)", () => {
		const dir = tempDir("orrery-transcript-");
		mkdirSync(join(dir, "real-conf", "projects", "p"), { recursive: true });
		symlinkSync(join(dir, "real-conf"), join(dir, "conf"));
		const projects = join(dir, "conf", "projects");
		expect(transcriptIn(join(projects, "p", "s1.jsonl"), projects)).toBe(join(projects, "p", "s1.jsonl"));
	});
});

describe("TranscriptReader", () => {
	it("reads only what was appended since its offset, a line at a time, and confirms against it", () => {
		const t = testAgent();
		const projects = join(t.dir, "conf", "projects");
		mkdirSync(join(projects, "p"), { recursive: true });
		const path = join(projects, "p", "s1.jsonl");
		writeFileSync(path, `${line.typed("p-old", P.text)}\n`);
		const offset = Buffer.byteLength(`${line.typed("p-old", P.text)}\n`);
		const reader = new TranscriptReader({ path, projects, offset });
		reader.read();
		expect(reader.confirm({ promptId: "p-old", text: P.text })).toBe("wait");
		// Half a line is left for the next read.
		const next = `${line.typed(P.promptId, P.text)}\n`;
		appendFileSync(path, next.slice(0, 20));
		reader.read();
		expect(reader.confirm(P)).toBe("wait");
		appendFileSync(path, next.slice(20));
		reader.read();
		expect(reader.confirm(P)).toBe("user");
		// The line that confirmed it is used up.
		expect(reader.confirm(P)).toBe("wait");
		expect(reader.mark().offset).toBe(offset + Buffer.byteLength(next));
	});

	it("never reads through a link at the transcript's place, nor a transcript that leads out of the projects folder", () => {
		const t = testAgent();
		const projects = join(t.dir, "conf", "projects");
		mkdirSync(join(projects, "p"), { recursive: true });
		writeFileSync(join(t.dir, "planted.jsonl"), `${line.typed(P.promptId, P.text)}\n`);
		symlinkSync(join(t.dir, "planted.jsonl"), join(projects, "p", "s1.jsonl"));
		const reader = new TranscriptReader({ path: join(projects, "p", "s1.jsonl"), projects, offset: 0 });
		reader.read();
		expect(reader.confirm(P)).toBe("wait");
	});

	it("is not held up by a FIFO in the transcript's place", () => {
		const t = testAgent();
		const projects = join(t.dir, "conf", "projects");
		mkdirSync(join(projects, "p"), { recursive: true });
		const fifo = join(projects, "p", "s1.jsonl");
		execFileSync("mkfifo", [fifo]);
		const reader = new TranscriptReader({ path: fifo, projects, offset: 0 });
		reader.read();
		expect(reader.confirm(P)).toBe("wait");
	});

	it("keeps a line it read before the prompt's event came, and a restarted reader finds it again from the mark", () => {
		const t = testAgent();
		const projects = join(t.dir, "conf", "projects");
		mkdirSync(join(projects, "p"), { recursive: true });
		const path = join(projects, "p", "s1.jsonl");
		writeFileSync(path, `${line.typed(P.promptId, P.text)}\n${line.toolResult(P.promptId)}\n`);
		const reader = new TranscriptReader({ path, projects, offset: 0 });
		reader.read();
		const again = new TranscriptReader(reader.mark());
		again.read();
		expect(again.confirm(P)).toBe("user");
	});

	it("remembers what it recorded, so a replay of the same prompt is recorded once", () => {
		const reader = new TranscriptReader({ path: "/nowhere/s1.jsonl", projects: "/nowhere", offset: 0 });
		expect(reader.recordedBefore("user", P)).toBe(false);
		reader.remember("user", P);
		expect(reader.recordedBefore("user", P)).toBe(true);
		expect(reader.recordedBefore("report", P)).toBe(false);
		expect(new TranscriptReader(reader.mark()).recordedBefore("user", P)).toBe(true);
	});
});
