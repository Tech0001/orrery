import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkToolCall, runsGrokCommand } from "../../src/agent/guard-rules.ts";
import { newToken } from "../../src/agent/pick.ts";
import { CODEX_GUARD_DEADLINE_MS, CODEX_GUARD_WATCHDOG_MS, isGrokGuard } from "../../src/codex/guard-exit.ts";
import { GROK_AS_CLAUDE, type GrokGuardContext, grokGuard, grokRefusal, runGrokGuard } from "../../src/grok/guard.ts";
import { grokHookFile } from "../../src/grok/install.ts";
import { GROK_HOOK_EVENTS } from "../../src/grok/names.ts";
import { cleanupDirs, startedWith, testAgent } from "../claude/support.ts";

let dir: string | undefined;
afterEach(() => {
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
	cleanupDirs();
});

/**
 * What in Grok's folder can switch Orrery's Grok hooks off or put words in the records Orrery reads: its hooks, config,
 * policy files, the /hooks switch, the trust list, plugins, agent definitions (their hooks and MCP servers) and a session.
 */
const GROK_GUARDED = [
	"hooks/orrery.json",
	"config.toml",
	"requirements.toml",
	"managed_config.toml",
	"disabled-hooks",
	"trusted_folders.toml",
	"installed-plugins/x/hooks/hooks.json",
	"plugins/p/hooks/hooks.json",
	"agents/reviewer.md",
	"sessions/%2Fws/01a1/updates.jsonl",
];

/**
 * What else is in Grok's folder, named above or not: its language servers (lsp.json starts their commands), its pager
 * settings, the bundle's agents (they carry hooks) and manifest, and a file a later Grok may add. No tool writes them
 * either.
 */
const GROK_UNNAMED = ["lsp.json", "newthing.toml", "pager.toml", "bundled/agents/explore.md", "bundled/manifest.json"];

/**
 * What in Grok's folder its own features write to or run from, only through calls the guard sees: its memory, skills
 * and workflows, /learn's runs, the background-task skill's logs and watchers, plugins' data, /implement's notes, the
 * bundled skills (their scripts), its docs and its logs; and its session worktrees, the person's checkouts (grok -w).
 */
const GROK_OPEN = [
	"memory-v2/global/MEMORY.md",
	"skills/x/SKILL.md",
	"workflows/review.rhai",
	"learn/runs/20261029T000000Z/report.md",
	"long-running-background-tasks/dev_server_1.log",
	"plugin-data/pr-babysit/watched-prs-1.json",
	"implement-memory/0123abcd.md",
	"bundled/skills/pptx/scripts/x.py",
	"docs/user-guide/10-hooks.md",
	"logs/unified.jsonl",
	"worktrees/repo-x/src/a.ts",
];

/** Grok's folder under a home: the above, its login and a session's system prompt. */
const GROK_FILES = [...GROK_GUARDED, ...GROK_UNNAMED, ...GROK_OPEN, "auth.json", "sessions/%2Fws/01a1/system_prompt.txt"];

/**
 * An agent's folder with a subfolder (the cwd), a fake home with credentials and Grok's folder, a protected name, a
 * .env, links out of the folder, and Orrery's data folder.
 */
function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "orrery-grok-guard-")));
	dir = root;
	const folder = join(root, "ws");
	const home = join(root, "home");
	const cwd = join(folder, "sub");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(home, ".ssh"), { recursive: true });
	mkdirSync(join(root, "outside"));
	mkdirSync(join(root, "data", "app"), { recursive: true });
	writeFileSync(join(home, ".ssh", "config"), "Host x");
	writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
	for (const file of GROK_FILES) {
		mkdirSync(dirname(join(home, ".grok", file)), { recursive: true });
		writeFileSync(join(home, ".grok", file), "x");
	}
	writeFileSync(join(folder, "secret.txt"), "s");
	writeFileSync(join(folder, ".env"), "KEY=x");
	writeFileSync(join(folder, "notes.md"), "a");
	writeFileSync(join(root, "data", "config.toml"), "");
	symlinkSync(join(root, "outside"), join(folder, "link"));
	symlinkSync(join(home, ".grok", "hooks"), join(folder, "hooks-link"));
	const options = { folder, allowedRoots: [] as string[], cwd, home, foreignViews: [] as string[], protect: ["secret.txt"], orreryData: join(root, "data") };
	// An agent opened at home, so its folder holds Grok's; and a session there that is no agent's (Orrery's own rules).
	const atHome = { ...options, folder: home, cwd: home };
	const plain = { folder: home, allowedRoots: [] as string[], cwd: home, home, foreignViews: [] as string[], orreryOnly: true, orreryData: join(root, "data") };
	return { root, folder, home, cwd, grok: join(home, ".grok"), options, atHome, plain };
}

const SENSITIVE = /sensitive/;
const PROTECTED = /protected by \[guard\] protect/;
const OUTSIDE = /outside this agent's folder/;
const GROK_FOLDER = /Grok's folder/;
/** Shell text that names an open part of Grok's folder and could reach the rest from there. */
const GROK_REACH = /names a part of Grok's folder its own features write .* also changes folder .* makes a link .* could reach the rest of Grok's folder/;
/** Shell text that names Grok's folder itself or what Grok loads and runs in it. */
const GROK_NAMED = /^This command names Grok's folder or what Grok loads and runs in it/;
/** Shell text run in Grok's folder whose relative path's ".." leads out of the part it runs in. */
const GROK_CLIMB = /^This command runs in Grok's folder .* has a relative path whose \.\. leads out of the part it runs in, which could reach the rest of Grok's folder/;
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
/** A string past 4 KiB as Grok cuts one: its start, a tag of its whole value, and " [truncated]". */
const cut = (start: string) => `${start}${" ".repeat(5000)} <sha256:ab12> [truncated]`;

describe("every tool and input shape Grok 1.0.70 hands PreToolUse", () => {
	/**
	 * From a real session's tool_definitions.json (Grok 1.0.70, Grok 4.7) and the binary's tool list (hashline and codex
	 * toolsets): each tool by its name with its input keys, and an MCP call as PreToolUse shows it, its qualified name with
	 * use_tool's envelope (seen live).
	 */
	const grokTools: [string, Record<string, unknown>][] = [
		["run_terminal_command", { command: "git status", description: "Show the status", block_until_ms: 1000 }],
		["monitor", { command: "tail -f build.log", description: "Watch the build", timeout_ms: 1000, persistent: false }],
		["read_file", { target_file: "notes.md", offset: 1, limit: 10 }],
		["hashline_read", { target_file: "notes.md" }],
		["search_replace", { file_path: "notes.md", old_string: "a", new_string: "b", replace_all: false }],
		["hashline_edit", { file_path: "notes.md", edits: [{ line: "1#ab", text: "b" }] }],
		["write", { file_path: "new.md", content: "x" }],
		["grep", { pattern: "x", path: "..", glob: "*.md", "-i": true, head_limit: 10 }],
		["hashline_grep", { pattern: "x", path: "." }],
		["grep_files", { pattern: "x", include: "*.md", path: "." }],
		["list_dir", { target_directory: ".." }],
		["apply_patch", { input: patch("*** Add File: a.md", "+a") }],
		["spawn_subagent", { prompt: "Review src/ and report", description: "Review", background: false }],
		["spawn_subagent", { prompt: "Fix the tests", description: "Fix", isolation: "worktree", resume_from: null, cwd: null, subagent_type: "feature-dev:code-reviewer" }],
		["kill_command_or_subagent", { task_id: "t1" }],
		["get_command_or_subagent_output", { task_ids: ["t1"], timeout_ms: 0 }],
		["todo_write", { merge: false, todos: [{ id: "1", content: "Write tests", status: "pending" }] }],
		["scheduler_create", { task_id: "t", interval: "5m", prompt: "Check the build", durable: false, fire_immediately: false }],
		["scheduler_delete", { task_id: "t" }],
		["scheduler_list", {}],
		["search_tool", { query: "zoom", limit: 5 }],
		["use_tool", { tool_name: "orrery__zoom", tool_input: { id: "7" } }],
		["orrery__zoom", { tool_name: "orrery__zoom", tool_input: { id: "7" } }],
		["scratch__echo_text", { tool_name: "scratch__echo_text", tool_input: { text: "hi" } }],
		["workflow", { source: { type: "script", script: 'let meta = #{ name: "check", description: "x" }; let r = agent("Run the tests"); complete(r.output);' }, agent_budget: 4 }],
		["workflow", { source: { type: "name", name: "review-changes" }, args: { target: "origin/main...HEAD" } }],
		["workflow", { source: { type: "resume", resume_from_run_id: "review-changes" } }],
		["enter_plan_mode", {}],
		["exit_plan_mode", {}],
		["ask_user_question", { questions: [{ question: "Which?", options: [{ label: "A" }] }] }],
		["send_feedback", { title: "x", details: "y", product_area: "tools", type: "bug" }],
		["web_fetch", { url: "https://example.com/docs" }],
		["web_search", { query: "rust lifetimes" }],
		["image_gen", { prompt: "a cat", aspect_ratio: "1:1" }],
		["image_edit", { prompt: "brighter", image: "shot.png", aspect_ratio: "1:1" }],
		["image_to_video", { prompt: "pan", image: "shot.png", duration: 5, resolution_name: "720p" }],
		["reference_to_video", { prompt: "pan", images: ["a.png"], duration: 5 }],
		["view_image", { path: "shot.png" }],
		// The Cursor preset's tools, with their own keys.
		["Shell", { command: "git status" }],
		["StrReplace", { path: "notes.md", old_string: "a", new_string: "b" }],
		["Write", { path: "new.md", contents: "x" }],
		["EditNotebook", { target_notebook: "nb.ipynb", cell_idx: 0, new_string: "x" }],
		["List", { path: "." }],
	];

	it.each(grokTools)("lets %s through with an ordinary input", (tool, input) => {
		const { options } = setup();
		expect(grokGuard(tool, input, options, false)).toBeUndefined();
	});

	it.each([
		["run_terminal_command", { command: "cat ~/.ssh/id_ed25519", description: "x" }, SENSITIVE],
		["monitor", { command: "tail -f ../secret.txt", description: "x" }, PROTECTED],
		["read_file", { target_file: "~/.ssh/id_ed25519" }, SENSITIVE],
		["hashline_read", { target_file: "../secret.txt" }, PROTECTED],
		["search_replace", { file_path: "/etc/hosts", old_string: "a", new_string: "b" }, OUTSIDE],
		["hashline_edit", { file_path: "../link/x.md", edits: [] }, OUTSIDE],
		["write", { file_path: "../link/x.md", content: "x" }, OUTSIDE],
		["grep", { pattern: "x", path: "~/.ssh" }, SENSITIVE],
		["grep", { pattern: "key", path: "~" }, /would search credential files/],
		["hashline_grep", { pattern: "x", path: "~/.ssh" }, SENSITIVE],
		["grep_files", { pattern: "x", include: "secret.txt", path: ".." }, PROTECTED],
		["list_dir", { target_directory: "~/.ssh" }, SENSITIVE],
		["list_dir", { dir_path: "~/.ssh" }, SENSITIVE],
		["apply_patch", { input: patch("*** Add File: /etc/x", "+x") }, OUTSIDE],
		["spawn_subagent", { prompt: "Look around", description: "x", cwd: "~/.ssh" }, SENSITIVE],
		["use_tool", { tool_name: "fs__write_file", tool_input: { path: "/etc/x", content: "y" } }, OUTSIDE],
		["fs__write_file", { tool_name: "fs__write_file", tool_input: { path: "/etc/x", content: "y" } }, OUTSIDE],
		["fs__read_file", { tool_name: "fs__read_file", tool_input: { path: "~/.ssh/config" } }, SENSITIVE],
		["box__run", { tool_name: "box__run", tool_input: { input: "cat ../secret.txt" } }, PROTECTED],
		["box__apply", { tool_name: "box__apply", tool_input: { diff: patch("*** Add File: /etc/x", "+x") } }, OUTSIDE],
		["workflow", { source: { type: "script_path", script_path: "~/.ssh/x.rhai" } }, SENSITIVE],
		["image_edit", { prompt: "x", image: "~/.ssh/id_ed25519" }, SENSITIVE],
		["view_image", { path: "~/.ssh/id_ed25519" }, SENSITIVE],
		["web_fetch", { url: "file:///etc/../root/.ssh/config" }, SENSITIVE],
		["Shell", { command: "cat ~/.ssh/config" }, SENSITIVE],
		["StrReplace", { path: "/etc/hosts", old_string: "a", new_string: "b" }, OUTSIDE],
		["Write", { path: "../link/x.md", contents: "x" }, OUTSIDE],
		["EditNotebook", { target_notebook: "../secret.txt", new_string: "x" }, PROTECTED],
		["List", { path: "~/.ssh" }, SENSITIVE],
	] as const)("refuses %s with a harmful input", (tool, input, verdict) => {
		const { options } = setup();
		expect(grokGuard(tool, input, options, false)).toMatch(verdict);
	});

	it("maps Grok's own tools onto Claude Code's, renaming the keys Claude Code's guard reads by another name", () => {
		expect(GROK_AS_CLAUDE.run_terminal_command).toEqual({ name: "Bash" });
		expect(GROK_AS_CLAUDE.monitor).toEqual({ name: "Bash" });
		expect(GROK_AS_CLAUDE.read_file).toEqual({ name: "Read", keys: { target_file: "file_path" } });
		expect(GROK_AS_CLAUDE.search_replace).toEqual({ name: "Edit" });
		expect(GROK_AS_CLAUDE.hashline_edit?.name).toBe("Edit");
		expect(GROK_AS_CLAUDE.write).toEqual({ name: "Write" });
		expect(GROK_AS_CLAUDE.grep).toEqual({ name: "Grep" });
		expect(GROK_AS_CLAUDE.list_dir?.keys?.target_directory).toBe("path");
	});

	it("refuses an MCP call whose arguments are still in a file, and an input it cannot read", () => {
		const { options } = setup();
		expect(grokGuard("use_tool", { tool_name: "x__y", tool_input_file: "/tmp/args.json" }, options, false)).toMatch(/arguments are in a file/);
		expect(grokGuard("use_tool", { file: "/tmp/call.json" }, options, false)).toMatch(/arguments are in a file/);
		expect(grokGuard("x__y", { tool_name: "x__y", tool_input_file: "/tmp/args.json" }, options, false)).toMatch(/arguments are in a file/);
		expect(grokGuard("run_terminal_command", "ls", options, false)).toMatch(/could not read this call/);
		expect(grokGuard("x__y", null, options, false)).toMatch(/could not read this call/);
		expect(grokGuard("x__y", ["a"], options, false)).toMatch(/could not read this call/);
		// A tool named like an object's own property is no tool of the map's: judged by its input like any other.
		expect(grokGuard("constructor", { path: "~/.ssh/config" }, options, false)).toMatch(SENSITIVE);
		expect(grokGuard("__proto__", { command: "cat ~/.ssh/config" }, options, false)).toMatch(SENSITIVE);
	});

	it("judges a call's cwd or workdir as a folder it reads", () => {
		const { home, options } = setup();
		expect(grokGuard("spawn_subagent", { prompt: "x", description: "x", cwd: join(home, ".ssh") }, options, false)).toMatch(SENSITIVE);
		expect(grokGuard("box__exec", { tool_name: "box__exec", tool_input: { cmd: "ls", workdir: "~/.ssh" } }, options, false)).toMatch(SENSITIVE);
		// A folder outside the agent's may be read.
		expect(grokGuard("spawn_subagent", { prompt: "x", description: "x", cwd: join(options.folder, "..", "outside") }, options, false)).toBeUndefined();
	});

	it("shares the call's time among its checks: with none left, it refuses", () => {
		const { options } = setup();
		expect(grokGuard("run_terminal_command", { command: "ls" }, { ...options, judgeMs: 0 }, false)).toMatch(/in time/);
	});
});

