import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newToken } from "../../src/agent/pick.ts";
import { type CodexGuardContext, codexGuard, codexRefusal, codexToolPath, readPatch, runCodexGuard } from "../../src/codex/guard.ts";
import { cleanupDirs, testAgent } from "../claude/support.ts";

let dir: string | undefined;
afterEach(() => {
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
	cleanupDirs();
});

/**
 * An agent's folder with a subfolder (the cwd), a fake home with credentials, a protected name, links out of the folder,
 * and a folder named "~" in the cwd that links to home's .ssh (Codex opens "~/x" there, not in home).
 */
function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "orrery-codex-guard-")));
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
	writeFileSync(join(folder, "secret.txt"), "s");
	writeFileSync(join(folder, ".gitignore"), "node_modules\n");
	writeFileSync(join(root, "data", "config.toml"), "");
	symlinkSync(join(root, "outside"), join(folder, "link"));
	symlinkSync(join(home, ".ssh", "id_ed25519"), join(folder, "key.png"));
	symlinkSync(join(home, ".ssh"), join(cwd, "~"));
	const options = { folder, allowedRoots: [] as string[], cwd, home, foreignViews: [] as string[], protect: ["secret.txt"], orreryData: join(root, "data") };
	return { root, folder, home, cwd, options };
}

const SENSITIVE = /sensitive/;
const PROTECTED = /protected by \[guard\] protect/;
const OUTSIDE = /outside this agent's folder/;
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

describe("readPatch reads a patch's targets as Codex 0.162.1's apply_patch parser does", () => {
	it("takes each Add, Update, Delete and Move to target, in order", () => {
		expect(readPatch(patch("*** Add File: a.txt", "+x", "*** Update File: b.ts", "*** Move to: c.ts", "@@", "-1", "+2", "*** Delete File: d.md"))).toEqual({ targets: ["a.txt", "b.ts", "c.ts", "d.md"] });
	});

	it("reads the forms Codex takes: a heredoc around the patch, CRLF, blank space around it, and headers indented outside an update", () => {
		expect(readPatch(`<<'EOF'\n${patch("*** Add File: a.txt", "+x")}\nEOF\n`)).toEqual({ targets: ["a.txt"] });
		expect(readPatch(`<<EOF\n${patch("*** Delete File: a.txt")}\nEOF`)).toEqual({ targets: ["a.txt"] });
		expect(readPatch(patch("*** Add File: a.txt", "+x", "*** Delete File: b.txt").replaceAll("\n", "\r\n"))).toEqual({ targets: ["a.txt", "b.txt"] });
		expect(readPatch(`\n  ${patch("*** Add File: a.txt", "+x")}  \n\n`)).toEqual({ targets: ["a.txt"] });
		// The last line ends the patch even indented inside an update hunk, as Codex's parser reads it apart.
		expect(readPatch("*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n   *** End Patch")).toEqual({ targets: ["a.ts"] });
		// Codex trims each line before a header outside an update hunk (U+0085 too, which Rust counts as blank space).
		expect(readPatch(patch("*** Add File: a.txt", "+x", "   *** Add File: b.txt", "+y", "\u0085*** Delete File: c.txt"))).toEqual({ targets: ["a.txt", "b.txt", "c.txt"] });
	});

	it("keeps a path as Codex keeps it: blank space after the marker's one space is part of the name, a trailing one is not", () => {
		expect(readPatch(patch("*** Add File:  spaced.txt  ", "+x"))).toEqual({ targets: [" spaced.txt"] });
		expect(readPatch(patch("*** Update File: ~/notes.md", "@@", "+x"))).toEqual({ targets: ["~/notes.md"] });
	});

	it("reads lines inside an update hunk as content when they are indented, as Codex does", () => {
		expect(readPatch(patch("*** Update File: a.ts", "@@", " *** Add File: /etc/x", "-old", "+new"))).toEqual({ targets: ["a.ts"] });
		// At column 0 such a line starts the next hunk.
		expect(readPatch(patch("*** Update File: a.ts", "@@", "-old", "+new", "*** Add File: b.ts", "+x"))).toEqual({ targets: ["a.ts", "b.ts"] });
		// A move anywhere in the hunk counts (Codex refuses the patch for one that does not follow the header).
		expect(readPatch(patch("*** Update File: a.ts", "@@", "-old", "+new", "*** Move to: /etc/x"))).toEqual({ targets: ["a.ts", "/etc/x"] });
	});

	it.each([
		["text that is no patch", "rm -rf /"],
		["a patch without its end", "*** Begin Patch\n*** Add File: a.txt\n+x"],
		["a patch without its start", "*** Add File: a.txt\n+x\n*** End Patch"],
		["a line that is no hunk header", patch("*** Copy File: a.txt")],
		["a header with no path", patch("*** Add File: ")],
		["an added file's line without its +", patch("*** Add File: a.txt", "x")],
		["more after the end", `${patch("*** Add File: a.txt", "+x")}\n*** Add File: b.txt`],
		["another environment's patch", patch("*** Environment ID: remote", "*** Add File: a.txt", "+x")],
		["an empty patch", ""],
	])("cannot read %s", (_what, text) => {
		expect(readPatch(text)).toMatchObject({ unreadable: expect.any(String) });
	});
});

