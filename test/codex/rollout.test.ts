import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { codexHome, confirmCodex, findRollout, holdsOpen, openFiles, parseLsof, parseRolloutMark, readerStart, RolloutReader, rolloutIn, rolloutThread } from "../../src/codex/rollout.ts";
import { tempDir } from "../agent/support.ts";
import { type CodexHome, codexHomeIn, codexSession, rollout } from "./rollout-lines.ts";

const dirs: string[] = [];
const homes: CodexHome[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) home.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
	const dir = tempDir("orrery-rollout-");
	dirs.push(dir);
	return dir;
};
const homeIn = (dir = scratch()) => {
	const home = codexHomeIn(dir);
	homes.push(home);
	return home;
};

/** A live process that is not this one. */
const other = spawn("sleep", ["600"], { stdio: "ignore" });
afterAll(() => {
	other.kill();
});

describe("confirmCodex: what Codex's rollout says a hook's prompt or reply was", () => {
	it("a TUI turn (trigger user) and an exec turn confirm the prompt; the turn's final agent message confirms the reply", () => {
		for (const trigger of ["user", "exec"]) {
			const lines = rollout.turn("t-1", "Ship the bridge fix.", "Shipped.", trigger);
			expect(confirmCodex(lines, { kind: "prompt", turnId: "t-1", text: "Ship the bridge fix." }), trigger).toBe("user");
			expect(confirmCodex(lines, { kind: "reply", turnId: "t-1", text: "Shipped." }), trigger).toBe("user");
		}
	});

	it("drops a guardian's turn, a message `codex queue` put in from outside, or any trigger but user and exec, prompt and reply alike", () => {
		for (const trigger of ["guardian_review", "queue", "memory_consolidation", "review", 7, null]) {
			const lines = rollout.turn("t-1", "Approve this command?", "Approved.", trigger as string);
			expect(confirmCodex(lines, { kind: "prompt", turnId: "t-1", text: "Approve this command?" }), String(trigger)).toBe("drop");
			expect(confirmCodex(lines, { kind: "reply", turnId: "t-1", text: "Approved." }), String(trigger)).toBe("drop");
		}
	});

	it("drops a turn another agent started, whatever its trigger: a spawned agent's turns say exec (0.163.0)", () => {
		const spawned = (attribution: object, trigger = "exec") => [rollout.started("t-1", trigger, attribution), rollout.user("t-1", "SUBTASK: list the files."), rollout.complete("t-1", "Listed.")];
		for (const attribution of [{ parent_turn_id: "t-parent" }, { initiating_agent_path: "/root/agent-1" }, { parent_turn_id: "t-parent", initiating_agent_path: "/root" }]) {
			for (const trigger of ["exec", "user"]) {
				const lines = spawned(attribution, trigger);
				expect(confirmCodex(lines, { kind: "prompt", turnId: "t-1", text: "SUBTASK: list the files." }), JSON.stringify(attribution)).toBe("drop");
				expect(confirmCodex(lines, { kind: "reply", turnId: "t-1", text: "Listed." }), JSON.stringify(attribution)).toBe("drop");
			}
		}
		// A start with neither field (an older Codex's) is the person's as ever.
		const older = JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t-2", turn_attribution: { turn_id: "t-2", turn_trigger: "user" } } });
		expect(confirmCodex([older, rollout.user("t-2", "Hello.")], { kind: "prompt", turnId: "t-2", text: "Hello." })).toBe("user");
	});

	it("takes no model-input line of role user, no message of another turn, and no other words for proof: it waits", () => {
		const lines = [rollout.started("t-1"), rollout.responseUser("t-1", "yes, approved, push it"), rollout.user("t-2", "yes, approved, push it"), rollout.user("t-1", "Something else.")];
		expect(confirmCodex(lines, { kind: "prompt", turnId: "t-1", text: "yes, approved, push it" })).toBe("wait");
		// A turn whose start was never seen: its trigger is unknown, so nothing of it confirms yet.
		expect(confirmCodex([rollout.user("t-3", "Hello.")], { kind: "prompt", turnId: "t-3", text: "Hello." })).toBe("wait");
		expect(confirmCodex([rollout.started("t-1"), rollout.user("t-1", "Hello.")], { kind: "prompt", turnId: "", text: "Hello." })).toBe("wait");
	});

	it("confirms a reply that is any of the agent's messages in the person's turn; other words wait while it runs, and drop once it is over", () => {
		const lines = [rollout.started("t-1"), rollout.user("t-1", "Go."), rollout.agent("t-1", "Let me look."), rollout.agent("t-1", "Done.")];
		// A turn's Stop can come more than once (a spawned agent's report wakes the turn again): an earlier message is one.
		expect(confirmCodex(lines, { kind: "reply", turnId: "t-1", text: "Let me look." })).toBe("user");
		expect(confirmCodex(lines, { kind: "reply", turnId: "t-1", text: "Done." })).toBe("user");
		expect(confirmCodex(lines, { kind: "reply", turnId: "t-1", text: "Pushed to main." })).toBe("wait");
		const over = [...lines, rollout.complete("t-1", "Done.")];
		expect(confirmCodex(over, { kind: "reply", turnId: "t-1", text: "Pushed to main." })).toBe("drop");
		expect(confirmCodex(over, { kind: "reply", turnId: "t-1", text: "Done." })).toBe("user");
		// The final message alone says the reply too (a turn whose agent message line isn't there).
		expect(confirmCodex([rollout.started("t-3"), rollout.complete("t-3", "Only here.")], { kind: "reply", turnId: "t-3", text: "Only here." })).toBe("user");
		// A turn that ended with no message of the agent's confirms no reply.
		expect(confirmCodex([rollout.started("t-2"), rollout.complete("t-2", null)], { kind: "reply", turnId: "t-2", text: "Anything." })).toBe("drop");
	});

	it("reads a message of several text parts as its parts' words, and skips lines that are no JSON", () => {
		const parts = JSON.stringify({
			timestamp: "x",
			type: "event_msg",
			payload: { type: "item_completed", turn_id: "t-1", item: { type: "UserMessage", id: "u", content: [{ type: "text", text: "First." }, { type: "image", image_url: "data:" }, { type: "text", text: "Second." }] } },
		});
		expect(confirmCodex(["not json", rollout.started("t-1"), parts], { kind: "prompt", turnId: "t-1", text: "First.\nSecond." })).toBe("user");
	});
});