describe("search_replace and hashline_edit on a protected file are refused", () => {
	it("refuses each on [guard] protect, .env, Orrery's config and another agent's view, by any spelling or link", () => {
		const { folder, root, options } = setup();
		const view = join(root, "other", ".orrery", "view.md");
		mkdirSync(dirname(view), { recursive: true });
		writeFileSync(view, "Birch's memory");
		const withView = { ...options, foreignViews: [view] };
		for (const tool of ["search_replace", "hashline_edit"]) {
			expect(grokGuard(tool, { file_path: "../secret.txt", old_string: "s", new_string: "t" }, options, false)).toMatch(PROTECTED);
			expect(grokGuard(tool, { file_path: join(folder, ".env"), old_string: "x", new_string: "y" }, options, false)).toMatch(SENSITIVE);
			expect(grokGuard(tool, { file_path: join(root, "data", "config.toml"), old_string: "x", new_string: "y" }, options, false)).toMatch(/Orrery's config/);
			expect(grokGuard(tool, { file_path: view, old_string: "x", new_string: "y" }, withView, false)).toMatch(/another agent's memory view|sensitive/);
			expect(grokGuard(tool, { file_path: "../hooks-link/orrery.json", old_string: "x", new_string: "y" }, options, false)).toMatch(GROK_FOLDER);
		}
		expect(grokGuard("hashline_edit", { target_file: "../secret.txt", edits: [] }, options, false)).toMatch(PROTECTED);
		expect(grokGuard("search_replace", { file_path: "../notes.md", old_string: "a", new_string: "b" }, options, false)).toBeUndefined();
	});
});

describe("an input Grok cut (toolInputTruncated)", () => {
	it("a truncated input whose cut string is a shell command, a patch, or text a rule reads is refused, naming the size", () => {
		const { options } = setup();
		const SIZE = /^this call's input is over 128 KiB, so Grok cut its (command|input|query|prompt|path) short, and Orrery's guard can't check what was cut; nothing was run\.$/;
		expect(grokGuard("run_terminal_command", { command: cut("echo ok; "), description: "x" }, options, true)).toMatch(SIZE);
		expect(grokGuard("monitor", { command: cut("tail -f x"), description: "x" }, options, true)).toMatch(SIZE);
		expect(grokGuard("apply_patch", { input: cut(patch("*** Add File: a.md", "+a")) }, options, true)).toMatch(/cut its command short/);
		expect(grokGuard("box__apply", { tool_name: "box__apply", tool_input: { input: cut("*** Begin Patch\n") } }, options, true)).toMatch(SIZE);
		expect(grokGuard("web_search", { query: cut("rust") }, options, true)).toMatch(SIZE);
		expect(grokGuard("spawn_subagent", { prompt: cut("Review src/"), description: "x" }, options, true)).toMatch(SIZE);
		expect(grokGuard("fs__write_file", { tool_name: "fs__write_file", tool_input: { path: "notes.md", content: cut("x") } }, options, true)).toMatch(/cut its content short/);
		// The same calls whole (toolInputTruncated false) are judged as they are.
		expect(grokGuard("run_terminal_command", { command: `echo ok;${" ".repeat(5000)}`, description: "x" }, options, false)).toBeUndefined();
	});

	it("a truncated write whose path is allowed and whose content no rule reads goes through", () => {
		const { folder, options } = setup();
		expect(grokGuard("write", { file_path: "notes.md", content: cut("# Notes") }, options, true)).toBeUndefined();
		expect(grokGuard("search_replace", { file_path: "notes.md", old_string: cut("a"), new_string: cut("b") }, options, true)).toBeUndefined();
		// Its path is still judged.
		expect(grokGuard("write", { file_path: "/etc/x", content: cut("x") }, options, true)).toMatch(OUTSIDE);
		expect(grokGuard("write", { file_path: "../secret.txt", content: cut("x") }, options, true)).toMatch(PROTECTED);
		// A skill's front matter can't be judged from a cut text: refused (the skills rule).
		const skill = join(folder, ".claude", "skills", "s", "SKILL.md");
		expect(grokGuard("write", { file_path: skill, content: "---\nname: s\n---\nBody" }, options, false)).toBeUndefined();
		expect(grokGuard("write", { file_path: skill, content: cut("---\nname: s\n---\nBody") }, options, true)).toBeDefined();
		// Short strings Grok never cuts: an input marked cut whose strings are all short is judged whole.
		expect(grokGuard("run_terminal_command", { command: "ls", description: "x" }, options, true)).toBeUndefined();
	});

	it("takes a string of 4 KiB or more, or one ending in Grok's mark, as cut: Grok cuts to a length never under 4 KiB", () => {
		const { options } = setup();
		const SIZE = /cut its command short/;
		// At the floor a cut ASCII string is exactly 4096 bytes; its tag's layout is not relied on.
		const at = `echo ${"a".repeat(4096 - 5)}`;
		expect(Buffer.byteLength(at)).toBe(4096);
		expect(grokGuard("run_terminal_command", { command: at }, options, true)).toMatch(SIZE);
		// One byte short of it is never cut.
		expect(grokGuard("run_terminal_command", { command: at.slice(1) }, options, true)).toBeUndefined();
		// Counted in UTF-8 bytes: 2048 two-byte letters are 4096 bytes.
		expect(grokGuard("run_terminal_command", { command: `echo ${"é".repeat(2048)}` }, options, true)).toMatch(SIZE);
		// A short string ending in Grok's mark is a cut one, whatever its length.
		expect(grokGuard("run_terminal_command", { command: "cat notes.md <sha256:ab12> [truncated]" }, options, true)).toMatch(SIZE);
		expect(grokGuard("write", { file_path: "notes.md", content: "x [truncated]", description: "a [truncated]" }, options, true)).toMatch(/cut its description short/);
		// Whole (toolInputTruncated false), the same text is judged as it is.
		expect(grokGuard("run_terminal_command", { command: at }, options, false)).toBeUndefined();
		expect(grokGuard("run_terminal_command", { command: "cat notes.md [truncated]" }, options, false)).toBeUndefined();
		// What a write puts in its file, cut at the floor, still goes through, the skills rule seeing none of it.
		expect(grokGuard("write", { file_path: "notes.md", content: "a".repeat(4096) }, options, true)).toBeUndefined();
		expect(grokGuard("write", { file_path: join(options.folder, ".claude", "skills", "s", "SKILL.md"), content: "body [truncated]" }, options, true)).toBeDefined();
	});
});

describe("Grok's folder: all but what its own features write (what can switch Orrery's Grok hooks off or forge its records among it) is written by no tool and named in no shell text; its memory, skills, workflows and the rest it writes are Grok's own", () => {
	it("refuses writes to each guarded entry from file tools, in an agent's session and one that is no agent's, by any spelling or link", () => {
		const { grok, options, atHome, plain } = setup();
		for (const file of GROK_GUARDED) {
			for (const path of [join(grok, file), `~/.grok/${file}`, join(grok, file).toUpperCase().replace(grok.toUpperCase(), grok)]) {
				// Even with the agent's folder at home, which holds Grok's folder.
				expect([path, grokGuard("write", { file_path: path, content: "x" }, atHome, false)]).toEqual([path, expect.stringMatching(/Grok's folder|sensitive/)]);
				expect([path, grokGuard("search_replace", { file_path: path, old_string: "x", new_string: "y" }, atHome, false)]).toEqual([path, expect.stringMatching(/Grok's folder|sensitive/)]);
				expect([path, grokGuard("write", { file_path: path, content: "x" }, plain, false)]).toEqual([path, expect.stringMatching(/Grok's folder|session records/)]);
				expect([path, grokGuard("hashline_edit", { file_path: path, edits: [] }, plain, false)]).toEqual([path, expect.stringMatching(/Grok's folder|session records/)]);
			}
		}
		// A new file in a guarded folder, Grok's folder itself, through a link, and from an MCP tool or a patch.
		for (const opts of [atHome, plain]) {
			expect(grokGuard("write", { file_path: join(grok, "hooks", "evil.json"), content: "{}" }, opts, false)).toMatch(GROK_FOLDER);
			expect(grokGuard("write", { file_path: join(grok, "agents", "new.md"), content: "---\nhooks: {}\n---" }, opts, false)).toMatch(GROK_FOLDER);
			expect(grokGuard("write", { file_path: grok, content: "x" }, opts, false)).toMatch(GROK_FOLDER);
			expect(grokGuard("write", { file_path: join(opts.folder, "..", "ws", "hooks-link", "new.json"), content: "{}" }, opts, false)).toMatch(GROK_FOLDER);
			expect(grokGuard("fs__write_file", { tool_name: "fs__write_file", tool_input: { path: join(grok, "config.toml"), content: "x" } }, opts, false)).toMatch(GROK_FOLDER);
			expect(grokGuard("apply_patch", { input: patch(`*** Add File: ${join(grok, "hooks", "x.json")}`, "+{}") }, opts, false)).toMatch(GROK_FOLDER);
		}
		expect(grokGuard("write", { file_path: "../hooks-link/new.json", content: "{}" }, options, false)).toMatch(GROK_FOLDER);
	});

	it("refuses writes to lsp.json and to any file in Grok's folder outside what its own features write, from file tools, shell text, an unknown tool and a no-verb MCP tool, in both sessions", () => {
		const { grok, atHome, plain } = setup();
		// What it doesn't name, and a name beside an open part, is no part of them.
		const files = [
			...GROK_UNNAMED,
			"skills-old/x/SKILL.md",
			"memory-v2.bak",
			"workflowsx/review.rhai",
			"hooks-backup/x.json",
			"config.toml.bak",
			"agentsx/a.md",
			"logs-old/x",
			"learnx/y",
			"bundled/skillsx/y",
			"bundled/workflows/deep-research.rhai",
		];
		for (const opts of [atHome, plain]) {
			for (const file of files) {
				for (const path of [join(grok, file), `~/.grok/${file}`]) {
					expect([path, grokGuard("write", { file_path: path, content: "x" }, opts, false)]).toEqual([path, expect.stringMatching(GROK_FOLDER)]);
					expect([path, grokGuard("search_replace", { file_path: path, old_string: "x", new_string: "y" }, opts, false)]).toEqual([path, expect.stringMatching(GROK_FOLDER)]);
					expect([path, grokGuard("hashline_edit", { file_path: path, edits: [] }, opts, false)]).toEqual([path, expect.stringMatching(GROK_FOLDER)]);
					expect([path, grokGuard("lsp", { operation: "rename", file_path: path, line: 1, character: 1, new_name: "y" }, opts, false)]).toEqual([path, expect.stringMatching(GROK_FOLDER)]);
					expect([path, grokGuard("box__apply", { tool_name: "box__apply", tool_input: { target_file: path, text: "{}" } }, opts, false)]).toEqual([path, expect.stringMatching(GROK_FOLDER)]);
				}
				for (const command of [`echo x > ~/.grok/${file}`, `cp x ${grok}/${file}`, `echo x >> $GROK_HOME/${file}`]) {
					expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_FOLDER)]);
				}
			}
			// Reads stay open to file tools.
			for (const path of ["~/.grok/lsp.json", "~/.grok/docs/user-guide/10-hooks.md", "~/.grok/pager.toml"]) {
				expect([path, grokGuard("read_file", { target_file: path }, opts, false)]).toEqual([path, undefined]);
			}
		}
	});

	it("leaves what its own features write writable (its memory, skills, workflows, /learn's runs, background-task logs, plugins' data, bundled skills, docs, logs and session worktrees), in both sessions", () => {
		const { grok, atHome, plain } = setup();
		for (const file of GROK_OPEN) {
			for (const opts of [atHome, plain]) {
				for (const path of [join(grok, file), `~/.grok/${file}`]) {
					expect([path, grokGuard("write", { file_path: path, content: "---\nname: x\n---\nBody" }, opts, false)]).toEqual([path, undefined]);
					expect([path, grokGuard("search_replace", { file_path: path, old_string: "x", new_string: "y" }, opts, false)]).toEqual([path, undefined]);
				}
				const command = `echo x >> ~/.grok/${file} && cp ${join(grok, file)} $GROK_HOME/${file}.new`;
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, undefined]);
			}
		}
	});

	it("refuses shell text that names a guarded entry, or Grok's folder itself, by its path, from home, or $GROK_HOME, in every tool that runs one, in both sessions", () => {
		const { grok, options, plain } = setup();
		for (const command of [
			"echo '{}' > ~/.grok/hooks/orrery.json",
			"rm ~/.grok/hooks/orrery.json",
			"printf 'global/orrery:pre_tool_use[0].hooks[0]\\n' >> ~/.grok/disabled-hooks",
			"sed -i /orrery/d $HOME/.grok/config.toml",
			`cat >> ${grok}/trusted_folders.toml`,
			"cp policy.toml ${HOME}/.grok/requirements.toml",
			"cp policy.toml ~/.grok/managed_config.toml",
			"echo x >> $GROK_HOME/hooks/x.json",
			"ls ${GROK_HOME}/installed-plugins",
			"cp -r p ~/.grok/plugins/",
			"printf -- '---\\nhooks: {}\\n---\\n' > ~/.grok/agents/a.md",
			"echo x >> ~/.grok/sessions/%2Fws/01a1/updates.jsonl",
			// Grok's folder itself: a copy, an archive or a cd into it reaches every guarded entry.
			"cp -r hooks ~/.grok/",
			"tar -xf x.tar -C ~/.grok",
			"cd ~/.grok && rm -rf hooks",
			"cd $GROK_HOME",
			// Spellings that come back to a guarded entry, or could be one.
			"cat ~/.grok/docs/../hooks/orrery.json",
			"echo x > ~/.grok/{docs,hooks}/x.json",
			"rm ~/.grok/h*/orrery.json",
			"rm ~/.grok/[ch]onfig.toml",
			"rm ~/.grok/HOOKS/orrery.json",
			'rm "$HOME/.grok"/config.toml',
			"rm ~/.grok/docs/.*/hooks/orrery.json",
			"rm ~/.grok/$name",
			"rm ~/.grok/docs/`echo ..`/hooks/x",
			// Everything outside what its own features write, named or not (reads go through the file tools): the bundle but
			// its skills among it (its agents carry hooks).
			"echo '{}' > ~/.grok/lsp.json",
			"ls ~/.grok/hooks-backup",
			"cp x ~/.grok/skills-old/x",
			"cp -r x ~/.grok/s*/",
			"cat ~/.grok/skills/../lsp.json",
			"ls ~/.grok/bundled",
			"cp a.md ~/.grok/bundled/agents/",
			"cp x ~/.grok/bundled/s*/x",
			"cat ~/.grok/bundled/skills/../manifest.json",
			"echo x > ~/.grok/logs/../hooks/x.json",
		]) {
			expect([command, grokGuard("run_terminal_command", { command, description: "x" }, options, false)]).toEqual([command, expect.stringMatching(/Grok's folder|sensitive|session records/)]);
			expect([command, grokGuard("monitor", { command }, options, false)]).toEqual([command, expect.stringMatching(/Grok's folder|sensitive|session records/)]);
			expect([command, grokGuard("run_terminal_command", { command }, plain, false)]).toEqual([command, expect.stringMatching(/Grok's folder|session records/)]);
		}
		// What its own features write, and a name beside Grok's folder.
		for (const command of [
			"cat ~/.grok/memory-v2/global/MEMORY.md",
			"echo '- likes tabs' >> ~/.grok/memory-v2/global/MEMORY.md",
			"ls ~/.grok/skills && cat ~/.grok/skills/*/SKILL.md",
			"cp review.rhai $GROK_HOME/workflows/",
			"cat ~/.grok/./skills/x/SKILL.md ~/.grok/skills/y/../x/SKILL.md",
			"cat ~/.grok/docs/user-guide/10-hooks.md",
			"tail -n 50 ~/.grok/logs/unified.jsonl",
			"ls ~/.grok/bundled/skills",
			"cat ~/.grokrc",
			"grok --version",
		]) {
			expect([command, grokGuard("run_terminal_command", { command }, options, false)]).toEqual([command, undefined]);
			expect([command, grokGuard("run_terminal_command", { command }, plain, false)]).toEqual([command, undefined]);
		}
		// A project's own .grok folder: a project's hooks and config are the project's (a known limit, src/grok/guard.ts),
		// as Claude Code's project settings are. From home (the plain session's cwd), .grok is Grok's folder.
		for (const command of ["ls .grok/hooks", "cat .grok/config.toml"]) {
			expect([command, grokGuard("run_terminal_command", { command }, options, false)]).toEqual([command, undefined]);
			expect([command, grokGuard("run_terminal_command", { command }, plain, false)]).toEqual([command, expect.stringMatching(GROK_NAMED)]);
		}
	});

	it("lets Grok's bundled skills run their scripts and write where they do, in both sessions; what Grok loads stays kept", () => {
		const { grok, options, atHome, plain } = setup();
		// The shapes Grok 1.0.70's bundled skills use (bundled/skills/*/SKILL.md): long-running-background-tasks' dev server
		// log, keyed on the shell's own process number ($$) after the path, and its watchers; pptx's and learn's scripts;
		// pr-babysit's state folder; a /learn run's report; the manual; the logs.
		const commands = [
			"echo $$; npm start >~/.grok/long-running-background-tasks/dev_server_$$.log 2>&1",
			"bash ~/.grok/long-running-background-tasks/watch_dev_server.sh 123456789",
			'python3 ~/.grok/long-running-background-tasks/watch_pr.py "https://github.com/o/r/pull/1"',
			`python3 ${grok}/bundled/skills/pptx/scripts/x.py deck.pptx`,
			"python3 ~/.grok/bundled/skills/learn/state.py get",
			"python3 $GROK_HOME/bundled/skills/learn/collect_sessions.py --estimate",
			"mkdir -p ~/.grok/plugin-data/pr-babysit",
			"cat ~/.grok/learn/runs/20261029T000000Z/actions.json",
			"cat ~/.grok/docs/user-guide/10-hooks.md",
			"tail -n 50 ~/.grok/logs/unified.jsonl",
			// The shared helper beside a skill, as implement, design, review, execute-plan and pr-babysit name it
			// (<dirname of SKILL.md>/../shared/scripts/host.py): a ".." that stays in the bundled skills.
			`python ${grok}/bundled/skills/implement/../shared/scripts/host.py setup`,
			"python3 ~/.grok/bundled/skills/review/../shared/scripts/host.py cleanup /tmp/s/a.md",
			'"$PY" "$GROK_HOME/bundled/skills/pr-babysit/../shared/scripts/host.py" uuid --full',
			// /learn's own --cwd is no folder option of the shell's.
			"python3 ~/.grok/bundled/skills/learn/collect_sessions.py --cwd /src/app --days 7",
		];
		for (const opts of [options, atHome, plain]) {
			for (const command of commands) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, undefined]);
				expect([command, grokGuard("monitor", { command }, opts, false)]).toEqual([command, undefined]);
			}
		}
		// File tools, in an agent's session whose folder holds Grok's, and in one that is no agent's.
		const files = ["plugin-data/pr-babysit/watched-prs-1.json", "learn/trash/run/originals/x.md", "learn/state.json", "long-running-background-tasks/watch_dev_server.sh", "implement-memory/0123abcd.md"];
		for (const opts of [atHome, plain]) {
			for (const file of files) {
				expect([file, grokGuard("write", { file_path: join(grok, file), content: "{}" }, opts, false)]).toEqual([file, undefined]);
				expect([file, grokGuard("write", { file_path: `~/.grok/${file}`, content: "{}" }, opts, false)]).toEqual([file, undefined]);
			}
		}
		// Still kept: what Grok loads and runs, the bundle's agents among it (Grok runs their hooks).
		for (const opts of [options, atHome, plain]) {
			for (const command of ["echo '{}' > ~/.grok/hooks/x.json", "sed -i s/a/b/ ~/.grok/config.toml", "echo '{}' > ~/.grok/lsp.json", "cp a.md ~/.grok/bundled/agents/a.md"]) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_FOLDER)]);
			}
		}
		for (const opts of [atHome, plain]) {
			for (const file of ["hooks/x.json", "config.toml", "lsp.json", "bundled/agents/a.md"]) {
				expect([file, grokGuard("write", { file_path: join(grok, file), content: "{}" }, opts, false)]).toEqual([file, expect.stringMatching(GROK_FOLDER)]);
			}
		}
	});

	it("takes the shell's own process number ($$) after Grok's folder as the digits it is, and any other variable or substitution as anything", () => {
		const { options, plain } = setup();
		for (const opts of [options, plain]) {
			for (const command of ["npm start > ~/.grok/logs/dev_$$.log", "echo x > ~/.grok/logs/a$$$$b", 'echo x > "$HOME/.grok/logs/dev_$$.log"', "echo x > ~/.grok/logs/a$${x}"]) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, undefined]);
			}
			for (const command of [
				"echo x > ~/.grok/logs/x$y",
				"echo x > ~/.grok/logs/x$$$y",
				"echo x > ~/.grok/logs/x\\$$y",
				"echo x > ~/.grok/logs/x${$}",
				"echo x > ~/.grok/$$",
				"echo x > ~/.grok/skills$$/x",
				"echo x > ~/.grok/logs/x$$/../../hooks/a.json",
				"echo x > ~/.grok/logs/x`id`",
			]) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_FOLDER)]);
			}
		}
	});

	it("takes an open part's path after a command substitution's opening ($(, a backquote, ${ …; }), followed by ) or a backquote, or in text whose parentheses don't pair up, as anything: the shell may make another path of it, in both sessions and under $GROK_HOME", () => {
		const { root, grok, options, atHome, plain } = setup();
		const refused = [
			"echo x > $(dirname ~/.grok/skills)/hooks/e.json",
			`echo x > "$(dirname ${grok}/skills)/hooks/e.json"`,
			"echo x > $(dirname $GROK_HOME/skills)/hooks/e.json",
			"cp x $(dirname $(dirname ~/.grok/skills/x))/hooks/e.json",
			// Inside one, followed by more than its close.
			"echo x > $(dirname ~/.grok/skills/x/SKILL.md | xargs dirname | xargs dirname)/hooks/e.json",
			"d=$(dirname ~/.grok/logs ); echo x > $d/hooks/e.json",
			"echo x > `dirname ~/.grok/skills`/hooks/e.json",
			"echo x > `dirname ~/.grok/skills/x/SKILL.md | xargs dirname | xargs dirname`/hooks/e.json",
			'cp x "`dirname "$GROK_HOME/docs/a" | xargs dirname`/config.toml"',
			// An escaped backquote before it changes nothing.
			"echo \\` ; echo x > `dirname ~/.grok/skills/x/SKILL.md | xargs dirname | xargs dirname`/hooks/e.json",
			// Read failing closed, as a count can't tell a quoted ")" or a case pattern's from a close: a substitution's
			// opening anywhere before the path counts.
			'echo x > $(: ")"; dirname ~/.grok/skills )/hooks/e.json',
			"echo x > $(: ')'; dirname ~/.grok/skills )/hooks/e.json",
			"echo x > $(: \\); dirname ~/.grok/skills )/hooks/e.json",
			"echo x > $(case a in a) dirname ~/.grok/skills;; esac)/hooks/e.json",
			'echo x > `: ")"; dirname ~/.grok/skills `/hooks/e.json',
			// One beside the path, before it, too.
			'echo "$(date)" >> ~/.grok/logs/x.log',
			"x=$(date); echo $x >> ~/.grok/logs/x.log",
			// bash's own ${ …; } and ${| …; } (5.3).
			"echo x > ${ dirname ~/.grok/skills; }/hooks/e.json",
			"echo x > ${\ndirname ~/.grok/skills\n}/hooks/e.json",
			"echo x > ${| REPLY=~/.grok/skills; REPLY=${REPLY%/*}; }/hooks/e.json",
			// Parentheses that don't pair up in number, with no substitution before the path.
			'case "$1" in a) cp a ~/.grok/skills/x;; esac',
			'cp a ~/.grok/skills/x; echo ")"',
			'cp a ~/.grok/skills/x; echo "$(date"',
		];
		for (const opts of [options, atHome, plain]) {
			for (const command of refused) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_NAMED)]);
				expect([command, grokGuard("monitor", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_NAMED)]);
			}
			// No substitution before the path (one after it, or a variable), and parentheses that pair up.
			for (const command of [
				"cp a ~/.grok/skills/x",
				"cp a ~/.grok/skills/x; echo $(date)",
				"echo x > ~/.grok/skills/x/SKILL.md; echo `date`",
				'echo "${HOME}" >> ~/.grok/logs/x.log',
				"(cd ~/.grok/worktrees/repo-x; npm test)",
				"cp a ~/.grok/skills/x; case $1 in (a) echo a;; esac",
			]) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, undefined]);
			}
		}
		// A folder GROK_HOME moves Grok's to, named by its path or the variable.
		const moved = join(root, "grok-home");
		mkdirSync(join(moved, "skills"), { recursive: true });
		const before = process.env.GROK_HOME;
		process.env.GROK_HOME = moved;
		try {
			for (const opts of [{ ...options, folder: root, cwd: root }, { ...plain, folder: root, cwd: root }]) {
				for (const command of [
					`echo x > $(dirname ${moved}/skills)/hooks/e.json`,
					"echo x > $(dirname $GROK_HOME/skills)/hooks/e.json",
					`echo x > \`dirname ${moved}/skills/x y\`/hooks/e.json`,
					`echo x > $(: ")"; dirname ${moved}/skills )/hooks/e.json`,
					"echo x > $(case a in a) dirname $GROK_HOME/skills;; esac)/hooks/e.json",
					`echo "$(date)" >> ${moved}/skills/x/log`,
					'case "$1" in a) cp a $GROK_HOME/skills/x;; esac',
				]) {
					expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_NAMED)]);
				}
				for (const command of [`cp a ${moved}/skills/x`, "cp a $GROK_HOME/skills/x; echo $(date)"]) {
					expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, undefined]);
				}
			}
		} finally {
			if (before === undefined) delete process.env.GROK_HOME;
			else process.env.GROK_HOME = before;
		}
	});

	it("refuses shell text that names an open part and also changes folder, has a .. path part or makes a link, which could reach the rest, in both sessions and under $GROK_HOME", () => {
		const { root, grok, options, atHome, plain } = setup();
		const commands = [
			// A relative path after a cd, a pushd or a tool's own folder option is read from the open part.
			"cd ~/.grok/skills && echo x > ../hooks/e.json",
			`cd ${grok}/skills && echo x > ../hooks/e.json`,
			'cd "$GROK_HOME/skills" && echo x > ../hooks/e.json',
			"cd ~/.grok/docs",
			"(cd ~/.grok/skills; ls)",
			"pushd ~/.grok/learn; echo x >> ../config.toml; popd",
			"git -C ~/.grok/skills mv x ../hooks/x.json",
			"git -C ~/.grok/skills status",
			"/usr/bin/git -C $GROK_HOME/workflows log",
			"git --git-dir=~/.grok/skills/.git --work-tree ~/.grok/skills checkout .",
			"make -C ~/.grok/plugin-data/p",
			"npm --prefix ~/.grok/plugin-data/p install",
			"bun --cwd=~/.grok/plugin-data/p run x",
			// A ".." anywhere: beside the open part, or in its own path above the open part it ends in.
			"cat ~/.grok/skills/x/SKILL.md ../notes.md",
			"cp ~/.grok/skills/x/SKILL.md --target-directory=..",
			"cat ~/.grok/workflows/../skills/x/SKILL.md",
			"cat ~/.grok/bundled/skills/../skills/x/SKILL.md",
			"cat ~/.grok/skills/x/SKILL.md .*/hooks/orrery.json",
			// A link made there could lead it to the rest.
			"ln -s ../hooks ~/.grok/skills/h",
			"ln -s ~/dotfiles/x ~/.grok/skills/h",
			"/bin/ln -sf x $GROK_HOME/learn/h",
			"cp -s x ~/.grok/skills/h",
			"cp -rs dir ~/.grok/skills/d",
			"cp --symbolic-link x ~/.grok/skills/h",
			"cp --sym x ~/.grok/skills/h",
			"cp -l x ~/.grok/skills/h",
			"cp --link x ~/.grok/skills/h",
			"xargs cp -s < list -t ~/.grok/skills/",
			// A popd: back to a folder an earlier cd or pushd left on the stack.
			"cp a ~/.grok/skills/x; popd",
		];
		for (const opts of [options, atHome, plain]) {
			for (const command of commands) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_REACH)]);
				expect([command, grokGuard("monitor", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_REACH)]);
			}
			// A path that walks into the rest names it, as before.
			expect(grokGuard("run_terminal_command", { command: "echo x > ~/.grok/skills/../hooks/e.json" }, opts, false)).toMatch(GROK_FOLDER);
			// A ".." in an open part's own path that stays in it, text that names no part of Grok's folder, and git's -c
			// setting (lower case, as its -C reads).
			for (const command of ["cat ~/.grok/skills/x/../y/SKILL.md", "cp -r x ~/.grok/skills/x", "cd /src && ls ..", "ln -s ../x y", "git -C ../repo status", "echo 'wait...' >> ~/.grok/memory-v2/global/MEMORY.md", "git -c core.pager=cat log ~/.grok/skills"]) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, undefined]);
			}
		}
		// A folder GROK_HOME moves Grok's to, named by its path or the variable.
		const moved = join(root, "grok-home");
		mkdirSync(join(moved, "skills"), { recursive: true });
		const before = process.env.GROK_HOME;
		process.env.GROK_HOME = moved;
		try {
			for (const opts of [{ ...options, folder: root, cwd: root }, { ...plain, folder: root, cwd: root }]) {
				for (const command of [`cd ${moved}/skills && echo x > ../hooks/e.json`, "cd $GROK_HOME/skills && echo x > ../hooks/e.json", `git -C ${moved}/skills status`, `ln -s ../hooks ${moved}/skills/h`, `cp -l x ${moved}/skills/h`]) {
					expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_REACH)]);
				}
				expect(grokGuard("run_terminal_command", { command: `cp x ${moved}/skills/y/SKILL.md` }, opts, false)).toBeUndefined();
			}
		} finally {
			if (before === undefined) delete process.env.GROK_HOME;
			else process.env.GROK_HOME = before;
		}
	});

	it("lets Grok's session worktrees (worktrees/, the person's checkouts) be worked in: a folder change into one goes through; a .., a link, another open part beside it and Grok's worktree state stay refused, in both sessions and under $GROK_HOME", () => {
		const { root, grok, options, atHome, plain } = setup();
		const wt = join(grok, "worktrees", "repo-x");
		// An agent's grok -w session runs in the worktree, outside the agent's folder: it may write where it runs.
		const inWorktree = { ...options, folder: wt, cwd: wt };
		const plainInWorktree = { ...plain, folder: wt, cwd: wt };
		for (const opts of [options, atHome, inWorktree, plain, plainInWorktree]) {
			for (const command of [
				`cd ${wt} && npm test`,
				"cd ~/.grok/worktrees/repo-x && npm test",
				'cd "$GROK_HOME/worktrees/repo-x" && git add -A && git commit -m x',
				"(cd ~/.grok/worktrees/repo-x; npm run build)",
				"pushd ~/.grok/worktrees/repo-x; npm test; popd",
				`git -C ${wt} status`,
				"git -C ~/.grok/worktrees/repo-x diff HEAD",
				"make -C ~/.grok/worktrees/repo-x",
				"npm --prefix ~/.grok/worktrees/repo-x test",
			]) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, undefined]);
				expect([command, grokGuard("monitor", { command }, opts, false)]).toEqual([command, undefined]);
			}
			// A ".." or a link made there could still reach the rest; and another open part named beside a folder change keeps
			// the rule in full.
			for (const command of [
				`cd ${wt} && echo x > ../../hooks/e.json`,
				"cd ~/.grok/worktrees/repo-x; cat ../../config.toml",
				"cd $GROK_HOME/worktrees/repo-x && echo x > ../../hooks/e.json",
				"git -C ~/.grok/worktrees/repo-x mv a ../../hooks/a.json",
				"cat ~/.grok/worktrees/repo-x/../../skills/x/SKILL.md",
				"ln -s ../../hooks ~/.grok/worktrees/repo-x/h",
				"cd ~/.grok/worktrees/repo-x && ln -s /elsewhere h",
				"cp -s x ~/.grok/worktrees/repo-x/h",
				"cd ~/.grok/worktrees/repo-x && cp ~/.grok/skills/x/SKILL.md .",
				"git -C ~/.grok/worktrees/repo-x log > ~/.grok/docs/log.txt",
			]) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_REACH)]);
			}
			// What Grok loads, its worktree state (the registry and open-session list beside worktrees/, its pool), a variable or
			// substitution after the path, and a name beside it: named, as before.
			for (const command of [
				`ln -s ${grok}/hooks ${grok}/worktrees/h`,
				"cd ~/.grok/worktrees/repo-x && echo x > ~/.grok/hooks/e.json",
				"cat ~/.grok/worktrees/../hooks/orrery.json",
				"cd ~/.grok/worktrees/$name && echo x > e.json",
				"cd ~/.grok/worktrees/`echo ..`",
				"echo x > ~/.grok/worktrees.db",
				"rm ~/.grok/active_sessions.json",
				"cp -r x ~/.grok/worktree_pool/repo-x/y",
				"cd ~/.grok/worktreesx",
			]) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_NAMED)]);
			}
		}
		// File tools: the checkouts are writable where a session may write; Grok's worktree state is not.
		for (const opts of [atHome, inWorktree, plain, plainInWorktree]) {
			for (const path of [join(wt, "src", "a.ts"), "~/.grok/worktrees/repo-x/src/a.ts"]) {
				expect([path, grokGuard("write", { file_path: path, content: "x" }, opts, false)]).toEqual([path, undefined]);
				expect([path, grokGuard("search_replace", { file_path: path, old_string: "x", new_string: "y" }, opts, false)]).toEqual([path, undefined]);
			}
			for (const path of [join(grok, "worktrees.db"), join(grok, "active_sessions.json"), join(grok, "worktree_pool", "repo-x", "a.ts"), join(grok, "worktreesx", "a.ts")]) {
				expect([path, grokGuard("write", { file_path: path, content: "x" }, opts, false)]).toEqual([path, expect.stringMatching(GROK_FOLDER)]);
			}
		}
		for (const opts of [inWorktree, plainInWorktree]) {
			expect(grokGuard("write", { file_path: "src/a.ts", content: "x" }, opts, false)).toBeUndefined();
			expect(grokGuard("write", { file_path: "../../hooks/e.json", content: "{}" }, opts, false)).toMatch(GROK_FOLDER);
		}
		// Another worktree: open where a session may write; an agent's session writes there as anywhere outside where it
		// may: not at all.
		for (const opts of [atHome, plain, plainInWorktree]) expect(grokGuard("write", { file_path: join(grok, "worktrees", "repo-y", "new.ts"), content: "x" }, opts, false)).toBeUndefined();
		expect(grokGuard("write", { file_path: join(grok, "worktrees", "repo-y", "new.ts"), content: "x" }, inWorktree, false)).toMatch(OUTSIDE);
		expect(grokGuard("write", { file_path: join(wt, "src", "a.ts"), content: "x" }, options, false)).toMatch(OUTSIDE);
		// A folder GROK_HOME moves Grok's to, named by its path or the variable.
		const moved = join(root, "grok-home");
		mkdirSync(join(moved, "worktrees", "repo-x", "src"), { recursive: true });
		const before = process.env.GROK_HOME;
		process.env.GROK_HOME = moved;
		try {
			for (const opts of [{ ...options, folder: root, cwd: root }, { ...plain, folder: root, cwd: root }]) {
				for (const command of [`cd ${moved}/worktrees/repo-x && npm test`, "cd $GROK_HOME/worktrees/repo-x && npm test", `git -C ${moved}/worktrees/repo-x status`]) {
					expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, undefined]);
				}
				for (const command of [`cd ${moved}/worktrees/repo-x && echo x > ../../hooks/e.json`, "cd $GROK_HOME/worktrees/repo-x && echo x > ../../hooks/e.json", `ln -s ../../hooks ${moved}/worktrees/repo-x/h`]) {
					expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_REACH)]);
				}
				for (const command of [`ln -s ${moved}/hooks ${moved}/worktrees/h`, `echo x > ${moved}/worktrees.db`, "echo x > $GROK_HOME/worktrees.db"]) {
					expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_NAMED)]);
				}
				expect(grokGuard("write", { file_path: join(moved, "worktrees", "repo-x", "src", "a.ts"), content: "x" }, opts, false)).toBeUndefined();
				expect(grokGuard("write", { file_path: join(moved, "worktrees.db"), content: "x" }, opts, false)).toMatch(GROK_FOLDER);
			}
		} finally {
			if (before === undefined) delete process.env.GROK_HOME;
			else process.env.GROK_HOME = before;
		}
		// worktrees/ moved to another disk by a link (grok du counts one): writable through the link and where it is to file
		// tools; shell text, which can't follow the link, works in it where it is.
		const disk = join(root, "disk", "worktrees");
		mkdirSync(join(disk, "repo-z"), { recursive: true });
		rmSync(join(grok, "worktrees"), { recursive: true });
		symlinkSync(disk, join(grok, "worktrees"));
		for (const opts of [{ ...options, folder: root, cwd: root }, plain]) {
			for (const path of [join(grok, "worktrees", "repo-z", "a.ts"), join(disk, "repo-z", "a.ts")]) {
				expect([path, grokGuard("write", { file_path: path, content: "x" }, opts, false)]).toEqual([path, undefined]);
			}
			expect(grokGuard("run_terminal_command", { command: `cd ${disk}/repo-z && npm test` }, opts, false)).toBeUndefined();
			expect(grokGuard("run_terminal_command", { command: "cd ~/.grok/worktrees/repo-z && npm test" }, opts, false)).toMatch(GROK_NAMED);
		}
	});

	it("in text that names Grok's session worktrees, lets a folder change through only into one (a plain path at least worktrees/<repo> deep): a bare cd, cd -, cd ~, a stack argument, any other target is refused, in both sessions and under $GROK_HOME", () => {
		const { root, grok, options, atHome, plain } = setup();
		const wt = join(grok, "worktrees", "repo", "wt");
		mkdirSync(join(wt, "src"), { recursive: true });
		const inWorktree = { ...options, folder: wt, cwd: wt };
		const plainInWorktree = { ...plain, folder: wt, cwd: wt };
		const judge = (opts: object, allowed: readonly string[], refused: readonly string[]) => {
			for (const command of allowed) {
				expect([command, grokGuard("run_terminal_command", { command }, opts as typeof options, false)]).toEqual([command, undefined]);
				expect([command, grokGuard("monitor", { command }, opts as typeof options, false)]).toEqual([command, undefined]);
			}
			for (const command of refused) {
				expect([command, grokGuard("run_terminal_command", { command }, opts as typeof options, false)]).toEqual([command, expect.stringMatching(GROK_REACH)]);
				expect([command, grokGuard("monitor", { command }, opts as typeof options, false)]).toEqual([command, expect.stringMatching(GROK_REACH)]);
			}
		};
		for (const opts of [options, atHome, inWorktree, plain, plainInWorktree]) {
			judge(
				opts,
				[
					// Into a worktree, or a folder of its repo's, by its path, from home or $GROK_HOME, quoted or not.
					`cd ${wt} && npm test`,
					`git -C ${wt} status`,
					"cd ~/.grok/worktrees/repo/wt/src && npm test",
					"cd ~/.grok/worktrees/repo && ls",
					'cd "$GROK_HOME/worktrees/repo/wt" && npm test',
					'cd "$GROK_HOME"/worktrees/repo/wt && npm test',
					// A pushd's output sent away, the popd back from it, a cd's comment and what runs if it fails.
					`pushd ${wt} > /dev/null; npm test; popd > /dev/null`,
					`pushd ${wt} >/dev/null 2>&1 && npm test`,
					`pushd ${wt}; pushd ${wt}/src; popd; popd`,
					`cd ${wt} # the worktree`,
					`cd ${wt} || exit 1`,
					// A tool's folder options, alone, glued or with "=", and git's -c setting (lower case, as its -C reads).
					`git -C ${wt} -c core.pager=cat log`,
					`git --git-dir=${wt}/.git --work-tree ${wt} status`,
					`make -C${wt}`,
					`npm --prefix=${wt} test`,
				],
				[
					// A cd to home, back, or with a second word (zsh's cd old new).
					`cd ${wt} && cd && echo x > .grok/hooks/e.json`,
					`cd ${wt} && cd - && echo x > hooks/e.json`,
					`cd ${wt} && cd ~ && echo x > .grok/hooks/e.json`,
					`cd ${wt}; cd $HOME; echo x > .grok/hooks/e.json`,
					`cd ${wt} ~ && echo x > .grok/hooks/e.json`,
					// worktrees/ itself: one part deep.
					`cd ${grok}/worktrees && ls`,
					"cd ~/.grok/worktrees && echo x > repo/wt/a.ts",
					"cd $GROK_HOME/worktrees && ls",
					// The folder stack.
					`pushd ${wt}; pushd +1; echo x > hooks/e.json`,
					`pushd ${wt}; pushd; echo x > hooks/e.json`,
					`pushd ${wt}; popd +1; echo x > hooks/e.json`,
					`pushd ${wt}; popd -0`,
					// A popd with no pushd before it to undo: a shell that persists keeps an older stack.
					`cd ${wt}; popd; echo x > .grok/hooks/e.json`,
					`pushd ${wt}; popd; popd; echo x > .grok/hooks/e.json`,
					// Any other target: elsewhere, a variable, a glob or a brace group.
					`cd /tmp && cp x ${wt}/a.ts`,
					`cd $dir && cp x ${wt}/a.ts`,
					`cd ${wt}/* && ls`,
					`cd ${grok}/worktrees/{repo,x}/wt && ls`,
					`git -C /elsewhere status && cat ${wt}/a.ts`,
					`git -C ${wt} --git-dir=/elsewhere/.git status`,
					`make -C src -f ${wt}/Makefile`,
					`npm --prefix=/elsewhere test && cat ${wt}/a.ts`,
				],
			);
		}
		// A folder GROK_HOME moves Grok's to, named by its path or the variable.
		const moved = join(root, "grok-home");
		const movedWt = join(moved, "worktrees", "repo", "wt");
		mkdirSync(movedWt, { recursive: true });
		const before = process.env.GROK_HOME;
		process.env.GROK_HOME = moved;
		try {
			for (const opts of [{ ...options, folder: root, cwd: root }, { ...plain, folder: root, cwd: root }]) {
				judge(
					opts,
					[`cd ${movedWt} && npm test`, "cd $GROK_HOME/worktrees/repo/wt && npm test", "git -C ${GROK_HOME}/worktrees/repo/wt status"],
					[
						`cd ${movedWt} && cd && echo x > .grok/hooks/e.json`,
						"cd $GROK_HOME/worktrees/repo/wt && cd - && echo x > hooks/e.json",
						`cd ${moved}/worktrees && ls`,
						"pushd $GROK_HOME/worktrees/repo/wt; pushd +1; echo x > hooks/e.json",
					],
				);
			}
		} finally {
			if (before === undefined) delete process.env.GROK_HOME;
			else process.env.GROK_HOME = before;
		}
	});

	it("reads a relative path with a .. from where the call runs when that is in Grok's folder (a session worktree, a skill's folder): one that leaves the open part it runs in is refused, one that stays in it goes through, in both sessions and under $GROK_HOME", () => {
		const { root, grok, options, plain } = setup();
		const kinds = (here: string) => [
			{ ...options, folder: here, cwd: here },
			{ ...plain, folder: here, cwd: here },
		];
		const judge = (here: string, refused: readonly string[], allowed: readonly string[]) => {
			for (const opts of kinds(here)) {
				for (const command of refused) {
					expect([here, command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([here, command, expect.stringMatching(GROK_CLIMB)]);
					expect([here, command, grokGuard("monitor", { command }, opts, false)]).toEqual([here, command, expect.stringMatching(GROK_CLIMB)]);
				}
				for (const command of allowed) {
					expect([here, command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([here, command, undefined]);
				}
			}
		};
		// A grok -w session runs in <grok-home>/worktrees/<repo>/<name>; here a folder in one.
		const worktree = (home: string) => join(home, "worktrees", "repo", "wt", "sub");
		mkdirSync(worktree(grok), { recursive: true });
		const outOfWorktree = [
			"echo x > ../../../../hooks/e.json",
			"cat ../../../../config.toml",
			"ls ../../../..",
			"ls ../../../../..",
			// Another open part, or out of the worktrees and back.
			"cp x ../../../../skills/y/SKILL.md",
			"cat ../../../../worktrees/repo/wt/a.ts",
			// However the path is spelt: after ./ or a name, quoted, globbed, as an option's value, from $PWD or ~+.
			"echo x > ./../../../../hooks/e.json",
			"echo x > a/../../../../../hooks/e.json",
			'echo x > "../../../../hooks/e.json"',
			"cat ../../../../hooks/*.json",
			"cat .*/.*/.*/.*/hooks/orrery.json",
			"cp x --target-directory=../../../../hooks",
			"cp x -t../../../../hooks",
			// A short option's value glued after any of its letters, a glob among it.
			"cp x -vt../../../../hooks",
			"cp x -t.*/.*/.*/.*/hooks",
			"cp x -vt~+/../../../../hooks",
			"echo x > $PWD/../../../../hooks/e.json",
			"echo x > ${PWD}/../../../../hooks/e.json",
			"echo x > ~+/../../../../hooks/e.json",
			// A variable or substitution in it may be anything, as in a path the text names.
			"echo x > ../$name",
		];
		const inWorktree = ["cat ../README.md", "cd .. && npm test", "ls ../..", "cat ../../../other-repo/README.md", "git diff ../../other-wt", "npm test -- --reporter=../r.js", "git log main..feature", "git diff HEAD~1..", "ls -d .*", "cat ../src/../README.md", "echo x > out/e.json", "cp x -vt../out", "echo $(date) > ../out.txt"];
		judge(worktree(grok), outOfWorktree, inWorktree);
		// A path that starts with "-" or "--" (after --, or written by a redirection) is a path as written, and so is one
		// after "./" or a name.
		judge(
			join(grok, "worktrees", "repo", "wt"),
			[
				"echo x > --t/.*/.*/.*/.*/hooks/e.json",
				"cp x -- --t/.*/.*/.*/.*/hooks/",
				"cat -- -/.*/.*/.*/.*/config.toml",
				"cat -- -~/.*/.*/.*/.*/config.toml",
				"echo x > ./--t/.*/.*/.*/.*/hooks/e.json",
				"echo x > x/.*/.*/.*/.*/hooks/e.json",
			],
			["cat -- --t/../a.ts"],
		);
		// A session in a skill's folder.
		const skill = join(grok, "skills", "x");
		judge(skill, ["cat ../../config.toml", "echo x > ../../hooks/e.json", "cp x ../../docs/y.md", "ls ../..", "cat ../../skills/x/SKILL.md", "cat -- --t/.*/.*/.*/config.toml"], ["cat ../y/SKILL.md", "cp ../y/SKILL.md z.md", "ls .."]);
		// In Grok's folder itself, or what it loads, a ".." leads out of no open part.
		judge(grok, ["ls ..", "cat ../.grok/skills/x/SKILL.md", "echo x > --t/.*/hooks/e.json"], []);
		judge(join(grok, "hooks"), ["cat ../skills/x/SKILL.md"], []);
		// Elsewhere (the agent's folder, home), as before.
		for (const opts of [options, plain]) expect(grokGuard("run_terminal_command", { command: "cat ../../../../x" }, opts, false)).toBeUndefined();
		// A folder GROK_HOME moves Grok's to, and ~/.grok beside it.
		const moved = join(root, "grok-home");
		mkdirSync(worktree(moved), { recursive: true });
		const before = process.env.GROK_HOME;
		process.env.GROK_HOME = moved;
		try {
			judge(worktree(moved), ["echo x > ../../../../hooks/e.json", "cat ../../../../worktrees.db"], ["cat ../README.md"]);
			judge(join(moved, "skills", "x"), ["cat ../../config.toml"], ["cat ../y/SKILL.md"]);
			judge(worktree(grok), ["echo x > ../../../../hooks/e.json"], ["cat ../README.md"]);
		} finally {
			if (before === undefined) delete process.env.GROK_HOME;
			else process.env.GROK_HOME = before;
		}
	});

	it("reads every relative path from where the call runs when that is Grok's folder itself or what it loads, as if the text named it: its open parts stay open, a bare word goes through unless it names an entry there, in both sessions and under $GROK_HOME", () => {
		const { root, grok, options, plain } = setup();
		const judge = (here: string, refused: readonly string[], allowed: readonly string[]) => {
			for (const opts of [
				{ ...options, folder: here, cwd: here },
				{ ...plain, folder: here, cwd: here },
			]) {
				for (const command of refused) {
					expect([here, command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([here, command, expect.stringMatching(GROK_NAMED)]);
					expect([here, command, grokGuard("monitor", { command }, opts, false)]).toEqual([here, command, expect.stringMatching(GROK_NAMED)]);
				}
				for (const command of allowed) {
					expect([here, command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([here, command, undefined]);
				}
			}
		};
		const atGrok = [
			// What Grok loads, by a path from there however spelt, a new file among it.
			"echo x > hooks/e.json",
			"cp a config.toml",
			"echo x > ./hooks/e.json",
			"echo x > $PWD/hooks/e.json",
			"echo x > ~+/hooks/e.json",
			'echo x > "hooks/e.json"',
			"echo '{}' > lsp.json",
			"cp x newfile.toml",
			"cat bundled/agents/explore.md",
			"cp x --target-directory=installed-plugins/p",
			// An entry there by its bare name, as an option's value too; and any file a redirection writes.
			"cp /tmp/e.json hooks",
			"rm -rf agents",
			"mv /tmp/p plugins",
			"cp x --target-directory=hooks",
			"cp -thooks x",
			"echo x > newname",
			"echo x >> 'newname'",
			"echo x &> newname",
			"echo x >&disabled-hooks",
			"echo x >& newname",
			// The folder itself.
			"tar cf /tmp/grok.tar .",
			// A short option's value glued after any of its letters (sort -o writes it), an entry's name among them.
			"sort -rohooks/e.json x",
			"cp -vthooks x",
			"cp -vt$PWD/hooks x",
			`cp -${"v".repeat(300)}thooks x`,
			// A path that starts with "-" or "--", as written.
			"cat -- -/x",
			"echo x > --t/e.json",
			// A command substitution or a ${: its path may be any.
			"echo x > $(echo hooks)/e.json",
			"echo x > `echo hooks`/e.json",
			"echo x > ${ echo hooks; }/e.json",
			"echo x > ${H}/e.json",
			"echo x > ${PWD}/skills/s/SKILL.md",
			"echo $(date)",
		];
		const atGrokAllowed = [
			"echo x > skills/s/SKILL.md",
			"cat docs/user-guide/10-hooks.md",
			"ls skills",
			"cp x worktrees/repo-x/src/a.ts",
			"python3 bundled/skills/pptx/scripts/x.py",
			"cat <<EOF > skills/s/SKILL.md",
			"echo x >&2",
			"echo x >&-",
			"echo x 2>&1",
			"exec 3>&2-",
			"cp -tskills x",
			`ls -${"a".repeat(300)}`,
			"ls",
			"ls -la",
			"echo hello",
			"git status",
		];
		judge(grok, atGrok, atGrokAllowed);
		// In what Grok loads, every path from there is in it.
		judge(join(grok, "hooks"), ["echo x > e.json", "cat orrery.json", "rm orrery.json", "cp /tmp/e.json .", "cat `ls`", "echo x >&new"], ["ls", "ls -la"]);
		judge(join(grok, "bundled"), ["echo x > agents/a.md", "cp x manifest.json"], ["cat skills/pptx/scripts/x.py"]);
		// From an open part, or anywhere else, a path with no ".." is the project's, as before.
		for (const here of [join(grok, "skills", "x"), join(grok, "worktrees", "repo-x"), root]) {
			judge(here, [], ["echo x > hooks/e.json", "cp a config.toml", "cp /tmp/e.json hooks", "cp -vthooks x", "echo $(date) >&newname"]);
		}
		// A folder GROK_HOME moves Grok's to, and ~/.grok beside it.
		const moved = join(root, "grok-home");
		mkdirSync(join(moved, "hooks"), { recursive: true });
		mkdirSync(join(moved, "skills"), { recursive: true });
		const before = process.env.GROK_HOME;
		process.env.GROK_HOME = moved;
		try {
			judge(moved, ["echo x > hooks/e.json", "cp a config.toml", "cp /tmp/e.json hooks"], ["echo x > skills/s/SKILL.md", "ls"]);
			judge(join(moved, "hooks"), ["echo x > e.json"], []);
			judge(grok, ["echo x > hooks/e.json", "cp /tmp/e.json hooks"], ["echo x > skills/s/SKILL.md"]);
		} finally {
			if (before === undefined) delete process.env.GROK_HOME;
			else process.env.GROK_HOME = before;
		}
	});

	it("reads a relative spelling of Grok's folder from where the call runs when that holds it (home) or is beside it, as if the text named it: its open parts stay open, a project's own .grok is the project's, in both sessions and under $GROK_HOME", () => {
		const { root, home, folder, options, plain } = setup();
		const judge = (here: string, named: readonly string[], reach: readonly string[], allowed: readonly string[]) => {
			for (const opts of [
				{ ...options, folder: here, cwd: here },
				{ ...plain, folder: here, cwd: here },
			]) {
				for (const [commands, message] of [
					[named, GROK_NAMED],
					[reach, GROK_REACH],
				] as const) {
					for (const command of commands) {
						expect([here, command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([here, command, expect.stringMatching(message)]);
						expect([here, command, grokGuard("monitor", { command }, opts, false)]).toEqual([here, command, expect.stringMatching(message)]);
					}
				}
				for (const command of allowed) {
					expect([here, command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([here, command, undefined]);
				}
			}
		};
		// A session at home (a plain grok started there, an agent opened there).
		const atHome = [
			"echo x > .grok/hooks/e.json",
			"echo '{}' > .grok/hooks/evil.json",
			"cp x ./.grok/config.toml",
			"cp x .grok/config.toml",
			// However it is spelt: quoted, from $PWD or ~+, after a name and .., as an option's value, glued or not.
			'echo x > "./.grok/hooks/e.json"',
			"echo x > $PWD/.grok/hooks/e.json",
			"echo x > ~+/.grok/hooks/e.json",
			"echo x > a/../.grok/hooks/e.json",
			"cp x --target-directory=.grok/hooks",
			"cp -vt.grok/hooks x",
			// A glob right after its name, which the shell may expand to it.
			"cp x .grok*/hooks/",
			"cat ./.grok?/config.toml",
			"cp x .grok[k]/hooks/",
			// The folder itself, and what walks out of an open part into the rest.
			"tar cf /tmp/grok.tar .grok",
			"cat .grok/skills/../config.toml",
			// In a substitution, as by its path.
			"echo x > $(dirname .grok/skills)/hooks/e.json",
		];
		// An open part beside a folder change, a ".." or a link, as by its path.
		const reachFromHome = ["cd .grok/skills && echo x > ../hooks/e.json", "ln -s /tmp/x .grok/skills/h", "cat .grok/workflows/../skills/x/SKILL.md", "cd .grok/worktrees/repo-x && cd - && ls"];
		const allowedFromHome = [
			"echo x > .grok/skills/s/SKILL.md",
			"cat .grok/docs/user-guide/10-hooks.md",
			"cp x ./.grok/memory-v2/global/MEMORY.md",
			"cd .grok/worktrees/repo-x && npm test",
			// Names beside it, and a project's own .grok below home.
			"cat .grokrc",
			"ls .grok-old",
			"echo x > ws/.grok/hooks/e.json",
			"ls",
		];
		judge(home, atHome, reachFromHome, allowedFromHome);
		// A folder beside it in home: ../.grok.
		const beside = join(home, "proj");
		mkdirSync(beside);
		judge(beside, ["echo x > ../.grok/hooks/e.json", "cp x ./../.grok/config.toml"], ["cd ../.grok/skills && ls"], ["echo x > ../.grok/skills/s/SKILL.md", "echo x > .grok/hooks/e.json"]);
		// A project with its own .grok/hooks: the project's, as before.
		mkdirSync(join(folder, ".grok", "hooks"), { recursive: true });
		judge(folder, [], [], ["echo x > .grok/hooks/e.json", "cp x ./.grok/config.toml", "echo x > .grok/skills/s/SKILL.md"]);
		// A folder GROK_HOME moves Grok's to, further down, and ~/.grok from above home.
		const moved = join(root, "a", "grok-home");
		mkdirSync(join(moved, "skills"), { recursive: true });
		const before = process.env.GROK_HOME;
		process.env.GROK_HOME = moved;
		try {
			judge(root, ["echo x > a/grok-home/hooks/e.json", "cp x ./a/grok-home/config.toml", "echo x > home/.grok/hooks/e.json"], [], ["echo x > a/grok-home/skills/s/SKILL.md", "echo x > .grok/hooks/e.json"]);
			judge(home, ["echo x > .grok/hooks/e.json", "echo x > ../a/grok-home/hooks/e.json"], [], ["echo x > .grok/skills/s/SKILL.md"]);
		} finally {
			if (before === undefined) delete process.env.GROK_HOME;
			else process.env.GROK_HOME = before;
		}
	});

	it("keeps an open part a link takes into what Grok loads, to Grok's folder or a folder that holds it, or nowhere; one a link takes out of Grok's folder stays writable through the link to file tools, not to shell text, in both sessions", () => {
		const { home, grok, options, atHome, plain } = setup();
		// skills/ linked to hooks/: a file written there is a hook file Grok loads.
		rmSync(join(grok, "skills"), { recursive: true });
		symlinkSync(join(grok, "hooks"), join(grok, "skills"));
		// learn/ linked to the home, which holds Grok's folder: learn/.grok/hooks is its hooks.
		rmSync(join(grok, "learn"), { recursive: true });
		symlinkSync(home, join(grok, "learn"));
		// plugin-data/ a link that can't be resolved (to itself).
		rmSync(join(grok, "plugin-data"), { recursive: true });
		symlinkSync("plugin-data", join(grok, "plugin-data"));
		// logs/ linked out of Grok's folder (a dotfiles folder), as a person may keep it: open through the link to file tools,
		// which judge where it leads; shell text, which can't, writes there where it is.
		mkdirSync(join(home, "grok-logs"));
		rmSync(join(grok, "logs"), { recursive: true });
		symlinkSync(join(home, "grok-logs"), join(grok, "logs"));
		// workflows/ linked to another open part stays open.
		rmSync(join(grok, "workflows"), { recursive: true });
		symlinkSync(join(grok, "docs"), join(grok, "workflows"));
		for (const opts of [options, atHome, plain]) {
			for (const command of [
				"echo '{}' > ~/.grok/skills/evil.json",
				`cp x ${grok}/skills/evil.json`,
				"echo x > $GROK_HOME/skills/evil.json",
				"cp x ~/.grok/./skills/evil.json",
				"echo '{}' > ~/.grok/learn/.grok/hooks/evil.json",
				"echo x > ~/.grok/plugin-data/p/s.json",
				"echo x >> ~/.grok/logs/x.log",
				`cp x ${grok}/logs/x.log`,
				"echo x >> $GROK_HOME/logs/x.log",
			]) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_FOLDER)]);
			}
			for (const command of ["echo x >> ~/grok-logs/x.log", "cp x ~/.grok/workflows/w.rhai ~/grok-logs/x.log"]) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, undefined]);
			}
		}
		for (const opts of [atHome, plain]) {
			for (const path of [join(grok, "skills", "evil.json"), "~/.grok/skills/evil.json", join(grok, "learn", "x.json"), join(grok, "plugin-data", "p", "s.json")]) {
				expect([path, grokGuard("write", { file_path: path, content: "x" }, opts, false)]).toEqual([path, expect.stringMatching(GROK_FOLDER)]);
			}
			// The linked-out part, through the link and where it really is, and another open part's link stay open.
			for (const path of [join(grok, "logs", "x.log"), "~/.grok/logs/x.log", join(home, "grok-logs", "x.log"), join(grok, "workflows", "w.rhai")]) {
				expect([path, grokGuard("write", { file_path: path, content: "x" }, opts, false)]).toEqual([path, undefined]);
			}
		}
	});

	it("refuses a tool it doesn't know, named neither for writing nor only for reading, that names a guarded entry, in both sessions", () => {
		const { grok, atHome, plain } = setup();
		for (const opts of [atHome, plain]) {
			for (const path of [join(grok, "hooks", "x.json"), "~/.grok/config.toml"]) {
				// Grok's lsp (its edits name no file the guard reads as a write), and an MCP tool with no verb in its name.
				expect([path, grokGuard("lsp", { operation: "rename", file_path: path, line: 1, character: 1, new_name: "y" }, opts, false)]).toEqual([path, expect.stringMatching(GROK_FOLDER)]);
				expect([path, grokGuard("box__apply", { tool_name: "box__apply", tool_input: { target_file: path, text: "{}" } }, opts, false)]).toEqual([path, expect.stringMatching(GROK_FOLDER)]);
				expect([path, grokGuard("use_tool", { tool_name: "box__apply", tool_input: { spec: `${path}` } }, opts, false)]).toEqual([path, expect.stringMatching(GROK_FOLDER)]);
			}
			// The rest of Grok's folder, and a tool named only for reading, pass.
			expect(grokGuard("lsp", { operation: "rename", file_path: join(grok, "skills", "x", "SKILL.md"), new_name: "y" }, opts, false)).toBeUndefined();
			expect(grokGuard("box__read_config", { tool_name: "box__read_config", tool_input: { path: join(grok, "config.toml") } }, opts, false)).toBeUndefined();
		}
	});

	it("reads of sessions/ and auth.json refused; reads of docs/ allowed", () => {
		const { grok, options } = setup();
		for (const path of [join(grok, "auth.json"), "~/.grok/auth.json", join(grok, "sessions", "%2Fws", "01a1", "updates.jsonl"), join(grok, "sessions", "%2Fws", "01a1", "system_prompt.txt"), "~/.grok/sessions"]) {
			expect([path, grokGuard("read_file", { target_file: path }, options, false)]).toEqual([path, expect.stringMatching(SENSITIVE)]);
			expect([path, grokGuard("list_dir", { target_directory: path }, options, false)]).toEqual([path, expect.stringMatching(SENSITIVE)]);
		}
		expect(grokGuard("grep", { pattern: "x", path: grok }, options, false)).toMatch(/would search credential files/);
		for (const path of [join(grok, "docs", "user-guide", "10-hooks.md"), "~/.grok/docs/user-guide/10-hooks.md", "~/.grok/bundled/skills/learn/SKILL.md", "~/.grok/hooks/orrery.json", "~/.grok/config.toml", "~/.grok/memory-v2/global/MEMORY.md"]) {
			expect([path, grokGuard("read_file", { target_file: path }, options, false)]).toEqual([path, undefined]);
		}
		expect(grokGuard("grep", { pattern: "hook", path: join(grok, "docs") }, options, false)).toBeUndefined();
	});

	it("keeps a folder GROK_HOME moves Grok's to the same way, in both sessions", () => {
		const { root, options, plain } = setup();
		const moved = join(root, "grok-home");
		for (const file of [...GROK_GUARDED, ...GROK_UNNAMED, "auth.json", "docs/x.md", "memory-v2/global/MEMORY.md", "skills/x/SKILL.md", "workflows/w.rhai"]) {
			mkdirSync(dirname(join(moved, file)), { recursive: true });
			writeFileSync(join(moved, file), "x");
		}
		const before = process.env.GROK_HOME;
		process.env.GROK_HOME = moved;
		try {
			const atMoved = { ...options, folder: root, cwd: root };
			const plainHere = { ...plain, folder: root, cwd: root };
			for (const file of [...GROK_GUARDED, ...GROK_UNNAMED]) {
				expect([file, grokGuard("write", { file_path: join(moved, file), content: "{}" }, atMoved, false)]).toEqual([file, expect.stringMatching(/Grok's folder|sensitive/)]);
				expect([file, grokGuard("write", { file_path: join(moved, file), content: "{}" }, plainHere, false)]).toEqual([file, expect.stringMatching(/Grok's folder|session records/)]);
				expect([file, grokGuard("run_terminal_command", { command: `echo x > ${join(moved, file)}` }, plainHere, false)]).toEqual([file, expect.stringMatching(/Grok's folder|session records/)]);
				expect([file, grokGuard("run_terminal_command", { command: `echo x > $GROK_HOME/${file}` }, atMoved, false)]).toEqual([file, expect.stringMatching(/Grok's folder|sensitive|session records/)]);
			}
			// lsp.json and a file Orrery doesn't name, from an unknown tool and a no-verb MCP tool too.
			for (const file of ["lsp.json", "newthing.toml"]) {
				for (const opts of [atMoved, plainHere]) {
					expect([file, grokGuard("search_replace", { file_path: join(moved, file), old_string: "x", new_string: "y" }, opts, false)]).toEqual([file, expect.stringMatching(GROK_FOLDER)]);
					expect([file, grokGuard("run_terminal_command", { command: `echo x > ${join(moved, file)}` }, opts, false)]).toEqual([file, expect.stringMatching(GROK_FOLDER)]);
					expect([file, grokGuard("lsp", { operation: "rename", file_path: join(moved, file), new_name: "y" }, opts, false)]).toEqual([file, expect.stringMatching(GROK_FOLDER)]);
					expect([file, grokGuard("box__apply", { tool_name: "box__apply", tool_input: { target_file: join(moved, file) } }, opts, false)]).toEqual([file, expect.stringMatching(GROK_FOLDER)]);
				}
			}
			for (const file of ["memory-v2/global/MEMORY.md", "skills/x/SKILL.md", "workflows/w.rhai", "logs/x.log", "bundled/skills/x/y.py", "learn/state.json", "plugin-data/p/s.json", "implement-memory/x.md"]) {
				for (const opts of [atMoved, plainHere]) {
					expect([file, grokGuard("write", { file_path: join(moved, file), content: "x" }, opts, false)]).toEqual([file, undefined]);
					expect([file, grokGuard("run_terminal_command", { command: `cat ${join(moved, file)} $GROK_HOME/${file}` }, opts, false)]).toEqual([file, undefined]);
				}
			}
			expect(grokGuard("read_file", { target_file: join(moved, "sessions", "%2Fws", "01a1", "updates.jsonl") }, options, false)).toMatch(SENSITIVE);
			expect(grokGuard("read_file", { target_file: join(moved, "auth.json") }, options, false)).toMatch(SENSITIVE);
			expect(grokGuard("read_file", { target_file: join(moved, "docs", "x.md") }, options, false)).toBeUndefined();
			expect(grokGuard("run_terminal_command", { command: `echo x > ${moved}/hooks/x.json` }, options, false)).toMatch(GROK_FOLDER);
		} finally {
			if (before === undefined) delete process.env.GROK_HOME;
			else process.env.GROK_HOME = before;
		}
	});

	it("keeps a guarded entry where a link takes it out of Grok's folder (a config.toml in a dotfiles folder), and an open part linked out of it from shell text alone, in both sessions", () => {
		const { root, grok, atHome, plain } = setup();
		// skills/ as it is: shell text writes there.
		for (const opts of [atHome, plain]) {
			for (const command of ["cp x ~/.grok/skills/x/SKILL.md", `echo x > ${grok}/skills/x/SKILL.md`]) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, undefined]);
			}
		}
		const dotfiles = join(root, "home", "dotfiles");
		mkdirSync(join(dotfiles, "grok-hooks"), { recursive: true });
		writeFileSync(join(dotfiles, "grok.toml"), "x");
		rmSync(join(grok, "config.toml"));
		symlinkSync(join(dotfiles, "grok.toml"), join(grok, "config.toml"));
		rmSync(join(grok, "hooks"), { recursive: true });
		symlinkSync(join(dotfiles, "grok-hooks"), join(grok, "hooks"));
		// An entry Orrery doesn't name (a later Grok's), kept there too; and Grok's skills.
		writeFileSync(join(dotfiles, "grok-lsp.json"), "{}");
		rmSync(join(grok, "lsp.json"));
		symlinkSync(join(dotfiles, "grok-lsp.json"), join(grok, "lsp.json"));
		mkdirSync(join(dotfiles, "grok-skills"));
		rmSync(join(grok, "skills"), { recursive: true });
		symlinkSync(join(dotfiles, "grok-skills"), join(grok, "skills"));
		for (const opts of [atHome, plain]) {
			for (const path of [join(dotfiles, "grok.toml"), join(dotfiles, "grok-hooks", "x.json"), "~/dotfiles/grok.toml", join(dotfiles, "grok-lsp.json"), "~/dotfiles/grok-lsp.json"]) {
				expect([path, grokGuard("write", { file_path: path, content: "x" }, opts, false)]).toEqual([path, expect.stringMatching(GROK_FOLDER)]);
			}
			for (const command of [`echo x >> ${join(dotfiles, "grok.toml")}`, "rm ~/dotfiles/grok-hooks/orrery.json", "echo '{}' > ~/dotfiles/grok-lsp.json"]) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_FOLDER)]);
			}
			// The rest of the dotfiles folder is the person's, and Grok's skills stay writable where they really are, and
			// through the link to file tools, which follow it and judge where it leads.
			expect(grokGuard("write", { file_path: join(dotfiles, "grok.toml.bak"), content: "x" }, opts, false)).toBeUndefined();
			expect(grokGuard("run_terminal_command", { command: "cat ~/dotfiles/notes.md" }, opts, false)).toBeUndefined();
			expect(grokGuard("write", { file_path: join(dotfiles, "grok-skills", "x", "SKILL.md"), content: "x" }, opts, false)).toBeUndefined();
			expect(grokGuard("run_terminal_command", { command: "cp x ~/dotfiles/grok-skills/x/SKILL.md" }, opts, false)).toBeUndefined();
			expect(grokGuard("write", { file_path: join(grok, "skills", "x", "SKILL.md"), content: "x" }, opts, false)).toBeUndefined();
			expect(grokGuard("write", { file_path: "~/.grok/skills/x/SKILL.md", content: "x" }, opts, false)).toBeUndefined();
			// Shell text can't follow the link, so through it skills/ is kept as the rest is (a link to a guarded place would
			// reach it).
			for (const command of ["cp x ~/.grok/skills/x/SKILL.md", `echo x > ${grok}/skills/x/SKILL.md`, "echo x >> $GROK_HOME/skills/x/SKILL.md"]) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_NAMED)]);
			}
			// A call run in skills/ through the link reads its "..": kept as the text naming it would be.
			const inSkill = { ...opts, folder: join(grok, "skills", "x"), cwd: join(grok, "skills", "x") };
			expect(grokGuard("run_terminal_command", { command: "cat ../y/SKILL.md" }, inSkill, false)).toMatch(GROK_CLIMB);
			expect(grokGuard("run_terminal_command", { command: "cat SKILL.md" }, inSkill, false)).toBeUndefined();
			// One run in Grok's folder itself reads skills/ as the text naming it would.
			expect(grokGuard("run_terminal_command", { command: "cp x skills/x/SKILL.md" }, { ...opts, folder: grok, cwd: grok }, false)).toMatch(GROK_NAMED);
		}
	});
});

describe("Grok's own commands in shell text: none but its read-only ones, and none that opens a session by its id or the latest, in any session", () => {
	const ID = "01a18bb1-6f58-71b3-b214-904c0bfc4abd";
	/** Each refused command line, and the command its refusal names. */
	const refused: [string, string][] = [
		[`grok -p "hi" -r ${ID} --no-leader`, "grok -r"],
		[`grok --resume ${ID}`, "grok --resume"],
		[`grok --resume=${ID} -p hi`, "grok --resume"],
		["grok -r", "grok -r"],
		["grok -c -p hi", "grok -c"],
		["grok --continue", "grok --continue"],
		[`grok -s ${ID} -p hi`, "grok -s"],
		[`grok --session-id=${ID}`, "grok --session-id"],
		[`grok "fix the bug" -r ${ID}`, "grok -r"],
		[`grok -p -r ${ID}`, "grok -r"],
		["grok -vc", "grok -c"],
		[`/usr/local/bin/grok --model grok-4 -r ${ID}`, "grok -r"],
		[`cd repo && GROK_X=1 grok -p "go on" --continue`, "grok --continue"],
		[`env FOO=1 grok-linux-x86_64 -r ${ID}`, "grok -r"],
		[`(grok -c) && echo done`, "grok -c"],
		[`x=$(grok -p hi -c)`, "grok -c"],
		[`grok -p "$(cat prompt.txt)" -r ${ID}`, "grok -r"],
		["grok --trust -p hi", "grok --trust"],
		["grok plugin install ./p --trust", "grok --trust"],
		["grok mcp disable orrery", "grok mcp disable"],
		["grok mcp remove orrery", "grok mcp remove"],
		["grok mcp enable orrery", "grok mcp enable"],
		["grok mcp add x -- node server.js", "grok mcp add"],
		["grok mcp --debug-file /tmp/d add x -- node s.js --help", "grok mcp add"],
		["grok plugin install ./p", "grok plugin install"],
		["grok plugin rm pr-babysit", "grok plugin rm"],
		["grok plugin marketplace add ./m", "grok plugin marketplace add"],
		["grok update", "grok update"],
		["grok update --version 1.0.71", "grok update"],
		["grok login --device-auth", "grok login"],
		["grok logout", "grok logout"],
		["grok setup", "grok setup"],
		[`grok sessions delete ${ID}`, "grok sessions delete"],
		["grok agent stdio", "grok agent stdio"],
		["grok agent --leader serve", "grok agent serve"],
		["grok agent", "grok agent"],
		["grok wrap grok -c", "grok wrap"],
		// Text that only names one is refused too, as for Orrery's commands, and so is a prompt given as Grok's first word
		// that starts with a subcommand's name: the shell may read it without its quotes.
		["echo grok update", "grok update"],
		['grok "update the docs"', "grok update"],
	];
	/** Command lines that stay open: Grok's read-only commands, prompts, and text that names Grok otherwise. */
	const open = [
		"grok --version",
		"grok --help",
		"grok -h",
		"grok mcp list",
		"grok mcp add --help",
		"grok plugin list",
		"grok plugin details pr-babysit",
		"grok plugin marketplace list",
		"grok sessions list",
		"grok sessions search resume",
		"grok inspect",
		"grok agent --help",
		"grok help mcp",
		'grok "fix the bug"',
		'grok -p "resume where we left off"',
		"grok -p update",
		"grok -w feat -p hi",
		"grok -- -r",
		"git checkout grok -- src/x.ts",
		"cd .worktrees/grok && npm test",
		"npm test -- test/grok/hooks.test.ts",
		"git log grok --oneline",
		"ls src/grok",
	];

	/** Each of `lines` refused in an agent's session and in one that is no agent's, by Grok's guard and every tool's, naming its command. */
	function refusesEach(lines: readonly (readonly [string, string])[]) {
		const { options, plain } = setup();
		for (const [command, named] of lines) {
			const why = grokGuard("run_terminal_command", { command }, options, false);
			expect([command, why]).toEqual([command, expect.stringContaining(`${named} can't run from a session's shell`)]);
			expect([command, grokGuard("run_terminal_command", { command }, plain, false)]).toEqual([command, why]);
			expect([command, checkToolCall({ name: "bash", arguments: { command } }, options)]).toEqual([command, why]);
			expect([command, runsGrokCommand(command)?.command]).toEqual([command, named]);
		}
	}

	/** Each of `lines` let through in both kinds of session. */
	function opensEach(lines: readonly string[]) {
		const { options, plain } = setup();
		for (const command of lines) {
			expect([command, grokGuard("run_terminal_command", { command }, options, false)]).toEqual([command, undefined]);
			expect([command, grokGuard("run_terminal_command", { command }, plain, false)]).toEqual([command, undefined]);
		}
	}

	it("refuses each in an agent's session and in one that is no agent's, by Grok's guard and by every tool's (the shared rule)", () => {
		refusesEach(refused);
	});

	it("says why: a session that may be live elsewhere stops recording, --trust changes Grok's setup, and only Grok's read-only commands run", () => {
		const { options } = setup();
		expect(grokGuard("run_terminal_command", { command: `grok -p hi -r ${ID}` }, options, false)).toMatch(/opens a Grok session by its id or the latest one, which may be live in another Grok .* stops Orrery recording that session/);
		expect(grokGuard("run_terminal_command", { command: "grok --trust" }, options, false)).toMatch(/trusts a folder for good, which changes Grok's own setup \(its MCP servers, plugins, trusted folders, sign-in, managed config or saved sessions\)/);
		for (const command of ["grok mcp disable orrery", "grok agent stdio", "grok worker start"]) {
			expect(grokGuard("run_terminal_command", { command }, options, false)).toMatch(
				/of Grok's own commands only those that read run here \(grok help, version, models, inspect, completions, usage, du, mcp list, plugin list, details and validate, plugin marketplace list, sessions list and search, worktree list and show, and any command's --help\); the others change Grok's own setup .* or run Grok sessions outside Orrery's launch/,
			);
		}
	});

	it("lets Grok's read-only commands, a prompt and text that names Grok otherwise through", () => {
		opensEach(open);
	});

	it("refuses every subcommand grok --help (1.0.70) lists but its read-only ones: leader, worker, agent, setup, update, login, logout, and every one that writes, runs a session or a server, or opens one", () => {
		refusesEach([
			...["agent", "agent stdio", "agent headless", "agent serve", "agent leader", "clone", "dashboard", "doctor", "doctor fix", "leader", "leader list", "leader info", "leader kill", "leader worker start"].map((command): [string, string] => [`grok ${command}`, `grok ${command}`]),
			...["login", "logout", "memory clear", "setup", "trace", "update", "worker", "worker start", "worker status", "worker list", "worker controller", "worker stop", "wrap"].map((command): [string, string] => [`grok ${command}`, `grok ${command}`]),
			...["mcp add", "mcp remove", "mcp enable", "mcp disable", "mcp doctor", "plugin install", "plugin uninstall", "plugin rm", "plugin remove", "plugin update", "plugin enable", "plugin disable", "plugin tag"].map((command): [string, string] => [`grok ${command}`, `grok ${command}`]),
			...["plugin marketplace add", "plugin marketplace remove", "plugin marketplace update", "sessions delete", "worktree create", "worktree rm", "worktree gc", "worktree detach", "worktree salvage", "worktree clean-artifacts", "worktree redirect", "worktree db"].map((command): [string, string] => [`grok ${command}`, `grok ${command}`]),
			// export writes a file or the clipboard (and prints another session's whole transcript); trace writes and uploads.
			[`grok export ${ID}`, "grok export"],
			[`grok export ${ID} -c`, "grok export"],
			[`grok export ${ID} /tmp/x.md`, "grok export"],
			[`grok trace ${ID} --local`, "grok trace"],
			// update and setup whole, their read-only forms too; a read-only one's option that writes.
			["grok update --check", "grok update"],
			["grok setup --json", "grok setup"],
			["grok du --clean", "grok du"],
			["grok disk-usage --clean-orphaned --yes", "grok disk-usage"],
			["grok plugin list --json --available", "grok plugin list"],
			// One that needs its own subcommand, with none or one Grok doesn't have.
			["grok mcp", "grok mcp"],
			["grok plugin marketplace", "grok plugin marketplace"],
			["grok sessions", "grok sessions"],
			// Grok reads its subcommand after its prompt too (grok hi mcp list runs mcp list: seen live, 1.0.70).
			["grok hi mcp disable orrery", "grok mcp disable"],
			['grok "fix it" update', "grok update"],
			["grok -p hi worker start", "grok worker start"],
			["grok --model m hi leader worker start", "grok leader worker start"],
		]);
	});

	it("lets each of Grok's read-only commands through, with their read-only options, and any command's help", () => {
		opensEach([
			"grok -v",
			"grok version",
			"grok v --json",
			"grok help",
			"grok help mcp add",
			"grok models",
			"grok inspect --json",
			"grok completions bash",
			`grok usage ${ID}`,
			`grok usage ${ID} 3`,
			"grok du",
			"grok du --json",
			"grok disk-usage",
			"grok mcp list --json",
			"grok mcp help",
			"grok mcp help add",
			"grok plugin list --json",
			"grok plugin details pr-babysit",
			"grok plugin validate ./p",
			"grok plugin marketplace list --json",
			"grok plugin marketplace help",
			"grok sessions list -n 5",
			"grok sessions list --limit=5",
			"grok sessions search 'resume the bridge'",
			"grok worktree list --all --repo x",
			"grok worktree ls",
			"grok worktree show feat",
			"grok agent help",
			"grok agent --help",
			"grok leader --help",
			"grok worker --help",
			"grok worker --help start",
			"grok --help mcp add x",
			"grok mcp add --help x",
			"grok mcp --help add x",
			"grok plugin --help install ./p",
			"grok mcp add -e K=V --help x",
			"grok --debug --leader-socket /tmp/l.sock mcp list",
			"grok hi there",
		]);
	});

	it("a word built at run time or a glob: an option's value is passed over, and where Grok's subcommand stands the rest is searched (fail closed)", () => {
		refusesEach([
			// A value built at run time fills its option, and reading goes on.
			["grok --model $M mcp disable orrery", "grok mcp disable"],
			['grok --model "$M" mcp disable orrery', "grok mcp disable"],
			['grok -m "$(cat model.txt)" mcp disable orrery', "grok mcp disable"],
			["grok mcp --debug-file $F disable orrery", "grok mcp disable"],
			['grok --rules "$R" update', "grok update"],
			// Where Grok's subcommand stands: a refused one any later word names, under any command it is one of.
			["grok $X mcp disable orrery", "grok mcp disable"],
			["grok -m$M mcp disable orrery", "grok mcp disable"],
			["grok hi $C disable orrery", "grok mcp disable"],
			["grok $C add evil -- node s.js", "grok mcp add"],
			["grok $C start", "grok leader worker start"],
			// Where a subcommand's own stands: which one can't be told.
			["grok mcp $SUB orrery", "grok mcp"],
			["grok plugin marketplace $SUB ./m", "grok plugin marketplace"],
			// A read-only one with an option that writes: a word that may be that option.
			["grok du $X", "grok du"],
			// A glob that could name a refused one (the shell may make it a file's name).
			["grok m?p disable orrery", "grok mcp disable"],
			["grok up*", "grok update"],
			["grok mcp dis*ble orrery", "grok mcp"],
			["grok du --cl*", "grok du"],
			["grok --tr* -p hi", "grok --trust"],
			[`grok --re* ${ID}`, "grok --resume"],
		]);
		opensEach([
			'grok -p "$PROMPT"',
			'grok "$PROMPT"',
			'grok "$PROMPT" --model m',
			"grok $X help",
			"grok sessions list --debug-file $F",
			"grok sessions search $Q",
			`grok usage "$ID"`,
			"grok mcp list --debug-file $F",
			"ls src/grok src/*.ts",
		]);
	});

	it("help counts only before the first word past the subcommands that is no option or value, never after --, and never as an option's value or as -h", () => {
		refusesEach([
			["grok mcp add x -- cmd --help", "grok mcp add"],
			["grok mcp add x node s.js --help", "grok mcp add"],
			["grok plugin install ./p --help", "grok plugin install"],
			["grok mcp add -e --help x -- node s.js", "grok mcp add"],
			["grok --model --help mcp add x", "grok mcp add"],
			// -h doesn't count: the readings are lower case, and mcp add's -H (a header) reads as -h.
			["grok mcp add x -h", "grok mcp add"],
			['grok mcp add -H "authorization: x" --transport http api https://example.invalid/mcp', "grok mcp add"],
			["grok -h mcp add x", "grok mcp add"],
		]);
	});
});

describe("[guard] protect and .env apply to Grok's tools", () => {
	it("refuses each to Grok's file tools, its shells, its MCP calls and its patches", () => {
		const { folder, options } = setup();
		const env = join(folder, ".env");
		for (const [tool, input] of [
			["read_file", { target_file: env }],
			["read_file", { target_file: "../secret.txt" }],
			["write", { file_path: env, content: "x" }],
			["search_replace", { file_path: "../secret.txt", old_string: "s", new_string: "t" }],
			["grep", { pattern: "x", path: "..", glob: ".env" }],
			["run_terminal_command", { command: "cat ../.env" }],
			["run_terminal_command", { command: "cat ../secret.txt" }],
			["monitor", { command: "tail -f ../secret.txt" }],
			["fs__read_file", { tool_name: "fs__read_file", tool_input: { path: env } }],
			["apply_patch", { input: patch(`*** Update File: ${env}`, "@@", "-a", "+b") }],
		] as const) {
			expect([tool, grokGuard(tool, input, options, false)]).toEqual([tool, expect.stringMatching(/sensitive|protected by \[guard\] protect/)]);
		}
		expect(grokGuard("read_file", { target_file: join(folder, ".env.example") }, options, false)).toBeUndefined();
	});
});

describe("the PreToolUse hook (runGrokGuard)", () => {
	/** Agent Test, and a Grok (pid 4343, a plain grok's command line) that holds its token. */
	function agentWorld() {
		const t = testAgent();
		const token = newToken();
		const home = join(t.dir, "home");
		mkdirSync(join(home, ".grok", "hooks"), { recursive: true });
		writeFileSync(join(home, ".grok", "hooks", "orrery.json"), "{}");
		mkdirSync(join(t.folder, "sub"));
		writeFileSync(join(t.folder, "protected.txt"), "x");
		const ctx = (extra: Partial<GrokGuardContext> = {}): GrokGuardContext => {
			const env = extra.env ?? { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token };
			return {
				config: t.config,
				env,
				grokPid: 4343,
				alive: (pid) => pid === 4343,
				argvOf: () => ["/home/u/.grok/downloads/grok-linux-x86_64", "--no-leader", "--rules", "x"],
				home,
				configFile: t.configPath,
				// The Grok was started with the environment its hooks get.
				envOf: startedWith(env),
				...extra,
			};
		};
		// The token's claim, as the memory server or SessionStart makes it for this Grok.
		mkdirSync(join(t.agent.dir, "claims"), { recursive: true, mode: 0o700 });
		writeFileSync(join(t.agent.dir, "claims", token), "4343\n");
		return { t, ctx, home };
	}
	/** Grok's PreToolUse input, camelCase with Claude Code's aliases (seen live). */
	const call = (toolName: string, toolInput: unknown, cwd: string, extra: object = {}) =>
		JSON.stringify({
			hookEventName: "pre_tool_use",
			hook_event_name: "PreToolUse",
			sessionId: "01a18982-0e69-7763-b5ed-e7afc3283986",
			cwd,
			workspaceRoot: cwd,
			permissionMode: "default",
			toolName,
			toolUseId: "c1",
			toolInput,
			toolInputTruncated: false,
			session_id: "01a18982-0e69-7763-b5ed-e7afc3283986",
			tool_name: toolName,
			tool_input: toolInput,
			...extra,
		});

	it("judges the agent's calls by its folder, a subagent's too, and lets the rest through; a refusal is ready for Grok", () => {
		const { t, ctx } = agentWorld();
		const cwd = join(t.folder, "sub");
		expect(runGrokGuard(call("write", { file_path: "../top.md", content: "x" }, cwd), ctx())).toBeUndefined();
		expect(runGrokGuard(call("write", { file_path: "/etc/x", content: "x" }, cwd), ctx())).toMatch(/^Orrery guard: (\/private)?\/etc\/x is outside this agent's folder and allowed roots$/);
		expect(runGrokGuard(call("run_terminal_command", { command: "cat ~/.ssh/id_rsa" }, cwd, { subagentType: "general-purpose", sessionId: "01a18982-a077" }), ctx())).toBe(
			"Orrery guard: This command touches sensitive files (keys, credentials or Orrery's private data)",
		);
		expect(runGrokGuard(call("run_terminal_command", { command: "ls" }, cwd), ctx())).toBeUndefined();
		// Its [guard] protect, and Orrery's config, which the agent may read and not change.
		const protect = { ...t.config, guard: { protect: ["protected.txt"] } };
		expect(runGrokGuard(call("read_file", { target_file: "../protected.txt" }, cwd), ctx({ config: protect }))).toMatch(/protected by \[guard\] protect/);
		expect(runGrokGuard(call("read_file", { target_file: t.configPath }, cwd), ctx())).toBeUndefined();
		expect(runGrokGuard(call("search_replace", { file_path: t.configPath, old_string: "a", new_string: "b" }, cwd), ctx())).toMatch(/Orrery's config/);
	});

	it("judges whose session it is by the Grok's start environment: a hook whose own names another agent or token, or a Grok whose start can't be read, gets no agent's rules", () => {
		const { t, ctx } = agentWorld();
		const cwd = join(t.folder, "sub");
		const grok = ctx().env;
		const up = call("write", { file_path: "../top.md", content: "x" }, cwd);
		expect(runGrokGuard(up, ctx())).toBeUndefined();
		const other = { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: newToken() };
		for (const context of [ctx({ env: other, envOf: startedWith(grok) }), ctx({ envOf: () => undefined })]) {
			expect(runGrokGuard(up, context)).toMatch(/is outside this agent's folder and allowed roots$/);
		}
	});

	it("reads Claude Code's snake_case aliases when the camelCase names are missing, and a truncated input as Grok marks it", () => {
		const { t, ctx } = agentWorld();
		const snake = JSON.stringify({ session_id: "s1", cwd: t.folder, tool_name: "run_terminal_command", tool_input: { command: "cat ~/.ssh/id_rsa" } });
		expect(runGrokGuard(snake, ctx())).toMatch(/sensitive/);
		expect(runGrokGuard(call("run_terminal_command", { command: cut("ls") }, t.folder, { toolInputTruncated: true }), ctx())).toMatch(/cut its command short/);
		// No toolInputTruncated at all: taken as cut, where it matters.
		const unmarked = JSON.stringify({ sessionId: "s1", cwd: t.folder, toolName: "run_terminal_command", toolInput: { command: cut("ls") } });
		expect(runGrokGuard(unmarked, ctx())).toMatch(/cut its command short/);
	});

	it("plain-window rules for a plain Grok session: Orrery's own rules, no agent's", () => {
		const { t, ctx, home } = agentWorld();
		const plain = ctx({ env: {} });
		const elsewhere = join(t.dir, "elsewhere");
		mkdirSync(elsewhere);
		// No folder confinement, no .env or [guard] protect: those are an agent's.
		expect(runGrokGuard(call("write", { file_path: join(t.dir, "anywhere.md"), content: "x" }, elsewhere), plain)).toBeUndefined();
		expect(runGrokGuard(call("read_file", { target_file: join(t.folder, "protected.txt") }, elsewhere), plain)).toBeUndefined();
		// Orrery's own: its data, config and credentials, every agent's memory, its commands, Grok's folder and the records.
		expect(runGrokGuard(call("read_file", { target_file: join(t.agent.dir, "memory.sqlite") }, elsewhere), plain)).toMatch(/sensitive/);
		expect(runGrokGuard(call("search_replace", { file_path: t.configPath, old_string: "a", new_string: "b" }, elsewhere), plain)).toMatch(/sensitive|Orrery's config/);
		expect(runGrokGuard(call("run_terminal_command", { command: "orrery compact Test" }, elsewhere), plain)).toMatch(/Orrery guard: .*orrery compact/);
		expect(runGrokGuard(call("write", { file_path: join(home, ".grok", "hooks", "orrery.json"), content: "{}" }, elsewhere), plain)).toMatch(/^Orrery guard: .* is in Grok's folder, .*: it may be read, not changed$/);
		expect(runGrokGuard(call("run_terminal_command", { command: "rm ~/.grok/hooks/orrery.json" }, elsewhere), plain)).toMatch(/Grok's folder/);
		// A plain session reads Grok's docs and its own records; it may not change them.
		expect(runGrokGuard(call("read_file", { target_file: join(home, ".grok", "hooks", "orrery.json") }, elsewhere), plain)).toBeUndefined();
		// Grok's own memory is the person's: Grok's memory "forget" edits it.
		expect(runGrokGuard(call("search_replace", { file_path: join(home, ".grok", "memory-v2", "global", "MEMORY.md"), old_string: "a", new_string: "b" }, elsewhere), plain)).toBeUndefined();
	});

	it("lets an agent's grok -w session, and a plain one, work in its worktree in Grok's folder as in a project", () => {
		const { ctx, home } = agentWorld();
		const wt = join(home, ".grok", "worktrees", "repo-x");
		mkdirSync(join(wt, "src"), { recursive: true });
		for (const context of [ctx(), ctx({ env: {} })]) {
			expect(runGrokGuard(call("write", { file_path: "src/a.ts", content: "x" }, wt), context)).toBeUndefined();
			expect(runGrokGuard(call("search_replace", { file_path: join(wt, "src", "a.ts"), old_string: "a", new_string: "b" }, wt), context)).toBeUndefined();
			expect(runGrokGuard(call("run_terminal_command", { command: `cd ${wt} && npm test` }, wt), context)).toBeUndefined();
			expect(runGrokGuard(call("run_terminal_command", { command: `git -C ${wt} status` }, wt), context)).toBeUndefined();
			expect(runGrokGuard(call("run_terminal_command", { command: `cd ${wt} && echo x > ../../hooks/e.json` }, wt), context)).toMatch(/^Orrery guard: .*could reach the rest of Grok's folder/);
			expect(runGrokGuard(call("write", { file_path: "../../hooks/e.json", content: "{}" }, wt), context)).toMatch(/^Orrery guard: .* is in Grok's folder/);
			// Its shell text from where it runs, as the hook gives it: a ".." out of the worktrees refused, one in them not.
			expect(runGrokGuard(call("run_terminal_command", { command: "echo x > ../../hooks/e.json" }, wt), context)).toMatch(/^Orrery guard: This command runs in Grok's folder .*leads out of the part it runs in/);
			expect(runGrokGuard(call("run_terminal_command", { command: "cat ../repo-y/README.md src/../README.md" }, wt), context)).toBeUndefined();
			// A folder change in text that names the worktree: into one only.
			expect(runGrokGuard(call("run_terminal_command", { command: `cd ${wt} && cd - && echo x > hooks/e.json` }, wt), context)).toMatch(/^Orrery guard: .*could reach the rest of Grok's folder/);
			expect(runGrokGuard(call("run_terminal_command", { command: `cd ${join(home, ".grok", "worktrees")} && ls` }, wt), context)).toMatch(/^Orrery guard: .*could reach the rest of Grok's folder/);
		}
	});

	it("reads a session's relative paths from Grok's folder itself, as the hook gives its cwd: what Grok loads refused, its open parts not", () => {
		const { ctx, home } = agentWorld();
		const grok = join(home, ".grok");
		mkdirSync(join(grok, "skills"));
		for (const context of [ctx(), ctx({ env: {} })]) {
			for (const command of ["echo x > hooks/e.json", "cp /tmp/e.json hooks", "cp a config.toml"]) {
				expect([command, runGrokGuard(call("run_terminal_command", { command }, grok), context)]).toEqual([command, expect.stringMatching(/^Orrery guard: This command names Grok's folder/)]);
			}
			for (const command of ["echo x > skills/s/SKILL.md", "ls -la", "git status"]) {
				expect([command, runGrokGuard(call("run_terminal_command", { command }, grok), context)]).toEqual([command, undefined]);
			}
		}
	});

	it("reads a session's relative spelling of Grok's folder from home, as the hook gives its cwd: what Grok loads refused, its open parts not", () => {
		const { ctx, home } = agentWorld();
		for (const context of [ctx(), ctx({ env: {} })]) {
			for (const command of ["echo x > .grok/hooks/e.json", "cp x ./.grok/config.toml"]) {
				expect([command, runGrokGuard(call("run_terminal_command", { command }, home), context)]).toEqual([command, expect.stringMatching(/^Orrery guard: This command names Grok's folder/)]);
			}
			expect(runGrokGuard(call("run_terminal_command", { command: "echo x > .grok/skills/s/SKILL.md" }, home), context)).toBeUndefined();
		}
	});

	it("judges a session opened as an agent but refused by no agent's rules: only where it runs, every agent's view kept from it", () => {
		const { t, ctx } = agentWorld();
		const cwd = join(t.folder, "sub");
		const other = ctx({ env: { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: newToken() } });
		expect(runGrokGuard(call("write", { file_path: "../top.md", content: "x" }, cwd), ctx())).toBeUndefined();
		expect(runGrokGuard(call("write", { file_path: "../top.md", content: "x" }, cwd), other)).toMatch(/outside this agent's folder/);
		expect(runGrokGuard(call("write", { file_path: "x.md", content: "x" }, cwd), other)).toBeUndefined();
		const view = join(t.folder, ".orrery", "view.md");
		expect(runGrokGuard(call("read_file", { target_file: view }, cwd), ctx())).toBeUndefined();
		expect(runGrokGuard(call("read_file", { target_file: view }, cwd), other)).toMatch(/another agent's memory view|sensitive/);
	});

	it("under Grok's shared leader, applies the plain-window rules to every session, whatever agent and token it names", () => {
		const { t, ctx, home } = agentWorld();
		// Leader mode's, one run in its own process (worker start, leader worker start), one with global options before agent.
		const leaders = [
			["/home/u/.grok/downloads/grok-linux-x86_64", "agent", "leader", "--no-exit-on-disconnect"],
			["grok", "worker", "--name", "w", "start"],
			["grok", "leader", "worker", "start"],
			["grok", "--debug", "--leader-socket", "/tmp/l.sock", "agent", "leader"],
		];
		for (const c of leaders.flatMap((leaderArgv) => [ctx({ argvOf: () => leaderArgv }), ctx({ argvOf: () => leaderArgv, env: {} })])) {
			// Never allow-all: Orrery's settings and every agent's memory and Grok's folder stay write-protected.
			expect(runGrokGuard(call("write", { file_path: t.configPath, content: "[" }, t.folder), c)).toMatch(/^Orrery guard: /);
			expect(runGrokGuard(call("read_file", { target_file: join(t.folder, ".orrery", "view.md") }, t.folder), c)).toMatch(/another agent's memory view|sensitive/);
			expect(runGrokGuard(call("write", { file_path: join(home, ".grok", "hooks", "x.json"), content: "{}" }, t.folder), c)).toMatch(/Grok's folder/);
			// Never deny-all: an ordinary call goes through, and no agent's folder rule applies (a session no agent's).
			expect(runGrokGuard(call("run_terminal_command", { command: "ls" }, t.folder), c)).toBeUndefined();
			expect(runGrokGuard(call("write", { file_path: join(t.dir, "elsewhere.md"), content: "x" }, t.folder), c)).toBeUndefined();
		}
	});

	it("with Grok's command line unread, judges a session ORRERY_AGENT names as opened but refused (only where it runs), and one it doesn't as plain", () => {
		const { t, ctx, home } = agentWorld();
		const cwd = join(t.folder, "sub");
		// The agent's own token is claimed for this Grok, but its command line can't be read: no agent's session is proved.
		const unread = ctx({ argvOf: () => undefined });
		expect(runGrokGuard(call("write", { file_path: "x.md", content: "x" }, cwd), unread)).toBeUndefined();
		expect(runGrokGuard(call("write", { file_path: "../top.md", content: "x" }, cwd), unread)).toMatch(/outside this agent's folder/);
		expect(runGrokGuard(call("write", { file_path: join(t.dir, "elsewhere.md"), content: "x" }, cwd), unread)).toMatch(/outside this agent's folder/);
		expect(runGrokGuard(call("read_file", { target_file: join(t.folder, ".orrery", "view.md") }, cwd), unread)).toMatch(/another agent's memory view|sensitive/);
		expect(runGrokGuard(call("write", { file_path: join(home, ".grok", "hooks", "x.json"), content: "{}" }, cwd), unread)).toMatch(/Grok's folder|outside/);
		// No ORRERY_AGENT: a plain grok's rules.
		const plain = ctx({ argvOf: () => undefined, env: {} });
		expect(runGrokGuard(call("write", { file_path: join(t.dir, "elsewhere.md"), content: "x" }, cwd), plain)).toBeUndefined();
		expect(runGrokGuard(call("write", { file_path: t.configPath, content: "[" }, cwd), plain)).toMatch(/^Orrery guard: /);
	});

	it("refuses what it cannot judge: input over 1 MB or unread, input that is no JSON object, a call with no cwd or tool, a failure", () => {
		const { t, ctx } = agentWorld();
		expect(runGrokGuard(undefined, ctx())).toBe("Orrery guard: this call's input is too large for Orrery's guard to check (over 1 MB); nothing was run");
		expect(runGrokGuard("not json", ctx())).toBe("Orrery guard: Orrery could not read this call; nothing was run");
		expect(runGrokGuard("[1]", ctx())).toBe("Orrery guard: Orrery could not read this call; nothing was run");
		expect(runGrokGuard(JSON.stringify({ toolName: "write", toolInput: { file_path: "x" } }), ctx())).toBe("Orrery guard: Orrery could not read this call; nothing was run");
		expect(runGrokGuard(JSON.stringify({ cwd: "relative", toolName: "write", toolInput: {} }), ctx())).toBe("Orrery guard: Orrery could not read this call; nothing was run");
		expect(runGrokGuard(JSON.stringify({ cwd: t.folder, toolInput: { command: "ls" } }), ctx())).toBe("Orrery guard: Orrery could not read this call; nothing was run");
		const broken = Object.defineProperty({ ...ctx() }, "config", {
			get(): never {
				throw new Error("disk gone");
			},
		});
		expect(runGrokGuard(call("run_terminal_command", { command: "ls" }, t.folder), broken)).toBe("Orrery guard: this call could not be checked (disk gone); nothing was run");
	});

	it("refuses, never skips, what it has not judged by its deadline", () => {
		const { t, ctx } = agentWorld();
		expect(runGrokGuard(call("run_terminal_command", { command: "ls" }, t.folder), ctx({ deadline: performance.now() - 1 }))).toBe("Orrery guard: this call names more than the guard can check in time; nothing was run");
	});

	it("puts a refusal on one line: Grok takes the first line of stderr as the reason", () => {
		expect(grokRefusal("Orrery's config could not be read (bad TOML:\n1:  [\n     ^\n), so nothing was run.")).toBe("Orrery guard: Orrery's config could not be read (bad TOML: 1:  [ ^ ), so nothing was run");
	});
});

describe("the guard process's last line (src/codex/guard-exit.ts), armed for Grok's guard too", () => {
	it("is armed for grok-hook pre-tool-use alone, whatever options come with it", () => {
		expect(isGrokGuard(["grok-hook", "pre-tool-use"])).toBe(true);
		expect(isGrokGuard(["--config", "/x/config.toml", "grok-hook", "pre-tool-use"])).toBe(true);
		for (const event of GROK_HOOK_EVENTS.filter((name) => name !== "pre-tool-use")) expect(isGrokGuard(["grok-hook", event])).toBe(false);
		expect(isGrokGuard(["codex-hook", "pre-tool-use"])).toBe(false);
	});

	it("judges by 4 s and refuses a stall at 6 s, well inside the 10 s Orrery's hook file gives Grok's PreToolUse (Grok lets a call through once it passes)", () => {
		const hooks = JSON.parse(grokHookFile("/x/orrery")) as { hooks: Record<string, { hooks: { timeout: number }[] }[]> };
		const timeout = (hooks.hooks.PreToolUse?.[0]?.hooks[0]?.timeout ?? 0) * 1000;
		expect(timeout).toBe(10_000);
		expect(CODEX_GUARD_DEADLINE_MS).toBe(4000);
		expect(CODEX_GUARD_WATCHDOG_MS).toBe(6000);
		expect(CODEX_GUARD_WATCHDOG_MS).toBeLessThanOrEqual(timeout - 4000);
	});
});