describe("codexToolPath resolves as Codex joins a path onto its cwd", () => {
	it("keeps an absolute path, joins a relative one, and never expands ~", () => {
		expect(codexToolPath("/etc/x", "/w")).toBe("/etc/x");
		expect(codexToolPath("a/../b.txt", "/w/sub")).toBe("/w/sub/b.txt");
		expect(codexToolPath("../x", "/w/sub")).toBe("/w/x");
		expect(codexToolPath("~/x", "/w")).toBe("/w/~/x");
		expect(codexToolPath(" a.txt", "/w")).toBe("/w/ a.txt");
	});
});

describe("codexGuard on apply_patch: every target is a write", () => {
	it("refuses a patch that writes, moves, deletes or moves away a protected or credential file", () => {
		const { folder, home, options } = setup();
		const call = (text: string) => codexGuard("apply_patch", { command: text }, options);
		expect(call(patch(`*** Add File: ${join(folder, "secret.txt")}`, "+x"))).toMatch(PROTECTED);
		expect(call(patch("*** Update File: ../secret.txt", "@@", "-s", "+t"))).toMatch(PROTECTED);
		expect(call(patch("*** Delete File: ../secret.txt"))).toMatch(PROTECTED);
		expect(call(patch("*** Update File: notes.md", "*** Move to: ../secret.txt", "@@", "-a", "+b"))).toMatch(PROTECTED);
		expect(call(patch("*** Update File: ../secret.txt", "*** Move to: notes.md", "@@", "-s", "+t"))).toMatch(PROTECTED);
		expect(call(patch(`*** Add File: ${join(home, ".ssh", "authorized_keys")}`, "+x"))).toMatch(SENSITIVE);
		expect(call(patch("*** Add File: ~/.ssh/authorized_keys", "+x"))).toMatch(SENSITIVE);
		// A later hunk is judged as much as the first.
		expect(call(patch("*** Add File: ok.txt", "+x", "*** Delete File: ../.env"))).toMatch(SENSITIVE);
	});

	it("keeps writes inside the folder and its allowed roots, relative to the cwd as Codex resolves them, links followed", () => {
		const { root, folder, options } = setup();
		const call = (text: string) => codexGuard("apply_patch", { command: text }, options);
		expect(call(patch("*** Add File: a.ts", "+x"))).toBeUndefined();
		expect(call(patch("*** Add File: ../top.ts", "+x"))).toBeUndefined();
		expect(call(patch("*** Add File: ../../outside/x.ts", "+x"))).toMatch(OUTSIDE);
		expect(call(patch("*** Add File: /etc/orrery-test.txt", "+x"))).toMatch(OUTSIDE);
		expect(call(patch(`*** Add File: ${join(folder, "link", "x.ts")}`, "+x"))).toMatch(OUTSIDE);
		expect(call(patch("*** Update File: a.ts", "*** Move to: /tmp/elsewhere.ts", "@@", "-a", "+b"))).toMatch(OUTSIDE);
		expect(codexGuard("apply_patch", { command: patch(`*** Add File: ${join(root, "outside", "x.ts")}`, "+x") }, { ...options, allowedRoots: [join(root, "outside")] })).toBeUndefined();
	});

	it("keeps Orrery's config and program from every patch", () => {
		const { root, options } = setup();
		const call = (text: string) => codexGuard("apply_patch", { command: text }, { ...options, allowedRoots: [root] });
		expect(call(patch(`*** Update File: ${join(root, "data", "config.toml")}`, "@@", "+x"))).toMatch(/Orrery's config/);
		expect(call(patch(`*** Add File: ${join(root, "data", "app", "hook.js")}`, "+x"))).toMatch(/Orrery's installed program/);
	});

	it("never judges what a patch writes: a .gitignore may gain a .env line", () => {
		const { options } = setup();
		expect(codexGuard("apply_patch", { command: patch("*** Update File: ../.gitignore", "@@", " node_modules", "+.env", "+~/.ssh/") }, options)).toBeUndefined();
	});

	it("refuses a patch it cannot read, and one that is no text", () => {
		const { options } = setup();
		expect(codexGuard("apply_patch", { command: "*** Begin Patch\n*** Add File: a.txt\n+x" }, options)).toMatch(/could not read this patch/);
		expect(codexGuard("apply_patch", { command: patch("*** Environment ID: remote", "*** Add File: a.txt", "+x") }, options)).toMatch(/could not read this patch/);
		expect(codexGuard("apply_patch", {}, options)).toMatch(/could not read this patch/);
		expect(codexGuard("apply_patch", { command: 7 }, options)).toMatch(/could not read this patch/);
	});
});

describe("codexGuard places a patch's targets as Codex does", () => {
	it("joins a relative target onto the cwd and keeps an absolute one, '..' taken as written, as Codex's PathUri join does", () => {
		const { folder, options } = setup();
		const call = (path: string) => codexGuard("apply_patch", { command: patch(`*** Add File: ${path}`, "+x") }, options);
		// ws/link leads out of the folder, but "link/.." is the folder itself, written or joined.
		expect(call("../link/../top.ts")).toBeUndefined();
		expect(call(`${folder}/link/../top.ts`)).toBeUndefined();
		expect(call("../link/x.ts")).toMatch(OUTSIDE);
		expect(call("//etc///orrery-x")).toMatch(OUTSIDE);
	});

	it("takes '~' as a name, as Codex does: a folder named ~ in the cwd, never home", () => {
		const { root, options } = setup();
		// The cwd's "~" is a link to home's .ssh: Codex writes there.
		expect(codexGuard("apply_patch", { command: patch("*** Add File: ~/notes.txt", "+x") }, options)).toMatch(SENSITIVE);
		// Without one, ~/notes.txt is a file in the cwd's own new folder "~": inside the agent's folder.
		const plain = { ...options, cwd: join(root, "ws") };
		expect(codexGuard("apply_patch", { command: patch("*** Add File: ~/notes.txt", "+x") }, plain)).toBeUndefined();
		// Named as home's credentials it is still refused by name.
		expect(codexGuard("apply_patch", { command: patch("*** Add File: ~/.ssh/authorized_keys", "+x") }, plain)).toMatch(SENSITIVE);
	});

	it("matches a protected name in any letter case, as a case-insensitive file system opens it", () => {
		const { options } = setup();
		expect(codexGuard("apply_patch", { command: patch("*** Update File: ../SECRET.TXT", "@@", "+x") }, options)).toMatch(PROTECTED);
		expect(codexGuard("apply_patch", { command: patch("*** Add File: ../.ENV", "+x") }, options)).toMatch(SENSITIVE);
	});
});

describe("codexGuard on a shell command that runs apply_patch (Codex applies a heredoc itself, and puts the program on the shell's PATH)", () => {
	const heredoc = (...lines: string[]) => `apply_patch <<'EOF'\n${patch(...lines)}\nEOF`;
	const CANNOT = /runs apply_patch with a patch Orrery could not read/;

	it("judges every target of Codex's own heredoc form as a write", () => {
		const { options } = setup();
		const bash = (command: string) => codexGuard("Bash", { command }, options);
		expect(bash(heredoc("*** Add File: notes.md", "+hello"))).toBeUndefined();
		expect(bash(heredoc("*** Add File: /etc/orrery-x", "+x"))).toMatch(OUTSIDE);
		// Through a link out of the folder: no name in the text says so, the target's real place does.
		expect(bash(heredoc("*** Add File: ../link/x.ts", "+x"))).toMatch(OUTSIDE);
		expect(bash(heredoc("*** Update File: a.ts", "*** Move to: ../link/b.ts", "@@", "-a", "+b"))).toMatch(OUTSIDE);
		expect(bash(`applypatch <<EOF\n${patch("*** Delete File: ../link/old.ts")}\nEOF`)).toMatch(OUTSIDE);
		expect(bash(`  apply_patch << "PATCH"\n${patch("*** Add File: ../link/x.ts", "+x")}\nPATCH\n\n`)).toMatch(OUTSIDE);
		expect(bash(heredoc("*** Add File: notes.md", "+hello").replaceAll("\n", "\r\n"))).toBeUndefined();
		// The heredoc wrapper Codex reads leniently, inside the shell's own heredoc.
		expect(bash(`apply_patch <<'X'\n<<'EOF'\n${patch("*** Add File: ../link/x.ts", "+x")}\nEOF\nX`)).toMatch(OUTSIDE);
	});

	it("reads the patch as one single-quoted argument, and judges it the same", () => {
		const { options } = setup();
		const bash = (command: string) => codexGuard("Bash", { command }, options);
		expect(bash(`apply_patch '${patch("*** Add File: notes.md", "+hello")}'`)).toBeUndefined();
		expect(bash(`apply_patch '${patch("*** Add File: ../link/x.ts", "+x")}'`)).toMatch(OUTSIDE);
	});

	it("judges relative targets from the cwd and from the folder a cd && before it goes to, as Codex and the shell read it", () => {
		const { home, options } = setup();
		const bash = (command: string) => codexGuard("Bash", { command }, options);
		expect(bash(`cd ../link && ${heredoc("*** Add File: x.ts", "+x")}`)).toMatch(OUTSIDE);
		expect(bash(`cd .. && ${heredoc("*** Add File: top.ts", "+x")}`)).toBeUndefined();
		expect(bash(`cd '../link' && ${heredoc("*** Add File: x.ts", "+x")}`)).toMatch(OUTSIDE);
		expect(bash(`cd "../link" && apply_patch '${patch("*** Add File: x.ts", "+x")}'`)).toMatch(OUTSIDE);
		// "~" is home to a shell, and a folder named "~" to Codex: both are judged.
		expect(bash(`cd ~ && ${heredoc("*** Add File: .bashrc", "+x")}`)).toMatch(SENSITIVE);
		expect(bash(`cd ${join(home, ".ssh")} && ${heredoc("*** Add File: config", "+x")}`)).toMatch(SENSITIVE);
	});

	it.each([
		["a patch from a file", "apply_patch < fix.patch"],
		["a patch from a pipe", "cat fix.patch | apply_patch"],
		["a patch from a substitution", 'apply_patch "$(cat fix.patch)"'],
		["a patch as a double-quoted argument, which a shell changes", `apply_patch "${patch("*** Add File: x.md", "+a")}"`],
		["a patch as a $'…' argument", "apply_patch $'*** Begin Patch\\n*** Add File: ../link/x\\n+x\\n*** End Patch'"],
		["the program by a path", "/tmp/bin/apply_patch < fix.patch"],
		["the program's name split by quotes", "appl''y_patch < fix.patch"],
		["the program's name by an escape", "$'\\x61pply_patch' < fix.patch"],
		["the program's name in a brace group", "{apply_patch,x} < fix.patch"],
		["the program's name in capitals, not a form", "APPLY_PATCH < fix.patch"],
		["a second command after the heredoc", `${heredoc("*** Add File: a.md", "+a")}\napply_patch < evil.patch`],
		["a heredoc whose end word comes early", `apply_patch <<'EOF'\n${patch("*** Add File: a.md", "+a")}\nEOF\nrm -f x\nEOF`],
		["two heredocs", `${heredoc("*** Add File: a.md", "+a")} && ${heredoc("*** Add File: b.md", "+b")}`],
		["another command before it", `echo hi; ${heredoc("*** Add File: a.md", "+a")}`],
		["a bare cd before it", `cd && ${heredoc("*** Add File: a.md", "+a")}`],
		["a cd to a variable", `cd "$DIR" && ${heredoc("*** Add File: x.md", "+a")}`],
		["a cd back", `cd - && ${heredoc("*** Add File: x.md", "+a")}`],
		["a cd to a glob", `cd ../li* && ${heredoc("*** Add File: x.md", "+a")}`],
		["a patch without its end", "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: a.md\n+a\nEOF"],
		["a path its shell would expand", `apply_patch <<EOF\n${patch("*** Add File: $DIR/x.md", "+a")}\nEOF`],
		["a command that only names the program", "grep -rn apply_patch src"],
	])("refuses %s", (_what, command) => {
		const { options } = setup();
		expect(codexGuard("Bash", { command }, options)).toMatch(CANNOT);
	});

	it("leaves a command that holds the name only inside a longer word, and judges no content of a patch", () => {
		const { options } = setup();
		const bash = (command: string) => codexGuard("Bash", { command }, options);
		expect(bash("rg -n apply_patch_spec src && cat src/apply_patch.rs")).toBeUndefined();
		expect(bash(heredoc("*** Update File: deploy.sh", "@@", " cd $DIR", "-make", "+make all"))).toBeUndefined();
		expect(bash(heredoc("*** Add File: notes.md", "+*** Begin Patch", "+*** End Patch"))).toBeUndefined();
		// In a quoted heredoc the shell changes nothing: a $ in a path is a name.
		expect(bash(heredoc("*** Add File: price$.md", "+a"))).toBeUndefined();
	});
});

describe("codexGuard on Codex's other tools", () => {
	it("judges view_image's path as a read, opened where Codex opens it", () => {
		const { folder, options } = setup();
		expect(codexGuard("view_image", { path: "~/.ssh/id_ed25519" }, options)).toMatch(SENSITIVE);
		expect(codexGuard("view_image", { path: join(folder, "key.png") }, options)).toMatch(SENSITIVE);
		expect(codexGuard("view_image", { path: "../secret.txt" }, options)).toMatch(PROTECTED);
		// "~/config" is the cwd's folder named "~", a link to home's .ssh: Codex reads home's .ssh/config.
		expect(codexGuard("view_image", { path: "~/config" }, options)).toMatch(SENSITIVE);
		expect(codexGuard("view_image", { path: "shot.png", detail: "high" }, options)).toBeUndefined();
		expect(codexGuard("view_image", { path: "/tmp/elsewhere/shot.png" }, options)).toBeUndefined();
	});

	it("judges a shell command by the shell-text rules, Orrery's hook plumbing included", () => {
		const { options } = setup();
		expect(codexGuard("Bash", { command: "cat ~/.ssh/config" }, options)).toMatch(SENSITIVE);
		expect(codexGuard("Bash", { command: "cat secret.txt" }, options)).toMatch(PROTECTED);
		expect(codexGuard("Bash", { command: "echo '{}' | orrery codex-hook user-prompt-submit" }, options)).toMatch(/hook plumbing/);
		expect(codexGuard("Bash", { command: "npm test && git status" }, options)).toBeUndefined();
	});

	it("judges MCP and unknown tools as Claude Code's guard does: every path and file: URI they name", () => {
		const { home, options } = setup();
		expect(codexGuard("mcp__files__read_file", { path: join(home, ".ssh", "config") }, options)).toMatch(SENSITIVE);
		expect(codexGuard("mcp__files__write_file", { path: "/etc/x", content: "y" }, options)).toMatch(OUTSIDE);
		expect(codexGuard("read_mcp_resource", { server: "files", uri: `file://${join(home, ".ssh", "config")}` }, options)).toMatch(SENSITIVE);
		expect(codexGuard("mcp__shell__run", { cmd: "cat secret.txt" }, options)).toMatch(PROTECTED);
		expect(codexGuard("mcp__orrery__zoom", { id: "7" }, options)).toBeUndefined();
		expect(codexGuard("update_plan", { plan: [{ step: "x", status: "pending" }] }, options)).toBeUndefined();
	});

	it("lets spawn_agent through, but judges any file its input hands the new agent (an image, a skill) as a read", () => {
		const { home, options } = setup();
		expect(codexGuard("spawn_agent", { message: "Review src/ and report", agent_type: "worker" }, options)).toBeUndefined();
		expect(codexGuard("spawn_agent", { items: [{ type: "local_image", path: join(home, ".ssh", "id_ed25519") }] }, options)).toMatch(SENSITIVE);
		expect(codexGuard("spawn_agent", { items: [{ type: "skill", name: "x", path: "../secret.txt" }] }, options)).toMatch(PROTECTED);
	});

	it("refuses an input it cannot read", () => {
		const { options } = setup();
		expect(codexGuard("Bash", "cat x", options)).toMatch(/could not read this call/);
		expect(codexGuard("mcp__x__y", null, options)).toMatch(/could not read this call/);
		expect(codexGuard("mcp__x__y", ["a"], options)).toMatch(/could not read this call/);
	});
});

describe("every tool and input shape Codex 0.162.1 hands PreToolUse, and shells and patches under any other name", () => {
	const heredoc = (target: string) => `apply_patch <<'EOF'\n${patch(`*** Add File: ${target}`, "+x")}\nEOF`;
	/**
	 * From codex-rs at rust-v0.162.1: exec_command (as Bash, `{command}`), apply_patch (`{command}`: the patch), MCP tools
	 * (mcp__<server>__<tool>, their arguments), and every other function tool by its name with its JSON arguments
	 * (core/src/tools/registry.rs). write_stdin and code mode's exec and wait cells give the hook nothing.
	 */
	const codexTools: [string, Record<string, unknown>][] = [
		["Bash", { command: "git status" }],
		["apply_patch", { command: patch("*** Add File: a.md", "+a") }],
		["mcp__orrery__zoom", { id: "7" }],
		["view_image", { path: "shot.png" }],
		["spawn_agent", { message: "Review src/", agent_type: "worker", fork_context: false }],
		["spawn_agent", { message: "Review src/", task_name: "review", fork_turns: "none" }],
		["send_input", { id: "a1", message: "go on", interrupt: false }],
		["send_message", { target: "a1", message: "go on" }],
		["followup_task", { target: "a1", message: "and the tests" }],
		["wait_agent", { ids: ["a1"], timeout_ms: 1000 }],
		["close_agent", { id: "a1" }],
		["resume_agent", { id: "a1" }],
		["interrupt_agent", { target: "a1" }],
		["list_agents", {}],
		["update_plan", { explanation: "x", plan: [{ step: "a", status: "pending" }] }],
		["request_user_input", { questions: [{ id: "q", header: "Pick", question: "Which?", options: [{ label: "A", description: "a" }] }] }],
		["request_permissions", { reason: "build", permissions: { network: { enabled: true } } }],
		["list_mcp_resources", { server: "orrery" }],
		["list_mcp_resource_templates", { server: "orrery" }],
		["read_mcp_resource", { server: "orrery", uri: "orrery://view" }],
		["tool_search", { query: "zoom" }],
		["curr_time", {}],
		["get_context_remaining", {}],
		["sleep", { duration_ms: 10 }],
		["new_context", {}],
		["wait_for_environment", { environment_id: "local" }],
		["send_message_to_user_async", { message: "working" }],
		["request_plugin_install", { plugin: "x" }],
		["list_available_plugins_to_install", {}],
		["test_sync_tool", {}],
	];

	it.each(codexTools)("lets %s through with an ordinary input", (tool, input) => {
		const { options } = setup();
		expect(codexGuard(tool, input, options)).toBeUndefined();
	});

	it.each([
		["Bash", { command: "cat ~/.ssh/id_ed25519" }, SENSITIVE],
		["apply_patch", { command: patch("*** Add File: /etc/x", "+x") }, OUTSIDE],
		["view_image", { path: "../secret.txt" }, PROTECTED],
		["spawn_agent", { message: "look", items: [{ type: "local_image", path: "../secret.txt" }] }, PROTECTED],
		["send_input", { id: "a1", items: [{ type: "skill", name: "s", path: "../secret.txt" }] }, PROTECTED],
		["request_permissions", { reason: "x", permissions: { file_system: { write: ["/home/u/.ssh"] } } }, SENSITIVE],
		["read_mcp_resource", { server: "files", uri: "file:///home/u/.ssh/config" }, SENSITIVE],
		["mcp__files__write_file", { path: "/etc/x", content: "y" }, OUTSIDE],
	] as const)("refuses %s with a harmful input", (tool, input, verdict) => {
		const { options } = setup();
		expect(codexGuard(tool, input, options)).toMatch(verdict);
	});

	it.each([
		// Shells under other names: whatever the tool is called, a command line is shell text.
		["an MCP exec_command", "mcp__box__exec_command", { cmd: "cat secret.txt" }, PROTECTED],
		["an MCP shell with an argv list", "mcp__box__shell", { command: ["bash", "-lc", "cat ~/.ssh/config"] }, SENSITIVE],
		["a container.exec", "container.exec", { argv: ["cat", "secret.txt"] }, PROTECTED],
		["a local_shell", "local_shell", { command: ["sh", "-c", "orrery codex-hook stop"], workdir: "." }, /hook plumbing/],
		["a tool's script", "dynamic_runner", { script: "cat ../.env" }, SENSITIVE],
		["a freeform tool's input", "mcp__box__run", { input: "cat secret.txt" }, PROTECTED],
		["a tool's code", "mcp__node__eval", { code: "require('fs').readFileSync('secret.txt')" }, PROTECTED],
		["a command nested deep", "mcp__box__batch", { steps: [{ run: { cmd: "cat ~/.ssh/config" } }] }, SENSITIVE],
		// Patches under other names: whatever the tool is called, a patch's targets are writes.
		["an MCP apply_patch's input", "mcp__box__apply_patch", { input: patch("*** Add File: /etc/x", "+x") }, OUTSIDE],
		["a patch under any key", "apply_patch_v2", { patch: patch("*** Update File: notes.md", "*** Move to: ../link/x.md", "@@", "-a", "+b") }, OUTSIDE],
		["a patch as an argv list", "local_shell", { command: ["apply_patch", patch("*** Delete File: ../link/x.md")] }, OUTSIDE],
		["a shell's heredoc patch in an argv list", "local_shell", { command: ["bash", "-lc", heredoc("../link/x.md")] }, OUTSIDE],
		["an MCP shell's heredoc patch", "mcp__box__exec_command", { cmd: heredoc("/etc/x") }, OUTSIDE],
		["an MCP shell running apply_patch from a file", "mcp__box__exec_command", { cmd: "apply_patch < fix.patch" }, /could not read/],
		["a patch that does not read", "mcp__box__apply", { diff: "*** Begin Patch\n*** Add File: a.md\n+a" }, /could not read this patch/],
		["hunk headers with no patch around them", "mcp__box__apply", { diff: "*** Add File: /etc/x\n+x" }, /could not read this patch/],
	] as const)("refuses %s", (_what, tool, input, verdict) => {
		const { options } = setup();
		expect(codexGuard(tool, input, options)).toMatch(verdict);
	});

	it("shares the call's time among all its checks: with none left, a call that names anything is refused", () => {
		const { options } = setup();
		const spent = { ...options, judgeMs: 0 };
		expect(codexGuard("apply_patch", { command: patch("*** Add File: a.md", "+a") }, spent)).toMatch(/in time/);
		expect(codexGuard("mcp__box__run", { input: "ls", diff: patch("*** Add File: a.md", "+a") }, spent)).toMatch(/in time/);
		expect(codexGuard("Bash", { command: "ls" }, spent)).toMatch(/in time/);
	});

	it("still lets the same shapes through when what they carry is ordinary", () => {
		const { options } = setup();
		expect(codexGuard("mcp__box__exec_command", { cmd: "npm test" }, options)).toBeUndefined();
		expect(codexGuard("local_shell", { command: ["bash", "-lc", heredoc("notes.md")] }, options)).toBeUndefined();
		expect(codexGuard("local_shell", { command: ["apply_patch", patch("*** Add File: notes.md", "+x")] }, options)).toBeUndefined();
		expect(codexGuard("mcp__box__apply_patch", { input: patch("*** Add File: notes.md", "+x") }, options)).toBeUndefined();
		expect(codexGuard("mcp__node__eval", { code: "console.log(1 + 1)" }, options)).toBeUndefined();
		// A patch inside the apply_patch tool's own content is content, not another patch.
		expect(codexGuard("apply_patch", { command: patch("*** Add File: guard.test.ts", "+const p = `", "+*** Begin Patch", "+*** Add File: /etc/x", "+*** End Patch`;") }, options)).toBeUndefined();
	});
});

describe("codexRefusal", () => {
	it("says the guard refused, and leaves the final period to Codex", () => {
		expect(codexRefusal("This command touches sensitive files (keys, credentials or Orrery's private data).")).toBe(
			"Orrery guard: This command touches sensitive files (keys, credentials or Orrery's private data)",
		);
		expect(codexRefusal("x is outside this agent's folder and allowed roots...")).toBe("Orrery guard: x is outside this agent's folder and allowed roots");
	});
});

describe("the PreToolUse hook (runCodexGuard)", () => {
	/** Agent Test, and a Codex (pid 4343) that holds its token. */
	function agentWorld() {
		const t = testAgent();
		const token = newToken();
		mkdirSync(join(t.folder, "sub"));
		writeFileSync(join(t.folder, "protected.txt"), "x");
		const ctx = (extra: Partial<CodexGuardContext> = {}): CodexGuardContext => ({
			config: t.config,
			env: { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token },
			codexPid: 4343,
			alive: (pid) => pid === 4343,
			...extra,
		});
		// The token's claim, as the memory server or SessionStart makes it for this Codex.
		mkdirSync(join(t.agent.dir, "claims"), { recursive: true, mode: 0o700 });
		writeFileSync(join(t.agent.dir, "claims", token), "4343\n");
		return { t, ctx };
	}
	const call = (tool_name: string, tool_input: unknown, cwd: string, extra: object = {}) =>
		JSON.stringify({ session_id: "s1", turn_id: "t1", cwd, hook_event_name: "PreToolUse", model: "m", permission_mode: "default", tool_name, tool_input, tool_use_id: "c1", ...extra });

	it("judges the agent's calls by its folder, subagents' too, and lets the rest through", () => {
		const { t, ctx } = agentWorld();
		const cwd = join(t.folder, "sub");
		expect(runCodexGuard(call("apply_patch", { command: patch("*** Add File: ../top.ts", "+x") }, cwd), ctx())).toBeUndefined();
		expect(runCodexGuard(call("apply_patch", { command: patch("*** Add File: /etc/x", "+x") }, cwd), ctx())).toMatch(/^Orrery guard: \/etc\/x is outside this agent's folder and allowed roots$/);
		expect(runCodexGuard(call("Bash", { command: "cat ~/.ssh/id_rsa" }, cwd, { agent_id: "a1", agent_type: "worker" }), ctx())).toBe(
			"Orrery guard: This command touches sensitive files (keys, credentials or Orrery's private data)",
		);
		expect(runCodexGuard(call("Bash", { command: "ls" }, cwd), ctx())).toBeUndefined();
	});

	it("judges each call a code cell makes, as Codex hands each to the hook on its own", () => {
		const { t, ctx } = agentWorld();
		const protect = { ...t.config, guard: { protect: ["protected.txt"] } };
		// The three calls of the live test's code cell (research note, Live test 5), each its own PreToolUse.
		expect(runCodexGuard(call("mcp__orrery__zoom", { id: "7" }, t.folder), ctx({ config: protect }))).toBeUndefined();
		expect(runCodexGuard(call("Bash", { command: "cat protected.txt" }, t.folder), ctx({ config: protect }))).toMatch(/^Orrery guard: This command touches protected\.txt, protected by \[guard\] protect in Orrery's config$/);
		expect(runCodexGuard(call("apply_patch", { command: "*** Begin Patch\n*** Update File: protected.txt\n@@\n+edited\n*** End Patch" }, t.folder), ctx({ config: protect }))).toMatch(/protected by \[guard\] protect/);
	});

	it("judges a session that is not the agent's by no agent's rules: its own folder, every agent's view kept from it", () => {
		const { t, ctx } = agentWorld();
		const cwd = join(t.folder, "sub");
		const other = ctx({ env: { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: newToken() } });
		// The agent may write its whole folder; a session whose token is no one's only where it runs.
		expect(runCodexGuard(call("apply_patch", { command: patch("*** Add File: ../top.ts", "+x") }, cwd), ctx())).toBeUndefined();
		expect(runCodexGuard(call("apply_patch", { command: patch("*** Add File: ../top.ts", "+x") }, cwd), other)).toMatch(/outside this agent's folder/);
		expect(runCodexGuard(call("apply_patch", { command: patch("*** Add File: x.ts", "+x") }, cwd), other)).toBeUndefined();
		// The agent reads its own memory view; to any other session it is another agent's.
		const view = { path: join(t.folder, ".orrery", "view.md") };
		expect(runCodexGuard(call("view_image", view, cwd), ctx())).toBeUndefined();
		expect(runCodexGuard(call("view_image", view, cwd), other)).toMatch(/another agent's memory view|sensitive/);
		expect(runCodexGuard(call("apply_patch", { command: patch("*** Add File: ../top.ts", "+x") }, cwd), ctx({ env: {} }))).toMatch(/outside this agent's folder/);
	});

	it("refuses what it cannot judge: input over 1 MB or unread, input that is no JSON object, a call with no cwd or tool, a failure", () => {
		const { t, ctx } = agentWorld();
		expect(runCodexGuard(undefined, ctx())).toBe("Orrery guard: this call's input is too large for Orrery's guard to check (over 1 MB); nothing was run");
		expect(runCodexGuard("not json", ctx())).toBe("Orrery guard: Orrery could not read this call; nothing was run");
		expect(runCodexGuard("[1]", ctx())).toBe("Orrery guard: Orrery could not read this call; nothing was run");
		expect(runCodexGuard(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), ctx())).toBe("Orrery guard: Orrery could not read this call; nothing was run");
		expect(runCodexGuard(JSON.stringify({ cwd: t.folder, tool_input: { command: "ls" } }), ctx())).toBe("Orrery guard: Orrery could not read this call; nothing was run");
		const broken = Object.defineProperty({ ...ctx() }, "config", {
			get(): never {
				throw new Error("disk gone");
			},
		});
		expect(runCodexGuard(call("Bash", { command: "ls" }, t.folder), broken)).toBe("Orrery guard: this call could not be checked (disk gone); nothing was run");
	});

	it("refuses, never skips, what it has not judged by its deadline, and answers by then on the slowest input it reads", () => {
		const { t, ctx } = agentWorld();
		const OUT_OF_TIME = "Orrery guard: this call names more than the guard can check in time; nothing was run";
		expect(runCodexGuard(call("Bash", { command: "ls" }, t.folder), ctx({ deadline: performance.now() - 1 }))).toBe(OUT_OF_TIME);
		// The slowest command line to read every way: 64 KB of brace groups at the readings' cap, in short words.
		const group = `{${Array.from({ length: 63 }, () => "a").join(",")},b} `;
		const slow = group.repeat(Math.floor((64 * 1024 - 8) / group.length));
		const steps = Array.from({ length: 15 }, () => ({ cmd: slow }));
		const started = performance.now();
		expect(runCodexGuard(call("mcp__box__batch", { steps }, t.folder), ctx({ deadline: started + 300 }))).toMatch(/^Orrery guard: this call (has more command lines|names more) than the guard can check in time; nothing was run$/);
		// It stopped at the deadline, give or take one read.
		expect(performance.now() - started).toBeLessThan(1500);
		// A command line nested deeper than Claude Code's keys, over 64 KB, is refused unread.
		expect(runCodexGuard(call("mcp__box__run", { command: { line: "x".repeat(70 * 1024) } }, t.folder), ctx())).toBe(
			"Orrery guard: a command line is too long to check (over 64 KB); nothing was run",
		);
	});
});