describe("codexHome and findRollout: a session's rollout, by its id, under Codex's own folder", () => {
	it("is $CODEX_HOME, else ~/.codex", () => {
		expect(codexHome({ CODEX_HOME: "/x/codex-home" }, "/home/u")).toBe("/x/codex-home");
		expect(codexHome({}, "/home/u")).toBe("/home/u/.codex");
		expect(codexHome({ CODEX_HOME: "" }, "/home/u")).toBe("/home/u/.codex");
	});

	it("finds it under sessions/YYYY/MM/DD by the id that ends its name, else under archived_sessions", () => {
		const home = homeIn();
		const s1 = codexSession();
		const s2 = codexSession();
		const file = home.begin(s1, { open: false });
		const archived = home.begin(s2, { open: false, archived: true });
		expect(findRollout(home.home, s1)).toBe(file);
		expect(findRollout(home.home, s2)).toBe(archived);
		expect(findRollout(home.home, codexSession())).toBeUndefined();
		expect(findRollout(join(home.home, "none"), s1)).toBeUndefined();
	});

	it("takes only a whole Codex session id: never part of one, nor a name that isn't a session id", () => {
		const home = homeIn();
		const s1 = codexSession();
		home.begin(s1, { open: false });
		// The tail of a real id would name the real rollout.
		expect(findRollout(home.home, s1.slice(9))).toBeUndefined();
		expect(findRollout(home.home, s1.slice(0, 8))).toBeUndefined();
		for (const bad of ["../x", "", "s1", `${s1}/..`]) expect(findRollout(home.home, bad)).toBeUndefined();
	});

	it("never follows a link: a linked rollout, or a linked day folder, is not found", () => {
		const dir = scratch();
		const home = homeIn(dir);
		const elsewhere = join(dir, "elsewhere");
		mkdirSync(join(elsewhere, "18"), { recursive: true });
		const linked = codexSession();
		writeFileSync(join(elsewhere, `rollout-2026-10-18T22-34-55-${linked}.jsonl`), `${rollout.meta(linked)}\n`);
		mkdirSync(join(home.home, "sessions", "2026", "10"), { recursive: true });
		symlinkSync(join(elsewhere, `rollout-2026-10-18T22-34-55-${linked}.jsonl`), join(home.home, "sessions", "2026", "10", `rollout-2026-10-18T22-34-55-${linked}.jsonl`));
		expect(findRollout(home.home, linked)).toBeUndefined();
		const inFolder = codexSession();
		writeFileSync(join(elsewhere, "18", `rollout-2026-10-18T22-34-55-${inFolder}.jsonl`), `${rollout.meta(inFolder)}\n`);
		symlinkSync(join(elsewhere, "18"), join(home.home, "sessions", "2026", "10", "19"));
		expect(findRollout(home.home, inFolder)).toBeUndefined();
	});

	it("rolloutIn takes only a rollout of that session under the home's sessions or archived_sessions folder", () => {
		const dir = scratch();
		const home = homeIn(dir);
		const s1 = codexSession();
		const file = home.begin(s1, { open: false });
		expect(rolloutIn(file, home.home, s1)).toBe(file);
		expect(rolloutIn(file, home.home, codexSession())).toBeUndefined();
		expect(rolloutIn(file, join(dir, "another-home"), s1)).toBeUndefined();
		expect(rolloutIn(`${home.home}/sessions/../sessions/2026/10/18/${file.split("/").at(-1) as string}`, home.home, s1)).toBeUndefined();
		expect(rolloutIn("relative.jsonl", home.home, s1)).toBeUndefined();
		expect(rolloutIn(42, home.home, s1)).toBeUndefined();
		// A folder in the sessions folder that links out of it: what it holds is elsewhere.
		const outside = join(dir, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(home.home, "sessions", "2025"));
		writeFileSync(join(outside, `rollout-2026-10-18T22-34-55-${s1}.jsonl`), "");
		expect(rolloutIn(join(home.home, "sessions", "2025", `rollout-2026-10-18T22-34-55-${s1}.jsonl`), home.home, s1)).toBeUndefined();
		// A sessions folder that is itself a link is Codex's folder all the same (another disk, say).
		const other = join(dir, "other-home");
		mkdirSync(other);
		symlinkSync(outside, join(other, "sessions"));
		expect(rolloutIn(join(other, "sessions", `rollout-2026-10-18T22-34-55-${s1}.jsonl`), other, s1)).toBe(join(other, "sessions", `rollout-2026-10-18T22-34-55-${s1}.jsonl`));
	});
});

