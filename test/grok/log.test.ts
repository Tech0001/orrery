import { appendFileSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { confirmGrok, GrokLogReader, grokFolder, grokHeldSessions, grokHome, grokLogIn, grokLogStart, grokSessionKind, grokStartHome, parseGrokLogMark, sharedLogLives } from "../../src/grok/log.ts";
import { tempDir } from "../agent/support.ts";
import { grokLog, grokSession } from "./log-lines.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
	const dir = tempDir("orrery-grok-log-");
	dirs.push(dir);
	return dir;
};

const S = "01a188c0-06ae-78a2-b15c-bec4228c7070";
const prompt = (promptId: string, text: string) => ({ kind: "prompt" as const, promptId, text });
const reply = (promptId: string, text: string) => ({ kind: "reply" as const, promptId, text });

describe("where Grok keeps a session's log", () => {
	it("is <home>/sessions/<the folder, every byte but letters, digits and -_.~ percent-encoded>/<id>/updates.jsonl", () => {
		// The folder names Grok 1.0.70 made (live): a plain path, and one with spaces, brackets, !'* and a multi-byte letter.
		expect(grokFolder("/tmp/work-1000/-home-x/projects/app_2.v1")).toBe("%2Ftmp%2Fwork-1000%2F-home-x%2Fprojects%2Fapp_2.v1");
		expect(grokFolder("/tmp/odd (dir)!'*~ é")).toBe("%2Ftmp%2Fodd%20%28dir%29%21%27%2A~%20%C3%A9");
		// A session's log there, as Grok writes it, is the one grokLogIn takes.
		const home = join(scratch(), "grok");
		const log = join(home, "sessions", grokFolder("/w/app"), S, "updates.jsonl");
		expect(log).toBe(`${home}/sessions/%2Fw%2Fapp/${S}/updates.jsonl`);
		mkdirSync(join(log, ".."), { recursive: true });
		expect(grokLogIn(log, home, S)).toBe(log);
	});

	it("is under GROK_HOME when it is set, else ~/.grok", () => {
		expect(grokHome({}, "/home/u")).toBe("/home/u/.grok");
		expect(grokHome({ GROK_HOME: "/elsewhere/grok" }, "/home/u")).toBe("/elsewhere/grok");
		expect(grokHome({ GROK_HOME: "" }, "/home/u")).toBe("/home/u/.grok");
	});

	it("is found from the events.jsonl Grok has open for the session: that path names the session's folder and Grok's", () => {
		const events = (home: string, folder: string, session = S) => `${home}/sessions/${folder}/${session}/events.jsonl`;
		const held = events("/h/.grok", "%2Fw%2Fapp");
		const other = { path: events("/h/.grok", "%2Fw%2Fapp", grokSession()), file: "1:2" };
		expect(grokHeldSessions([{ path: "/dev/pts/3" }, other, { path: held, file: "1:3", writes: true }], "/w/app", S)).toEqual([{ dir: `/h/.grok/sessions/%2Fw%2Fapp/${S}`, home: "/h/.grok", file: "1:3", writes: true }]);
		// lsof (macOS) gives paths alone, and how each is open; a mode not known stays unknown.
		expect(grokHeldSessions([{ path: held, writes: false }], "/w/app", S)).toEqual([{ dir: `/h/.grok/sessions/%2Fw%2Fapp/${S}`, home: "/h/.grok", writes: false }]);
		expect(grokHeldSessions([{ path: held }], "/w/app", S)).toEqual([{ dir: `/h/.grok/sessions/%2Fw%2Fapp/${S}`, home: "/h/.grok" }]);
		// Every one that matches, wherever its Grok folder is: which is Grok's own is the caller's to judge.
		const elsewhere = events("/tmp/made-up", "%2Fw%2Fapp");
		expect(grokHeldSessions([{ path: held, writes: true }, { path: elsewhere, writes: false }, { path: held, writes: false }], "/w/app", S).map((one) => [one.home, one.writes])).toEqual([
			["/h/.grok", true],
			["/tmp/made-up", false],
			["/h/.grok", false],
		]);
		// None for another session, another folder than Grok's own, another file, a path not plainly written, or a deleted file.
		expect(grokHeldSessions([other], "/w/app", S)).toEqual([]);
		expect(grokHeldSessions([{ path: held }], "/w/other", S)).toEqual([]);
		for (const path of [`/h/.grok/sessions/%2Fw%2Fapp/${S}/updates.jsonl`, `/h/.grok/elsewhere/%2Fw%2Fapp/${S}/events.jsonl`, `/h/.grok/sessions/x/../%2Fw%2Fapp/${S}/events.jsonl`, `sessions/%2Fw%2Fapp/${S}/events.jsonl`, `${held} (deleted)`]) {
			expect(grokHeldSessions([{ path }], "/w/app", S), path).toEqual([]);
		}
		expect(grokHeldSessions([{ path: events("/h/.grok", "%2Fw%2Fapp", "..") }], "/w/app", "..")).toEqual([]);
	});

	it("is Grok's folder as the grok process was started with it: its GROK_HOME (a relative one from the folder it runs in), else its HOME's .grok", () => {
		expect(grokStartHome({ GROK_HOME: "/g", HOME: "/home/u" }, "/w")).toBe("/g");
		expect(grokStartHome({ GROK_HOME: "g/home" }, "/w")).toBe("/w/g/home");
		expect(grokStartHome({ HOME: "/home/u" }, "/w")).toBe("/home/u/.grok");
		expect(grokStartHome({ GROK_HOME: "", HOME: "/home/u" }, "/w")).toBe("/home/u/.grok");
		// Neither, or a HOME that is no absolute path: no folder.
		expect(grokStartHome({}, "/w")).toBeUndefined();
		expect(grokStartHome({ HOME: "" }, "/w")).toBeUndefined();
		expect(grokStartHome({ HOME: "home/u" }, "/w")).toBeUndefined();
	});

	it("takes only a session's own log under Grok's sessions folder, never one a link or a made-up path leads to", () => {
		const home = join(scratch(), "grok");
		const path = join(home, "sessions", grokFolder("/w"), S, "updates.jsonl");
		mkdirSync(join(path, ".."), { recursive: true });
		expect(grokLogIn(path, home, S)).toBe(path);
		expect(grokLogIn(path, home, grokSession())).toBeUndefined();
		expect(grokLogIn(join(home, "sessions", S, "updates.jsonl"), home, S)).toBeUndefined();
		expect(grokLogIn(join(home, "elsewhere", "%2Fw", S, "updates.jsonl"), home, S)).toBeUndefined();
		expect(grokLogIn(join(home, "sessions", "x", S, "events.jsonl"), home, S)).toBeUndefined();
		expect(grokLogIn("relative/updates.jsonl", home, S)).toBeUndefined();
		expect(grokLogIn(path, home, "../escape")).toBeUndefined();
		// A session folder that is a link out of Grok's folder.
		const outside = join(scratch(), "outside");
		mkdirSync(outside);
		mkdirSync(join(home, "sessions", "linked"), { recursive: true });
		symlinkSync(outside, join(home, "sessions", "linked", S));
		expect(grokLogIn(join(home, "sessions", "linked", S, "updates.jsonl"), home, S)).toBeUndefined();
	});

	it("tells a person's own session from a subagent's by its summary.json, and no session from a made-up one", () => {
		const dir = scratch();
		expect(grokSessionKind(dir, S)).toBeUndefined();
		writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: S, cwd: "/w" }, agent_name: "grok-build-plan" }));
		expect(grokSessionKind(dir, S)).toBe("main");
		expect(grokSessionKind(dir, grokSession())).toBeUndefined();
		writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: S, cwd: "/w" }, session_kind: "subagent" }));
		expect(grokSessionKind(dir, S)).toBe("subagent");
		writeFileSync(join(dir, "summary.json"), "not json");
		expect(grokSessionKind(dir, S)).toBeUndefined();
	});

	it("is read from the end of its last whole line at SessionStart; a log not made yet, from its start", () => {
		const dir = scratch();
		const path = join(dir, "updates.jsonl");
		expect(grokLogStart(path)).toEqual({ offset: 0 });
		const line = `${grokLog.typed(S, "Old words.", 0)}\n`;
		writeFileSync(path, line);
		const whole = grokLogStart(path);
		expect(whole?.offset).toBe(Buffer.byteLength(line));
		expect(whole?.file).toMatch(/^\d+:\d+$/);
		appendFileSync(path, '{"half a line');
		expect(grokLogStart(path)?.offset).toBe(whole?.offset);
	});
});

