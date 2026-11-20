import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGY_AS_CLAUDE, agyGuard, orreryMemoryTool, runAgyGuard } from "../../src/antigravity/guard.ts";
import { agyKeeps, agyNamed, agyRule } from "../../src/antigravity/guard-rules.ts";
import { cleanupDirs, testAgent } from "../claude/support.ts";

let dir: string | undefined;
afterEach(() => {
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
	cleanupDirs();
});

/** Antigravity's files the guard keeps, under ~/.gemini. */
const KEPT = [
	"antigravity-cli/brain/e6f5acd5-ee5c-4b2b-b2c4-bbcbda5781a2/.system_generated/logs/transcript_full.jsonl",
	"antigravity-cli/conversations/e6f5acd5-ee5c-4b2b-b2c4-bbcbda5781a2.db",
	"antigravity-cli/presence/e6f5acd5-ee5c-4b2b-b2c4-bbcbda5781a2.lock",
	"antigravity-cli/conversation_summaries.db-wal",
	"antigravity-cli/settings.json",
	"config/hooks.json",
	"config/mcp_config.json",
	"config/plugins/p/hooks.json",
];

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "orrery-agy-guard-")));
	dir = root;
	const folder = join(root, "ws");
	const home = join(root, "home");
	mkdirSync(join(folder, ".agents"), { recursive: true });
	mkdirSync(join(home, ".ssh"), { recursive: true });
	writeFileSync(join(home, ".ssh", "config"), "Host x");
	for (const file of KEPT) {
		mkdirSync(dirname(join(home, ".gemini", file)), { recursive: true });
		writeFileSync(join(home, ".gemini", file), "x");
	}
	mkdirSync(join(home, ".gemini", "config", "skills", "s"), { recursive: true });
	writeFileSync(join(folder, "secret.txt"), "s");
	writeFileSync(join(folder, "notes.md"), "a");
	mkdirSync(join(root, "outside"));
	symlinkSync(join(home, ".gemini", "config"), join(folder, "config-link"));
	const options = { folder, allowedRoots: [] as string[], cwd: folder, home, foreignViews: [] as string[], protect: ["secret.txt"], orreryData: join(root, "data") };
	// An agent opened at home, so its folder holds Antigravity's; and a session there that is no agent's.
	const atHome = { ...options, folder: home, cwd: home };
	const plain = { folder: home, allowedRoots: [] as string[], cwd: home, home, foreignViews: [] as string[], orreryOnly: true, orreryData: join(root, "data") };
	return { root, folder, home, options, atHome, plain };
}

const SENSITIVE = /sensitive/;
const PROTECTED = /protected by \[guard\] protect/;
const OUTSIDE = /outside this agent's folder/;
const AGY_OWN = /Antigravity's own/;

