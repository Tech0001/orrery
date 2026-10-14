import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupMarker, viewFile } from "../../src/claude/paths.ts";
import { claudeSetup } from "../../src/claude/setup.ts";
import { agentMode, markedHere, readSetupMarker, refreshViewFile, VIEW_IMPORT, viewGate, viewImported, writeSetupMarker, writeViewFile } from "../../src/claude/view-file.ts";
import { memorySection } from "../../src/agent/view-text.ts";
import { MemoryStore, MemoryView } from "../../src/memory/index.ts";
import { brokenGit, cleanupDirs, gitIn, seed, type TestAgent, testAgent, withEnv, withGit } from "./support.ts";

afterEach(cleanupDirs);

/** A view over the agent's memory, read-only. */
function withView(t: TestAgent, use: (view: MemoryView) => void): void {
	const store = MemoryStore.openReadOnly(join(t.agent.dir, "memory.sqlite"));
	try {
		use(new MemoryView(store, t.agent.memory.viewBytes));
	} finally {
		store.close();
	}
}

describe("the view file", () => {
	it("reads a mod-mode marker, and agentMode tells none, file and mod apart; a mod marker holds for any folder", () => {
		const t = testAgent({ setup: false });
		expect(agentMode(t.agent)).toBe("none");
		writeSetupMarker(t.agent.dir, t.agent.folder, "CLAUDE.md");
		expect(agentMode(t.agent)).toBe("file");
		writeSetupMarker(t.agent.dir, "/somewhere/else", "CLAUDE.md");
		expect(agentMode(t.agent)).toBe("none");
		writeSetupMarker(t.agent.dir, t.agent.folder, "mod");
		expect(readSetupMarker(t.agent.dir)?.file).toBe("mod");
		expect(agentMode(t.agent)).toBe("mod");
		writeSetupMarker(t.agent.dir, "/somewhere/else", "mod");
		expect(agentMode(t.agent)).toBe("mod");
	});

	it("keeps the marker's on-disk key workspace, so a marker an older build wrote still reads", () => {
		const t = testAgent({ setup: false });
		mkdirSync(join(t.agent.dir, "claude"), { recursive: true });
		writeFileSync(setupMarker(t.agent.dir), '{"workspace":"/w","file":"mod","at":1}');
		expect(readSetupMarker(t.agent.dir)).toEqual({ folder: "/w", file: "mod", at: 1 });
		expect(agentMode(t.agent)).toBe("mod");
		writeSetupMarker(t.agent.dir, t.agent.folder, "CLAUDE.md");
		expect(JSON.parse(readFileSync(setupMarker(t.agent.dir), "utf8"))).toMatchObject({ workspace: t.agent.folder, file: "CLAUDE.md" });
	});

	it("for an agent without a folder: no mode, no gate, and no view written, even with a marker", () => {
		const t = testAgent({ setup: true });
		seed(t.agent, ["one", "two"]);
		const { folder: _, ...nomad } = t.agent;
		expect(agentMode(nomad)).toBe("none");
		expect(markedHere(nomad)).toBe(false);
		expect(viewGate(nomad)).toEqual({ open: false });
		withView(t, (view) => expect(writeViewFile(nomad, view)).toBe(false));
		expect(existsSync(viewFile(t.folder))).toBe(false);
	});

	it("in mod mode the gate writes nothing and deletes a stale view file", () => {
		const t = testAgent();
		seed(t.agent, ["one", "two"]);
		writeFileSync(join(t.agent.folder, "CLAUDE.md"), "@AGENTS.md\n@.orrery/view.md\n");
		mkdirSync(join(t.agent.folder, ".orrery"), { recursive: true, mode: 0o700 });
		writeFileSync(viewFile(t.agent.folder), "old view");
		writeSetupMarker(t.agent.dir, t.agent.folder, "mod");
		expect(viewGate(t.agent)).toMatchObject({ open: false, mod: true });
		expect(existsSync(viewFile(t.agent.folder))).toBe(false);
		expect(refreshViewFile(t.agent)).toBe(2);
		expect(existsSync(viewFile(t.agent.folder))).toBe(false);
		expect(markedHere(t.agent)).toBe(true);
	});

	it("in mod mode the gate says why a stale view could not be deleted", () => {
		const t = testAgent();
		const dir = join(t.agent.folder, ".orrery");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(viewFile(t.agent.folder), "old view");
		writeSetupMarker(t.agent.dir, t.agent.folder, "mod");
		chmodSync(dir, 0o500);
		try {
			const gate = viewGate(t.agent);
			expect(gate).toMatchObject({ open: false, mod: true });
			expect(gate.failed).toEqual(expect.any(String));
		} finally {
			chmodSync(dir, 0o700);
		}
	});

	it("in mod mode the gate leaves a view file git tracks (the repo's), and one git cannot say about", () => {
		const t = testAgent();
		const git = gitIn(t.agent.folder);
		git("init", "-q");
		mkdirSync(join(t.agent.folder, ".orrery"), { mode: 0o700 });
		writeFileSync(viewFile(t.agent.folder), "the repo's own file");
		git("add", "-f", ".orrery/view.md");
		git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "view");
		writeSetupMarker(t.agent.dir, t.agent.folder, "mod");
		expect(viewGate(t.agent)).toMatchObject({ open: false, mod: true, removed: false });
		expect(readFileSync(viewFile(t.agent.folder), "utf8")).toBe("the repo's own file");
		// Untracked, but git cannot say this time: it stays until a later gate can ask.
		git("rm", "-q", "--cached", ".orrery/view.md");
		expect(withGit(brokenGit(t), () => viewGate(t.agent))).toMatchObject({ open: false, mod: true, removed: false });
		expect(existsSync(viewFile(t.agent.folder))).toBe(true);
		expect(viewGate(t.agent)).toMatchObject({ open: false, mod: true, removed: true });
		expect(existsSync(viewFile(t.agent.folder))).toBe(false);
	});

	it("is written only where claude-setup left its marker for this folder, and CLAUDE.md imports it", () => {
		const t = testAgent();
		seed(t.agent, ["Use pnpm here.", "Done."]);
		writeFileSync(join(t.folder, "CLAUDE.md"), `${VIEW_IMPORT}\n`);
		// A repo that commits the import line gets nothing: the trusted marker is missing.
		withView(t, (view) => expect(writeViewFile(t.agent, view)).toBe(false));
		expect(refreshViewFile(t.agent)).toBe(2);
		expect(existsSync(join(t.folder, ".orrery"))).toBe(false);
		// A marker that names another folder does not count either.
		writeSetupMarker(t.agent.dir, join(t.dir, "elsewhere"), "CLAUDE.md");
		withView(t, (view) => expect(writeViewFile(t.agent, view)).toBe(false));
		expect(refreshViewFile(t.agent)).toBe(2);
		expect(existsSync(join(t.folder, ".orrery"))).toBe(false);
		writeSetupMarker(t.agent.dir, t.folder, "CLAUDE.md");
		expect(readSetupMarker(t.agent.dir)).toMatchObject({ folder: t.folder, file: "CLAUDE.md" });
		expect(statSync(setupMarker(t.agent.dir)).mode & 0o777).toBe(0o600);
		expect(refreshViewFile(t.agent)).toBe(2);
		withView(t, (view) => {
			expect(readFileSync(viewFile(t.folder), "utf8")).toBe(memorySection(view, "claude-code"));
			expect(writeViewFile(t.agent, view)).toBe(true);
		});
	});

	it("counts only the import line in the file the marker names, and the marker's folder however it is spelled", () => {
		const t = testAgent();
		seed(t.agent, ["hello"]);
		// claude-setup put the line in CLAUDE.local.md, which is gone; a CLAUDE.md the repo commits does not count.
		writeFileSync(join(t.folder, "CLAUDE.md"), `${VIEW_IMPORT}\n`);
		writeSetupMarker(t.agent.dir, t.folder, "CLAUDE.local.md");
		expect(refreshViewFile(t.agent)).toBe(1);
		expect(existsSync(join(t.folder, ".orrery"))).toBe(false);
		writeFileSync(join(t.folder, "CLAUDE.local.md"), `${VIEW_IMPORT}\n`);
		refreshViewFile(t.agent);
		expect(existsSync(viewFile(t.folder))).toBe(true);
		// The same folder through a symlink, or with a trailing slash, is the same folder.
		rmSync(join(t.folder, ".orrery"), { recursive: true });
		symlinkSync(t.folder, join(t.dir, "ws-link"));
		writeSetupMarker(t.agent.dir, join(t.dir, "ws-link"), "CLAUDE.local.md");
		refreshViewFile(t.agent);
		expect(existsSync(viewFile(t.folder))).toBe(true);
		rmSync(join(t.folder, ".orrery"), { recursive: true });
		writeSetupMarker(t.agent.dir, `${t.folder}/`, "CLAUDE.local.md");
		refreshViewFile(t.agent);
		expect(existsSync(viewFile(t.folder))).toBe(true);
	});

	it("is never written where git would see it: the marker goes, and the view orrery wrote is deleted, never through a symlink", () => {
		// A repo where nothing ignores .orrery/: every writer (claude-setup, SessionStart, the holder) comes through here.
		const t = testAgent({ setup: true });
		gitIn(t.folder)("init", "-q");
		seed(t.agent, ["hello"]);
		mkdirSync(join(t.folder, ".orrery"));
		writeFileSync(viewFile(t.folder), "an older view\n");
		withView(t, (view) => expect(writeViewFile(t.agent, view)).toBe(false));
		expect([readSetupMarker(t.agent.dir), existsSync(viewFile(t.folder))]).toEqual([undefined, false]);
		// The repo commits .orrery as a symlink: the view is withdrawn, and what the link points to stays.
		const u = testAgent({ setup: true });
		gitIn(u.folder)("init", "-q");
		seed(u.agent, ["hello"]);
		const outside = join(u.dir, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "view.md"), "outside\n");
		symlinkSync(outside, join(u.folder, ".orrery"));
		gitIn(u.folder)("add", ".orrery");
		expect(refreshViewFile(u.agent)).toBe(1);
		expect([readSetupMarker(u.agent.dir), readFileSync(join(outside, "view.md"), "utf8")]).toEqual([undefined, "outside\n"]);
		// view.md itself a symlink: unlink would take only the link, but a link is not orrery's view, so it stays.
		const w = testAgent({ setup: true });
		gitIn(w.folder)("init", "-q");
		seed(w.agent, ["hello"]);
		mkdirSync(join(w.folder, ".orrery"));
		writeFileSync(join(w.dir, "target.md"), "target\n");
		symlinkSync(join(w.dir, "target.md"), viewFile(w.folder));
		refreshViewFile(w.agent);
		expect([readSetupMarker(w.agent.dir), readFileSync(join(w.dir, "target.md"), "utf8")]).toEqual([undefined, "target\n"]);
		expect(lstatSync(viewFile(w.folder)).isSymbolicLink()).toBe(true);
	});

	it("fails closed until git answers: the view is taken out, the setup stays, and the next write puts it back", () => {
		const t = testAgent({ setup: true });
		seed(t.agent, ["hello"]);
		const empty = join(t.dir, "no-git");
		mkdirSync(empty);
		// No git installed: nothing can commit the view.
		withEnv({ PATH: empty }, () => refreshViewFile(t.agent));
		expect(existsSync(viewFile(t.folder))).toBe(true);
		// A git that fails for another reason than "not a git repository" (a timeout, an unsafe repo): no write, and the
		// view already there goes too, since git might see it. The marker stays: no setup to redo.
		withGit(brokenGit(t), () => withView(t, (view) => expect(writeViewFile(t.agent, view)).toBe(false)));
		expect(existsSync(viewFile(t.folder))).toBe(false);
		expect(readSetupMarker(t.agent.dir)).toBeDefined();
		// Git answers again: the next write puts the view back.
		withView(t, (view) => expect(writeViewFile(t.agent, view)).toBe(true));
		expect(existsSync(viewFile(t.folder))).toBe(true);
	});

	it("leaves nothing for git to stage when a pulled .gitignore un-ignores .orrery/ and check-ignore cannot answer", () => {
		const t = testAgent();
		const git = gitIn(t.folder);
		git("init", "-q");
		seed(t.agent, ["hello"]);
		claudeSetup(t.agent);
		expect(existsSync(viewFile(t.folder))).toBe(true);
		writeFileSync(join(t.folder, ".gitignore"), "!.orrery/\n");
		const gate = withGit(brokenGit(t, "check-ignore"), () => viewGate(t.agent));
		expect(gate).toMatchObject({ open: false, unchecked: expect.stringContaining("git could not say") });
		expect(existsSync(viewFile(t.folder))).toBe(false);
		expect(readSetupMarker(t.agent.dir)).toBeDefined();
		expect(git("add", "-A", "--dry-run")).not.toContain(".orrery");
	});

	it("withdraws the view before the marker: when the delete fails, the marker stays and the next gate finishes the job", () => {
		const t = testAgent({ setup: true });
		gitIn(t.folder)("init", "-q");
		seed(t.agent, ["hello"]);
		mkdirSync(join(t.folder, ".orrery"));
		writeFileSync(viewFile(t.folder), "an older view\n");
		chmodSync(join(t.folder, ".orrery"), 0o500);
		try {
			const gate = viewGate(t.agent);
			// A failed withdrawal, said as such: git did answer.
			expect(gate).toMatchObject({ open: false, exposed: { kind: "not ignored" }, failed: expect.stringContaining("EACCES") });
			expect(gate.unchecked).toBeUndefined();
			expect([readSetupMarker(t.agent.dir) !== undefined, existsSync(viewFile(t.folder))]).toEqual([true, true]);
		} finally {
			chmodSync(join(t.folder, ".orrery"), 0o700);
		}
		const again = viewGate(t.agent);
		expect(again).toMatchObject({ open: false, exposed: { kind: "not ignored" } });
		expect(again.failed).toBeUndefined();
		expect([readSetupMarker(t.agent.dir), existsSync(viewFile(t.folder))]).toEqual([undefined, false]);
	});

	it("treats a .orrery that is a symlink or a file as not set up, and writes nothing through it", () => {
		const t = testAgent({ setup: true });
		seed(t.agent, ["hello"]);
		const outside = join(t.dir, "outside");
		mkdirSync(outside);
		chmodSync(outside, 0o755); // not through mkdir's mode, which the umask trims
		symlinkSync(outside, join(t.folder, ".orrery"));
		withView(t, (view) => expect(writeViewFile(t.agent, view)).toBe(false));
		expect(refreshViewFile(t.agent)).toBe(1);
		expect(readdirSync(outside)).toEqual([]);
		expect(statSync(outside).mode & 0o777).toBe(0o755);
		const u = testAgent({ setup: true });
		seed(u.agent, ["hello"]);
		writeFileSync(join(u.folder, ".orrery"), "planted");
		withView(u, (view) => expect(writeViewFile(u.agent, view)).toBe(false));
		expect(refreshViewFile(u.agent)).toBe(1);
		expect(readFileSync(join(u.folder, ".orrery"), "utf8")).toBe("planted");
	});

	it("reads CLAUDE.md only as a regular file: a symlink is never followed, so /dev/zero cannot hold it up", () => {
		const t = testAgent();
		writeFileSync(join(t.dir, "real.md"), `${VIEW_IMPORT}\n`);
		symlinkSync(join(t.dir, "real.md"), join(t.folder, "CLAUDE.md"));
		expect(viewImported(t.folder)).toBe(false);
		const u = testAgent();
		symlinkSync("/dev/zero", join(u.folder, "CLAUDE.md"));
		const started = Date.now();
		expect(viewImported(u.folder)).toBe(false);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("looks for the import line only in the first 256 KB of CLAUDE.md", () => {
		const t = testAgent();
		writeFileSync(join(t.folder, "CLAUDE.local.md"), `${"x".repeat(300 * 1024)}\n${VIEW_IMPORT}\n`);
		expect(viewImported(t.folder)).toBe(false);
		writeFileSync(join(t.folder, "CLAUDE.local.md"), `# Notes\n${VIEW_IMPORT}\n${"x".repeat(300 * 1024)}\n`);
		expect(viewImported(t.folder)).toBe(true);
	});
});