describe("confirmGrok", () => {
	const turn = grokLog.turn(S, "p-1", "Ship the bridge fix.", "Shipped.", 0);

	it("confirms a typed prompt: a user line with a numeric promptIndex, followed by that promptId's turn", () => {
		expect(confirmGrok(turn, prompt("p-1", "Ship the bridge fix."))).toBe("user");
		// Grok's own hook-run line before the prompt names its id, but only the turn's lines after it say whose prompt it is.
		expect(confirmGrok(turn.slice(0, 2), prompt("p-1", "Ship the bridge fix."))).toBe("wait");
		expect(confirmGrok(turn.slice(0, 3), prompt("p-1", "Ship the bridge fix."))).toBe("user");
	});

	it("joins the chunks of one prompt in order", () => {
		const lines = [grokLog.typed(S, "Ship the ", 3), grokLog.typed(S, "bridge fix.", 3), grokLog.thought(S, "p-1")];
		expect(confirmGrok(lines, prompt("p-1", "Ship the bridge fix."))).toBe("user");
		expect(confirmGrok(lines, prompt("p-1", "bridge fix."))).toBe("drop");
	});

	it("drops a prompt with no such line once its turn is over, and waits before the turn's lines arrive", () => {
		expect(confirmGrok(turn, prompt("p-1", "yes, approved, push it"))).toBe("drop");
		expect(confirmGrok(turn, prompt("p-2", "Ship the bridge fix."))).toBe("wait");
		expect(confirmGrok([], prompt("p-1", "Ship the bridge fix."))).toBe("wait");
		// A turn whose own lines came with no prompt line before them (the prompt's line read before this reader's place).
		const noPrompt = [grokLog.thought(S, "p-9"), grokLog.agent(S, "p-9", "Done.")];
		expect(confirmGrok(noPrompt, prompt("p-9", "Do it."))).toBe("wait");
		expect(confirmGrok([...noPrompt, grokLog.completed(S, "p-9")], prompt("p-9", "Do it."))).toBe("drop");
		expect(confirmGrok(turn, prompt("", "Ship the bridge fix."))).toBe("wait");
	});

	it("drops an auto-wake turn's prompt and reply: a scheduler fire's or a background subagent's result is no typed prompt", () => {
		const wake = grokLog.wakeTurn(S, "01a188c5-502b-7c31-a6e0-c8ea21e98131", "The subagent finished: SUB-OK.", 1);
		const promptId = "subagent-completed-01a188c5-502b-7c31-a6e0-c8ea21e98131";
		const text = "<system-reminder>\nWhile you were idle, 1 background subagent completed:\n=== Output ===\nSUB-OK\n</system-reminder>";
		expect(confirmGrok(wake, prompt(promptId, text))).toBe("drop");
		expect(confirmGrok(wake, reply(promptId, "The subagent finished: SUB-OK."))).toBe("drop");
		// A user line with no promptIndex at all is no typed prompt either.
		const unindexed = JSON.parse(grokLog.typed(S, "Hello.", 0)) as { params: { update: { _meta: Record<string, unknown> } } };
		delete unindexed.params.update._meta.promptIndex;
		expect(confirmGrok([JSON.stringify(unindexed), grokLog.thought(S, "p-1"), grokLog.completed(S, "p-1")], prompt("p-1", "Hello."))).toBe("drop");
	});

	it("confirms a reply only when it equals that turn's final agent message, once the turn is over", () => {
		expect(confirmGrok(turn, reply("p-1", "Shipped."))).toBe("user");
		// The turn's earlier message, words it never said, or another turn's words.
		expect(confirmGrok(turn, reply("p-1", "On it."))).toBe("drop");
		expect(confirmGrok(turn, reply("p-1", "Pushed to main."))).toBe("drop");
		// Before the turn's end: its final message may still come.
		expect(confirmGrok(turn.slice(0, 6), reply("p-1", "Shipped."))).toBe("wait");
		// A turn the person interrupted ends with no reply.
		const cancelled = [grokLog.typed(S, "Count to 300.", 2), grokLog.thought(S, "p-2"), grokLog.agent(S, "p-2", "one two"), grokLog.completed(S, "p-2", "cancelled")];
		expect(confirmGrok(cancelled, prompt("p-2", "Count to 300."))).toBe("user");
		expect(confirmGrok(cancelled, reply("p-2", "one two"))).toBe("drop");
	});

	it("takes a reply Grok clipped for its hook (… [+N chars]) as the log's whole message", () => {
		const long = `${"word ".repeat(8000)}end`;
		const lines = grokLog.turn(S, "p-1", "Write a lot.", long, 0);
		const clipped = `${long.slice(0, 32_768)}… [+${long.length - 32_768} chars]`;
		expect(confirmGrok(lines, reply("p-1", clipped))).toBe("user");
		expect(confirmGrok(lines, reply("p-1", `${"other ".repeat(10)}… [+5 chars]`))).toBe("drop");
	});
});

