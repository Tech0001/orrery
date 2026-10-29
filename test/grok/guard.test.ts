import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newToken } from "../../src/agent/pick.ts";
import { CODEX_GUARD_DEADLINE_MS, CODEX_GUARD_WATCHDOG_MS, isGrokGuard } from "../../src/codex/guard-exit.ts";
import { GROK_AS_CLAUDE, type GrokGuardContext, grokGuard, grokRefusal, runGrokGuard } from "../../src/grok/guard.ts";
import { grokHookFile } from "../../src/grok/install.ts";
import { GROK_HOOK_EVENTS } from "../../src/grok/names.ts";
import { cleanupDirs, testAgent } from "../claude/support.ts";

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
 * and workflows, /learn's runs, the background-task skill's logs and watchers, plugins' data, the bundled skills (their
 * scripts), its docs and its logs.
 */
const GROK_OPEN = [
	"memory-v2/global/MEMORY.md",
	"skills/x/SKILL.md",
	"workflows/review.rhai",
	"learn/runs/20261029T000000Z/report.md",
	"long-running-background-tasks/dev_server_1.log",
	"plugin-data/pr-babysit/watched-prs-1.json",
	"bundled/skills/pptx/scripts/x.py",
	"docs/user-guide/10-hooks.md",
	"logs/unified.jsonl",
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

	it("leaves what its own features write writable (its memory, skills, workflows, /learn's runs, background-task logs, plugins' data, bundled skills, docs and logs), in both sessions", () => {
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
		// What its own features write, a name beside Grok's folder, and a project's own .grok folder: a project's hooks and
		// config are the project's (a known limit, src/grok/guard.ts), as Claude Code's project settings are.
		for (const command of [
			"cat ~/.grok/memory-v2/global/MEMORY.md",
			"echo '- likes tabs' >> ~/.grok/memory-v2/global/MEMORY.md",
			"ls ~/.grok/skills && cat ~/.grok/skills/*/SKILL.md",
			"cp review.rhai $GROK_HOME/workflows/",
			"cat ~/.grok/./skills/x/SKILL.md ~/.grok/workflows/../skills/x/SKILL.md",
			"cat ~/.grok/docs/user-guide/10-hooks.md",
			"tail -n 50 ~/.grok/logs/unified.jsonl",
			"ls ~/.grok/bundled/skills",
			"cat ~/.grokrc",
			"ls .grok/hooks",
			"cat .grok/config.toml",
			"grok --version",
		]) {
			expect([command, grokGuard("run_terminal_command", { command }, options, false)]).toEqual([command, undefined]);
			expect([command, grokGuard("run_terminal_command", { command }, plain, false)]).toEqual([command, undefined]);
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
		];
		for (const opts of [options, atHome, plain]) {
			for (const command of commands) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, undefined]);
				expect([command, grokGuard("monitor", { command }, opts, false)]).toEqual([command, undefined]);
			}
		}
		// File tools, in an agent's session whose folder holds Grok's, and in one that is no agent's.
		const files = ["plugin-data/pr-babysit/watched-prs-1.json", "learn/trash/run/originals/x.md", "learn/state.json", "long-running-background-tasks/watch_dev_server.sh"];
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

	it("keeps an open part that is a link into what Grok loads, or out of its open parts, from file tools and shell text, in both sessions", () => {
		const { home, grok, options, atHome, plain } = setup();
		// skills/ linked to hooks/: a file written there is a hook file Grok loads.
		rmSync(join(grok, "skills"), { recursive: true });
		symlinkSync(join(grok, "hooks"), join(grok, "skills"));
		// logs/ linked out of Grok's folder: where it really is may be anything.
		mkdirSync(join(home, "grok-logs"));
		rmSync(join(grok, "logs"), { recursive: true });
		symlinkSync(join(home, "grok-logs"), join(grok, "logs"));
		// workflows/ linked to another open part stays open.
		rmSync(join(grok, "workflows"), { recursive: true });
		symlinkSync(join(grok, "docs"), join(grok, "workflows"));
		for (const opts of [options, atHome, plain]) {
			for (const command of ["echo '{}' > ~/.grok/skills/evil.json", `cp x ${grok}/skills/evil.json`, "echo x > $GROK_HOME/skills/evil.json", "cp x ~/.grok/./skills/evil.json", "echo x >> ~/.grok/logs/x.log"]) {
				expect([command, grokGuard("run_terminal_command", { command }, opts, false)]).toEqual([command, expect.stringMatching(GROK_FOLDER)]);
			}
			expect(grokGuard("run_terminal_command", { command: "cp x ~/.grok/workflows/w.rhai ~/grok-logs/x.log" }, opts, false)).toBeUndefined();
		}
		for (const opts of [atHome, plain]) {
			for (const path of [join(grok, "skills", "evil.json"), "~/.grok/skills/evil.json", join(grok, "logs", "x.log"), "~/.grok/logs/x.log"]) {
				expect([path, grokGuard("write", { file_path: path, content: "x" }, opts, false)]).toEqual([path, expect.stringMatching(GROK_FOLDER)]);
			}
			// Where the linked-out part really is is judged as itself; another open part's link stays open.
			for (const path of [join(home, "grok-logs", "x.log"), join(grok, "workflows", "w.rhai")]) {
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
			for (const file of ["memory-v2/global/MEMORY.md", "skills/x/SKILL.md", "workflows/w.rhai", "logs/x.log", "bundled/skills/x/y.py", "learn/state.json", "plugin-data/p/s.json"]) {
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

	it("keeps a guarded entry where a link takes it out of Grok's folder (a config.toml in a dotfiles folder), in both sessions", () => {
		const { root, grok, atHome, plain } = setup();
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
			// The rest of the dotfiles folder is the person's, and Grok's skills stay writable where they really are; through
			// the link out of Grok's open parts they are kept, as any open part a link takes elsewhere is.
			expect(grokGuard("write", { file_path: join(dotfiles, "grok.toml.bak"), content: "x" }, opts, false)).toBeUndefined();
			expect(grokGuard("run_terminal_command", { command: "cat ~/dotfiles/notes.md" }, opts, false)).toBeUndefined();
			expect(grokGuard("write", { file_path: join(dotfiles, "grok-skills", "x", "SKILL.md"), content: "x" }, opts, false)).toBeUndefined();
			expect(grokGuard("run_terminal_command", { command: "cp x ~/dotfiles/grok-skills/x/SKILL.md" }, opts, false)).toBeUndefined();
			expect(grokGuard("write", { file_path: join(grok, "skills", "x", "SKILL.md"), content: "x" }, opts, false)).toMatch(GROK_FOLDER);
			expect(grokGuard("run_terminal_command", { command: "cp x ~/.grok/skills/x/SKILL.md" }, opts, false)).toMatch(GROK_FOLDER);
		}
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
		const ctx = (extra: Partial<GrokGuardContext> = {}): GrokGuardContext => ({
			config: t.config,
			env: { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token },
			grokPid: 4343,
			alive: (pid) => pid === 4343,
			argvOf: () => ["/home/u/.grok/downloads/grok-linux-x86_64", "--no-leader", "--rules", "x"],
			home,
			configFile: t.configPath,
			...extra,
		});
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
		const leaderArgv = ["/home/u/.grok/downloads/grok-linux-x86_64", "agent", "leader", "--no-exit-on-disconnect"];
		for (const c of [ctx({ argvOf: () => leaderArgv }), ctx({ argvOf: () => leaderArgv, env: {} })]) {
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