describe("the guard on Antigravity's tool calls", () => {
	it("maps agy's tools onto Claude Code's, by the argument names agy 1.5.13 sends", () => {
		expect(AGY_AS_CLAUDE.run_command).toEqual({ name: "Bash", keys: { CommandLine: "command", Cwd: "cwd" } });
		expect(AGY_AS_CLAUDE.read_file).toEqual({ name: "Read", keys: { Path: "file_path" } });
		expect(AGY_AS_CLAUDE.write_file?.name).toBe("Write");
		expect(AGY_AS_CLAUDE.edit_file?.keys).toEqual({ Path: "file_path", Target: "old_string", Replacement: "new_string" });
		expect(AGY_AS_CLAUDE.list_dir).toEqual({ name: "LS", keys: { DirectoryPath: "path" } });
	});

	it.each([
		["run_command", { CommandLine: "cat ~/.ssh/config", Cwd: "/tmp" }, SENSITIVE],
		["read_file", { Path: "~/.ssh/config" }, SENSITIVE],
		["view_file", { AbsolutePath: "~/.ssh/config" }, SENSITIVE],
		["write_file", { Path: "/etc/hosts", Content: "x" }, OUTSIDE],
		["write_to_file", { TargetFile: "/etc/hosts", CodeContent: "x" }, OUTSIDE],
		["edit_file", { Path: "secret.txt", Target: "s", Replacement: "t" }, PROTECTED],
		["replace_file_content", { TargetFile: "secret.txt", TargetContent: "s", ReplacementContent: "t" }, PROTECTED],
		["multi_replace_file_content", { TargetFile: "/etc/hosts", ReplacementChunks: [] }, OUTSIDE],
		["list_dir", { DirectoryPath: "~/.ssh" }, SENSITIVE],
		["find_by_name", { SearchDirectory: "~/.ssh", Pattern: "*" }, SENSITIVE],
		["grep_search", { SearchPath: "~/.ssh", Query: "Host" }, SENSITIVE],
		["call_mcp_tool", { ServerName: "fs", ToolName: "read", Arguments: { path: "~/.ssh/config" } }, SENSITIVE],
		["invoke_subagent", { Subagents: [{ Prompt: "x", Workspace: "~/.ssh" }] }, SENSITIVE],
	] as const)("refuses %s with a harmful input", (tool, input, verdict) => {
		const { options } = setup();
		expect(agyGuard(tool, input, options)).toMatch(verdict);
	});

	it("lets ordinary work through: a read, a write and a command in the agent's folder", () => {
		const { options, folder } = setup();
		expect(agyGuard("read_file", { Path: join(folder, "notes.md") }, options)).toBeUndefined();
		expect(agyGuard("write_file", { Path: join(folder, "new.md"), Content: "x" }, options)).toBeUndefined();
		expect(agyGuard("edit_file", { Path: join(folder, "notes.md"), Target: "a", Replacement: "b" }, options)).toBeUndefined();
		expect(agyGuard("run_command", { CommandLine: "npm test", Cwd: folder }, options)).toBeUndefined();
	});

	it("refuses Orrery's hook plumbing in a command, so an agent can't feed a hook made-up input", () => {
		const { options } = setup();
		expect(agyGuard("run_command", { CommandLine: "echo '{}' | orrery agy-hook stop" }, options)).toMatch(/hook plumbing/);
	});

	it("keeps Antigravity's records and settings: readable with a file tool, written by none, named in no command", () => {
		const { atHome, plain, home, folder } = setup();
		for (const file of KEPT) {
			const path = join(home, ".gemini", file);
			for (const session of [atHome, plain]) {
				expect(agyGuard("write_file", { Path: path, Content: "x" }, session), file).toMatch(AGY_OWN);
				expect(agyGuard("edit_file", { Path: path, Target: "x", Replacement: "y" }, session), file).toMatch(AGY_OWN);
			}
			expect(agyGuard("read_file", { Path: path }, atHome), file).toBeUndefined();
		}
		// A project's own hooks and MCP servers, anywhere.
		expect(agyGuard("write_file", { Path: join(folder, ".agents", "hooks.json"), Content: "{}" }, { ...atHome, folder, cwd: folder })).toMatch(AGY_OWN);
		expect(agyGuard("write_file", { Path: join(folder, ".agents", "mcp_config.json"), Content: "{}" }, { ...atHome, folder, cwd: folder })).toMatch(AGY_OWN);
		// Through a link, as it really is.
		expect(agyGuard("write_file", { Path: join(folder, "config-link", "hooks.json"), Content: "{}" }, { ...atHome, folder, cwd: folder, allowedRoots: [home] })).toMatch(AGY_OWN);
		// In shell text, read or write, in every session.
		for (const session of [atHome, plain]) {
			expect(agyGuard("run_command", { CommandLine: "cat ~/.gemini/config/hooks.json" }, session)).toMatch(/names Antigravity's own files/);
			expect(agyGuard("run_command", { CommandLine: "echo x >> ~/.gemini/antigravity-cli/brain/a/.system_generated/logs/transcript_full.jsonl" }, session)).toMatch(/names Antigravity's own files/);
			expect(agyGuard("run_command", { CommandLine: "rm .agents/hooks.json" }, session)).toMatch(/names Antigravity's own files/);
		}
		// What Antigravity's own features write stays open: its skills and rules.
		expect(agyGuard("write_file", { Path: join(home, ".gemini", "config", "skills", "s", "SKILL.md"), Content: "x" }, atHome)).toBeUndefined();
	});

	it("knows Orrery's own memory tools, eager or through call_mcp_tool", () => {
		expect(orreryMemoryTool("mcp_orrery_zoom", {})).toBe(true);
		expect(orreryMemoryTool("mcp_orrery_agent_memory", {})).toBe(true);
		expect(orreryMemoryTool("call_mcp_tool", { ServerName: "orrery", ToolName: "search" })).toBe(true);
		expect(orreryMemoryTool("call_mcp_tool", { ServerName: "other" })).toBe(false);
		expect(orreryMemoryTool("mcp_other_zoom", {})).toBe(false);
	});

	it("always answers with a decision, and denies a call it can't read", () => {
		const t = testAgent();
		const ctx = { config: t.config, env: {}, agyPid: process.pid };
		const decision = (stdin: string | undefined) => JSON.parse(runAgyGuard(stdin, ctx)) as { decision: string; reason?: string };
		expect(decision("not json")).toMatchObject({ decision: "deny", reason: expect.stringMatching(/^Orrery guard: Orrery could not read this call/) });
		expect(decision(JSON.stringify({ toolCall: "x", cwd: "/" }))).toMatchObject({ decision: "deny" });
		expect(decision(undefined)).toMatchObject({ decision: "deny", reason: expect.stringMatching(/too large/) });
		// A plain agy (no ORRERY_AGENT): Orrery's own rules, a read in its folder allowed.
		expect(decision(JSON.stringify({ toolCall: { name: "read_file", args: { Path: join(t.folder, "x.md") } }, cwd: t.folder }))).toEqual({ decision: "allow" });
		expect(decision(JSON.stringify({ toolCall: { name: "read_file", args: { Path: join(t.agent.dir, "memory.sqlite") } }, cwd: t.folder }))).toMatchObject({ decision: "deny" });
	});
});

describe("Antigravity's own files", () => {
	it("are its records and the settings that load hooks and servers, by path, as written and as they really are", () => {
		const { home } = setup();
		const rule = agyRule(home);
		expect(agyKeeps(join(home, ".gemini", "config", "hooks.json"), rule)).toBe(true);
		expect(agyKeeps(join(home, ".gemini", "antigravity-cli", "brain", "x", "y"), rule)).toBe(true);
		expect(agyKeeps(join(home, ".gemini", "antigravity-cli", "conversation_summaries.db-shm"), rule)).toBe(true);
		expect(agyKeeps("/w/app/.agents/hooks.json", rule)).toBe(true);
		expect(agyKeeps(join(home, ".gemini", "config", "skills", "s", "SKILL.md"), rule)).toBe(false);
		expect(agyKeeps(join(home, ".gemini", "antigravity-cli", "log", "cli.log"), rule)).toBe(false);
		expect(agyKeeps("/w/app/.agents/rules/style.md", rule)).toBe(false);
	});

	it("are named in shell text from any folder", () => {
		expect(agyNamed("cat ~/.gemini/config/hooks.json")).toBe(true);
		expect(agyNamed("ls /home/u/.gemini/antigravity-cli/brain/")).toBe(true);
		expect(agyNamed("cp x .agents/mcp_config.json")).toBe(true);
		expect(agyNamed("cat ~/.gemini/config/skills/s/skill.md")).toBe(false);
		expect(agyNamed("cat .agents/rules/style.md")).toBe(false);
	});
});
