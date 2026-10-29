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

/** Grok's folder under a home: its hooks, config, trust list, policy files, the /hooks switch, plugins, docs, login and a session. */
const GROK_FILES = [
	"hooks/orrery.json",
	"config.toml",
	"trusted_folders.toml",
	"requirements.toml",
	"managed_config.toml",
	"disabled-hooks",
	"installed-plugins/x/hooks/hooks.json",
	"agents/reviewer.md",
	"workflows/review.rhai",
	"docs/user-guide/10-hooks.md",
	"bundled/skills/learn/SKILL.md",
	"auth.json",
	"sessions/%2Fws/01a1/updates.jsonl",
	"sessions/%2Fws/01a1/system_prompt.txt",
];

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
	return { root, folder, home, cwd, grok: join(home, ".grok"), options };
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
});

describe("Grok's folder: writes refused anywhere in it, from file tools and shell text; its login and sessions not read", () => {
	it("writes anywhere under the Grok home (hooks, config.toml, trusted_folders.toml, requirements.toml, sessions/, installed-plugins/) refused, from file tools", () => {
		const { grok, options } = setup();
		const home = { ...options, folder: options.home, cwd: options.home };
		for (const file of GROK_FILES) {
			for (const path of [join(grok, file), `~/.grok/${file}`, join(grok, file).toUpperCase().replace(grok.toUpperCase(), grok)]) {
				// Even with the agent's folder at home, which holds Grok's folder.
				expect([path, grokGuard("write", { file_path: path, content: "x" }, home, false)]).toEqual([path, expect.stringMatching(/Grok's folder|sensitive/)]);
				expect([path, grokGuard("search_replace", { file_path: path, old_string: "x", new_string: "y" }, home, false)]).toEqual([path, expect.stringMatching(/Grok's folder|sensitive/)]);
			}
		}
		expect(grokGuard("write", { file_path: join(grok, "hooks", "evil.json"), content: "{}" }, home, false)).toMatch(GROK_FOLDER);
		expect(grokGuard("write", { file_path: "../hooks-link/new.json", content: "{}" }, options, false)).toMatch(GROK_FOLDER);
		expect(grokGuard("fs__write_file", { tool_name: "fs__write_file", tool_input: { path: join(grok, "config.toml"), content: "x" } }, home, false)).toMatch(GROK_FOLDER);
		expect(grokGuard("apply_patch", { input: patch(`*** Add File: ${join(grok, "hooks", "x.json")}`, "+{}") }, home, false)).toMatch(GROK_FOLDER);
	});

	it("refuses shell text that names Grok's folder, by its path, from home, or $GROK_HOME, in every tool that runs one", () => {
		const { grok, options } = setup();
		for (const command of [
			"echo '{}' > ~/.grok/hooks/orrery.json",
			"rm ~/.grok/hooks/orrery.json",
			"printf 'global/orrery:pre_tool_use[0].hooks[0]\\n' >> ~/.grok/disabled-hooks",
			"sed -i /orrery/d $HOME/.grok/config.toml",
			`cat >> ${grok}/trusted_folders.toml`,
			"cp policy.toml ${HOME}/.grok/requirements.toml",
			"echo x >> $GROK_HOME/hooks/x.json",
			"ls ${GROK_HOME}/installed-plugins",
			"echo x >> ~/.grok/sessions/%2Fws/01a1/updates.jsonl",
			"cat ~/.grok/docs/user-guide/10-hooks.md",
		]) {
			expect([command, grokGuard("run_terminal_command", { command, description: "x" }, options, false)]).toEqual([command, expect.stringMatching(/Grok's folder|sensitive|session records/)]);
			expect([command, grokGuard("monitor", { command }, options, false)]).toEqual([command, expect.stringMatching(/Grok's folder|sensitive|session records/)]);
		}
		// A name beside it, and a project's own .grok folder, are no Grok folder of the person's.
		for (const command of ["cat ~/.grokrc", "ls .grok/hooks", "cat .grok/config.toml", "grok --version"]) {
			expect([command, grokGuard("run_terminal_command", { command }, options, false)]).toEqual([command, undefined]);
		}
	});

	it("reads of sessions/ and auth.json refused; reads of docs/ allowed", () => {
		const { grok, options } = setup();
		for (const path of [join(grok, "auth.json"), "~/.grok/auth.json", join(grok, "sessions", "%2Fws", "01a1", "updates.jsonl"), join(grok, "sessions", "%2Fws", "01a1", "system_prompt.txt"), "~/.grok/sessions"]) {
			expect([path, grokGuard("read_file", { target_file: path }, options, false)]).toEqual([path, expect.stringMatching(SENSITIVE)]);
			expect([path, grokGuard("list_dir", { target_directory: path }, options, false)]).toEqual([path, expect.stringMatching(SENSITIVE)]);
		}
		expect(grokGuard("grep", { pattern: "x", path: grok }, options, false)).toMatch(/would search credential files/);
		for (const path of [join(grok, "docs", "user-guide", "10-hooks.md"), "~/.grok/docs/user-guide/10-hooks.md", "~/.grok/bundled/skills/learn/SKILL.md", "~/.grok/hooks/orrery.json", "~/.grok/config.toml"]) {
			expect([path, grokGuard("read_file", { target_file: path }, options, false)]).toEqual([path, undefined]);
		}
		expect(grokGuard("grep", { pattern: "hook", path: join(grok, "docs") }, options, false)).toBeUndefined();
	});

	it("keeps a folder GROK_HOME moves Grok's to the same way", () => {
		const { root, options } = setup();
		const moved = join(root, "grok-home");
		for (const file of ["hooks/orrery.json", "auth.json", "sessions/%2Fws/01a1/updates.jsonl", "docs/x.md"]) {
			mkdirSync(dirname(join(moved, file)), { recursive: true });
			writeFileSync(join(moved, file), "x");
		}
		const before = process.env.GROK_HOME;
		process.env.GROK_HOME = moved;
		try {
			expect(grokGuard("write", { file_path: join(moved, "hooks", "orrery.json"), content: "{}" }, options, false)).toMatch(GROK_FOLDER);
			expect(grokGuard("read_file", { target_file: join(moved, "sessions", "%2Fws", "01a1", "updates.jsonl") }, options, false)).toMatch(SENSITIVE);
			expect(grokGuard("read_file", { target_file: join(moved, "auth.json") }, options, false)).toMatch(SENSITIVE);
			expect(grokGuard("read_file", { target_file: join(moved, "docs", "x.md") }, options, false)).toBeUndefined();
			expect(grokGuard("run_terminal_command", { command: `echo x > ${moved}/hooks/x.json` }, options, false)).toMatch(GROK_FOLDER);
		} finally {
			if (before === undefined) delete process.env.GROK_HOME;
			else process.env.GROK_HOME = before;
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
		expect(runGrokGuard(call("write", { file_path: join(home, ".grok", "hooks", "orrery.json"), content: "{}" }, elsewhere), plain)).toMatch(/^Orrery guard: .* is in Grok's folder .*: it may be read, not changed$/);
		expect(runGrokGuard(call("run_terminal_command", { command: "rm ~/.grok/hooks/orrery.json" }, elsewhere), plain)).toMatch(/Grok's folder/);
		// A plain session reads Grok's docs and its own records; it may not change them.
		expect(runGrokGuard(call("read_file", { target_file: join(home, ".grok", "hooks", "orrery.json") }, elsewhere), plain)).toBeUndefined();
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
		const leader = ctx({ argvOf: () => ["/home/u/.grok/downloads/grok-linux-x86_64", "agent", "leader", "--no-exit-on-disconnect"] });
		const unread = ctx({ argvOf: () => undefined });
		for (const c of [leader, unread]) {
			// Never allow-all: Orrery's settings and every agent's memory and Grok's folder stay write-protected.
			expect(runGrokGuard(call("write", { file_path: t.configPath, content: "[" }, t.folder), c)).toMatch(/^Orrery guard: /);
			expect(runGrokGuard(call("read_file", { target_file: join(t.folder, ".orrery", "view.md") }, t.folder), c)).toMatch(/another agent's memory view|sensitive/);
			expect(runGrokGuard(call("write", { file_path: join(home, ".grok", "hooks", "x.json"), content: "{}" }, t.folder), c)).toMatch(/Grok's folder/);
			// Never deny-all: an ordinary call goes through, and no agent's folder rule applies (a session no agent's).
			expect(runGrokGuard(call("run_terminal_command", { command: "ls" }, t.folder), c)).toBeUndefined();
			expect(runGrokGuard(call("write", { file_path: join(t.dir, "elsewhere.md"), content: "x" }, t.folder), c)).toBeUndefined();
		}
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