describe("rolloutThread: a rollout's session_meta", () => {
	it("says the session and the kind of thread: a person's own (user), or a spawned agent's (subagent)", () => {
		const home = homeIn();
		const [s1, sub] = [codexSession(), codexSession()];
		expect(rolloutThread(home.begin(s1, { open: false }))).toEqual({ id: s1, threadSource: "user" });
		expect(rolloutThread(home.begin(sub, { open: false, meta: rollout.subagentMeta(sub, s1) }))).toEqual({ id: sub, threadSource: "subagent" });
	});

	it("is none for a first line that is no session_meta, or not whole yet", () => {
		const home = homeIn();
		const [a, b] = [codexSession(), codexSession()];
		expect(rolloutThread(home.begin(a, { open: false, meta: rollout.started("t-1") }))).toBeUndefined();
		const file = home.begin(b, { open: false });
		writeFileSync(file, rollout.meta(b));
		expect(rolloutThread(file)).toBeUndefined();
		expect(rolloutThread(join(home.home, "none.jsonl"))).toBeUndefined();
	});
});

describe("holdsOpen: whether Codex's process has the rollout open", () => {
	it("is the file's device:inode for a file this process holds open, false once closed, false for another process", () => {
		const home = homeIn();
		const s1 = codexSession();
		const file = home.begin(s1, { open: false });
		expect(holdsOpen(process.pid, file)).toBe(false);
		const fd = openSync(file, "a");
		try {
			const stat = statSync(file);
			expect(holdsOpen(process.pid, file)).toBe(`${stat.dev}:${stat.ino}`);
			expect(holdsOpen(other.pid as number, file)).toBe(false);
		} finally {
			closeSync(fd);
		}
		expect(holdsOpen(process.pid, file)).toBe(false);
	});

	it.skipIf(process.platform !== "linux")("is false for another file put at the path since the process opened it (Linux judges the very file)", () => {
		const dir = scratch();
		const home = homeIn(dir);
		const s1 = codexSession();
		const file = home.begin(s1);
		const forged = join(dir, "forged.jsonl");
		writeFileSync(forged, `${rollout.meta(s1)}\n`);
		renameSync(forged, file);
		expect(holdsOpen(process.pid, file)).toBe(false);
	});

	it("can't tell on a system it can't ask, and never says yes then", () => {
		expect(holdsOpen(process.pid, "/x", () => undefined)).toBe("unknown");
		expect(openFiles(process.pid, "win32")).toBeUndefined();
	});

	it.skipIf(process.platform !== "linux")("reads lsof's names (macOS's way) as Linux's /proc gives them", () => {
		const home = homeIn();
		const file = home.begin(codexSession());
		expect(openFiles(process.pid, "darwin")?.map((open) => open.path)).toContain(file);
		expect(holdsOpen(process.pid, file, (pid) => openFiles(pid, "darwin"))).toMatch(/^\d+:\d+$/);
		expect(parseLsof("p123\nfcwd\nn/home/u\nf3\nn/x/rollout.jsonl\nf4\ntREG\n")).toEqual(["/home/u", "/x/rollout.jsonl"]);
	});
});

