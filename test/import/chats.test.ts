import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { chatMatches, listChats } from "../../src/import/chats.ts";

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

	it("lists a 300 MB chat from its head and tail only, in under 2 s", () => {
		const h = home();
		const file = join(h, ".claude", "projects", "-big", "big.jsonl");
		const size = 300 * 1024 * 1024;
		sparse(file, lines([claudeUser("Start the big one.")]), JSON.stringify({ type: "ai-title", aiTitle: "The big chat", sessionId: "s-1" }), size, 60);
		const started = performance.now();
		const { chats, bytesRead } = listChats({ env: {}, home: h, now: NOW });
		const took = performance.now() - started;
		expect(took).toBeLessThan(2000);
		expect(chats.map((chat) => [chat.title, chat.size])).toEqual([["The big chat", size]]);
		expect(bytesRead).toBeLessThan(1024 * 1024);
		console.log(`300 MB chat listed in ${took.toFixed(1)} ms, ${bytesRead} bytes read`);
	});

	it("lists a folder of large chats (about 1,000 files, 440 over 256 KB) in about a second, reading little", () => {
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
		expect(took).toBeLessThan(2000);
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

	it("filters by every word, in the title or the folder as the list shows it", () => {
		const chat = { tool: "codex" as const, file: "/f", id: "i", title: "Install RPCS3 AppImage", folder: "/home/someone/Work/emu", lastActive: NOW, size: 1, inUse: false };
		expect(chatMatches(chat, "rpcs3 ~/work", "/home/someone")).toBe(true);
		expect(chatMatches(chat, "rpcs3 other", "/home/someone")).toBe(false);
	});
});
