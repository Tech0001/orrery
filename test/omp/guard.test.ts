import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editTargets, globBase, guardOmpToolCall, guardToolCall, ompCredentials, ompToolPath, pathParts } from "../../src/lane/guard-paths.ts";
import { writeSetupMarker } from "../../src/claude/view-file.ts";
import type { LaneConfig } from "../../src/lane/config.ts";
import { cleanup, world } from "../pi/world.ts";
import { type FakeOmp, ompCleanup, ompOrrery } from "./world.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A lane folder and a fake home with OMP's agent dir and one named profile. */
function setup() {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "orrery-omp-guard-")));
	const workspace = join(dir, "ws");
	const home = join(dir, "home");
	mkdirSync(join(workspace, "src"), { recursive: true });
	mkdirSync(join(home, ".omp", "agent"), { recursive: true });
	mkdirSync(join(home, ".omp", "profiles", "work", "agent"), { recursive: true });
	writeFileSync(join(home, ".omp", "agent", "agent.db"), "x");
	writeFileSync(join(home, ".omp", "agent", "models.yml"), "providers: {}");
	return { workspace, home, options: { workspace, allowedRoots: [], cwd: workspace, home, credentials: ompCredentials({}, home), foreignViews: [] as string[] } };
}

describe("guardOmpToolCall: OMP's tools, judged like pi's", () => {
	it("checks every file of a multi-file edit, and every file, folder or glob ast_edit rewrites", () => {
		const { options } = setup();
		const outside = join(dir, "elsewhere.ts");
		expect(guardOmpToolCall("edit", { paths: ["src/a.ts", "src/b.ts"] }, options)).toBeUndefined();
		expect(guardOmpToolCall("edit", { paths: ["src/a.ts", outside] }, options)).toMatch(/outside this lane's workspace/);
		expect(guardOmpToolCall("edit", { path: "src/a.ts", paths: ["src/a.ts"] }, options)).toBeUndefined();
		expect(guardOmpToolCall("ast_edit", { ops: [{ pat: "a", out: "b" }], paths: ["src/**/*.ts"] }, options)).toBeUndefined();
		expect(guardOmpToolCall("ast_edit", { ops: [{ pat: "a", out: "b" }], paths: ["src/**/*.ts", `${dir}/**/*.ts`] }, options)).toMatch(/outside this lane's workspace/);
		expect(guardOmpToolCall("ast_edit", { ops: [{ pat: "a", out: "b" }], paths: ["~/.ssh/config"] }, options)).toMatch(/sensitive/);
	});

	it("treats eval like bash: its code gets the sensitive-file check, nothing more", () => {
		const { options } = setup();
		expect(guardOmpToolCall("eval", { language: "py", code: "open('/home/x/.ssh/id_ed25519').read()" }, options)).toMatch(/sensitive/);
		expect(guardOmpToolCall("eval", { language: "js", code: "1 + 1" }, options)).toBeUndefined();
	});

	it("judges each path of a ;-, comma- or space-separated list in grep, glob, ast_grep, find and read", () => {
		const { home, options } = setup();
		expect(guardOmpToolCall("grep", { pattern: "key", path: "src;~" }, options)).toMatch(/narrower folder/);
		expect(guardOmpToolCall("grep", { pattern: "key", path: `src, ${home}` }, options)).toMatch(/narrower folder/);
		expect(guardOmpToolCall("glob", { path: "~/**/*.json" }, options)).toMatch(/narrower folder/);
		expect(guardOmpToolCall("ast_grep", { pat: "x", path: "src ~/.omp" }, options)).toMatch(/narrower folder|sensitive/);
		expect(guardOmpToolCall("find", { query: "x", grep_keywords: [], path: "src;/" }, options)).toMatch(/narrower folder/);
		expect(guardOmpToolCall("read", { path: "src/a.ts ~/.omp/agent/models.yml" }, options)).toMatch(/sensitive/);
		expect(guardOmpToolCall("grep", { pattern: "key", path: "src; src/**/*.ts" }, options)).toBeUndefined();
		expect(guardOmpToolCall("glob", { path: "src/**/*.ts" }, options)).toBeUndefined();
		expect(guardOmpToolCall("read", { path: "src/a.ts" }, options)).toBeUndefined();
	});

	it("leaves every other tool to pi's judgment", () => {
		const { options } = setup();
		const write = { path: join(dir, "x.txt"), content: "x" };
		expect(guardOmpToolCall("write", write, options)).toBe(guardToolCall("write", write, options));
		expect(guardOmpToolCall("bash", { command: "ls" }, options)).toBeUndefined();
	});
});

describe("OMP's credential stores", () => {
	it("are refused by name, through a link, and as a search root", () => {
		const { workspace, home, options } = setup();
		for (const path of ["~/.omp/agent/agent.db", "~/.omp/agent/models.yml", "~/.omp/profiles/work/agent/agent.db", join(dir, "xdg", "omp", "agent.db")]) {
			expect([path, guardToolCall("read", { path }, options)]).toEqual([path, expect.stringMatching(/sensitive/)]);
		}
		expect(guardToolCall("bash", { command: "sqlite3 ~/.omp/agent/agent.db .dump" }, options)).toMatch(/sensitive/);
		symlinkSync(join(home, ".omp", "agent", "agent.db"), join(workspace, "db"));
		expect(guardToolCall("read", { path: "db" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("grep", { pattern: "key", path: "~/.omp" }, options)).toMatch(/narrower folder/);
		expect(guardToolCall("read", { path: "~/.omp/agent/config.yml" }, options)).toBeUndefined();
	});

	it("include each profile's, a dir moved by PI_CODING_AGENT_DIR, and $XDG_DATA_HOME/omp", () => {
		const { home } = setup();
		expect(ompCredentials({ PI_CODING_AGENT_DIR: "/srv/omp", XDG_DATA_HOME: "/x/data" }, home)).toEqual([
			join(home, ".omp", "profiles", "work", ".env"),
			join(home, ".omp", "profiles", "work", "agent", "agent.db"),
			join(home, ".omp", "profiles", "work", "agent", "models.yml"),
			join(home, ".omp", "profiles", "work", "agent", ".env"),
			join(home, ".omp", "profiles", "work", "agent", "secrets.yml"),
			"/srv/omp/agent.db",
			"/srv/omp/models.yml",
			"/srv/omp/.env",
			"/srv/omp/secrets.yml",
			"/x/data/omp/agent.db",
		]);
		expect(ompCredentials({}, join(dir, "nobody"))).toEqual([]);
	});
});

describe("globBase and pathParts", () => {
	it("cut a glob at the segment of its first wildcard, and split OMP's path lists", () => {
		expect(globBase("~/**/*.json")).toBe("~");
		expect(globBase("src/**/*.ts")).toBe("src");
		expect(globBase("**/*.ts")).toBe(".");
		expect(globBase("/etc/*.conf")).toBe("/etc");
		expect(globBase("/*")).toBe("/");
		expect(globBase("src/a.ts")).toBe("src/a.ts");
		expect(pathParts("src; ~")).toEqual(["src; ~", "src", "~"]);
		expect(pathParts("a.ts")).toEqual(["a.ts"]);
	});
});

describe("fix round 1: OMP's paths, read as OMP reads them", () => {
	it("ompToolPath mirrors OMP's expandPath: quotes, a stray leading colon, @, file://, and any ~x under home; / stays the root", () => {
		const home = "/h";
		const cwd = "/w";
		expect(ompToolPath(":~", cwd, home)).toBe("/h");
		expect(ompToolPath('"~"', cwd, home)).toBe("/h");
		expect(ompToolPath(' "~/.omp" ', cwd, home)).toBe("/h/.omp");
		expect(ompToolPath("~.", cwd, home)).toBe("/h");
		expect(ompToolPath("~.omp", cwd, home)).toBe("/h/.omp");
		expect(ompToolPath(":/etc/x", cwd, home)).toBe("/etc/x");
		expect(ompToolPath(":../x", cwd, home)).toBe("/x");
		expect(ompToolPath("@~/x", cwd, home)).toBe("/h/x");
		expect(ompToolPath("FILE:///etc/x", cwd, home)).toBe("/etc/x");
		expect(ompToolPath("/", cwd, home)).toBe("/");
		expect(ompToolPath("src/a.ts", cwd, home)).toBe("/w/src/a.ts");
		expect(ompToolPath(":src", cwd, home)).toBe("/w/:src");
		expect(pathParts('"src;~"')).toEqual(['"src;~"', "src;~", "src", "~"]);
	});

	it("refuses home-rooted searches however OMP would spell them", () => {
		const { options } = setup();
		for (const path of [":~", '"~"', ":~/.omp", "~.", "~.omp", 'src;"~"', '"src;~"', "src\\..\\..", ":/"]) {
			expect([path, guardOmpToolCall("grep", { pattern: "key", path }, options)]).toEqual([path, expect.stringMatching(/narrower folder/)]);
		}
		expect(guardOmpToolCall("glob", { path: ":~/**/*.json" }, options)).toMatch(/narrower folder/);
		expect(guardOmpToolCall("grep", { pattern: "key", path: '"src"' }, options)).toBeUndefined();
	});

	it("refuses writes and edits outside the lane however OMP would spell them, [path#TAG] headers included", () => {
		const { options } = setup();
		const write = (path: string) => guardOmpToolCall("write", { path, content: "x" }, options);
		for (const path of [":/etc/x", "[/etc/x]", "[/etc/x#1a2B]", "[:/etc/x]", "~.bashrc"]) expect([path, write(path)]).toEqual([path, expect.stringMatching(/outside this lane's workspace/)]);
		expect(write("[src/a.ts#1a2b]")).toBeUndefined();
		expect(write("src/a.ts")).toBeUndefined();
		expect(guardOmpToolCall("edit", { paths: [":/etc/x"] }, options)).toMatch(/outside this lane's workspace/);
		expect(guardOmpToolCall("edit", { path: "[/etc/x#1a2b]", old_string: "a", new_string: "b" }, options)).toMatch(/outside this lane's workspace/);
		expect(guardOmpToolCall("ast_edit", { ops: [{ pat: "a", out: "b" }], paths: [":/etc/**/*.conf"] }, options)).toMatch(/outside this lane's workspace/);
		expect(guardOmpToolCall("ast_edit", { ops: [{ pat: "a", out: "b" }], paths: ['"/etc/x.conf"'] }, options)).toMatch(/outside this lane's workspace/);
		expect(guardOmpToolCall("ast_edit", { ops: [{ pat: "a", out: "b" }], paths: ["src;/etc/x.conf"] }, options)).toMatch(/outside this lane's workspace/);
	});

	it("refuses brace alternatives and a parent segment after a wildcard in OMP's globs, and still checks the names", () => {
		const { options } = setup();
		const astEdit = (path: string) => guardOmpToolCall("ast_edit", { ops: [{ pat: "a", out: "b" }], paths: [path] }, options);
		for (const path of ["src/{../../.omp/agent/agent.db,x}", "src/*/../../x", "src/**/../../x.ts", "src\\*\\..\\..\\x", "src/{a,b}.ts"]) {
			expect([path, astEdit(path)]).toEqual([path, expect.stringMatching(/brace or parent patterns are not allowed in OMP paths/)]);
		}
		expect(guardOmpToolCall("grep", { pattern: "k", path: "src/{a,b}" }, options)).toMatch(/brace or parent patterns/);
		expect(guardOmpToolCall("glob", { path: "src/*/../../../x" }, options)).toMatch(/brace or parent patterns/);
		expect(guardOmpToolCall("ast_grep", { pat: "x", path: "src;src/*/../.." }, options)).toMatch(/brace or parent patterns/);
		expect(astEdit("~/.ssh/*")).toMatch(/sensitive/);
		expect(astEdit("../ws/src/*.ts")).toBeUndefined();
		expect(guardOmpToolCall("glob", { path: "src/../src/**/*.ts" }, options)).toBeUndefined();
	});

	it("judges an edit's MV destinations, apply_patch targets and patch renames like its paths, and its text like a command", () => {
		const { options } = setup();
		const edit = (input: Record<string, unknown>) => guardOmpToolCall("edit", input, options);
		expect(edit({ input: "[src/a.ts#1a2b]\nMV /etc/x\n", paths: ["src/a.ts"], path: "src/a.ts" })).toMatch(/outside this lane's workspace/);
		expect(edit({ input: "[src/a.ts#1a2b]\nMV src/b.ts\n", paths: ["src/a.ts"], path: "src/a.ts" })).toBeUndefined();
		expect(edit({ input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: ../../x\n@@\n-a\n+b\n*** End Patch\n" })).toMatch(/outside this lane's workspace/);
		expect(edit({ input: "*** Begin Patch\n*** Add File: :/etc/x\n+hi\n*** End Patch\n" })).toMatch(/outside this lane's workspace/);
		expect(edit({ _input: "*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch\n" })).toBeUndefined();
		expect(edit({ path: "src/a.ts", edits: [{ op: "update", rename: "/etc/x" }] })).toMatch(/outside this lane's workspace/);
		expect(edit({ path: "src/a.ts", edits: [{ op: "update", rename: "src/b.ts" }] })).toBeUndefined();
		expect(edit({ input: "*** Update File: ~/.omp/agent/models.yml\n" })).toMatch(/sensitive/);
		expect(edit({ input: "[src/a.ts]\nPUT 1\n+see ~/.ssh/config\n" })).toMatch(/sensitive/);
		// Neither path, paths nor targets it can read: only the text is judged.
		expect(edit({ input: "something OMP's parser may read" })).toBeUndefined();
		expect(edit({ _input: "an edit naming id_ed25519" })).toMatch(/sensitive/);
	});

	it("editTargets reads OMP's headers, moves and patch file lines", () => {
		expect(editTargets('[src/a.ts#1a2b]\nPUT 1\n+[not/a/header]\nMV "src/b.ts"\n¶legacy.ts#00ff\n*** Add File: c.ts\n*** Move to: d.ts\n*** Edit File: e.ts\n')).toEqual([
			"src/a.ts",
			"src/b.ts",
			"legacy.ts",
			"c.ts",
			"d.ts",
			"e.ts",
		]);
		expect(editTargets("plain text\n+MV x\n")).toEqual([]);
	});

	it("counts each $XDG_DATA_HOME/omp profile's agent.db (models.yml stays in the profile's agent dir)", () => {
		const { workspace, home } = setup();
		const xdg = join(dir, "xdg");
		mkdirSync(join(xdg, "omp", "profiles", "work"), { recursive: true });
		const credentials = ompCredentials({ XDG_DATA_HOME: xdg }, home);
		expect(credentials).toEqual([
			join(home, ".omp", "profiles", "work", ".env"),
			join(home, ".omp", "profiles", "work", "agent", "agent.db"),
			join(home, ".omp", "profiles", "work", "agent", "models.yml"),
			join(home, ".omp", "profiles", "work", "agent", ".env"),
			join(home, ".omp", "profiles", "work", "agent", "secrets.yml"),
			join(xdg, "omp", "agent.db"),
			join(xdg, "omp", "profiles", "work", "agent.db"),
		]);
		const options = { workspace, allowedRoots: [], cwd: workspace, home, credentials, foreignViews: [] as string[] };
		expect(guardOmpToolCall("grep", { pattern: "k", path: join(xdg, "omp", "profiles", "work") }, options)).toMatch(/narrower folder/);
	});
});

describe("fix rounds 2-3: an edit's whole text is checked like a command (round 3 reverts round 2's narrowing)", () => {
	it("refuses an edit whose content names a credential file, whatever its target, and target lines naming one", () => {
		const { options } = setup();
		const edit = (input: Record<string, unknown>) => guardOmpToolCall("edit", input, options);
		const body = "PUT 1\n+keys live in ~/.ssh/id_rsa, logins in .netrc\n";
		expect(edit({ input: `[src/a.ts#1a2b]\n${body}`, paths: ["src/a.ts"], path: "src/a.ts" })).toMatch(/sensitive/);
		expect(edit({ input: `*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+see id_rsa and .netrc\n*** End Patch\n` })).toMatch(/sensitive/);
		expect(edit({ input: body })).toMatch(/sensitive/);
		expect(edit({ _input: body })).toMatch(/sensitive/);
		expect(edit({ input: "[~/.netrc]\nPUT 1\n+x\n" })).toMatch(/sensitive/);
		expect(edit({ input: `[src/a.ts#1a2b]\nMV ~/.ssh/config\n` })).toMatch(/sensitive/);
		expect(edit({ input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: ~/.omp/agent/models.yml\n*** End Patch\n" })).toMatch(/sensitive/);
	});
});

describe("fix round 3: where OMP's own parsers may read more, the guard fails closed", () => {
	it("refuses an edit with a directive-looking line it cannot read, and lets a plain one through", () => {
		const { options } = setup();
		const edit = (input: Record<string, unknown>) => guardOmpToolCall("edit", input, options);
		const unreadable = /could not read every target of this edit/;
		// Round 4 reads two of round 3's inputs as OMP 18.8.7 does: "MV=/etc/x" is no move (OMP's MV needs an end, a space
		// or ":" after it) and " [/etc/x#ab12]" no header (no parser that writes reads an indented "["); both are allowed
		// in the round-4 tests. "[*** Begin Patch] [/etc/x#ab12]" now reads as OMP unwraps it, a header for /etc/x, refused below.
		for (const input of [
			"[src/a.ts#1a2b]\nMV:/etc/x\n",
			"[* /etc/x#1a2b]\nPUT 1\n+x\n",
			"[*** Update File: /etc/x]\nPUT 1\n+x\n",
			"[src/a.ts#1a2b]\nMV * /etc/x\n",
			"*** Edit File /etc/x\n",
			'*** Edit File: "\\u002fetc/x"\n',
			"***Add File: /etc/x\n",
			"*** update file: /etc/x\n",
		]) {
			expect([input, edit({ input, paths: ["src/a.ts"], path: "src/a.ts" })]).toEqual([input, expect.stringMatching(unreadable)]);
		}
		expect(edit({ input: "[*** Begin Patch] [/etc/x#ab12]\nPUT 1\n+x\n", paths: ["src/a.ts"], path: "src/a.ts" })).toMatch(/outside this lane's workspace/);
		// The reviewer's credential-named forms: refused (by name, before the parse).
		expect(edit({ input: "[*** Begin Patch] [~/.netrc#T]\n" })).toMatch(/sensitive/);
		expect(edit({ input: "*** Edit File ~/.netrc\n" })).toMatch(/sensitive/);
		// Plain edits still pass: a hashline edit with ordinary content, a quoted sloppy path, an apply_patch with its markers.
		expect(edit({ input: "[src/a.ts#1a2b]\nPUT 1\n+const x = 1;\nMV\tsrc/b.ts\n", paths: ["src/a.ts"], path: "src/a.ts" })).toBeUndefined();
		expect(edit({ input: '*** Edit File: "src/a.ts"\n+x\n' })).toBeUndefined();
		expect(edit({ input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End of File\n*** End Patch\n" })).toBeUndefined();
		// OMP's own path counts even when the text names none.
		expect(edit({ input: "PUT 1\n+x\n", path: "/etc/x" })).toMatch(/outside this lane's workspace/);
		expect(edit({ input: "PUT 1\n+x\n", _path: "/etc/x" })).toMatch(/outside this lane's workspace/);
	});

	it("refuses file:// targets Node cannot read, in edits and writes", () => {
		const { options } = setup();
		const url = /cannot read this file:\/\/ URL/;
		expect(guardOmpToolCall("write", { path: "file://~/x", content: "x" }, options)).toMatch(url);
		expect(guardOmpToolCall("write", { path: "file://%2Fetc%2Fx", content: "x" }, options)).toMatch(url);
		expect(guardOmpToolCall("edit", { paths: ["file://%7E/x"] }, options)).toMatch(url);
		expect(guardOmpToolCall("edit", { input: "[file://~/x#ab12]\nPUT 1\n+x\n" }, options)).toMatch(url);
		expect(guardOmpToolCall("edit", { input: "[src/a.ts#ab12]\nMV file://~/x\n" }, options)).toMatch(url);
		expect(guardOmpToolCall("edit", { path: "src/a.ts", edits: [{ rename: "file://~/x" }] }, options)).toMatch(url);
		expect(guardOmpToolCall("read", { path: "file://%2Fetc%2Fx" }, options)).toMatch(url);
		expect(guardOmpToolCall("write", { path: `file://${join(dir, "ws", "src", "a.ts")}`, content: "x" }, options)).toBeUndefined();
	});

	it("judges read and write with a selector peeled: :N-M, :table, ?q=", () => {
		const { workspace, home } = setup();
		// Files only the credential list names (a moved agent dir, a custom name): no name pattern catches them.
		const vault = join(dir, "vault");
		mkdirSync(vault);
		writeFileSync(join(vault, "secret.store"), "x");
		writeFileSync(join(vault, "x.db"), "x");
		symlinkSync(join(vault, "secret.store"), join(workspace, "link"));
		const options = { workspace, allowedRoots: [], cwd: workspace, home, credentials: [join(vault, "secret.store"), join(vault, "x.db")], foreignViews: [] as string[] };
		const read = (path: string) => guardOmpToolCall("read", { path }, options);
		expect(read("link:1-50")).toMatch(/sensitive/);
		expect(read(`${vault}/x.db:table`)).toMatch(/sensitive/);
		expect(read(`${vault}/x.db?q=1`)).toMatch(/sensitive/);
		expect(read("link:raw")).toMatch(/sensitive/);
		expect(guardOmpToolCall("write", { path: "link:1", content: "x" }, options)).toMatch(/sensitive/);
		expect(read("src/a.ts:10-20")).toBeUndefined();
		expect(guardOmpToolCall("write", { path: "src/a.ts", content: "x" }, options)).toBeUndefined();
	});

	it("judges a search or ast_edit path with glob characters as the literal path too", () => {
		const { workspace, home, options } = setup();
		symlinkSync(home, join(workspace, "[x]"));
		expect(guardOmpToolCall("grep", { pattern: "k", path: "[x]" }, options)).toMatch(/narrower folder/);
		expect(guardOmpToolCall("ast_edit", { ops: [{ pat: "a", out: "b" }], paths: ["[x]/*.conf"] }, options)).toMatch(/outside this lane's workspace/);
		expect(guardOmpToolCall("grep", { pattern: "k", path: "src/[a-z]*.ts" }, options)).toBeUndefined();
	});
});

describe("fix round 4: edit targets read where and as OMP 18.8.7's parsers read them", () => {
	const at = { path: "src/a.ts", paths: ["src/a.ts"] };
	const outside = /outside this lane's workspace/;

	it("refuses targets behind U+0085 (NEL), which Rust's trim() strips and JS's does not", () => {
		const { options } = setup();
		const edit = (input: Record<string, unknown>) => guardOmpToolCall("edit", input, options);
		for (const input of [
			"[src/a.ts#1a2b]\n\u0085MV /etc/x\n",
			"[src/a.ts#1a2b]\nMV \u0085/etc/x\n",
			"[\u0085/etc/x#1a2b]\nPUT 1.=1:\n+x\n",
			"\u0085*** Edit File: /etc/x\n*** Find\na\n*** Replace\nb\n",
		]) {
			expect([input, edit({ input, ...at })]).toEqual([input, expect.stringMatching(outside)]);
		}
		// OMP's event path and a write-style [path] header with a NEL around them.
		expect(edit({ input: "PUT 1\n+x\n", path: "\u0085/etc/x" })).toMatch(outside);
		expect(edit({ path: "[/etc/x]\u0085", old_string: "a", new_string: "b" })).toMatch(outside);
		// A C1 control inside a target is never clean.
		expect(edit({ input: "[src/a.ts#1a2b]\nMV src/b\u0085.ts\n", ...at })).toMatch(/could not read every target/);
	});

	it("judges header paths, MV destinations and OMP's own paths with OMP's apply_patch noise stripped", () => {
		const { options } = setup();
		const edit = (input: Record<string, unknown>) => guardOmpToolCall("edit", input, options);
		// OMP's event path is the unstripped "add:../outside.ts"; its hashline parser writes ../outside.ts.
		expect(edit({ input: "[add:../outside.ts#1a2b]\nPUT 1.=1:\n+x\n", path: "add:../outside.ts", paths: ["add:../outside.ts"] })).toMatch(outside);
		expect(edit({ input: "[Update File: /etc/x]\nPUT 1.=1:\n+x\n", path: "Update File: /etc/x", paths: ["Update File: /etc/x"] })).toMatch(outside);
		expect(edit({ input: "[src/a.ts#1a2b]\nMV update:/etc/x\n", ...at })).toMatch(outside);
		expect(edit({ input: "[src/a.ts#1a2b]\nMV move to: /etc/x\n", ...at })).toMatch(outside);
		expect(edit({ input: "PUT 1\n+x\n", paths: ["delete: /etc/x"] })).toMatch(outside);
		// OMP's header recovery strips the noise twice (a trailing space inside the brackets sends it there).
		expect(edit({ input: "[add:add:/etc/x#1a2b ]\nPUT 1.=1:\n+x\n" })).toMatch(outside);
		// Names that only start like noise are left alone.
		expect(edit({ input: "[address.ts#1a2b]\nPUT 1.=1:\n+x\n" })).toBeUndefined();
		expect(edit({ input: "[src/a.ts#1a2b]\nMV added: notes.md\n", ...at })).toBeUndefined();
	});

	it("judges a sloppy header's path with a trailing ' all' flag removed too", () => {
		const { workspace, options } = setup();
		writeFileSync(join(dir, "outside.txt"), "x");
		symlinkSync(join(dir, "outside.txt"), join(workspace, "lnk"));
		const edit = (input: Record<string, unknown>) => guardOmpToolCall("edit", input, options);
		for (const header of ["*** Edit File: lnk all", "*** Edit File: lnk ALL", "*** Edit File: lnk  All"]) {
			expect([header, edit({ input: `${header}\n*** Find\na\n*** Replace\nb\n` })]).toEqual([header, expect.stringMatching(outside)]);
		}
		expect(edit({ input: "*** Edit File: src/a.ts all\n*** Find\na\n*** Replace\nb\n" })).toBeUndefined();
		expect(editTargets("*** Edit File: src/a.ts all\n")).toEqual(["src/a.ts all", "src/a.ts"]);
	});

	it("reads [ headers at column 0 only, unwraps OMP's bracketed envelope markers, and refuses nested headers OMP unwraps", () => {
		const { options } = setup();
		const edit = (input: Record<string, unknown>) => guardOmpToolCall("edit", input, options);
		// OMP's resolver unwraps one more [path]: "[[/etc/x]]" writes /etc/x; a quoted header path is unquoted.
		expect(edit({ input: "[[/etc/x]]\nPUT 1.=1:\n+x\n" })).toMatch(outside);
		expect(edit({ input: '["/etc/x"]\nPUT 1.=1:\n+x\n' })).toMatch(outside);
		expect(edit({ input: "[*** Abort] [/etc/x]\nPUT 1.=1:\n+x\n" })).toMatch(outside);
		// apply_patch reads its file lines after trimming them (js_trim).
		expect(edit({ input: "*** Begin Patch\n  *** Add File: /etc/x\n+x\n*** End Patch\n" })).toMatch(outside);
		// A bracketed marker alone, or before a header, names nothing more.
		expect(edit({ input: "[*** Begin Patch]\n[src/a.ts#1a2b]\nPUT 1.=1:\n+x\n[*** End Patch]\n", ...at })).toBeUndefined();
		expect(edit({ input: "[*** Begin Patch] [src/a.ts#1a2b]\nPUT 1.=1:\n+x\n", ...at })).toBeUndefined();
		expect(edit({ input: "[src/a.ts#1a2b]\nPUT 1.=1:\n+x\n[*** End Patch]\n", ...at })).toBeUndefined();
		// An indented "[" is no header (OMP's hashline parser refuses a first line that is not one), and "MV=" no move.
		expect(edit({ input: " [/etc/x#ab12]\nPUT 1\n+x\n", ...at })).toBeUndefined();
		expect(edit({ input: "[src/a.ts#1a2b]\nMV=/etc/x\n", ...at })).toBeUndefined();
	});

	it("lets ordinary content through: hashline + rows, apply_patch context rows, sloppy bodies", () => {
		const { options } = setup();
		const edit = (input: Record<string, unknown>) => guardOmpToolCall("edit", input, options);
		const rows = "+[link](https://example.com)\n+* Add file upload\n+  [1, 2]\n+MV: notes\n+**Update to** v2\n";
		expect(edit({ input: `[src/a.md#1a2b]\nPUT 3.=3:\n${rows}`, path: "src/a.md", paths: ["src/a.md"] })).toBeUndefined();
		expect(edit({ input: `[src/a.json#1a2b]\nPUT 3.=3:\n${rows}`, path: "src/a.json", paths: ["src/a.json"] })).toBeUndefined();
		for (const row of [" [link](https://example.com)", "   [", " * Add to cart", " **Move to** settings", " MV old notes aside"]) {
			const input = `*** Begin Patch\n*** Update File: src/a.md\n@@\n${row}\n-old\n+new\n*** End Patch\n`;
			expect([row, edit({ input })]).toEqual([row, undefined]);
		}
		for (const body of ["[[bin]]", '["a","b"]', "[link](https://example.com)", "[package]", "[ ]"]) {
			const input = `*** Edit File: Cargo.toml\n*** Find\n${body}\n*** Replace\n${body}\nname = "x"\n`;
			expect([body, edit({ input })]).toEqual([body, undefined]);
		}
	});
});

describe("final review: an edit target OMP's native resolver reads differently from its TS tools", () => {
	it("judges ~//abs (and ~\\/abs) also as /abs: Rust's Path::join drops home for an absolute rest (pi-edit path_policy.rs:366-428)", () => {
		const { home, options: base } = setup();
		// A workspace at <home>/tmp: the TS reading of ~//tmp/x (<home>/tmp/x) is inside it, the native one (/tmp/x) is not.
		const workspace = join(home, "tmp");
		mkdirSync(join(workspace, "src"), { recursive: true });
		const options = { ...base, workspace, cwd: workspace };
		const edit = (input: Record<string, unknown>) => guardOmpToolCall("edit", input, options);
		const outside = /outside this lane's workspace/;
		const cases: Record<string, unknown>[] = [
			{ path: "~//tmp/x", old_string: "a", new_string: "b" },
			{ path: "~\\/tmp/x", old_string: "a", new_string: "b" },
			{ path: ":~//tmp/x", old_string: "a", new_string: "b" },
			{ paths: ["src/a.ts", "~//tmp/x"] },
			{ input: "[~//tmp/x#1a2b]\nPUT 1\n+x\n" },
			{ input: "[src/a.ts#1a2b]\nMV ~//tmp/y\n", paths: ["src/a.ts"], path: "src/a.ts" },
			{ input: "*** Begin Patch\n*** Update File: ~//tmp/x\n@@\n-a\n+b\n*** End Patch\n" },
			{ input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: ~//tmp/y\n@@\n-a\n+b\n*** End Patch\n" },
			{ path: "src/a.ts", edits: [{ op: "update", rename: "~//tmp/y" }] },
		];
		for (const input of cases) expect([input, edit(input)]).toEqual([input, expect.stringMatching(outside)]);
		// Read the same way by both, inside the workspace: let through.
		expect(edit({ path: "~/tmp/x", old_string: "a", new_string: "b" })).toBeUndefined();
		expect(edit({ input: "[~/tmp/src/a.ts#1a2b]\nPUT 1\n+x\n" })).toBeUndefined();
		// write resolves with OMP's TS expandPath, which reads ~//tmp/x under home.
		expect(guardOmpToolCall("write", { path: "~//tmp/x", content: "x" }, options)).toBeUndefined();
	});
});

describe("final review: OMP's .env and secrets.yml, and the stores PI_CONFIG_DIR moves", () => {
	it("counts .env and secrets.yml with agent.db and models.yml: each profile, a moved agent dir, ~/$PI_CONFIG_DIR and its profiles", () => {
		const { home } = setup();
		mkdirSync(join(home, ".omp-alt", "profiles", "lab", "agent"), { recursive: true });
		const stores = (agent: string) => ["agent.db", "models.yml", ".env", "secrets.yml"].map((name) => join(agent, name));
		expect(ompCredentials({ PI_CONFIG_DIR: ".omp-alt", PI_CODING_AGENT_DIR: "/srv/omp" }, home)).toEqual([
			join(home, ".omp", "profiles", "work", ".env"),
			...stores(join(home, ".omp", "profiles", "work", "agent")),
			join(home, ".omp-alt", ".env"),
			...stores(join(home, ".omp-alt", "agent")),
			join(home, ".omp-alt", "profiles", "lab", ".env"),
			...stores(join(home, ".omp-alt", "profiles", "lab", "agent")),
			...stores("/srv/omp"),
		]);
		// OMP joins PI_CONFIG_DIR under home, an absolute one too (utils/src/dirs.ts getBaseConfigRoot).
		const nobody = join(dir, "nobody");
		expect(ompCredentials({ PI_CONFIG_DIR: "/cfg" }, nobody)).toEqual([join(nobody, "cfg", ".env"), ...stores(join(nobody, "cfg", "agent"))]);
		expect(ompCredentials({ PI_CONFIG_DIR: ".omp" }, nobody)).toEqual([]);
	});

	it("are refused in every tool's judgment: by name, through the given home's PI_CONFIG_DIR, as a search root and through a link", () => {
		const { workspace, home } = setup();
		mkdirSync(join(home, ".omp-alt", "profiles", "lab", "agent"), { recursive: true });
		mkdirSync(join(home, ".omp-alt", "agent"));
		writeFileSync(join(home, ".omp-alt", "agent", "models.yml"), "providers: {}");
		const options = { workspace, allowedRoots: [], cwd: workspace, home, credentials: ompCredentials({ PI_CONFIG_DIR: ".omp-alt" }, home), foreignViews: [] as string[] };
		const paths = [
			"~/.omp/.env",
			"~/.omp/agent/.env",
			"~/.omp/agent/secrets.yml",
			"~/.omp/profiles/work/.env",
			"~/.omp/profiles/work/agent/.env",
			"~/.omp/profiles/work/agent/secrets.yml",
			"~/.omp-alt/.env",
			"~/.omp-alt/agent/agent.db",
			"~/.omp-alt/agent/models.yml",
			"~/.omp-alt/agent/.env",
			"~/.omp-alt/agent/secrets.yml",
			"~/.omp-alt/profiles/lab/agent/secrets.yml",
		];
		for (const path of paths) {
			expect([path, guardToolCall("read", { path }, options)]).toEqual([path, expect.stringMatching(/sensitive/)]);
			expect([path, guardOmpToolCall("read", { path }, options)]).toEqual([path, expect.stringMatching(/sensitive/)]);
		}
		expect(guardToolCall("bash", { command: "cat ~/.omp/agent/secrets.yml" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("bash", { command: "cat ~/.omp/.env" }, options)).toMatch(/sensitive/);
		expect(guardOmpToolCall("edit", { input: "[src/a.ts#1a2b]\nPUT 1\n+see ~/.omp/agent/.env\n" }, options)).toMatch(/sensitive/);
		expect(guardOmpToolCall("grep", { pattern: "k", path: "~/.omp-alt" }, options)).toMatch(/narrower folder/);
		symlinkSync(join(home, ".omp-alt", "agent", "models.yml"), join(workspace, "models-link.yml"));
		expect(guardToolCall("read", { path: "models-link.yml" }, options)).toMatch(/sensitive/);
		// Their neighbours are not credentials.
		for (const path of ["~/.omp/agent/config.yml", "~/.omp-alt/agent/config.yml", "~/.omp/agent/.envrc"]) expect([path, guardToolCall("read", { path }, options)]).toEqual([path, undefined]);
	});
});

describe("OMP: only the agent that owns a folder's memory view reads it", () => {
	afterEach(async () => {
		await ompCleanup();
		await cleanup();
	});

	/** The world's two lanes, Atlas and Birch, each set up the file way: a memory view in its folder. */
	function viewWorld() {
		const made = world();
		dir = made.root;
		const views = { atlasView: join(made.root, "agent-Atlas", ".orrery", "view.md"), birchView: join(made.root, "agent-Birch", ".orrery", "view.md") };
		for (const [name, path] of [
			["Atlas", views.atlasView],
			["Birch", views.birchView],
		]) {
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, `${name}'s view: secret`);
		}
		return { ...made, ...views, atlas: join(made.root, "agent-Atlas"), birch: join(made.root, "agent-Birch") };
	}
	const call = async (omp: FakeOmp, toolName: string, input: Record<string, unknown>) => (await omp.emit("tool_call", { toolName, toolCallId: "t1", input }))[0];
	const refused = { block: true, reason: expect.stringMatching(/sensitive|memory view/) };

	it("refuses Atlas a read of Birch's view and any search whose root holds it; Atlas's own view stays open", async () => {
		const { config, atlas, birch, birchView } = viewWorld();
		symlinkSync(birchView, join(atlas, "notes.md"));
		const omp = await ompOrrery(atlas, config);
		expect(omp.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		const calls: [string, Record<string, unknown>][] = [
			["read", { path: birchView }],
			["read", { path: "../agent-Birch/.orrery/view.md" }],
			["read", { path: "notes.md" }],
			["read", { path: `src/a.ts ${birchView}` }],
			["read", { path: `${birchView}:1-5` }],
			["edit", { path: birchView, input: "x" }],
			["write", { path: birchView, content: "planted" }],
			["grep", { pattern: "secret", path: birch }],
			["grep", { pattern: "secret", path: "../agent-Birch" }],
			["glob", { path: `${birchView}` }],
			["ast_grep", { pat: "x", path: birch }],
			["find", { query: "secret", grep_keywords: [], path: birch }],
			["bash", { command: `cat ${birchView}` }],
			["eval", { language: "py", code: `open('${birchView}').read()` }],
		];
		for (const [tool, input] of calls) expect([tool, input, await call(omp, tool, input)]).toEqual([tool, input, refused]);
		expect(await call(omp, "read", { path: ".orrery/view.md" })).toBeUndefined();
		expect(await call(omp, "grep", { pattern: "secret", path: "." })).toBeUndefined();
		const atlasView = join(atlas, ".orrery", "view.md");
		expect(await call(omp, "bash", { command: `cat ${atlasView}` })).toBeUndefined();
		// OMP's shell keeps its folder across calls: after `cd <Birch>`, a relative name is Birch's, whatever ctx.cwd says.
		expect(await call(omp, "bash", { command: `cd ${birch}` })).toBeUndefined();
		expect(await call(omp, "bash", { command: "cat .orrery/view.md" })).toEqual(refused);
		// glob lists names only (fix round 1): a listing of Birch's folder goes through.
		expect(await call(omp, "glob", { path: `${birch}/**/*.md` })).toBeUndefined();
		expect(await call(omp, "glob", { path: birch })).toBeUndefined();
	});

	it("refuses Birch's view to Atlas opened by ORRERY_AGENT in Birch's folder, and keeps Atlas's own open", async () => {
		const { config, atlasView, birch } = viewWorld();
		const omp = await ompOrrery(birch, config, { env: { ORRERY_AGENT: "Atlas" } });
		expect(omp.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		expect(await call(omp, "read", { path: ".orrery/view.md" })).toEqual(refused);
		expect(await call(omp, "grep", { pattern: "secret", path: "." })).toEqual(refused);
		expect(await call(omp, "ast_grep", { pat: "x", path: "." })).toEqual(refused);
		expect(await call(omp, "find", { query: "secret", grep_keywords: ["secret"], path: "." })).toEqual(refused);
		expect(await call(omp, "glob", { path: "**/*.md" })).toBeUndefined();
		expect(await call(omp, "bash", { command: "cat .orrery/view.md" })).toEqual(refused);
		expect(await call(omp, "read", { path: atlasView })).toBeUndefined();
	});

	it("keeps Atlas's content searches out of Birch's folder once Birch is set up the file way, before its view is written (fix round 1)", async () => {
		const { config, atlas, birch, birchView } = viewWorld();
		rmSync(birchView);
		writeSetupMarker((config.lanes.get("Birch") as LaneConfig).dir, birch, "CLAUDE.md");
		const omp = await ompOrrery(atlas, config);
		expect(await call(omp, "grep", { pattern: "secret", path: birch })).toEqual(refused);
		expect(await call(omp, "glob", { path: birch })).toBeUndefined();
	});

	it("refuses shell text that names Orrery's config, to read or to change it (fix round 1)", async () => {
		const { config, atlas } = viewWorld();
		const omp = await ompOrrery(atlas, config);
		for (const command of ["cat ~/.orrery/config.toml", "sed -i s/Atlas/Birch/ ~/.orrery/config.toml", "printf '[' >> ~/.orrery/config.toml"]) {
			expect([command, await call(omp, "bash", { command })]).toEqual([command, refused]);
		}
		expect(await call(omp, "eval", { language: "py", code: "open('/home/x/.orrery/config.toml', 'a').write('[')" })).toEqual(refused);
	});

	it("refuses every lane's view to a refused ORRERY_AGENT, the folder's own lane's too", async () => {
		const { config, atlas, birchView } = viewWorld();
		const omp = await ompOrrery(atlas, config, { env: { ORRERY_AGENT: "Nobody" } });
		expect(await call(omp, "read", { path: ".orrery/view.md" })).toEqual(refused);
		expect(await call(omp, "grep", { pattern: "secret", path: "." })).toEqual(refused);
		expect(await call(omp, "read", { path: birchView })).toEqual(refused);
	});
});
