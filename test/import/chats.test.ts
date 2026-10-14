import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { chatMatches, folderLabel, listChats, titleLine } from "../../src/import/chats.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const home = () => {
	const dir = mkdtempSync(join(tmpdir(), "orrery-chats-"));
	dirs.push(dir);
	return dir;
};
const lines = (records: readonly object[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

/** Writes `text` to `file`, last written `minutesAgo` before NOW. */
function put(file: string, text: string, minutesAgo: number): string {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	const at = new Date(NOW - minutesAgo * 60_000);
	utimesSync(file, at, at);
	return file;
}

const claudeUser = (text: string, cwd = "/home/someone/Work") => ({ type: "user", uuid: `u-${text.length}`, sessionId: "s-1", cwd, timestamp: "2026-10-10T10:00:00.000Z", message: { role: "user", content: text } });
const codexMeta = (id: string, cwd: string, extra: object = {}) => ({ timestamp: "2026-10-10T10:00:00.000Z", type: "session_meta", payload: { id, cwd, timestamp: "2026-10-10T10:00:00.000Z", ...extra } });
const codexUser = (text: string) => ({ timestamp: "2026-10-10T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: text } });
const list = (h: string, env: NodeJS.ProcessEnv = {}) => listChats({ env, home: h, now: NOW }).chats;
/** The wall-clock budget of the large listings: 2 s here, 5 s on shared CI runners, which are slower and busier. */
const BUDGET_MS = process.env.CI ? 5000 : 2000;

/** A sparse file of `size` bytes: `first` at its start, `last` (a line) at its end. No disk is used. */
function sparse(file: string, first: string, last: string, size: number, minutesAgo: number): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, first);
	const end = `\n${last}\n`;
	truncateSync(file, size - Buffer.byteLength(end));
	appendFileSync(file, end);
	const at = new Date(NOW - minutesAgo * 60_000);
	utimesSync(file, at, at);
}

describe("listChats", () => {
	it("titles a Claude Code chat by its custom title, else its AI title, else its first prompt, newest first", () => {
		const h = home();
		const project = join(h, ".claude", "projects", "-home-someone-Work");
		put(join(project, "a.jsonl"), lines([{ type: "user", isMeta: true, message: { content: "<local-command-caveat>x" } }, claudeUser("Install RPCS3 AppImage\nand set it up"), { type: "ai-title", aiTitle: "Installing RPCS3", sessionId: "s-1" }]), 60);
		put(join(project, "b.jsonl"), lines([claudeUser("Fix the build"), { type: "ai-title", aiTitle: "Build fix", sessionId: "s-2" }, { type: "custom-title", customTitle: "My build", sessionId: "s-2" }]), 120);
		put(join(project, "c.jsonl"), lines([claudeUser("<command-name>/clear</command-name>"), claudeUser("Plan the trip")]), 180);
		put(join(project, "d.jsonl"), "\n", 200);
		expect(list(h).map((chat) => [chat.tool, chat.title, chat.folder])).toEqual([
			["claude-code", "Installing RPCS3", "/home/someone/Work"],
			["claude-code", "My build", "/home/someone/Work"],
			["claude-code", "Plan the trip", "/home/someone/Work"],
		]);
	});

	it("titles a Codex chat by its thread name, else its first message; skips subagent sessions; lists archived ones", () => {
		const h = home();
		const codex = join(h, ".codex");
		put(join(codex, "sessions", "2026", "10", "10", "rollout-2026-10-10T10-00-00-a.jsonl"), lines([codexMeta("id-a", "/home/someone/Work"), codexUser("Install RPCS3 AppImage")]), 5);
		put(join(codex, "archived_sessions", "rollout-2026-10-01T10-00-00-b.jsonl"), lines([codexMeta("id-b", "/home/someone/Other"), codexUser("Old question")]), 600);
		put(join(codex, "sessions", "2026", "10", "10", "rollout-2026-10-10T11-00-00-c.jsonl"), lines([codexMeta("id-c", "/x", { source: { subagent: "review" } }), codexUser("from an agent")]), 30);
		writeFileSync(join(codex, "session_index.jsonl"), lines([{ id: "id-b", thread_name: "Old name", updated_at: "x" }, { id: "id-b", thread_name: "Archived chat", updated_at: "y" }]));
		expect(list(h).map((chat) => [chat.tool, chat.title, chat.folder, chat.inUse])).toEqual([
			["codex", "Install RPCS3 AppImage", "/home/someone/Work", true],
			["codex", "Archived chat", "/home/someone/Other", false],
		]);
	});

	it("is in use when written in the last 10 minutes, and not after", () => {
		const h = home();
		const project = join(h, ".claude", "projects", "-p");
		put(join(project, "now.jsonl"), lines([claudeUser("Nine minutes ago")]), 9);
		put(join(project, "then.jsonl"), lines([claudeUser("Eleven minutes ago")]), 11);
		expect(list(h).map((chat) => [chat.title, chat.inUse])).toEqual([["Nine minutes ago", true], ["Eleven minutes ago", false]]);
	});

	it("lists a 300 MB chat from its head and tail only, within the budget (2 s; 5 s on CI)", () => {
		const h = home();
		const file = join(h, ".claude", "projects", "-big", "big.jsonl");
		const size = 300 * 1024 * 1024;
		sparse(file, lines([claudeUser("Start the big one.")]), JSON.stringify({ type: "ai-title", aiTitle: "The big chat", sessionId: "s-1" }), size, 60);
		const started = performance.now();
		const { chats, bytesRead } = listChats({ env: {}, home: h, now: NOW });
		const took = performance.now() - started;
		expect(took).toBeLessThan(BUDGET_MS);
		expect(chats.map((chat) => [chat.title, chat.size])).toEqual([["The big chat", size]]);
		expect(bytesRead).toBeLessThan(1024 * 1024);
		console.log(`300 MB chat listed in ${took.toFixed(1)} ms, ${bytesRead} bytes read`);
	});

	it("lists a folder of large chats (about 1,000 files, 440 over 256 KB) within the budget, reading little", () => {
		const h = home();
		const project = (n: number) => join(h, ".claude", "projects", `-proj-${n % 20}`);
		for (let i = 0; i < 560; i++) put(join(project(i), `small-${i}.jsonl`), lines([claudeUser(`Small chat ${i}`), { type: "ai-title", aiTitle: `Small ${i}`, sessionId: "s" }]), i);
		for (let i = 0; i < 440; i++) {
			const body = lines([claudeUser(`Large chat ${i}`)]);
			sparse(join(project(i), `large-${i}.jsonl`), body, JSON.stringify({ type: "ai-title", aiTitle: `Large ${i}`, sessionId: "s" }), 256 * 1024 + 1024 * 1024 * (i % 50), i);
		}
		const started = performance.now();
		const { chats, bytesRead } = listChats({ env: {}, home: h, now: NOW });
		const took = performance.now() - started;
		expect(chats).toHaveLength(1000);
		expect(chats.filter((chat) => chat.title.startsWith("Large "))).toHaveLength(440);
		expect(took).toBeLessThan(BUDGET_MS);
		expect(bytesRead).toBeLessThan(440 * (320 * 1024) + 560 * 2048);
		console.log(`1,000 chats (440 large) listed in ${took.toFixed(1)} ms, ${bytesRead} bytes read`);
	});

	it("finds a Codex chat's folder and first message when its first line is longer than the head window", () => {
		const h = home();
		put(join(h, ".codex", "sessions", "rollout-2026-10-10T10-00-00-big.jsonl"), lines([codexMeta("id-big", "/home/someone/Work", { instructions: "x".repeat(600 * 1024) }), codexUser("Install RPCS3 AppImage")]), 5);
		expect(list(h).map((chat) => [chat.title, chat.folder])).toEqual([["Install RPCS3 AppImage", "/home/someone/Work"]]);
	});

	it("lists a chat whose last line is half written", () => {
		const h = home();
		put(join(h, ".claude", "projects", "-p", "live.jsonl"), `${lines([claudeUser("Still talking")])}{"type":"user","mess`, 1);
		expect(list(h).map((chat) => [chat.title, chat.inUse])).toEqual([["Still talking", true]]);
	});

	it("reads CLAUDE_CONFIG_DIR and CODEX_HOME when set, and nothing under the home then", () => {
		const h = home();
		put(join(h, ".claude", "projects", "-p", "home.jsonl"), lines([claudeUser("From the home")]), 1);
		put(join(h, "cc", "projects", "-p", "moved.jsonl"), lines([claudeUser("From CLAUDE_CONFIG_DIR")]), 2);
		put(join(h, "cx", "sessions", "rollout-2026-10-10T10-00-00-m.jsonl"), lines([codexMeta("id-m", "/w"), codexUser("From CODEX_HOME")]), 3);
		expect(list(h, { CLAUDE_CONFIG_DIR: join(h, "cc"), CODEX_HOME: join(h, "cx") }).map((chat) => chat.title)).toEqual(["From CLAUDE_CONFIG_DIR", "From CODEX_HOME"]);
	});

	const DIRTY = "\u001b[31mred\u001b[0m \u001b]0;x\u0007 \u009b31m \u202eflip\u2028 end";
	const clean = (text: string | undefined) => expect(text ?? "").not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u2028\u2029]/);

	it("shows no escape sequences or control characters from a Claude title, a Codex thread name, a first prompt or a cwd", () => {
		const h = home();
		const dirty = `${h}/we${DIRTY}ird`;
		put(join(h, ".claude", "projects", "-p", "a.jsonl"), lines([claudeUser("hello", dirty), { type: "ai-title", aiTitle: DIRTY }]), 1);
		put(join(h, ".claude", "projects", "-p", "b.jsonl"), lines([claudeUser(DIRTY)]), 2);
		put(join(h, ".codex", "sessions", "rollout-2026-10-10T10-00-00-n.jsonl"), lines([codexMeta("id-n", dirty), codexUser("plain")]), 3);
		put(join(h, ".codex", "sessions", "rollout-2026-10-10T10-00-00-o.jsonl"), lines([codexMeta("id-o", "/w"), codexUser(DIRTY)]), 4);
		writeFileSync(join(h, ".codex", "session_index.jsonl"), lines([{ id: "id-n", thread_name: DIRTY }]));
		const chats = list(h);
		expect(chats).toHaveLength(4);
		for (const chat of chats) {
			clean(chat.title);
			clean(folderLabel(chat.folder ?? "", h));
		}
		expect(chats.find((chat) => chat.folder === dirty)).toBeDefined(); // the real path is kept for opening
	});

	it("cuts a title on a code-point boundary", () => {
		const title = titleLine("😀".repeat(200));
		expect(Array.from(title)).toHaveLength(80);
		expect(title.isWellFormed()).toBe(true);
	});

	it("skips a FIFO named like a chat in each root, promptly", () => {
		const h = home();
		mkdirSync(join(h, ".claude", "projects", "-p"), { recursive: true });
		mkdirSync(join(h, ".codex", "sessions"), { recursive: true });
		mkdirSync(join(h, ".codex", "archived_sessions"), { recursive: true });
		execFileSync("mkfifo", [join(h, ".claude", "projects", "-p", "fifo.jsonl"), join(h, ".codex", "sessions", "rollout-fifo.jsonl"), join(h, ".codex", "archived_sessions", "rollout-fifo.jsonl"), join(h, ".codex", "session_index.jsonl")]);
		put(join(h, ".claude", "projects", "-p", "real.jsonl"), lines([claudeUser("Real one")]), 1);
		const started = performance.now();
		expect(list(h).map((chat) => chat.title)).toEqual(["Real one"]);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("finds a Codex first message after a first line over the head window and a spacer event", () => {
		const h = home();
		const spacer = { timestamp: "2026-10-10T10:00:00.500Z", type: "turn_context", payload: { note: "y".repeat(100 * 1024) } };
		put(join(h, ".codex", "sessions", "rollout-2026-10-10T10-00-00-s.jsonl"), lines([codexMeta("id-s", "/w", { instructions: "x".repeat(300 * 1024) }), spacer, codexUser("After the spacer")]), 5);
		expect(list(h).map((chat) => chat.title)).toEqual(["After the spacer"]);
	});

	it("skips Codex's injected context for the first message", () => {
		const h = home();
		put(join(h, ".codex", "sessions", "rollout-2026-10-10T10-00-00-i.jsonl"), lines([codexMeta("id-i", "/w"), codexUser("<environment_context>\n<cwd>/w</cwd>"), codexUser("My real question")]), 5);
		expect(list(h).map((chat) => chat.title)).toEqual(["My real question"]);
	});

	it("lists every chat: one with no usable title is (untitled), never dropped", () => {
		const h = home();
		const project = join(h, ".claude", "projects", "-p");
		// A title of control characters only, and no prompt: blank once made safe to show.
		put(join(project, "blank.jsonl"), lines([{ type: "user", isMeta: true, sessionId: "s-b", cwd: "/w", message: { content: "<local-command-caveat>x" } }, { type: "ai-title", aiTitle: "\u0007\u0007", sessionId: "s-b" }]), 1);
		// Nothing but a command: no prompt and no title.
		put(join(project, "command.jsonl"), lines([claudeUser("<command-name>/clear</command-name>")]), 2);
		// A Codex chat whose only message is injected context, with no thread name.
		put(join(h, ".codex", "sessions", "rollout-2026-10-10T10-00-00-j.jsonl"), lines([codexMeta("id-j", "/w"), codexUser("<environment_context>\n<cwd>/w</cwd>")]), 3);
		// A file with no record at all is no chat.
		put(join(project, "empty.jsonl"), "\n", 4);
		expect(list(h).map((chat) => [chat.tool, chat.title])).toEqual([
			["claude-code", "(untitled)"],
			["claude-code", "(untitled)"],
			["codex", "(untitled)"],
		]);
	});

	it("keeps one row per Codex thread across sessions and archived_sessions, the newest file", () => {
		const h = home();
		put(join(h, ".codex", "sessions", "rollout-2026-10-10T10-00-00-d.jsonl"), lines([codexMeta("id-d", "/w"), codexUser("Live copy")]), 5);
		put(join(h, ".codex", "archived_sessions", "rollout-2026-10-10T10-00-00-d.jsonl"), lines([codexMeta("id-d", "/w"), codexUser("Archived copy")]), 50);
		expect(list(h).map((chat) => chat.title)).toEqual(["Live copy"]);
	});

	it("reads only the end of an oversized session_index.jsonl, counts it, and keeps the newest names", () => {
		const h = home();
		put(join(h, ".codex", "sessions", "rollout-2026-10-10T10-00-00-x.jsonl"), lines([codexMeta("id-x", "/w"), codexUser("Plain")]), 5);
		const filler = `${JSON.stringify({ id: "other", thread_name: "z".repeat(1000) })}\n`.repeat(8000);
		writeFileSync(join(h, ".codex", "session_index.jsonl"), `${lines([{ id: "id-x", thread_name: "Stale" }])}${filler}${lines([{ id: "id-x", thread_name: "Newest" }])}`);
		const { chats, bytesRead } = listChats({ env: {}, home: h, now: NOW });
		expect(chats.map((chat) => chat.title)).toEqual(["Newest"]);
		expect(bytesRead).toBeGreaterThan(3 * 1024 * 1024);
		expect(bytesRead).toBeLessThan(5 * 1024 * 1024);
	});

	it("filters by every word, in the title or the folder as the list shows it", () => {
		const chat = { tool: "codex" as const, file: "/f", id: "i", title: "Install RPCS3 AppImage", folder: "/home/someone/Work/emu", lastActive: NOW, size: 1, inUse: false };
		expect(chatMatches(chat, "rpcs3 ~/work", "/home/someone")).toBe(true);
		expect(chatMatches(chat, "rpcs3 other", "/home/someone")).toBe(false);
	});
});