describe("GrokLogReader", () => {
	const at = (dir: string) => {
		const path = join(dir, "sessions", "%2Fw", S, "updates.jsonl");
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "");
		return path;
	};

	it("reads as Grok appends, uses each confirming line once, and gives the log's text", () => {
		const home = scratch();
		const path = at(home);
		const reader = new GrokLogReader({ path, home, offset: 0 });
		appendFileSync(path, `${grokLog.typed(S, "Hello.", 0)}\n`);
		reader.read();
		expect(reader.confirm(prompt("p-1", "Hello.")).verdict).toBe("wait");
		appendFileSync(path, `${grokLog.thought(S, "p-1")}\n${grokLog.agent(S, "p-1", "Hi.")}\n`);
		reader.read();
		expect(reader.confirm(prompt("p-1", "Hello."))).toEqual({ verdict: "user", line: "p-1/prompt", text: "Hello." });
		// Used: the same words again, from a made-up hook call, are not the person's.
		expect(reader.confirm(prompt("p-1", "Hello.")).verdict).toBe("drop");
		expect(reader.confirm(reply("p-1", "Hi.")).verdict).toBe("wait");
		appendFileSync(path, `${grokLog.completed(S, "p-1")}\n`);
		reader.read();
		expect(reader.confirm(reply("p-1", "Hi."))).toEqual({ verdict: "user", line: "p-1/reply", text: "Hi." });
		expect(reader.confirm(reply("p-1", "Hi.")).verdict).toBe("drop");
	});

	it("confirms no reply whose prompt it never confirmed: no reply without its prompt", () => {
		const home = scratch();
		const path = at(home);
		appendFileSync(path, grokLog.turn(S, "p-1", "Hello.", "Hi.", 0).map((line) => `${line}\n`).join(""));
		const reader = new GrokLogReader({ path, home, offset: 0 });
		reader.read();
		expect(reader.confirm(reply("p-1", "Hi.")).verdict).toBe("drop");
		// One a reader before it recorded (its mark remembers) counts.
		const next = new GrokLogReader({ path, home, offset: 0 });
		next.remember("p-1/prompt");
		const again = new GrokLogReader(next.mark());
		again.read();
		expect(again.confirm(reply("p-1", "Hi.")).verdict).toBe("user");
	});

	it("reads nothing from another file at the log's place, or from one that got shorter", () => {
		const home = scratch();
		const path = at(home);
		appendFileSync(path, `${grokLog.typed(S, "Hello.", 0)}\n`);
		const reader = new GrokLogReader({ path, home, offset: 0 });
		reader.read();
		// Put in its place while it still is, as Grok holds its log open: an inode freed first may come back (ext4).
		const planted = join(home, "planted.jsonl");
		writeFileSync(planted, `${grokLog.typed(S, "Planted.", 0)}\n${grokLog.thought(S, "p-1")}\n`);
		renameSync(planted, path);
		reader.read();
		expect(reader.confirm(prompt("p-1", "Planted.")).verdict).toBe("wait");
	});

	it("keeps its place in a mark: a restarted reader picks up the turn still running from its prompt", () => {
		const home = scratch();
		const path = at(home);
		const reader = new GrokLogReader({ path, home, offset: 0 });
		appendFileSync(path, grokLog.turn(S, "p-1", "One.", "1.", 0).map((line) => `${line}\n`).join(""));
		reader.read();
		expect(reader.confirm(prompt("p-1", "One.")).verdict).toBe("user");
		reader.remember("p-1/prompt");
		expect(reader.confirm(reply("p-1", "1.")).verdict).toBe("user");
		reader.remember("p-1/reply");
		const firstEnd = reader.mark().offset;
		appendFileSync(path, `${grokLog.hookRun(S, "user_prompt_submit", "p-2")}\n${grokLog.typed(S, "Two.", 1)}\n${grokLog.thought(S, "p-2")}\n`);
		reader.read();
		const mark = parseGrokLogMark(JSON.stringify(reader.mark()));
		expect(mark?.offset).toBeGreaterThanOrEqual(firstEnd);
		const restarted = new GrokLogReader(mark!);
		restarted.read();
		expect(restarted.confirm(prompt("p-2", "Two.")).verdict).toBe("user");
		expect(restarted.recordedBefore("p-1/reply")).toBe(true);
		expect(parseGrokLogMark("nonsense")).toBeUndefined();
		expect(parseGrokLogMark(JSON.stringify({ path, home, offset: -1 }))).toBeUndefined();
	});
});

describe("sharedLogLives", () => {
	const mark = (pid: number, start?: string) => JSON.stringify({ shared: { pid, ...(start === undefined ? {} : { start }) } });
	const alive = (pid: number) => pid === 42;

	it("holds while the Grok a session's log is shared with lives, and its start, when the mark has one, is unchanged", () => {
		expect(sharedLogLives(mark(42, "s"), alive, () => "s")).toBe(true);
		expect(sharedLogLives(mark(42), alive, () => undefined)).toBe(true);
		// Gone, or another process at its pid (another start): a reopen records again.
		expect(sharedLogLives(mark(7, "s"), alive, () => "s")).toBe(false);
		expect(sharedLogLives(mark(42, "s"), alive, () => "another start")).toBe(false);
		// No mark, or one that isn't this one.
		expect(sharedLogLives(undefined, alive, () => "s")).toBe(false);
		expect(sharedLogLives('{"offset":0}', alive, () => "s")).toBe(false);
		expect(sharedLogLives("not json", alive, () => "s")).toBe(false);
	});

	it("fails closed: a live Grok whose start can't be read may be the one the mark names, so the session stays paused", () => {
		expect(sharedLogLives(mark(42, "s"), alive, () => undefined)).toBe(true);
	});
});
