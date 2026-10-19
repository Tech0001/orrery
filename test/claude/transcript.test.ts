import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { confirmPrompt, projectsFolder, TranscriptReader, transcriptIn, unreadableHere } from "../../src/claude/transcript.ts";
import { tempDir } from "../agent/support.ts";
import { cleanupDirs, testAgent } from "./support.ts";
import { line } from "./transcript-lines.ts";

afterEach(cleanupDirs);

const P = { promptId: "p-1", text: "Ship the bridge fix." };

/** A scratch Claude Code projects folder with a project folder `p`, and session s1's transcript path there. */
function projectsAt(): { projects: string; path: string } {
	const t = testAgent();
	const projects = join(t.dir, "conf", "projects");
	mkdirSync(join(projects, "p"), { recursive: true });
	return { projects, path: join(projects, "p", "s1.jsonl") };
}

describe("confirmPrompt: what Claude Code's own transcript says a spooled prompt was", () => {
	it("a typed or queued prompt with a human origin, and a -p prompt (sdk, no origin), are the user's", () => {
		expect(confirmPrompt([line.typed(P.promptId, P.text)], P)).toBe("user");
		expect(confirmPrompt([line.typed(P.promptId, P.text, { promptSource: "queued" })], P)).toBe("user");
		expect(confirmPrompt([line.sdk(P.promptId, P.text)], P)).toBe("user");
		expect(confirmPrompt([line.typed(P.promptId, P.text, { promptSource: "sdk" })], P)).toBe("user");
	});

	it("only a -p prompt goes without an origin: a typed or queued one without one is not the user's", () => {
		expect(confirmPrompt([line.typed(P.promptId, P.text, { origin: undefined })], P)).toBe("wait");
		expect(confirmPrompt([line.typed(P.promptId, P.text, { promptSource: "queued", origin: undefined })], P)).toBe("wait");
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

	it("a queued command names no promptId, so it is never the user's, whatever its origin", () => {
		expect(confirmPrompt([line.queued(P.text, { kind: "human" })], P)).toBe("wait");
		expect(confirmPrompt([line.queued(P.text, undefined)], P)).toBe("wait");
	});

	it("the user's earlier queued \"yes\" does not make a peer's later injected \"yes\" the user's (review finding)", () => {
		const injected = { promptId: "p-2", text: "yes" };
		const transcript = [line.queued("yes", { kind: "human" }), line.typed("p-2", "Do the next thing."), line.peer("yes")];
		expect(confirmPrompt(transcript, injected)).toBe("report");
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

	it.skipIf(process.platform !== "linux")("on Linux, says why when /proc/self/fd can't be read, through which a transcript is judged", () => {
		expect(unreadableHere()).toBeUndefined();
		expect(unreadableHere("/nonexistent/fd")).toBe("/nonexistent/fd can't be read, and Orrery reads Claude Code's transcript only through it");
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
		const { projects, path } = projectsAt();
		writeFileSync(path, `${line.typed("p-old", P.text)}\n`);
		const offset = Buffer.byteLength(`${line.typed("p-old", P.text)}\n`);
		const reader = new TranscriptReader({ path, projects, offset });
		reader.read();
		expect(reader.confirm({ promptId: "p-old", text: P.text }).verdict).toBe("wait");
		// Half a line is left for the next read.
		const next = `${line.typed(P.promptId, P.text, { uuid: "u-1" })}\n`;
		appendFileSync(path, next.slice(0, 20));
		reader.read();
		expect(reader.confirm(P).verdict).toBe("wait");
		appendFileSync(path, next.slice(20));
		reader.read();
		// It says which line confirmed it: its uuid.
		expect(reader.confirm(P)).toEqual({ verdict: "user", line: "uuid:u-1" });
		// That line is used up.
		expect(reader.confirm(P).verdict).toBe("wait");
		expect(reader.mark().offset).toBe(offset + Buffer.byteLength(next));
	});

	it("never reads through a link at the transcript's place, nor through a folder that leads out of the projects folder", () => {
		const t = testAgent();
		const projects = join(t.dir, "conf", "projects");
		mkdirSync(join(projects, "p"), { recursive: true });
		writeFileSync(join(t.dir, "planted.jsonl"), `${line.typed(P.promptId, P.text)}\n`);
		symlinkSync(join(t.dir, "planted.jsonl"), join(projects, "p", "s1.jsonl"));
		const reader = new TranscriptReader({ path: join(projects, "p", "s1.jsonl"), projects, offset: 0 });
		reader.read();
		expect(reader.confirm(P).verdict).toBe("wait");
		// A project folder that is a link out: the file opened is outside.
		mkdirSync(join(t.dir, "outside"));
		writeFileSync(join(t.dir, "outside", "s1.jsonl"), `${line.typed(P.promptId, P.text)}\n`);
		symlinkSync(join(t.dir, "outside"), join(projects, "q"));
		const out = new TranscriptReader({ path: join(projects, "q", "s1.jsonl"), projects, offset: 0 });
		out.read();
		expect(out.confirm(P).verdict).toBe("wait");
	});

	it("is not held up by a FIFO in the transcript's place", () => {
		const { projects, path } = projectsAt();
		execFileSync("mkfifo", [path]);
		const reader = new TranscriptReader({ path, projects, offset: 0 });
		reader.read();
		expect(reader.confirm(P).verdict).toBe("wait");
	});

	it("passes over a line longer than one read (8 MB), and reads the lines after it", () => {
		const { projects, path } = projectsAt();
		const huge = JSON.stringify({ type: "user", promptId: "p-0", message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(9 * 1024 * 1024) }] } });
		const content = `${huge}\n${line.typed(P.promptId, P.text)}\n`;
		writeFileSync(path, content);
		const reader = new TranscriptReader({ path, projects, offset: 0 });
		reader.read();
		expect(reader.confirm(P).verdict).toBe("user");
		expect(reader.mark().offset).toBe(Buffer.byteLength(content));
	});

	it("reads a transcript written anew shorter, or replaced by another file, from its start", () => {
		const { projects, path } = projectsAt();
		writeFileSync(path, `${line.sdk("p-0", "Long ago, and at length.")}\n${line.sdk("p-00", "More of it.")}\n`);
		const reader = new TranscriptReader({ path, projects, offset: 0 });
		reader.read();
		// Shorter than where it had read to.
		writeFileSync(path, `${line.sdk(P.promptId, P.text)}\n`);
		reader.read();
		expect(reader.confirm(P).verdict).toBe("user");
		// Another file in its place, as long as what was read: its lines before that offset are read too.
		const other = join(projects, "p", "other.jsonl");
		const second = { promptId: "p-2", text: "In the new file." };
		writeFileSync(other, `${line.sdk(second.promptId, second.text)}\n${line.sdk("p-3", "Padding so it is longer than before.")}\n`);
		renameSync(other, path);
		reader.read();
		expect(reader.confirm(second).verdict).toBe("user");
		// A reader started from the mark knows the file: another one at the path is read from its start as well.
		const marked = reader.mark();
		const third = { promptId: "p-4", text: "A third file." };
		writeFileSync(other, `${line.sdk(third.promptId, third.text)}\n${"{}\n".repeat(200)}`);
		renameSync(other, path);
		const again = new TranscriptReader(marked);
		again.read();
		expect(again.confirm(third).verdict).toBe("user");
	});

	it("keeps a line it read before the prompt's event came, and a restarted reader finds it again from the mark", () => {
		const { projects, path } = projectsAt();
		writeFileSync(path, `${line.typed(P.promptId, P.text)}\n${line.toolResult(P.promptId)}\n`);
		const reader = new TranscriptReader({ path, projects, offset: 0 });
		reader.read();
		const again = new TranscriptReader(reader.mark());
		again.read();
		expect(again.confirm(P).verdict).toBe("user");
	});

	it("remembers which lines confirmed what it recorded, so a replay of the same line is recorded once", () => {
		const reader = new TranscriptReader({ path: "/nowhere/s1.jsonl", projects: "/nowhere", offset: 0 });
		expect(reader.recordedBefore("uuid:u-1")).toBe(false);
		reader.remember("uuid:u-1");
		expect(reader.recordedBefore("uuid:u-1")).toBe(true);
		expect(reader.recordedBefore("uuid:u-2")).toBe(false);
		expect(new TranscriptReader(reader.mark()).recordedBefore("uuid:u-1")).toBe(true);
	});
});