describe("readerStart: where a session's rollout is read from, at its SessionStart", () => {
	it("is the end of what is there, but the start of a turn still running (SessionStart comes after its start line)", () => {
		const home = homeIn();
		const s1 = codexSession();
		const file = home.begin(s1);
		expect(readerStart(file)).toEqual({ offset: Buffer.byteLength(`${rollout.meta(s1)}\n`), running: false });
		home.add(s1, ...rollout.turn("t-1", "One.", "Done."));
		const done = readerStart(file);
		expect(done?.running).toBe(false);
		home.add(s1, rollout.started("t-2", "user"), rollout.responseUser("t-2", "Two."));
		expect(readerStart(file)).toEqual({ offset: done?.offset, running: true });
		home.add(s1, rollout.aborted("t-2"));
		const aborted = readerStart(file);
		expect(aborted?.running).toBe(false);
		expect(aborted?.offset).toBeGreaterThan(done?.offset as number);
		// A line being written is not read into.
		home.add(s1, rollout.started("t-3"));
		const third = readerStart(file);
		expect(third?.running).toBe(true);
		writeFileSync(file, '{"type":"event_msg","payl', { flag: "a" });
		expect(readerStart(file)).toEqual(third);
		expect(readerStart(join(home.home, "none.jsonl"))).toBeUndefined();
	});
});

