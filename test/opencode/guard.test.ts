import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import { GuardCall, guardToolCall } from "../../src/agent/guard-paths.ts";
import { OPENCODE_COMMAND, OPENCODE_READ_ONLY } from "../../src/agent/guard-rules.ts";
import {
	afterDiff,
	CONFIG_UNREADABLE,
	headerTargets,
	type OpenCodeGuardOptions,
	OpenCodeGuardHook,
	openCodeGuard,
	openCodeGuardOptions,
	openCodeLogins,
	openCodePermission,
	openCodeRefusal,
	openCodeToolPath,
	readPatch,
} from "../../src/opencode/guard.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * An agent's folder (ws) with the session's folder below it (sub), a scratch home with an ssh key and OpenCode's data
 * folder (its database among it), Orrery's home (data, with its config and installed program), a [guard] protect path
 * entry (~/finance) and name entry (secret.txt), a folder outside, and a file whose name is in NFD form.
 */
function world() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "orrery-opencode-guard-")));
	dirs.push(root);
	const folder = join(root, "ws");
	const cwd = join(folder, "sub");
	const home = join(root, "home");
	const data = join(root, "data");
	for (const dir of [cwd, join(home, ".ssh"), join(home, "finance"), join(home, ".local", "share", "opencode"), join(data, "app", "0.8.0"), join(root, "outside"), join(folder, "vault")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
	writeFileSync(join(home, "finance", "q3.csv"), "q3");
	writeFileSync(join(home, ".local", "share", "opencode", "opencode.db"), "db");
	writeFileSync(join(data, "config.toml"), "");
	writeFileSync(join(folder, "secret.txt"), "s");
	writeFileSync(join(cwd, "a.ts"), "a");
	writeFileSync(join(cwd, "Café.txt"), "nfd");
	symlinkSync(join(home, ".ssh", "id_ed25519"), join(cwd, "key.png"));
	const env = { XDG_DATA_HOME: join(home, ".local", "share") };
	const config = parseConfig(
		[`data_dir = ${JSON.stringify(data)}`, "[guard]", `protect = ["~/finance", "secret.txt"]`, "[agents.Atlas]", `folder = ${JSON.stringify(folder)}`, `allowed_roots = [${JSON.stringify(join(root, "shared"))}]`, 'compactor_model = "faux-compactor/faux-1"', "[agents.Birch]", `folder = ${JSON.stringify(join(root, "birch"))}`, 'compactor_model = "faux-compactor/faux-1"', ""].join("\n"),
		root,
	);
	// Protect entries "~/" are the guard's home: the config's parser keeps them as written.
	const options: OpenCodeGuardOptions = { ...openCodeGuardOptions(config, config.agents.get("Atlas"), cwd, { env, home }), configFile: join(data, "config.toml") };
	return { root, folder, cwd, home, data, env, config, options };
}

const SENSITIVE = /sensitive/;
const PROTECTED = /protected by \[guard\] protect/;
const OUTSIDE = /outside this agent's folder/;
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

describe("readPatch reads a patch's targets as OpenCode 2.0.30's patch tool does", () => {
	it("takes each Add, Update, Delete and Move to target, in order", () => {
		expect(readPatch(patch("*** Add File: a.txt", "+x", "*** Update File: b.ts", "*** Move to: c.ts", "@@", "-1", "+2", "*** Delete File: d.md"))).toEqual({ targets: ["a.txt", "b.ts", "c.ts", "d.md"] });
	});

	it("reads the forms OpenCode takes: a heredoc (with cat or not), CRLF, blank space around, headers and paths trimmed, an Environment ID line, End of File before a move", () => {
		expect(readPatch(`<<'EOF'\n${patch("*** Add File: a.txt", "+x")}\nEOF`)).toEqual({ targets: ["a.txt"] });
		expect(readPatch(`cat <<EOF\n${patch("*** Delete File: a.txt")}\nEOF\n`)).toEqual({ targets: ["a.txt"] });
		expect(readPatch(patch("*** Add File: a.txt", "+x", "*** Delete File: b.txt").replaceAll("\n", "\r\n"))).toEqual({ targets: ["a.txt", "b.txt"] });
		expect(readPatch(`\n  ${patch("*** Add File: a.txt", "+x")}  \n\n`)).toEqual({ targets: ["a.txt"] });
		expect(readPatch(patch("   *** Add File:   spaced.txt  ", "+x"))).toEqual({ targets: ["spaced.txt"] });
		expect(readPatch(patch("*** Environment ID: env-1", "*** Add File: a.txt", "+x"))).toEqual({ targets: ["a.txt"] });
		expect(readPatch(patch("*** Update File: a.ts", "*** End of File", "*** Move to: b.ts", "@@", "-1", "+2"))).toEqual({ targets: ["a.ts", "b.ts"] });
		expect(readPatch(patch("*** Update File: ~/notes.md", "@@", "+x", "*** End of File"))).toEqual({ targets: ["~/notes.md"] });
	});

	it("reads an indented header inside an update hunk as a context line, and one at column 0 as the next hunk", () => {
		expect(readPatch(patch("*** Update File: a.ts", "@@", " *** Add File: /etc/x", "-old", "+new"))).toEqual({ targets: ["a.ts"] });
		expect(readPatch(patch("*** Update File: a.ts", "@@", "-old", "+new", "*** Add File: b.ts", "+x"))).toEqual({ targets: ["a.ts", "b.ts"] });
		// Outside an update hunk a header is read trimmed.
		expect(readPatch(patch("*** Add File: a.txt", "+x", "   *** Add File: b.txt", "+y"))).toEqual({ targets: ["a.txt", "b.txt"] });
	});

	it.each([
		["text that is no patch", "rm -rf /"],
		["a patch without its end", "*** Begin Patch\n*** Add File: a.txt\n+x"],
		["a patch without its start", "*** Add File: a.txt\n+x\n*** End Patch"],
		["the start line alone", "*** Begin Patch"],
		["a line that is no hunk header", patch("*** Copy File: a.txt")],
		["an Add File line without +", patch("*** Add File: a.txt", "x")],
		["a Delete File with lines", patch("*** Delete File: a.txt", "-x")],
		["an Update File with no lines", patch("*** Update File: a.txt")],
		["an Update File with an empty chunk", patch("*** Update File: a.txt", "@@", "@@", "+x")],
		["a move to nothing", patch("*** Update File: a.txt", "*** Move to:", "@@", "+x")],
		["an update line of no kind", patch("*** Update File: a.txt", "@@", "+x", "junk")],
		["more after End of File", patch("*** Update File: a.txt", "@@", "+x", "*** End of File", "+y")],
		["a Move to after the hunk's lines", patch("*** Update File: a.txt", "@@", "+x", "*** Move to: b.txt")],
	])("refuses to read %s, as OpenCode refuses to apply it", (_what, text) => {
		expect(readPatch(text)).toHaveProperty("unreadable");
	});

	it("finds every header line's target in any text, and both its spellings", () => {
		expect(headerTargets("notes\n  *** Add File: a.txt\n*** Move to:  b.txt \n+*** Add File: c.txt\n*** Update File:\n")).toEqual(["a.txt", " b.txt", "b.txt"]);
	});
});

describe("openCodeToolPath places a path as OpenCode's tools do", () => {
	it("takes ~ and ~/ from OpenCode's home, anything else from the session's folder, and trims nothing", () => {
		expect(openCodeToolPath("~", "/w", "/h")).toBe("/h");
		expect(openCodeToolPath("~/x", "/w", "/h")).toBe("/h/x");
		expect(openCodeToolPath("~x", "/w", "/h")).toBe("/w/~x");
		expect(openCodeToolPath("a/../b", "/w", "/h")).toBe("/w/b");
		expect(openCodeToolPath("/etc/x", "/w", "/h")).toBe("/etc/x");
		expect(openCodeToolPath(" ~/x", "/w", "/h")).toBe("/w/ ~/x");
	});
});

describe("openCodeGuard judges each tool with the shared rules", () => {
	it("shell: its command by the shell-text rules, its workdir (or the session's folder) as a read of that folder", () => {
		const t = world();
		const call = (input: unknown) => openCodeGuard("shell", input, t.options);
		expect(call({ command: "ls -la && npm test" })).toBeUndefined();
		expect(call({ command: "cat ~/.ssh/id_ed25519" })).toMatch(SENSITIVE);
		expect(call({ command: "cat ~/finance/q3.csv" })).toMatch(PROTECTED);
		expect(call({ command: "orrery codex-hook stop" })).toMatch(/hook plumbing/);
		expect(call({ command: "ls", workdir: "~/.ssh" })).toMatch(SENSITIVE);
		expect(call({ command: "ls", workdir: join(t.home, "finance") })).toMatch(PROTECTED);
		expect(call({ command: "ls", workdir: "../vault" })).toBeUndefined();
		expect(call({ command: "cat q3.csv", workdir: "~/finance" })).toMatch(PROTECTED);
		expect(call({ command: "ls", workdir: t.data })).toMatch(SENSITIVE);
		// No workdir: the session's own folder, which here is a protected one.
		expect(openCodeGuard("shell", { command: "cat q3.csv" }, { ...t.options, cwd: join(t.home, "finance") })).toMatch(PROTECTED);
		expect(call({ command: "x".repeat(70_000) })).toMatch(/too long to check/);
	});

	it("read, write and edit: their path, as OpenCode places it", () => {
		const t = world();
		const call = (tool: string, input: unknown) => openCodeGuard(tool, input, t.options);
		expect(call("read", { path: "a.ts" })).toBeUndefined();
		expect(call("read", { path: "~/.ssh/id_ed25519" })).toMatch(SENSITIVE);
		expect(call("read", { path: "key.png" })).toMatch(SENSITIVE);
		expect(call("read", { path: "../secret.txt" })).toMatch(PROTECTED);
		expect(call("read", { path: join(t.data, "config.toml") })).toBeUndefined();
		expect(call("write", { path: "b.ts", content: "~/.ssh/id_ed25519" })).toBeUndefined();
		expect(call("write", { path: join(t.root, "outside", "x"), content: "x" })).toMatch(OUTSIDE);
		expect(call("write", { path: join(t.data, "config.toml"), content: "" })).toMatch(/Orrery's config/);
		expect(call("edit", { path: join(t.data, "app", "0.8.0", "x.js"), oldString: "a", newString: "b" })).toMatch(/installed program/);
		// What an edit replaces is text, not a path.
		expect(call("edit", { path: "a.ts", oldString: "~/.ssh/id_ed25519", newString: "./.env" })).toBeUndefined();
		expect(call("edit", { path: "~/notes.md", oldString: "a", newString: "b" })).toMatch(OUTSIDE);
	});

	it("read: also each file OpenCode's read opens in place of a missing one (a name that differs only in Unicode form, no-break spaces or curly quotes)", () => {
		const t = world();
		// Its NFC spelling is missing; OpenCode reads the NFD file beside it. Protected by name in NFD here.
		const options = { ...t.options, protect: [...(t.options.protect ?? []), "Café.txt"] };
		expect(openCodeGuard("read", { path: "Café.txt" }, options)).toMatch(PROTECTED);
		writeFileSync(join(t.cwd, "it’s.txt"), "x");
		expect(openCodeGuard("read", { path: "it's.txt" }, { ...t.options, protect: ["it’s.txt"] })).toMatch(PROTECTED);
		expect(openCodeGuard("read", { path: "it's.txt" }, t.options)).toBeUndefined();
	});

	it("patch: each target of its patch text, a write; a patch OpenCode would not apply is refused unread", () => {
		const t = world();
		const call = (text: string) => openCodeGuard("patch", { patchText: text }, t.options);
		expect(call(patch("*** Add File: b.ts", "+x", "*** Update File: a.ts", "*** Move to: c.ts", "@@", "-a", "+b", "*** Delete File: d.ts"))).toBeUndefined();
		for (const target of ["~/.ssh/config", join(t.root, "outside", "x"), "../secret.txt", join(t.data, "config.toml")]) {
			expect(call(patch(`*** Add File: ${target}`, "+x")), target).toBeDefined();
			expect(call(patch(`*** Delete File: ${target}`)), target).toBeDefined();
			expect(call(patch(`*** Update File: ${target}`, "@@", "-a", "+b")), target).toBeDefined();
			expect(call(patch("*** Update File: a.ts", `*** Move to: ${target}`, "@@", "-a", "+b")), target).toBeDefined();
			expect(call(`<<'EOF'\n${patch(`*** Add File: ${target}`, "+x")}\nEOF`), target).toBeDefined();
		}
		expect(call(patch("*** Add File: ~/.ssh/config", "+x"))).toMatch(SENSITIVE);
		// A line that only looks like a header (a context line) counts too.
		expect(call(patch("*** Update File: a.ts", "@@", " *** Add File: ~/.ssh/config", "-a", "+b"))).toMatch(SENSITIVE);
		expect(call(patch("*** Add File: a.txt", "x"))).toBe("Orrery could not read this patch (a line of an Add File hunk does not start with +); nothing was changed.");
		expect(call("*** Add File: a.txt\n+x")).toMatch(/could not read this patch/);
	});

	it("glob and grep: their search root, and the names their pattern or include match", () => {
		const t = world();
		const call = (tool: string, input: unknown) => openCodeGuard(tool, input, t.options);
		expect(call("glob", { pattern: "**/*.ts" })).toBeUndefined();
		expect(call("glob", { pattern: "**/*.ts", path: "~" })).toMatch(/would search credential files/);
		expect(call("glob", { pattern: "**/.env" })).toMatch(SENSITIVE);
		expect(call("glob", { pattern: "*", path: "~/finance" })).toMatch(PROTECTED);
		// An absolute pattern does not move OpenCode's search: its root is still judged.
		expect(call("glob", { pattern: `${t.folder}/**`, path: "~/.ssh" })).toMatch(SENSITIVE);
		// "undefined" and "null" are no path to OpenCode's glob: the session's folder.
		expect(openCodeGuard("glob", { pattern: "*", path: "undefined" }, { ...t.options, cwd: t.home })).toMatch(/would search credential files/);
		expect(call("grep", { pattern: "key" })).toBeUndefined();
		expect(call("grep", { pattern: "key", path: t.home })).toMatch(/would search credential files/);
		expect(call("grep", { pattern: "key", include: ".env*" })).toMatch(SENSITIVE);
		expect(call("grep", { pattern: "auth.json" })).toBeUndefined();
	});

	it("webfetch and websearch: the network is open; a file: URL is a read", () => {
		const t = world();
		expect(openCodeGuard("webfetch", { url: "https://example.com/.ssh/id_rsa" }, t.options)).toBeUndefined();
		expect(openCodeGuard("websearch", { query: "~/.ssh/config permissions" }, t.options)).toBeUndefined();
		expect(openCodeGuard("webfetch", { url: `file://${t.home}/.ssh/id_ed25519` }, t.options)).toMatch(SENSITIVE);
	});

	it("Code Mode's execute: its program by the shell-text rules (each tool it calls comes in a call of its own)", () => {
		const t = world();
		expect(openCodeGuard("execute", { code: "const s = await tools.opencode.session_rename({ title: 'x' }); return s;" }, t.options)).toBeUndefined();
		expect(openCodeGuard("execute", { code: "return await tools.files.read({ path: '~/.ssh/id_ed25519' })" }, t.options)).toMatch(SENSITIVE);
		expect(openCodeGuard("execute", { code: "await tools.box.run({ cmd: 'orrery codex-hook stop' })" }, t.options)).toMatch(/hook plumbing/);
		// A name built from pieces gets past the program's text; the call it makes is judged on its own.
		expect(openCodeGuard("execute", { code: "await tools.files.read({ path: '~/fin' + 'ance/q3.csv' })" }, t.options)).toBeUndefined();
		expect(openCodeGuard("files_read", { path: "~/finance/q3.csv" }, t.options)).toMatch(PROTECTED);
	});

	it("opencode_session_move: its folder judged as a shell's workdir; another session's relative folder can't be placed", () => {
		const t = world();
		const call = (input: unknown, session = "ses_a") => openCodeGuard("opencode_session_move", input, t.options, session);
		expect(call({ directory: join(t.root, "outside") })).toBeUndefined();
		expect(call({ directory: "../vault" })).toBeUndefined();
		expect(call({ directory: " ~/finance " })).toMatch(PROTECTED);
		expect(call({ directory: "~/.ssh" })).toMatch(SENSITIVE);
		expect(call({ directory: t.data })).toMatch(SENSITIVE);
		expect(call({ sessionID: "ses_b", directory: "../x" })).toMatch(/another session/);
		expect(call({ sessionID: "ses_b", directory: "~/.ssh" })).toMatch(SENSITIVE);
		expect(call({ sessionID: "ses_a", directory: "../vault" })).toBeUndefined();
	});

	it("MCP, plugin and other tools: Claude Code's heuristics, code and input as shell text, and patch text in any string", () => {
		const t = world();
		const call = (tool: string, input: unknown) => openCodeGuard(tool, input, t.options);
		expect(call("box_run", { command: "cat ~/.ssh/id_ed25519" })).toMatch(SENSITIVE);
		expect(call("box_exec", { cmd: ["cat", "~/finance/q3.csv"] })).toMatch(PROTECTED);
		expect(call("box_python", { code: "open('/home/x/.ssh/id_rsa').read()" })).toMatch(SENSITIVE);
		expect(call("box_shell", { input: "orrery claude-hook stop" })).toMatch(/hook plumbing/);
		expect(call("box_apply", { diff: patch("*** Add File: ~/.ssh/authorized_keys", "+key") })).toMatch(SENSITIVE);
		expect(call("box_apply", { changes: [{ text: patch("*** Add File: ../../outside/x", "+x") }] })).toMatch(OUTSIDE);
		expect(call("fs_read_file", { path: "../secret.txt" })).toMatch(PROTECTED);
		expect(call("fs_write_file", { path: join(t.root, "outside", "x"), content: "x" })).toMatch(OUTSIDE);
		expect(call("opencode_worktree_remove", { directory: join(t.root, "outside") })).toMatch(OUTSIDE);
		expect(call("opencode_read_mcp_resource", { server: "fs", uri: `file://${t.home}/.ssh/id_ed25519` })).toMatch(SENSITIVE);
		expect(call("subagent", { agent: "general", description: "look", prompt: "Read the notes and say what they plan." })).toBeUndefined();
		expect(call("search", { query: "Saffron" })).toBeUndefined();
		expect(call("opencode_worktree_list", undefined)).toBeUndefined();
		// A value that is no object is judged by what it holds.
		expect(call("box_run", "cat ~/.ssh/id_ed25519")).toMatch(SENSITIVE);
		expect(call("box_run", ["cat", "~/.ssh/id_ed25519"])).toMatch(SENSITIVE);
	});

	it("keeps OpenCode's login: its database by path, in a search's root, and named in a command", () => {
		const t = world();
		const db = join(t.home, ".local", "share", "opencode", "opencode.db");
		expect(openCodeLogins(t.env, t.home)).toContain(db);
		expect(openCodeGuard("read", { path: db }, t.options)).toMatch(SENSITIVE);
		expect(openCodeGuard("read", { path: `${db}-wal` }, t.options)).toMatch(SENSITIVE);
		expect(openCodeGuard("grep", { pattern: "key", path: join(t.home, ".local", "share") }, t.options)).toMatch(/would search credential files/);
		// Named in a command: OpenCode's database is a credential store every gate keeps by name, and its config and code.
		expect(openCodeGuard("shell", { command: "sqlite3 ~/.local/share/opencode/opencode.db 'select * from credential'" }, t.options)).toMatch(SENSITIVE);
		expect(openCodeGuard("shell", { command: "cp data/opencode-beta.db /tmp/x" }, t.options)).toBe(OPENCODE_COMMAND);
		expect(openCodeGuard("box_sql", { code: "sqlite3 opencode.db" }, t.options)).toBe(OPENCODE_COMMAND);
		// A channel's database made after the session started, by its name in OpenCode's data folder.
		expect(openCodeGuard("read", { path: join(t.home, ".local", "share", "opencode", "opencode-dev.db") }, t.options)).toMatch(SENSITIVE);
		expect(openCodeGuard("shell", { command: "ls ~/.local/share/opencode/log && cat notes-opencode.dbx" }, t.options)).toBeUndefined();
	});

	it("lets the Plan agent write its plan files (~/.opencode/plan) and nothing else of ~/.opencode", () => {
		const t = world();
		expect(openCodeGuard("write", { path: "~/.opencode/plan/steps.md", content: "x" }, t.options)).toBeUndefined();
		expect(openCodeGuard("write", { path: "~/.opencode/plugins/x.ts", content: "x" }, t.options)).toMatch(/OpenCode's config or code/);
		// Not when it is a link (to home, say).
		mkdirSync(join(t.home, ".opencode"));
		symlinkSync(t.home, join(t.home, ".opencode", "plan"));
		const linked = openCodeGuardOptions(t.config, t.config.agents.get("Atlas"), t.cwd, { env: t.env, home: t.home });
		expect(openCodeGuard("write", { path: "~/.opencode/plan/steps.md", content: "x" }, linked)).toMatch(OUTSIDE);
	});

	it("with no agent: writes only where the session runs, and every agent's view is another's", () => {
		const t = world();
		const none = openCodeGuardOptions(t.config, undefined, t.cwd, { env: t.env, home: t.home });
		expect(none.folder).toBe(t.cwd);
		expect(openCodeGuard("write", { path: "x.ts", content: "x" }, none)).toBeUndefined();
		expect(openCodeGuard("write", { path: "../x.ts", content: "x" }, none)).toMatch(OUTSIDE);
		expect(openCodeGuard("read", { path: join(t.folder, ".orrery", "view.md") }, none)).toMatch(SENSITIVE);
		expect(openCodeGuard("read", { path: join(t.folder, ".orrery", "view.md") }, t.options)).toBeUndefined();
	});

	it("refuses an input over 1 MB unread, and what it can't judge in its time", () => {
		const t = world();
		expect(openCodeGuard("box_run", { notes: "x".repeat(1024 * 1024 + 1) }, t.options)).toBe("this call's input is too large for Orrery's guard to check (over 1 MB); nothing was run.");
		expect(openCodeGuard("read", { path: "a.ts" }, { ...t.options, judgeMs: 0 })).toBe("this call names more than the guard can check in time; nothing was run.");
		expect(openCodeGuard("box_run", { command: "ls" }, { ...t.options, judgeMs: 0 })).toBe("this call names more than the guard can check in time; nothing was run.");
	});
});

describe("openCodeGuard keeps OpenCode's config and plugins in every folder (.opencode/, opencode.json, opencode.jsonc): OpenCode loads them into its server", () => {
	const CONFIG = /OpenCode's config/;

	it("refuses the security review's probes: a write of opencode.json and opencode.jsonc, an edit of sub2/opencode.json, a write into .opencode/plugins, a patch adding to .opencode, a shell command naming opencode.json", () => {
		const t = world();
		const call = (tool: string, input: unknown) => openCodeGuard(tool, input, t.options);
		expect(call("write", { path: "opencode.json", content: "{}" })).toMatch(CONFIG);
		expect(call("write", { path: "opencode.jsonc", content: "{}" })).toMatch(CONFIG);
		expect(call("edit", { path: "sub2/opencode.json", oldString: "a", newString: "b" })).toMatch(CONFIG);
		expect(call("write", { path: ".opencode/plugins/x.ts", content: "" })).toMatch(CONFIG);
		expect(call("patch", { patchText: patch("*** Add File: .opencode/x.ts", "+x") })).toMatch(CONFIG);
		expect(call("shell", { command: "cp x opencode.json" })).toMatch(CONFIG);
		expect(call("write", { path: "opencode.json", content: "{}" })).toBe(OPENCODE_READ_ONLY("opencode.json"));
		expect(call("shell", { command: "cp x opencode.json" })).toBe(OPENCODE_COMMAND);
	});

	it("in any folder the agent may write (its own, above the session's, an allowed root), in any case, and through a link", () => {
		const t = world();
		const write = (path: string) => openCodeGuard("write", { path, content: "x" }, t.options);
		for (const path of ["../opencode.json", join(t.folder, ".opencode", "agents", "a.md"), join(t.root, "shared", "opencode.jsonc"), join(t.root, "shared", ".opencode", "x"), "deep/er/.opencode/commands/c.md", "OpenCode.JSON", ".OpenCode/plugins/x.ts"]) expect(write(path), path).toMatch(CONFIG);
		// A link whose target is one.
		writeFileSync(join(t.cwd, "opencode.json"), "{}");
		symlinkSync(join(t.cwd, "opencode.json"), join(t.cwd, "settings.json"));
		mkdirSync(join(t.folder, ".opencode"));
		symlinkSync(join(t.folder, ".opencode"), join(t.cwd, "tools"));
		expect(write("settings.json")).toMatch(CONFIG);
		expect(write("tools/plugins/x.ts")).toMatch(CONFIG);
		// Names that only look alike are other files.
		for (const path of ["opencode.json.bak", "my-opencode.json", "opencode.json5", "notes/opencode/x.md", ".opencoder/x"]) expect(write(path), path).toBeUndefined();
	});

	it("a patch's every target, a Move to among them, and an MCP or plugin tool that writes one; the permission layer's edit", () => {
		const t = world();
		expect(openCodeGuard("patch", { patchText: patch("*** Update File: a.ts", "*** Move to: opencode.jsonc", "@@", "-a", "+b") }, t.options)).toMatch(CONFIG);
		expect(openCodeGuard("patch", { patchText: patch("*** Delete File: .opencode/plugins/guard-off.ts") }, t.options)).toMatch(CONFIG);
		expect(openCodeGuard("fs_write_file", { path: "opencode.json", content: "{}" }, t.options)).toMatch(CONFIG);
		expect(openCodeGuard("box_copy", { source: "a.ts", destination: ".opencode/plugins/a.ts" }, t.options)).toMatch(CONFIG);
		expect(openCodeGuard("box_apply", { diff: patch("*** Add File: .opencode/x.ts", "+x") }, t.options)).toMatch(CONFIG);
		expect(openCodePermission("edit", ["opencode.json"], t.options)).toMatch(CONFIG);
		expect(openCodePermission("edit", [join(t.folder, ".opencode", "x.ts")], t.options)).toMatch(CONFIG);
	});

	it("shell text naming one in any reading a shell may make, as the other names this gate keeps; Code Mode's program and a tool's run text too", () => {
		const t = world();
		const shell = (command: string) => openCodeGuard("shell", { command }, t.options);
		for (const command of ["echo '{}' > opencode.json", "mkdir -p .opencode/plugins", "cp x.ts ./.opencode/plugins/", "cat sub/opencode.jsonc", 'mv a "opencode.json"', "cp a open{code.json,x}", "tee OPENCODE.JSON < a", "ls .opencode"]) expect(shell(command), command).toMatch(CONFIG);
		for (const command of ["cat opencode.json.bak", "ls notes/opencode", "npm run opencode-e2e", "echo .opencoder"]) expect(shell(command), command).toBeUndefined();
		expect(openCodeGuard("execute", { code: "await tools.fs.write_file({ path: '.opencode/plugins/x.ts', content: '' })" }, t.options)).toMatch(CONFIG);
		expect(openCodeGuard("box_run", { command: "cp x opencode.json" }, t.options)).toMatch(CONFIG);
	});

	it("leaves reading them alone, and OpenCode's Plan folder (~/.opencode/plan) writable", () => {
		const t = world();
		expect(openCodeGuard("read", { path: "opencode.json" }, t.options)).toBeUndefined();
		expect(openCodeGuard("read", { path: join(t.folder, ".opencode", "plugins", "x.ts") }, t.options)).toBeUndefined();
		expect(openCodeGuard("glob", { pattern: ".opencode/**" }, t.options)).toBeUndefined();
		expect(openCodeGuard("grep", { pattern: "plugins", include: "opencode.json*" }, t.options)).toBeUndefined();
		expect(openCodeGuard("write", { path: "~/.opencode/plan/steps.md", content: "x" }, t.options)).toBeUndefined();
		expect(openCodeGuard("write", { path: "~/.opencode/plan/opencode.json", content: "x" }, t.options)).toMatch(CONFIG);
		expect(openCodeGuard("write", { path: "~/.opencode/plan/x/.opencode/plugins/p.ts", content: "x" }, t.options)).toMatch(CONFIG);
	});
});

describe("openCodeGuard judges each patch target once", () => {
	it("a patch that names one file a thousand times is one judgment, in time", () => {
		const t = world();
		const text = patch(...Array.from({ length: 1000 }, () => ["*** Update File: a.ts", "@@", "-a", "+b"]).flat());
		expect(text.length).toBeLessThan(64 * 1024);
		expect(openCodeGuard("patch", { patchText: text }, t.options)).toBeUndefined();
	});

	it("a patch of 300 files is judged within the guard's time", () => {
		const t = world();
		const text = patch(...Array.from({ length: 300 }, (_, i) => [`*** Add File: f${i}.ts`, "+x"]).flat());
		const started = performance.now();
		expect(openCodeGuard("patch", { patchText: text }, t.options)).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(2000);
	});

	it("works out its rules once per call, however many paths it judges: a patch's 300 targets share them", () => {
		const t = world();
		const call = new GuardCall();
		const text = patch(...Array.from({ length: 300 }, (_, i) => [`*** Add File: f${i}.ts`, "+x"]).flat());
		expect(openCodeGuard("patch", { patchText: text }, { ...t.options, call })).toBeUndefined();
		expect(call.ruleSets).toBe(1);
		// Options that differ in what the rules come from (another cwd) get rule sets of their own.
		const other = new GuardCall();
		for (const cwd of [t.cwd, t.folder, t.cwd]) expect(guardToolCall("write", { path: join(t.cwd, "a.ts"), content: "x" }, { ...t.options, cwd, call: other })).toBeUndefined();
		expect(other.ruleSets).toBe(2);
		// The verdicts are the rules' own, shared or not.
		for (const target of [join(t.home, ".ssh", "x"), join(t.root, "outside", "x"), join(t.cwd, "b.ts"), join(t.home, ".local", "share", "opencode", "opencode.db")]) {
			expect(guardToolCall("write", { path: target, content: "x" }, { ...t.options, call: other })).toBe(guardToolCall("write", { path: target, content: "x" }, t.options));
		}
	});
});

describe("openCodeGuard lets nothing through by its shape (security review: authorization)", () => {
	const UNREADABLE = "Orrery could not read this call (its input is not what the tool takes); nothing was run.";

	it.each([
		["shell", "cat a.ts"],
		["shell", ["cat", "~/.ssh/id_ed25519"]],
		["read", undefined],
		["write", null],
		["patch", "*** Begin Patch\n*** Add File: ~/.ssh/x\n+x\n*** End Patch"],
	])("refuses a built-in tool's input that is no object (%s, %j)", (tool, input) => {
		expect(openCodeGuard(tool, input, world().options)).toBe(UNREADABLE);
	});

	it.each([
		["shell", {}],
		["shell", { command: ["cat", "~/.ssh/id_ed25519"] }],
		["shell", { command: "ls", workdir: ["~/.ssh"] }],
		["read", { path: ["~/.ssh/id_ed25519"] }],
		["read", { file_path: "~/.ssh/id_ed25519" }],
		["write", { path: { toString: "~/.ssh/x" }, content: "x" }],
		["write", { path: "a.ts" }],
		["edit", { path: "a.ts", oldString: "a" }],
		["patch", { patchText: ["*** Begin Patch", "*** Add File: ~/.ssh/x", "+x", "*** End Patch"] }],
		["glob", { path: "~" }],
		["grep", { pattern: "x", path: 7 }],
		["webfetch", { url: { href: "file:///etc/passwd" } }],
		["opencode_session_move", { directory: ["~/.ssh"] }],
		// Another tool renamed to a name the guard lets through: what it takes is not a web call's.
		["websearch", { path: join("..", "outside", "x"), content: "x" }],
		["webfetch", { command: "cat ~/.ssh/id_ed25519" }],
	])("refuses %s with a missing field or one that is not text: %j", (tool, input) => {
		expect(openCodeGuard(tool, input, world().options)).toBe(UNREADABLE);
	});

	it("judges what a built-in tool's input carries beside its schema by content (OpenCode drops it, but a renamed tool may not)", () => {
		const t = world();
		expect(openCodeGuard("write", { path: "a.ts", content: "x", command: "cat ~/.ssh/id_ed25519" }, t.options)).toMatch(SENSITIVE);
		expect(openCodeGuard("read", { path: "a.ts", file_path: "~/finance/q3.csv" }, t.options)).toMatch(PROTECTED);
		expect(openCodeGuard("websearch", { query: "x", target: join(t.root, "outside", "x") }, t.options)).toMatch(OUTSIDE);
		expect(openCodeGuard("shell", { command: "ls", script: "orrery codex-hook stop" }, t.options)).toMatch(/hook plumbing/);
		expect(openCodeGuard("patch", { patchText: "", diff: patch("*** Add File: ~/.ssh/x", "+x") }, t.options)).toMatch(SENSITIVE);
		// What the schema takes is judged as the tool uses it: an edit's text is not a path.
		expect(openCodeGuard("edit", { path: "a.ts", oldString: "~/.ssh/id_ed25519", newString: "x", replaceAll: true }, t.options)).toBeUndefined();
	});

	it("judges any other tool by what it carries, at any depth, never letting it through by default", () => {
		const t = world();
		const call = (tool: string, input: unknown) => openCodeGuard(tool, input, t.options);
		expect(call("mystery", { target: join(t.root, "outside", "x") })).toMatch(OUTSIDE);
		expect(call("mystery", { a: { b: [{ path: "~/.ssh/id_ed25519" }] } })).toMatch(SENSITIVE);
		expect(call("mystery", { steps: [{ run: { code: "cat ~/finance/q3.csv" } }] })).toMatch(PROTECTED);
		expect(call("mystery", { argv: ["cat", "~/.ssh/id_ed25519"] })).toMatch(SENSITIVE);
		expect(call("mystery", { note: "see ~/.ssh/id_ed25519" })).toBeUndefined();
		expect(call("mystery", "~/.ssh/id_ed25519")).toMatch(SENSITIVE);
		expect(call("mystery", 42)).toBeUndefined();
		expect(call("", { path: "a.ts" })).toBeUndefined();
	});

	it("needs no session from the hook: a session_move that names a session is another's unless the hook says it is this one", () => {
		const t = world();
		expect(openCodeGuard("opencode_session_move", { sessionID: "ses_a", directory: "../vault" }, t.options)).toMatch(/another session/);
		expect(openCodeGuard("opencode_session_move", { directory: "../vault" }, t.options)).toBeUndefined();
		expect(openCodeGuard("opencode_session_move", { directory: "~" }, t.options)).toBeUndefined();
	});

	it("refuses a permission whose resources it can't read", () => {
		const t = world();
		expect(openCodePermission("read", ["a.ts", 7], t.options)).toBe("Orrery could not read what this tool asks leave for; nothing was run.");
		expect(openCodePermission("edit", [""], t.options)).toBeUndefined();
	});
});

describe("openCodeGuard places every path where OpenCode 2.0.30 does (security review: parser and placement)", () => {
	it("patch: every header and whitespace form OpenCode reads, several files, moves, absolute, relative and ~ targets, each judged where it lands", () => {
		const t = world();
		const call = (text: string) => openCodeGuard("patch", { patchText: text }, t.options);
		const forms = (target: string) => [
			patch(`*** Add File: ${target}`, "+x"),
			patch(`\t *** Add File: ${target}  `, "+x"),
			patch("*** Add File: a.txt", "+x", `*** Delete File: ${target}`),
			patch("*** Update File: a.ts", "@@", "-a", "+b", `*** Update File: ${target}`, "@@", "-a", "+b"),
			patch("*** Update File: a.ts", "*** End of File", `*** Move to: ${target}   `, "@@", "-a", "+b"),
			patch(`*** Update File: ${target}`, "*** Move to: b.ts", "@@", "-a", "+b"),
			`  ${patch(`*** Add File: ${target}`, "+x").replaceAll("\n", "\r\n")}  \r\n`,
			`cat <<'PATCH'\n${patch(`*** Add File: ${target}`, "+x")}\nPATCH`,
			`<<"EOF"\n${patch(`*** Add File: ${target}`, "+x")}\nEOF`,
			patch("*** Environment ID: env-1", `*** Add File: ${target}`, "+x"),
		];
		for (const target of ["~/.ssh/config", join(t.home, ".ssh", "config"), "../secret.txt", "./x/../../secret.txt", join(t.home, "finance", "new.csv"), "~/finance/new.csv"]) {
			for (const [at, text] of forms(target).entries()) expect(call(text), `${target} #${at}`).toMatch(/sensitive|protected/);
		}
		for (const [at, text] of forms("new/file.ts").entries()) expect(call(text), `#${at}`).toBeUndefined();
		// ~ is OpenCode's home; "~x" and " ~/" are names in the session's folder.
		expect(call(patch("*** Add File: ~/notes.md", "+x"))).toMatch(/outside this agent's folder/);
		expect(call(patch("*** Add File: ~notes.md", "+x"))).toBeUndefined();
		// What OpenCode reads differently is refused unread: an Environment ID line with no id is no header to it.
		expect(call(patch("*** Environment ID:", "*** Add File: a.txt", "+x"))).toMatch(/could not read this patch/);
		expect(call(patch("*** Add File: a.txt", "+x", "*** Copy File: b.txt"))).toMatch(/could not read this patch/);
	});

	it("shell: the command as written, its workdir from the session's folder (~ from home), the session's folder without one", () => {
		const t = world();
		const call = (input: object, cwd = t.cwd) => openCodeGuard("shell", input, { ...t.options, cwd });
		expect(call({ command: "cat q3.csv", workdir: "~/finance" })).toMatch(PROTECTED);
		expect(call({ command: "cat q3.csv", workdir: "../../home/finance" }, join(t.root, "ws", "sub"))).toMatch(PROTECTED);
		expect(call({ command: "cat q3.csv", workdir: "finance" }, t.home)).toMatch(PROTECTED);
		expect(call({ command: "cat q3.csv" }, join(t.home, "finance"))).toMatch(PROTECTED);
		expect(call({ command: "cat q3.csv", workdir: "" }, join(t.home, "finance"))).toMatch(PROTECTED);
		expect(call({ command: "ls", workdir: "~" })).toBeUndefined();
	});

	it("read, write, edit, glob and grep: relative to the session's folder (the location OpenCode runs the session in), ~ from home, links followed", () => {
		const t = world();
		const at = (cwd: string) => ({ ...t.options, cwd });
		for (const [tool, input] of [
			["read", { path: "q3.csv" }],
			["write", { path: "q3.csv", content: "x" }],
			["edit", { path: "q3.csv", oldString: "a", newString: "b" }],
			["grep", { pattern: "x", path: "q3.csv" }],
			["glob", { pattern: "*", path: "." }],
		] as const) {
			// The same call from the agent's folder, and from a session moved into the protected folder.
			expect(openCodeGuard(tool, input, at(t.cwd)), `${tool} in sub`).toBeUndefined();
			expect(openCodeGuard(tool, input, at(join(t.home, "finance"))), `${tool} in finance`).toMatch(PROTECTED);
		}
		expect(openCodeGuard("read", { path: "~/finance/q3.csv" }, t.options)).toMatch(PROTECTED);
		expect(openCodeGuard("read", { path: "../sub/a.ts" }, t.options)).toBeUndefined();
		expect(openCodeGuard("read", { path: "../sub/../../home/finance/q3.csv" }, t.options)).toMatch(PROTECTED);
		expect(openCodeGuard("read", { path: "" }, at(join(t.home, "finance")))).toMatch(PROTECTED);
		// A file: URL is no URL to OpenCode's file tools (a name in the session's folder), but the guard reads it as one too.
		expect(openCodeGuard("read", { path: `file://${t.home}/finance/q3.csv` }, t.options)).toMatch(PROTECTED);
		// A link in the session's folder to the protected folder.
		symlinkSync(join(t.home, "finance"), join(t.cwd, "fin"));
		expect(openCodeGuard("read", { path: "fin/q3.csv" }, t.options)).toMatch(PROTECTED);
		expect(openCodeGuard("write", { path: "fin/new.csv", content: "x" }, t.options)).toMatch(PROTECTED);
		expect(openCodeGuard("grep", { pattern: "x", path: "fin" }, t.options)).toMatch(PROTECTED);
	});
});

describe("afterDiff: a file's text after the unified diff OpenCode reports for an edit", () => {
	const diff = (...hunks: string[]) => ["--- a/x.md", "+++ b/x.md", ...hunks].join("\n");

	it("applies each hunk: a change, an insertion at the top or after a line, several hunks, lines kept around them", () => {
		expect(afterDiff("a\nb\nc\n", diff("@@ -2,1 +2,1 @@", "-b", "+B"))).toBe("a\nB\nc\n");
		expect(afterDiff("a\nb\n", diff("@@ -0,0 +1,1 @@", "+---js"))).toBe("---js\na\nb\n");
		expect(afterDiff("a\nb\n", diff("@@ -1,0 +2,1 @@", "+x"))).toBe("a\nx\nb\n");
		expect(afterDiff("a\nb\nc\nd\n", diff("@@ -1,2 +1,2 @@", " a", "-b", "+B", "@@ -4 +4 @@", "-d", "+D"))).toBe("a\nB\nc\nD\n");
		expect(afterDiff("", diff("@@ -0,0 +1,2 @@", "+x", "+y"))).toBe("x\ny\n");
		expect(afterDiff("a\nb\n", diff("@@ -1,2 +0,0 @@", "-a", "-b"))).toBe("");
	});

	it("reads CRLF and a missing final newline as the same lines", () => {
		expect(afterDiff("a\r\nb\r\n", diff("@@ -2 +2 @@", "-b", "+B").replace(/\n/g, "\r\n"))).toBe("a\nB\n");
		expect(afterDiff("a\nb", diff("@@ -2 +2 @@", "-b", "\\ No newline at end of file", "+B", "\\ No newline at end of file"))).toBe("a\nB");
	});

	it("is undefined when the diff doesn't fit the text: a kept or removed line that differs, hunks out of order or past the end, no hunk", () => {
		expect(afterDiff("a\nb\n", diff("@@ -2 +2 @@", "-x", "+B"))).toBeUndefined();
		expect(afterDiff("a\nb\n", diff("@@ -1,2 +1,2 @@", " a", " x"))).toBeUndefined();
		expect(afterDiff("a\nb\nc\n", diff("@@ -3 +3 @@", "-c", "+C", "@@ -1 +1 @@", "-a", "+A"))).toBeUndefined();
		expect(afterDiff("a\n", diff("@@ -5 +5 @@", "-e", "+E"))).toBeUndefined();
		expect(afterDiff("a\n", diff())).toBeUndefined();
		expect(afterDiff("a\n", "")).toBeUndefined();
	});
});

describe("openCodePermission, the second layer: what a tool asks leave for, as OpenCode placed it", () => {
	it("judges a read's and an edit's resources (relative to the session's folder, or absolute); other actions are the first hook's", () => {
		const t = world();
		expect(openCodePermission("read", ["a.ts"], t.options)).toBeUndefined();
		expect(openCodePermission("read", ["../secret.txt"], t.options)).toMatch(PROTECTED);
		expect(openCodePermission("read", [join(t.home, ".ssh", "id_ed25519")], t.options)).toMatch(SENSITIVE);
		expect(openCodePermission("edit", ["b.ts", join(t.root, "outside", "x")], t.options)).toMatch(OUTSIDE);
		expect(openCodePermission("edit", [join(t.data, "config.toml")], t.options)).toMatch(/Orrery's config/);
		// A resource is a name in the session's folder: "~" there is a folder's name, not home.
		expect(openCodePermission("edit", ["~/x.ts"], t.options)).toBeUndefined();
		for (const action of ["shell", "external_directory", "glob", "grep", "subagent", "box_run"]) expect(openCodePermission(action, [join(t.home, ".ssh", "id_ed25519")], t.options), action).toBeUndefined();
	});
});

describe("OpenCodeGuardHook: the plugin's hooks, fail-closed and in time", () => {
	const rules = () => ({ options: world().options });

	it("lets a call through, or gives the refusal as the model sees it", async () => {
		const hook = new OpenCodeGuardHook();
		hook.decide(rules());
		expect(await hook.beforeTool({ tool: "read", input: { path: "a.ts" }, sessionID: "ses_a" })).toBeUndefined();
		expect(await hook.beforeTool({ tool: "read", input: { path: "~/.ssh/id_ed25519" } })).toMatch(/^Orrery guard: .* is a sensitive file/);
		expect(await hook.beforeTool({ input: {} })).toBe(openCodeRefusal("Orrery could not read this call; nothing was run."));
	});

	it("waits for its rules; with none in its time, refuses", async () => {
		const hook = new OpenCodeGuardHook({ ms: 200 });
		const started = Date.now();
		expect(await hook.beforeTool({ tool: "read", input: { path: "a.ts" } })).toBe(openCodeRefusal("this call could not be checked in time; nothing was run."));
		expect(Date.now() - started).toBeGreaterThanOrEqual(190);
		const waiting = hook.beforeTool({ tool: "read", input: { path: "a.ts" } });
		hook.decide(rules());
		expect(await waiting).toBeUndefined();
		// The first rules set stay.
		hook.decide({ blind: "x" });
		expect(await hook.beforeTool({ tool: "read", input: { path: "a.ts" } })).toBeUndefined();
	});

	it("refuses every call when Orrery's config can't be read, a judgment that fails, and one that held the thread past its time", async () => {
		const blind = new OpenCodeGuardHook();
		blind.decide({ blind: CONFIG_UNREADABLE("bad TOML at line 3") });
		expect(await blind.beforeTool({ tool: "websearch", input: { query: "x" } })).toBe("Orrery guard: Orrery's config could not be read (bad TOML at line 3), so no call can be checked; nothing was run. Fix the config file.");
		const failing = new OpenCodeGuardHook({
			judge: () => {
				throw new TypeError("boom.");
			},
		});
		failing.decide(rules());
		expect(await failing.beforeTool({ tool: "read", input: {} })).toBe("Orrery guard: this call could not be checked (boom); nothing was run.");
		const slow = new OpenCodeGuardHook({
			ms: 100,
			judge: () => {
				const until = performance.now() + 250;
				while (performance.now() < until) {
					// a judgment that keeps the thread
				}
				return undefined;
			},
		});
		slow.decide(rules());
		expect(await slow.beforeTool({ tool: "read", input: {} })).toBe("Orrery guard: this call could not be checked in time; nothing was run.");
	});

	it("refuses a permission the guard would refuse (effect deny, with the reason), and leaves the rest as they are", async () => {
		const hook = new OpenCodeGuardHook();
		hook.decide(rules());
		const event = { action: "read", resources: ["../secret.txt"], effect: "allow" as unknown, message: undefined as unknown };
		await hook.onPermission(event);
		expect(event.effect).toBe("deny");
		expect(event.message).toMatch(/^Orrery guard: .*protected by \[guard\] protect/);
		const fine = { action: "read", resources: ["a.ts"], effect: "ask" as unknown };
		await hook.onPermission(fine);
		expect(fine).toEqual({ action: "read", resources: ["a.ts"], effect: "ask" });
		const denied = { action: "read", resources: ["../secret.txt"], effect: "deny" as unknown, message: "a rule of the person's" as unknown };
		await hook.onPermission(denied);
		expect(denied.message).toBe("a rule of the person's");
	});
});
