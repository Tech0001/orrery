import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeGuard, claudeProjectFolder, claudeStateRoots } from "../../src/claude/guard.ts";
import { type HookContext, type HookInput, preToolUse, runHook } from "../../src/claude/hooks.ts";
import { ownFolder } from "../../src/lane/private-file.ts";
import { cleanupDirs, hookCli, testLane } from "./support.ts";

let dir: string | undefined;
afterEach(() => {
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
	cleanupDirs();
});

/** A workspace with a subfolder (the cwd), a fake home with credentials, and links out of the workspace. */
function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "orrery-claude-guard-")));
	dir = root;
	const workspace = join(root, "ws");
	const home = join(root, "home");
	mkdirSync(join(workspace, "sub"), { recursive: true });
	mkdirSync(join(home, ".ssh"), { recursive: true });
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	mkdirSync(join(root, "outside"));
	writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
	writeFileSync(join(home, ".pi", "agent", "models.json"), "{}");
	symlinkSync(join(home, ".pi", "agent", "models.json"), join(workspace, "settings.json"));
	symlinkSync(join(root, "outside"), join(workspace, "link"));
	return { root, workspace, home, options: { workspace, allowedRoots: [] as string[], cwd: join(workspace, "sub"), home } };
}

describe("claudeGuard", () => {
	it("denies credential files through every tool that names a file, by spelling, by ~ and through symlinks", () => {
		const { workspace, home, options } = setup();
		expect(claudeGuard("Read", { file_path: "~/.ssh/id_ed25519" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Read", { file_path: join(home, ".ssh", "id_ed25519") }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Read", { file_path: join(workspace, "settings.json") }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Edit", { file_path: join(home, ".ssh", "config"), old_string: "a", new_string: "b" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("MultiEdit", { file_path: "~/.aws/credentials", edits: [] }, options)).toMatch(/sensitive/);
		expect(claudeGuard("NotebookEdit", { notebook_path: join(home, ".netrc"), new_source: "x" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Read", { file_path: join(workspace, "notes.md") }, options)).toBeUndefined();
	});

	it("keeps writes inside the workspace and its allowed roots, links followed", () => {
		const { workspace, options } = setup();
		expect(claudeGuard("Write", { file_path: "/etc/orrery-test.txt", content: "x" }, options)).toMatch(/outside this lane's workspace/);
		expect(claudeGuard("Write", { file_path: join(workspace, "link", "x.txt"), content: "x" }, options)).toMatch(/outside this lane's workspace/);
		expect(claudeGuard("Write", { file_path: join(workspace, "sub", "a.ts"), content: "x" }, options)).toBeUndefined();
		expect(claudeGuard("Edit", { file_path: "../top.ts", old_string: "a", new_string: "b" }, options)).toBeUndefined();
	});

	it("judges searches by their root and file-name arguments, not by the text searched for", () => {
		const { home, options } = setup();
		expect(claudeGuard("Grep", { pattern: "auth.json" }, options)).toBeUndefined();
		expect(claudeGuard("Grep", { pattern: "x", glob: "**/auth.json" }, options)).toMatch(/names sensitive files/);
		expect(claudeGuard("Grep", { pattern: "x", path: home }, options)).toMatch(/narrower folder/);
		expect(claudeGuard("Glob", { pattern: "**/.ssh/*" }, options)).toMatch(/names sensitive files/);
		expect(claudeGuard("Glob", { pattern: "*.md", path: "../.." }, options)).toMatch(/narrower folder/);
		expect(claudeGuard("Glob", { pattern: "*", path: "/proc" }, options)).toMatch(/narrower folder/);
		expect(claudeGuard("Glob", { pattern: "**/*.ts" }, options)).toBeUndefined();
	});

	it("judges Bash by its command, any other tool by the paths it names, and lets the rest through", () => {
		const { options } = setup();
		expect(claudeGuard("Bash", { command: "cat ~/.ssh/id_ed25519" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Bash", { command: "cat /proc/self/environ" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Bash", { command: "ls -la" }, options)).toBeUndefined();
		expect(claudeGuard("mcp__files__read", { path: "~/.ssh/config" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("WebFetch", { url: "https://example.com/.ssh/" }, options)).toBeUndefined();
		expect(claudeGuard("Agent", { prompt: "read ~/.ssh and report", subagent_type: "general-purpose" }, options)).toBeUndefined();
		expect(claudeGuard("ToolSearch", { query: "select:Read" }, options)).toBeUndefined();
	});
});

describe("claudeGuard resolves a path as Claude Code does, not as pi does", () => {
	// Claude Code's expandPath trims, expands "~" and "~/", and resolves against the cwd. It keeps "@", "file://" and
	// unicode spaces, so a workspace link spelled that way is where the file lands.
	it("follows a link named @, file: or with a no-break space, where pi's spelling would point elsewhere", () => {
		const { root, workspace, home, options } = setup();
		const sub = join(workspace, "sub");
		symlinkSync(join(root, "outside"), join(sub, "@out"));
		symlinkSync(join(home, ".ssh"), join(sub, "file:"));
		mkdirSync(join(sub, "a b"));
		symlinkSync(join(root, "outside"), join(sub, "a b"));
		expect(claudeGuard("Write", { file_path: "@out/x.txt", content: "x" }, options)).toMatch(/outside this lane's workspace/);
		expect(claudeGuard("Read", { file_path: "file:///config" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Write", { file_path: "a b/x.txt", content: "x" }, options)).toMatch(/outside this lane's workspace/);
		expect(claudeGuard("Write", { file_path: "a b/x.txt", content: "x" }, options)).toBeUndefined();
	});

	it("trims the path, as Claude Code does before it opens the file", () => {
		const { root, options } = setup();
		const secret = join(root, "vault", "token.txt");
		const guarded = { ...options, credentials: [secret] };
		expect(claudeGuard("Read", { file_path: ` ${secret}\n` }, guarded)).toMatch(/sensitive/);
		expect(claudeGuard("Write", { file_path: " /etc/orrery-test.txt", content: "x" }, guarded)).toMatch(/outside this lane's workspace/);
	});

	it("searches the folder an absolute Glob pattern names, not the cwd", () => {
		const { workspace, home, options } = setup();
		expect(claudeGuard("Glob", { pattern: `${home}/**/*.json` }, options)).toMatch(/narrower folder/);
		expect(claudeGuard("Glob", { pattern: `${home}/notes.txt` }, options)).toMatch(/narrower folder/);
		expect(claudeGuard("Glob", { pattern: "/proc/*/status" }, options)).toMatch(/narrower folder/);
		expect(claudeGuard("Glob", { pattern: `${workspace}/**/*.ts`, path: home }, options)).toBeUndefined();
	});
});

describe("claudeGuard on Claude Code's own login and on tools the brief does not name", () => {
	it("denies Claude Code's login files by any spelling, through a link, in a backup, and from Bash", () => {
		const { workspace, home, options } = setup();
		mkdirSync(join(home, ".claude", "backups"), { recursive: true });
		writeFileSync(join(home, ".claude.json"), "{}");
		writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
		symlinkSync(join(home, ".claude.json"), join(workspace, "state.txt"));
		expect(claudeGuard("Read", { file_path: "~/.claude.json" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Read", { file_path: join(home, ".claude", ".credentials.json") }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Read", { file_path: "../state.txt" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Read", { file_path: join(home, ".claude", "backups", ".claude.json.backup.1759800000000") }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Bash", { command: "jq .oauthAccount ~/.claude.json" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Bash", { command: "cat ~/.claude/.credentials.json" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Grep", { pattern: "token", path: join(home, ".claude") }, options)).toMatch(/narrower folder/);
		expect(claudeGuard("Glob", { pattern: "**/.claude.json*", path: workspace }, options)).toMatch(/names sensitive files/);
		expect(claudeGuard("Read", { file_path: join(workspace, "claude.json") }, options)).toBeUndefined();
	});

	it("judges any tool's shell command as Bash, and every path a tool names, however deep", () => {
		const { workspace, home, options } = setup();
		expect(claudeGuard("Monitor", { command: "tail -f ~/.ssh/id_ed25519", description: "x", timeout_ms: 1000 }, options)).toMatch(/sensitive/);
		expect(claudeGuard("PowerShell", { command: "type ~/.aws/credentials" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("LSP", { operation: "hover", filePath: "~/.ssh/config", line: 1, character: 1 }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Upload", { file_paths: [join(workspace, "a.png"), "~/.ssh/id_ed25519"] }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Publish", { files: { "a.css": { from: "~/.aws/credentials" } } }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__x__fetch", { out_dir: "~/.ssh" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("ReadMcpResourceTool", { server: "fs", uri: `file://${home}/.ssh/id_ed25519` }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__fs__read", { uri: `FILE://${home}/.pi/agent/models.json` }, options)).toMatch(/sensitive/);
		// What is not a file: an HTTP path, a prompt, a description.
		expect(claudeGuard("mcp__example__request", { method: "GET", path: "/api/v1/workspaces/" }, options)).toBeUndefined();
		expect(claudeGuard("Monitor", { command: "tail -f build.log", description: "watch ~/.ssh", timeout_ms: 1000 }, options)).toBeUndefined();
		expect(claudeGuard("Skill", { skill: "review", args: "check ~/.ssh/config handling" }, options)).toBeUndefined();
	});
});

describe("claudeGuard lets a lane write Claude Code's own state (ruling C10)", () => {
	function stateSetup() {
		const s = setup();
		const tmp = join(s.root, "tmp");
		mkdirSync(join(s.home, ".claude", "plans"), { recursive: true });
		const uid = process.getuid?.() ?? 0;
		mkdirSync(join(tmp, `claude-${uid}`), { recursive: true });
		const project = join(s.home, ".claude", "projects", claudeProjectFolder(s.workspace) as string);
		const options = { ...s.options, allowedRoots: claudeStateRoots(s.workspace, s.home, { TMPDIR: tmp }) };
		return { ...s, tmp, uid, project, options };
	}

	it("names this project's folder as Claude Code does: every character but a letter or digit becomes -", () => {
		expect(claudeProjectFolder("/home/alex/Documents/GitHub/orrery")).toBe("-home-alex-Documents-GitHub-orrery");
		expect(claudeProjectFolder("/home/alex/Documents/GitHub/orrery/.worktrees/claude-code-plugin")).toBe("-home-alex-Documents-GitHub-orrery--worktrees-claude-code-plugin");
		expect(claudeProjectFolder("/srv/agent_Elm/my lane")).toBe("-srv-agent-Elm-my-lane");
		// Over 200 characters Claude Code adds a hash orrery does not compute: no folder, so no write there.
		expect(claudeProjectFolder(`/${"x".repeat(200)}`)).toBeUndefined();
	});

	it("names the project's folder, ~/.claude/plans and the session scratch root, under TMPDIR or /tmp", () => {
		const { root } = setup();
		const uid = process.getuid?.() ?? 0;
		const tmp = join(root, "tmp");
		mkdirSync(join(tmp, `claude-${uid}`), { recursive: true });
		expect(claudeStateRoots("/w/lane", "/h", { TMPDIR: `${tmp}/` })).toEqual(["/h/.claude/projects/-w-lane", "/h/.claude/plans", join(tmp, `claude-${uid}`)]);
		// Without a usable TMPDIR, /tmp: trusted only when /tmp/claude-<uid> is already a folder of ours.
		const slashTmp = existsSync(`/tmp/claude-${uid}`) && ownFolder(`/tmp/claude-${uid}`) === true ? [`/tmp/claude-${uid}`] : [];
		expect(claudeStateRoots("/w/lane", "/h", {})).toEqual(["/h/.claude/projects/-w-lane", "/h/.claude/plans", ...slashTmp]);
		expect(claudeStateRoots("/w/lane", "/h", { TMPDIR: "relative" })).toEqual(["/h/.claude/projects/-w-lane", "/h/.claude/plans", ...slashTmp]);
	});

	it("allows a write under each, and only there", () => {
		const { home, tmp, uid, project, options } = stateSetup();
		const write = (file_path: string) => claudeGuard("Write", { file_path, content: "x" }, options);
		expect(write(join(project, "memory", "MEMORY.md"))).toBeUndefined();
		expect(write(join(home, ".claude", "plans", "quiet-otter.md"))).toBeUndefined();
		expect(write(join(tmp, `claude-${uid}`, "-w-lane", "session", "scratchpad", "notes.txt"))).toBeUndefined();
		expect(claudeGuard("Edit", { file_path: "~/.claude/plans/quiet-otter.md", old_string: "a", new_string: "b" }, options)).toBeUndefined();
		// Elsewhere in ~/.claude, another project's memory, another user's scratch root, and a way out by "..".
		expect(write(join(home, ".claude", "settings.json"))).toMatch(/outside this lane's workspace/);
		expect(write(join(home, ".claude", "projects", "-home-alex-elsewhere", "memory", "MEMORY.md"))).toMatch(/outside this lane's workspace/);
		expect(write(join(tmp, `claude-${uid + 1}`, "x.txt"))).toMatch(/outside this lane's workspace/);
		expect(write(`${project}/../../settings.json`)).toMatch(/outside this lane's workspace/);
		expect(write(join(home, ".bashrc"))).toMatch(/outside this lane's workspace/);
	});

	it("follows links out of those folders, and still denies every credential", () => {
		const { root, home, project, options } = stateSetup();
		symlinkSync(join(root, "outside"), join(home, ".claude", "plans", "out"));
		expect(claudeGuard("Write", { file_path: join(home, ".claude", "plans", "out", "x.md"), content: "x" }, options)).toMatch(/outside this lane's workspace/);
		expect(claudeGuard("Read", { file_path: join(home, ".claude", ".credentials.json") }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Read", { file_path: join(home, ".claude.json") }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Write", { file_path: join(project, "memory", ".credentials.json"), content: "x" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Read", { file_path: "~/.ssh/id_ed25519" }, options)).toMatch(/sensitive/);
	});
});

describe("claudeGuard's state roots are real folders of this user's (fix round 1)", () => {
	it("drops a root that is a symlink: a scratch root planted as a link to home widens nothing", () => {
		const { root, home, workspace, options } = setup();
		const tmp = join(root, "tmp");
		mkdirSync(tmp);
		mkdirSync(join(home, ".claude", "plans"), { recursive: true });
		const uid = process.getuid?.() ?? 0;
		symlinkSync(home, join(tmp, `claude-${uid}`));
		const roots = claudeStateRoots(workspace, home, { TMPDIR: tmp });
		expect(roots).not.toContain(join(tmp, `claude-${uid}`));
		const write = (file_path: string) => claudeGuard("Write", { file_path, content: "x" }, { ...options, allowedRoots: roots });
		expect(write(join(home, ".bashrc"))).toMatch(/outside this lane's workspace/);
		expect(write(join(home, ".claude", "settings.json"))).toMatch(/outside this lane's workspace/);
		expect(write(join(home, ".claude", "plans", "x.md"))).toBeUndefined();
		// The same for a plans folder that is a link.
		rmSync(join(home, ".claude", "plans"), { recursive: true });
		symlinkSync(home, join(home, ".claude", "plans"));
		expect(claudeStateRoots(workspace, home, { TMPDIR: tmp })).not.toContain(join(home, ".claude", "plans"));
	});

	it("takes Claude Code's own temp folder, CLAUDE_CODE_TMPDIR, before TMPDIR, behind the same check", () => {
		const { root, home, workspace } = setup();
		const uid = process.getuid?.() ?? 0;
		const own = join(root, "cc-tmp");
		const other = join(root, "other-tmp");
		mkdirSync(join(own, `claude-${uid}`), { recursive: true });
		mkdirSync(join(other, `claude-${uid}`), { recursive: true });
		expect(claudeStateRoots(workspace, home, { CLAUDE_CODE_TMPDIR: own, TMPDIR: other })).toContain(join(own, `claude-${uid}`));
		expect(claudeStateRoots(workspace, home, { CLAUDE_CODE_TMPDIR: own, TMPDIR: other })).not.toContain(join(other, `claude-${uid}`));
		expect(claudeStateRoots(workspace, home, { CLAUDE_CODE_TMPDIR: "relative", TMPDIR: other })).toContain(join(other, `claude-${uid}`));
		const planted = join(root, "cc-planted");
		mkdirSync(planted);
		symlinkSync(home, join(planted, `claude-${uid}`));
		expect(claudeStateRoots(workspace, home, { CLAUDE_CODE_TMPDIR: planted })).not.toContain(join(planted, `claude-${uid}`));
	});

	it("checks the roots on every call the hook judges: a link planted before the call opens nothing", async () => {
		const t = testLane();
		const { root, home } = setup();
		const tmp = join(root, "tmp");
		mkdirSync(tmp);
		mkdirSync(join(home, ".claude", "plans"), { recursive: true });
		symlinkSync(home, join(tmp, `claude-${process.getuid?.() ?? 0}`));
		const c = { config: t.config, env: { CLAUDE_PROJECT_DIR: t.workspace, TMPDIR: tmp }, claudePid: 1, startHolder: () => {}, home };
		const write = async (file_path: string) =>
			runHook("pre-tool-use", JSON.stringify({ session_id: "s1", cwd: t.workspace, tool_name: "Write", tool_input: { file_path, content: "x" } }), c);
		expect(JSON.parse(await write(join(home, ".bashrc"))).hookSpecificOutput.permissionDecision).toBe("deny");
		expect(JSON.parse(await write(join(home, ".claude", "settings.json"))).hookSpecificOutput.permissionDecision).toBe("deny");
		expect(await write(join(home, ".claude", "plans", "x.md"))).toBe("");
	});

	it("drops a root it cannot check: reads go on, and a write there is refused as outside", async () => {
		const t = testLane();
		const { root, home } = setup();
		writeFileSync(join(root, "not-a-folder"), "x");
		const scratch = join(root, "not-a-folder", `claude-${process.getuid?.() ?? 0}`);
		expect(claudeStateRoots(t.workspace, home, { TMPDIR: join(root, "not-a-folder") })).not.toContain(scratch);
		const c = { config: t.config, env: { CLAUDE_PROJECT_DIR: t.workspace, TMPDIR: join(root, "not-a-folder") }, claudePid: 1, startHolder: () => {}, home };
		const call = (tool_name: string, tool_input: object) => runHook("pre-tool-use", JSON.stringify({ session_id: "s1", cwd: t.workspace, tool_name, tool_input }), c);
		expect(await call("Read", { file_path: join(t.workspace, "notes.md") })).toBe("");
		expect(JSON.parse(await call("Write", { file_path: join(scratch, "x.txt"), content: "x" })).hookSpecificOutput.permissionDecisionReason).toMatch(
			/^Orrery guard: .*outside this lane's workspace/,
		);
	});

	it("trusts a scratch root only once it is a folder of ours, so no one can put it there between check and write", () => {
		const { root, home, workspace, options } = setup();
		const tmp = join(root, "tmp");
		mkdirSync(tmp);
		const scratch = join(tmp, `claude-${process.getuid?.() ?? 0}`);
		expect(claudeStateRoots(workspace, home, { TMPDIR: tmp })).not.toContain(scratch);
		const roots = claudeStateRoots(workspace, home, { TMPDIR: tmp });
		expect(claudeGuard("Write", { file_path: join(scratch, "x.txt"), content: "x" }, { ...options, allowedRoots: roots })).toMatch(/outside this lane's workspace/);
		// ~/.claude's own folders may be made by the write itself.
		expect(roots).toContain(join(home, ".claude", "plans"));
		mkdirSync(scratch);
		expect(claudeStateRoots(workspace, home, { TMPDIR: tmp })).toContain(scratch);
	});
});

describe("claudeGuard on tools it does not know (fix round 1)", () => {
	it("judges the paths of a tool named for writing as writes", () => {
		const { workspace, home, options } = setup();
		expect(claudeGuard("mcp__fs__write_file", { path: "/etc/orrery-x", content: "x" }, options)).toMatch(/outside this lane's workspace/);
		expect(claudeGuard("mcp__fs__write_file", { path: join(workspace, "x.md"), content: "x" }, options)).toBeUndefined();
		expect(claudeGuard("mcp__fs__copy_file", { source: join(workspace, "a"), destination: join(home, ".bashrc") }, options)).toMatch(/outside this lane's workspace/);
		expect(claudeGuard("mcp__fs__move_file", { source: "~/.ssh/id_ed25519", destination: join(workspace, "k") }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__fs__create_directory", { path: join(home, "new") }, options)).toMatch(/outside this lane's workspace/);
		expect(claudeGuard("FileDelete", { path: join(home, ".bashrc") }, options)).toMatch(/outside this lane's workspace/);
		// A tool named for reading still reads anywhere but credentials.
		expect(claudeGuard("mcp__fs__read_file", { path: "/etc/hosts" }, options)).toBeUndefined();
		expect(claudeGuard("mcp__fs__read_file", { path: "/etc/hosts", source: "/etc/os-release" }, options)).toBeUndefined();
	});

	it("reads any string that looks like a path, under any key, when the tool reads", () => {
		const { workspace, home, options } = setup();
		symlinkSync(join(home, ".ssh"), join(workspace, "sub", "keys"));
		expect(claudeGuard("mcp__fs__x", { input: "~/.ssh/id_ed25519" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__fs__x", { opts: { location: join(home, ".pi", "agent", "models.json") } }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__fs__x", { list: ["a", "../../home/.netrc"] }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__fs__x", { name: "./keys/config" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__fs__x", { key: ` ${home}/.claude.json` }, options)).toMatch(/sensitive/);
		// Text that does not start like a path, and paths to nothing secret, pass.
		expect(claudeGuard("mcp__slack__post", { channel: "#ops", text: "/etc/hosts is fine" }, options)).toBeUndefined();
		expect(claudeGuard("mcp__slack__post", { text: "please rotate ~/.ssh keys" }, options)).toBeUndefined();
		// Text that starts like a path is read as one, so one that also names a credential is refused: the price of
		// catching source, dest and the like under any key.
		expect(claudeGuard("mcp__slack__post", { text: "/etc/hosts is fine; see ~/.ssh/config notes" }, options)).toMatch(/sensitive/);
	});

	it("does not judge what a writing tool writes as paths", () => {
		const { workspace, options } = setup();
		expect(claudeGuard("Write", { file_path: join(workspace, "notes.md"), content: "/etc/hosts is where names live" }, options)).toBeUndefined();
		expect(claudeGuard("Write", { file_path: join(workspace, "notes.md"), content: "~/.ssh/config holds the hosts" }, options)).toBeUndefined();
		expect(claudeGuard("Edit", { file_path: join(workspace, "notes.md"), old_string: "../old", new_string: "/etc/new" }, options)).toBeUndefined();
		expect(claudeGuard("mcp__fs__write_file", { path: join(workspace, "x.md"), content: "~/.ssh/id_rsa is the key" }, options)).toBeUndefined();
		expect(claudeGuard("TodoWrite", { todos: [{ content: "/etc/hosts: check ~/.ssh/config", status: "pending", activeForm: "x" }] }, options)).toBeUndefined();
	});

	it("runs the shell check on cmd, script and shell, and on command, args and argv lists, at any depth", () => {
		const { options } = setup();
		expect(claudeGuard("mcp__sh__run", { cmd: "cat ~/.ssh/id_rsa" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__sh__run", { script: "base64 ~/.aws/credentials" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__sh__run", { shell: "cat /proc/self/environ" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__sh__run", { command: ["cat", "~/.ssh/id_rsa"] }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__sh__run", { args: ["cat", "~/.netrc"] }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__sh__run", { argv: ["jq", ".", "~/.claude.json"] }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__sh__run", { spec: { steps: [{ cmd: "cat ~/.git-credentials" }] } }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__sh__run", { args: ["build", "--watch"], cmd: "npm" }, options)).toBeUndefined();
		// args as a string is not a command line (Skill's arguments are text).
		expect(claudeGuard("Skill", { skill: "review", args: "check ~/.ssh/config handling" }, options)).toBeUndefined();
	});
});

describe("claudeGuard reads what starts like a path in every tool, within limits (fix round 2)", () => {
	it("reads a path-looking string even when the tool's name says it writes", () => {
		const { workspace, home, options } = setup();
		expect(claudeGuard("mcp__fs__move_file", { from: "~/.ssh/id_ed25519", to: join(workspace, "k") }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__fs__copy_file", { from: join(home, ".ssh", "id_ed25519"), to: "k" }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__x__get_credit", { input: "~/.ssh/id_ed25519" }, options)).toMatch(/sensitive/);
		// Path keys keep the tool's own mode: a writer's path outside the lane is a write outside it.
		expect(claudeGuard("mcp__fs__write_file", { path: "/etc/orrery-x", content: "x" }, options)).toMatch(/outside this lane's workspace/);
		expect(claudeGuard("mcp__fs__copy_file", { from: "/etc/hosts", to: join(workspace, "hosts") }, options)).toBeUndefined();
	});

	it("leaves out what a tool writes, text over lines, and strings too long to be a path", () => {
		const { workspace, options } = setup();
		expect(claudeGuard("Write", { file_path: join(workspace, "notes.md"), content: "~/.ssh/config holds the hosts" }, options)).toBeUndefined();
		expect(claudeGuard("MultiEdit", { file_path: join(workspace, "notes.md"), edits: [{ old_string: "~/.ssh/a", new_string: "~/.aws/credentials" }] }, options)).toBeUndefined();
		expect(claudeGuard("NotebookEdit", { notebook_path: join(workspace, "n.ipynb"), new_source: "~/.netrc" }, options)).toBeUndefined();
		const prompt = "/home/alex/notes.md is the spec.\nCheck how credentials.json and ~/.ssh/config are read by the guard.";
		expect(claudeGuard("Agent", { prompt, subagent_type: "general-purpose" }, options)).toBeUndefined();
		expect(claudeGuard("SubagentHandback", { message: "/tmp/report follows.\n\nThe guard denies ~/.ssh/config reads." }, options)).toBeUndefined();
		// A one-line message that starts like a path is still read as one.
		expect(claudeGuard("SendMessage", { to: "x", message: "~/.ssh/id_ed25519 is the key" }, options)).toMatch(/sensitive/);
		const started = performance.now();
		expect(claudeGuard("mcp__x__post", { text: `/${"a/".repeat(60_000)}` }, options)).toBeUndefined();
		// Just under the limit (4092 characters) it is still read.
		expect(claudeGuard("mcp__x__post", { text: `/${"a/".repeat(2040)}.ssh/id_rsa` }, options)).toMatch(/sensitive/);
		expect(performance.now() - started).toBeLessThan(2000);
	});

	it("refuses a declared path longer than any path can be, at once", () => {
		const { options } = setup();
		const started = performance.now();
		for (const tool of ["Read", "Write"]) {
			expect(claudeGuard(tool, { file_path: `/${"a/".repeat(60_000)}`, content: "x" }, options)).toMatch(/longer than a path can be/);
		}
		expect(claudeGuard("mcp__fs__x", { files: [{ data: `QUJD/${"x".repeat(9000)}` }] }, options)).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("judges a destination as a write in every tool, whatever its name", () => {
		const { workspace, options } = setup();
		expect(claudeGuard("Artifact", { action: "read", url: "u", path: "p", out_dir: "/etc/cron.d" }, options)).toMatch(/outside this lane's workspace/);
		expect(claudeGuard("mcp__fs__put", { source: join(workspace, "a"), destination: "/etc/orrery-x" }, options)).toMatch(/outside this lane's workspace/);
		for (const key of ["outdir", "output", "output_dir", "outputPath", "output_file", "dest", "target", "save_path", "savePath"]) {
			expect([key, claudeGuard("mcp__x__export", { [key]: "/etc/orrery-x" }, options)]).toEqual([key, expect.stringMatching(/outside this lane's workspace/)]);
		}
		expect(claudeGuard("Artifact", { action: "read", url: "u", path: "p", out_dir: join(workspace, "out") }, options)).toBeUndefined();
		expect(claudeGuard("mcp__example__request", { method: "GET", path: "/api/v1/workspaces/" }, options)).toBeUndefined();
	});
});

describe("claudeGuard answers in time and reads paths as the tool will open them (fix round 3)", () => {
	// The budget is injected (judgeMs), so what is refused does not depend on how fast this machine is.
	it("refuses a call that names more than it can judge in its time budget, before Claude Code's hook timeout", () => {
		const { workspace, home, options } = setup();
		const paths = [join(workspace, "a.md"), join(workspace, "b.md")];
		const noTime = { ...options, judgeMs: 0 };
		expect(claudeGuard("mcp__fs__read_multiple_files", { paths }, options)).toBeUndefined();
		expect(claudeGuard("mcp__fs__read_multiple_files", { paths }, noTime)).toMatch(/more paths than the guard can check in time; nothing was run/);
		// A secret among them is not reached in time, and the call is still refused.
		expect(claudeGuard("mcp__fs__read_multiple_files", { paths: [join(home, ".ssh", "id_ed25519"), ...paths] }, noTime)).toMatch(/more paths than the guard can check in time/);
		// Command lines share the budget.
		expect(claudeGuard("Bash", { command: "ls -la" }, options)).toBeUndefined();
		expect(claudeGuard("Bash", { command: "ls -la" }, noTime)).toMatch(/more command lines than the guard can check in time; nothing was run/);
		// Nothing to judge, nothing to refuse.
		expect(claudeGuard("ToolSearch", { query: "select:Read" }, noTime)).toBeUndefined();
	});

	it("measures a path by its normalized form, so padding with x/../ hides nothing", () => {
		const { home, options } = setup();
		const padded = (start: string) => `${start}/${"x/../".repeat(900)}.ssh/id_ed25519`;
		expect(padded("~").length).toBeGreaterThan(4096);
		expect(claudeGuard("mcp__fs__read_multiple_files", { paths: [padded("~")] }, options)).toMatch(/sensitive/);
		expect(claudeGuard("mcp__fs__x", { input: padded("~") }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Artifact", { action: "publish", file_paths: [padded(home)] }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Artifact", { action: "publish", files: { "a.txt": padded(home) } }, options)).toMatch(/sensitive/);
		const started = performance.now();
		expect(claudeGuard("mcp__x__post", { text: `/${"a/".repeat(60_000)}` }, options)).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(500);
	});

	it("decodes a file: URI without //, and leaves the URIs a tool writes alone", () => {
		const { workspace, home, options } = setup();
		expect(claudeGuard("ReadMcpResourceTool", { server: "fs", uri: `file:${home}/.ssh/id_ed25519` }, options)).toMatch(/sensitive/);
		expect(claudeGuard("Write", { file_path: join(workspace, "notes.md"), content: "file:///etc/passwd" }, options)).toBeUndefined();
		expect(claudeGuard("Edit", { file_path: join(workspace, "notes.md"), old_string: "a", new_string: "file:///etc/hosts" }, options)).toBeUndefined();
	});
});

describe("the PreToolUse hook", () => {
	it("denies with Claude Code's deny shape, inside subagents too, and says nothing outside a lane", async () => {
		const t = testLane();
		const { home } = setup();
		const c = { config: t.config, env: { CLAUDE_PROJECT_DIR: t.workspace }, claudePid: 1, startHolder: () => {}, home };
		const read = (file_path: string, extra: object = {}) =>
			JSON.stringify({ session_id: "s1", cwd: t.workspace, tool_name: "Read", tool_input: { file_path }, ...extra });
		const denied = JSON.parse(await runHook("pre-tool-use", read(join(home, ".ssh", "id_ed25519"), { agent_id: "a1", agent_type: "general-purpose" }), c));
		expect(denied).toEqual({
			hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(/^Orrery guard: .*sensitive/) },
		});
		expect(JSON.parse(await runHook("pre-tool-use", read(t.config.credentialsPath), c)).hookSpecificOutput.permissionDecision).toBe("deny");
		expect(await runHook("pre-tool-use", read(join(t.workspace, "notes.md")), c)).toBe("");
		expect(await runHook("pre-tool-use", read(join(home, ".ssh", "id_ed25519")), { ...c, env: { CLAUDE_PROJECT_DIR: t.dir } })).toBe("");
	});

	it("lets the lane write this project's Claude Code state, its plans and its scratch root, and nothing else outside", async () => {
		const t = testLane();
		const { root, home } = setup();
		const tmp = join(root, "tmp");
		const uid = process.getuid?.() ?? 0;
		mkdirSync(join(tmp, `claude-${uid}`), { recursive: true });
		const c = { config: t.config, env: { CLAUDE_PROJECT_DIR: t.workspace, TMPDIR: tmp }, claudePid: 1, startHolder: () => {}, home };
		const write = async (file_path: string) =>
			runHook("pre-tool-use", JSON.stringify({ session_id: "s1", cwd: t.workspace, tool_name: "Write", tool_input: { file_path, content: "x" } }), c);
		expect(await write(join(home, ".claude", "projects", claudeProjectFolder(t.workspace) as string, "memory", "MEMORY.md"))).toBe("");
		expect(await write(join(home, ".claude", "plans", "plan.md"))).toBe("");
		expect(await write(join(tmp, `claude-${uid}`, "s", "scratchpad", "a.txt"))).toBe("");
		expect(await write(join(t.workspace, "a.ts"))).toBe("");
		for (const elsewhere of [join(home, ".claude", "settings.json"), join(home, ".claude", "projects", "-other", "memory", "MEMORY.md")]) {
			expect(JSON.parse(await write(elsewhere)).hookSpecificOutput.permissionDecisionReason).toMatch(/^Orrery guard: .*outside this lane's workspace/);
		}
		// Orrery's own home is refused outright now, not only as outside the workspace.
		expect(JSON.parse(await write(join(t.dir, "data", "x"))).hookSpecificOutput.permissionDecisionReason).toMatch(/^Orrery guard: .*sensitive/);
	});

	it("counts Claude Code's login in a config folder moved by CLAUDE_CONFIG_DIR as credentials", async () => {
		const t = testLane();
		const { home } = setup();
		const config = join(home, "claude-config");
		mkdirSync(join(config, "projects"), { recursive: true });
		const c = { config: t.config, env: { CLAUDE_PROJECT_DIR: t.workspace, CLAUDE_CONFIG_DIR: config }, claudePid: 1, startHolder: () => {}, home };
		const call = async (tool_name: string, tool_input: object) =>
			JSON.parse((await runHook("pre-tool-use", JSON.stringify({ session_id: "s1", cwd: t.workspace, tool_name, tool_input }), c)) || "{}").hookSpecificOutput?.permissionDecisionReason;
		expect(await call("Grep", { pattern: "accessToken", path: config })).toMatch(/narrower folder/);
		expect(await call("Read", { file_path: join(config, ".credentials.json") })).toMatch(/sensitive/);
		expect(await call("Grep", { pattern: "x", path: join(config, "projects") })).toBeUndefined();
	});

	it("counts OMP's stores in each profile and under $XDG_DATA_HOME/omp as credentials (fix round 1)", async () => {
		const t = testLane();
		const { root, home } = setup();
		const xdg = join(root, "xdg");
		mkdirSync(join(home, ".omp", "profiles", "work", "agent"), { recursive: true });
		mkdirSync(join(xdg, "omp", "profiles", "work"), { recursive: true });
		const c = { config: t.config, env: { CLAUDE_PROJECT_DIR: t.workspace, XDG_DATA_HOME: xdg }, claudePid: 1, startHolder: () => {}, home };
		const grep = async (path: string) =>
			JSON.parse((await runHook("pre-tool-use", JSON.stringify({ session_id: "s1", cwd: t.workspace, tool_name: "Grep", tool_input: { pattern: "token", path } }), c)) || "{}").hookSpecificOutput
				?.permissionDecisionReason;
		expect(await grep(join(home, ".omp", "profiles", "work"))).toMatch(/narrower folder/);
		expect(await grep(join(xdg, "omp"))).toMatch(/narrower folder/);
		expect(await grep(join(xdg, "omp", "profiles", "work"))).toMatch(/narrower folder/);
		expect(await grep(join(home, "notes"))).toBeUndefined();
	});

	it("counts OMP's .env and secrets.yml, and the stores PI_CONFIG_DIR moves, as credentials (final review)", async () => {
		const t = testLane();
		const { home } = setup();
		mkdirSync(join(home, ".omp-alt", "agent"), { recursive: true });
		const c = { config: t.config, env: { CLAUDE_PROJECT_DIR: t.workspace, PI_CONFIG_DIR: ".omp-alt" }, claudePid: 1, startHolder: () => {}, home };
		const read = async (file_path: string) =>
			JSON.parse((await runHook("pre-tool-use", JSON.stringify({ session_id: "s1", cwd: t.workspace, tool_name: "Read", tool_input: { file_path } }), c)) || "{}").hookSpecificOutput
				?.permissionDecisionReason;
		for (const path of [join(home, ".omp", ".env"), join(home, ".omp", "agent", "secrets.yml"), join(home, ".omp-alt", "agent", "agent.db"), join(home, ".omp-alt", ".env")]) {
			expect([path, await read(path)]).toEqual([path, expect.stringMatching(/sensitive/)]);
		}
		expect(await read(join(home, ".omp-alt", "agent", "config.yml"))).toBeUndefined();
	});

	it("denies a call it cannot judge rather than let it through", () => {
		const t = testLane();
		const { home } = setup();
		const c = { config: t.config, env: { CLAUDE_PROJECT_DIR: t.workspace }, claudePid: 1, startHolder: () => {}, home };
		const toolInput = {
			get file_path(): string {
				throw new Error("no reading this");
			},
		};
		const input: HookInput = { session_id: "s1", cwd: t.workspace, tool_name: "Read", tool_input: toolInput };
		expect(preToolUse(input, c)).toEqual({
			hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Orrery guard: this call could not be checked (no reading this)." },
		});
	});

	it("prints the deny on stdout and exits 0 when Claude Code runs it", () => {
		const t = testLane();
		// A scratch home and data folder, so the hook lists no real ~/.omp or $XDG_DATA_HOME/omp.
		const scratch = { HOME: t.dir, XDG_DATA_HOME: join(t.dir, "xdg") };
		const out = hookCli(
			"pre-tool-use",
			{ session_id: "s1", cwd: t.workspace, tool_name: "Bash", tool_input: { command: "cat ~/.ssh/id_rsa" } },
			{ ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.workspace, ...scratch },
		);
		expect(out.status).toBe(0);
		expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
		expect(out.stderr).toBe("");
		const fine = hookCli("pre-tool-use", { session_id: "s1", cwd: t.workspace, tool_name: "Bash", tool_input: { command: "ls" } }, { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.workspace, ...scratch });
		expect([fine.status, fine.stdout, fine.stderr]).toEqual([0, "", ""]);
	}, 60_000);

	// Without ORRERY_CONFIG, ~/.orrery or ~/.config/orrery, the hook falls back to the server's config, which a test must not read.
	it.skipIf(existsSync("/etc/orrery/config.toml"))("allows everything and prints nothing without any orrery config", () => {
		const t = testLane();
		const none = hookCli("pre-tool-use", { session_id: "s1", cwd: t.workspace, tool_name: "Read", tool_input: { file_path: "~/.ssh/id_rsa" } }, { HOME: t.dir });
		expect([none.status, none.stdout, none.stderr]).toEqual([0, "", ""]);
	}, 60_000);
});

describe("the PreToolUse hook answers in time, whatever the size of the call (fix round 4)", () => {
	const KB = 1024;
	/**
	 * Text that is slow for pi's /proc/…/environ pattern: from each "=/proc/" it scans to the end, so its time grows with
	 * the square of the length (0.36 s at 64 KB, 4.9 s at 256 KB, measured through the hook).
	 */
	const slowText = (length: number) => {
		const unit = `=/proc/${"a/".repeat(8)}`;
		return unit.repeat(Math.ceil(length / unit.length));
	};
	/** The same as a relative path that resolves to the cwd: each "=/proc/../../" cancels itself out. */
	const slowPath = (length: number) => "=/proc/../../".repeat(Math.ceil(length / 13));

	/** A lane, a fake home, a call's hook input, and the hook's reason for refusing it (undefined: let through). */
	function hook() {
		const t = testLane();
		const { home } = setup();
		const c: HookContext = { config: t.config, env: { CLAUDE_PROJECT_DIR: t.workspace }, claudePid: 1, startHolder: () => {}, home };
		const call = (tool_name: string, tool_input: object) => JSON.stringify({ session_id: "s1", cwd: t.workspace, tool_name, tool_input });
		const answer = async (stdin: string, ctx: HookContext = c) => {
			const out = await runHook("pre-tool-use", stdin, ctx);
			return out === "" ? undefined : (JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string);
		};
		/** Each call's tool, its answer, and whether it came in under 1 s. */
		const timed = async (cases: readonly (readonly [string, object])[]) => {
			const seen: unknown[] = [];
			for (const [tool, input] of cases) {
				const started = performance.now();
				const reason = await answer(call(tool, input));
				seen.push([tool, reason, performance.now() - started < 1000]);
			}
			return seen;
		};
		return { t, c, call, answer, timed };
	}
	const TOO_LONG = /^Orrery guard: .*too long to check \(over 64 KB\); nothing was run\.$/;

	it("refuses a command line, a Grep glob or a Glob pattern over 64 KB in under 1 s, before any pattern runs on it", async () => {
		const { call, answer, timed } = hook();
		const long = slowText(300 * KB);
		const cases = [
			["Bash", { command: `echo ${long}` }],
			["Monitor", { command: ["tail", "-f", long], description: "x" }],
			["mcp__sh__run", { spec: { steps: [{ cmd: long }] } }],
			["Glob", { pattern: long }],
			["Grep", { pattern: "x", glob: long }],
		] as const;
		expect(await timed(cases)).toEqual(cases.map(([tool]) => [tool, expect.stringMatching(TOO_LONG), true]));
		// The cap is 64 KB to the character: at it, the command is still judged.
		const at = (length: number) => call("Bash", { command: "cat ~/.ssh/id_rsa".padEnd(length, " ") });
		expect(await answer(at(64 * KB))).toMatch(/sensitive/);
		expect(await answer(at(64 * KB + 1))).toMatch(TOO_LONG);
	}, 120_000);

	it("refuses a path over 64 KB in under 1 s, however short it resolves, and still judges a padded path under it", async () => {
		const { call, answer, timed } = hook();
		const long = slowPath(300 * KB);
		const cases = [
			["Read", { file_path: long }],
			["Write", { file_path: long, content: "x" }],
			["Grep", { pattern: "x", path: long }],
			["LS", { path: long }],
			["mcp__fs__read_multiple_files", { paths: [long] }],
			["mcp__x__post", { text: `/${long}` }],
		] as const;
		expect(await timed(cases)).toEqual(cases.map(([tool]) => [tool, expect.stringMatching(TOO_LONG), true]));
		// Padding under the cap hides nothing: the path is judged by where it leads.
		expect(await answer(call("Read", { file_path: `${slowPath(60 * KB)}.ssh/id_rsa` }))).toMatch(/sensitive/);
		expect(await answer(call("Read", { file_path: `${slowPath(60 * KB)}notes.md` }))).toBeUndefined();
	}, 120_000);

	it("refuses a hook input over 1 MB unread, in under 1 s, unless Claude Code says the project is no lane's", async () => {
		const { t, c, call, answer } = hook();
		const big = call("Write", { file_path: join(t.workspace, "a.txt"), content: "x".repeat(1024 * KB) });
		const started = performance.now();
		expect(await answer(big)).toBe("Orrery guard: this call's input is over 1 MB, too long to check; nothing was run.");
		expect(performance.now() - started).toBeLessThan(1000);
		// The cap counts bytes, as Claude Code writes them: 600 K "é" are 1.2 MB.
		expect(await answer(call("Write", { file_path: join(t.workspace, "a.txt"), content: "é".repeat(600 * KB) }))).toMatch(/over 1 MB/);
		// Without CLAUDE_PROJECT_DIR only the unread input says where the call runs: refused all the same.
		expect(await answer(big, { ...c, env: {} })).toMatch(/over 1 MB/);
		// Claude Code says the project is no lane's: nothing to say, as for any call outside a lane.
		expect(await answer(big, { ...c, env: { CLAUDE_PROJECT_DIR: t.dir } })).toBeUndefined();
	});

	it("still lets through a normal command, and a large Write or Edit: what a tool writes is never pattern-checked", async () => {
		const { t, call, answer } = hook();
		expect(await answer(call("Bash", { command: "npm test -- test/claude" }))).toBeUndefined();
		const started = performance.now();
		expect(await answer(call("Write", { file_path: join(t.workspace, "a.txt"), content: slowText(900 * KB) }))).toBeUndefined();
		expect(await answer(call("Edit", { file_path: join(t.workspace, "a.txt"), old_string: slowText(400 * KB), new_string: slowText(400 * KB) }))).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("reads at most 1 MB of a PreToolUse input when Claude Code runs it, reads it to the end, and answers on stdout", () => {
		const t = testLane();
		const env = { ORRERY_CONFIG: t.configPath, CLAUDE_PROJECT_DIR: t.workspace, HOME: t.dir, TMPDIR: t.dir, XDG_DATA_HOME: join(t.dir, "xdg") };
		const write = (content: string) => ({ session_id: "s1", cwd: t.workspace, tool_name: "Write", tool_input: { file_path: join(t.workspace, "a.txt"), content } });
		const over = hookCli("pre-tool-use", write("é".repeat(600 * 1024)), env);
		expect([over.status, over.stderr]).toEqual([0, ""]);
		expect(over.stdout).toMatch(/"permissionDecision":"deny".*over 1 MB/);
		const under = hookCli("pre-tool-use", write("é".repeat(400 * 1024)), env);
		expect([under.status, under.stdout, under.stderr]).toEqual([0, "", ""]);
	}, 60_000);
});

describe("claudeGuard keeps Orrery's home out", () => {
	it("refuses the remote keys through the hook with the lane's real config, and a search of the home", async () => {
		const t = testLane();
		const { home } = setup();
		const data = t.config.dataDir;
		mkdirSync(data, { recursive: true });
		writeFileSync(join(data, "remotes.json"), "{}");
		const c = { config: t.config, env: { CLAUDE_PROJECT_DIR: t.workspace }, claudePid: 1, startHolder: () => {}, home };
		const call = (tool_name: string, tool_input: object) => runHook("pre-tool-use", JSON.stringify({ session_id: "s1", cwd: t.workspace, tool_name, tool_input }), c);
		expect(JSON.parse(await call("Read", { file_path: join(data, "remotes.json") })).hookSpecificOutput.permissionDecisionReason).toMatch(/sensitive/);
		const options = { workspace: t.workspace, allowedRoots: [] as string[], cwd: t.workspace, home, orreryData: data };
		expect(claudeGuard("Grep", { pattern: "x", path: data }, options)).toMatch(/credential/);
	});
});