describe("RolloutReader: one session's rollout, read as Codex appends to it", () => {
	const reader = (home: CodexHome, session: string, offset: number) => new RolloutReader({ path: home.path(session), home: home.home, offset });
	const prompt = (turnId: string, text: string) => ({ kind: "prompt" as const, turnId, text });
	const reply = (turnId: string, text: string) => ({ kind: "reply" as const, turnId, text });

	it("reads only from its place on, and learns a running turn's trigger from where SessionStart said to start", () => {
		const home = homeIn();
		const s1 = codexSession();
		const file = home.begin(s1);
		home.add(s1, ...rollout.turn("t-0", "Old words.", "Old reply."), rollout.started("t-1", "user"));
		const r = reader(home, s1, readerStart(file)?.offset as number);
		home.add(s1, rollout.user("t-1", "New words."), rollout.agent("t-1", "New reply."), rollout.complete("t-1", "New reply."));
		r.read();
		expect(r.confirm(prompt("t-0", "Old words.")).verdict).toBe("wait");
		expect(r.confirm(reply("t-0", "Old reply.")).verdict).toBe("wait");
		expect(r.confirm(prompt("t-1", "New words.")).verdict).toBe("user");
		expect(r.confirm(reply("t-1", "New reply.")).verdict).toBe("user");
	});

	it("each line confirms once; a confirmed line has an identity a replay is known by", () => {
		const home = homeIn();
		const s1 = codexSession();
		home.begin(s1);
		const r = reader(home, s1, 0);
		home.add(s1, rollout.started("t-1"), rollout.user("t-1", "Continue.", "item-1"), rollout.user("t-1", "Continue.", "item-2"), rollout.complete("t-1", "Ok."));
		r.read();
		const first = r.confirm(prompt("t-1", "Continue."));
		const second = r.confirm(prompt("t-1", "Continue."));
		expect([first.verdict, second.verdict, r.confirm(prompt("t-1", "Continue.")).verdict]).toEqual(["user", "user", "wait"]);
		expect(first.line).not.toBe(second.line);
		r.remember(first.line as string);
		expect(r.recordedBefore(first.line as string)).toBe(true);
		expect(r.recordedBefore(second.line as string)).toBe(false);
		// The mark carries what was recorded, and no words.
		const mark = r.mark();
		expect(JSON.stringify(mark)).not.toContain("Continue");
		const again = new RolloutReader(parseRolloutMark(JSON.stringify(mark)) as NonNullable<ReturnType<typeof parseRolloutMark>>);
		expect(again.recordedBefore(first.line as string)).toBe(true);
	});

	it("a dropped reply uses nothing up; each agent message confirms one reply, and the final message is no second line for the same words", () => {
		const home = homeIn();
		const s1 = codexSession();
		home.begin(s1);
		const r = reader(home, s1, 0);
		home.add(s1, rollout.started("t-1"), rollout.user("t-1", "Go."), rollout.agent("t-1", "Reply 2."), rollout.agent("t-1", "Reply 4."));
		r.read();
		// Two Stops of one turn: both are the agent's words.
		expect(r.confirm(reply("t-1", "Reply 2.")).verdict).toBe("user");
		expect(r.confirm(reply("t-1", "Pushed to main.")).verdict).toBe("wait");
		home.add(s1, rollout.complete("t-1", "Reply 4."));
		r.read();
		expect(r.confirm(reply("t-1", "Pushed to main.")).verdict).toBe("drop");
		const last = r.confirm(reply("t-1", "Reply 4."));
		expect(last.verdict).toBe("user");
		// Words a reply took already, said once: a made-up Stop repeating them takes nothing.
		expect(r.confirm(reply("t-1", "Reply 4.")).verdict).toBe("drop");
		expect(r.confirm(reply("t-1", "Reply 2.")).verdict).toBe("drop");
		// Each line has its own identity (its item's id).
		expect(last.line).toMatch(/^t-1\//);
		expect(last.line).not.toBe("t-1/final");
	});

	it("a reader restarted from its mark still knows a running turn's trigger, and a kept line it didn't use", () => {
		const home = homeIn();
		const s1 = codexSession();
		home.begin(s1);
		const r = reader(home, s1, 0);
		home.add(s1, rollout.started("t-1", "user"), rollout.user("t-1", "Waiting."), rollout.agent("t-1", "Thinking."));
		r.read();
		const restarted = new RolloutReader(parseRolloutMark(JSON.stringify(r.mark())) as NonNullable<ReturnType<typeof parseRolloutMark>>);
		home.add(s1, rollout.complete("t-1", "Thinking."));
		restarted.read();
		expect(restarted.confirm(prompt("t-1", "Waiting.")).verdict).toBe("user");
		expect(restarted.confirm(reply("t-1", "Thinking.")).verdict).toBe("user");
	});

	it("never reads through a link at the rollout's place, nor a file that leads out of the sessions folder", () => {
		const dir = scratch();
		const home = homeIn(dir);
		const s1 = codexSession();
		const file = home.begin(s1, { open: false });
		const outside = join(dir, "outside.jsonl");
		writeFileSync(outside, `${rollout.started("t-1")}\n${rollout.user("t-1", "From outside.")}\n`);
		rmSync(file);
		symlinkSync(outside, file);
		const r = reader(home, s1, 0);
		r.read();
		expect(r.confirm(prompt("t-1", "From outside.")).verdict).toBe("wait");
	});

	it("never reads another file put at the path than the one SessionStart saw Codex hold, nor one written anew shorter", () => {
		const dir = scratch();
		const home = homeIn(dir);
		const s1 = codexSession();
		const file = home.begin(s1, { open: false });
		const held = statSync(file);
		home.add(s1, ...rollout.turn("t-1", "First file.", "One."));
		const r = new RolloutReader({ path: file, home: home.home, offset: 0, file: `${held.dev}:${held.ino}` });
		r.read();
		expect(r.confirm(prompt("t-1", "First file.")).verdict).toBe("user");
		const replacement = join(dir, "replacement.jsonl");
		writeFileSync(replacement, `${rollout.meta(s1)}\n${rollout.turn("t-2", "Second file, and a longer one than the first.", "Two.").join("\n")}\n${"x".repeat(2000)}\n`);
		renameSync(replacement, file);
		r.read();
		expect(r.confirm(prompt("t-2", "Second file, and a longer one than the first.")).verdict).toBe("wait");
		// A reader that doesn't know the file yet takes the first it reads, then holds to it.
		const fresh = reader(home, s1, 0);
		fresh.read();
		expect(fresh.confirm(prompt("t-2", "Second file, and a longer one than the first.")).verdict).toBe("user");
		writeFileSync(file, `${rollout.turn("t-3", "Short.", "Three.").join("\n")}\n`);
		fresh.read();
		expect(fresh.confirm(prompt("t-3", "Short.")).verdict).toBe("wait");
	});

	it("lets lines go after a while, but keeps them all while told an earlier event waits", () => {
		const home = homeIn();
		const s1 = codexSession();
		home.begin(s1);
		const now = Date.now();
		const r = reader(home, s1, 0);
		home.add(s1, ...rollout.turn("t-1", "Kept a long while.", "Yes."));
		r.read(now);
		r.read(now + 11 * 60_000, true);
		expect(r.confirm(prompt("t-1", "Kept a long while.")).verdict).toBe("user");
		r.read(now + 22 * 60_000);
		// Its line let go, the turn over: nothing confirms the reply any more.
		expect(r.confirm(reply("t-1", "Yes.")).verdict).toBe("drop");
	});

	it("parseRolloutMark takes only a whole mark", () => {
		expect(parseRolloutMark(undefined)).toBeUndefined();
		expect(parseRolloutMark("{}")).toBeUndefined();
		expect(parseRolloutMark('{"path":"/x","home":"/h","offset":-1}')).toBeUndefined();
		expect(parseRolloutMark('{"path":"/x","home":"/h","offset":3}')).toMatchObject({ path: "/x", home: "/h", offset: 3 });
	});
});
