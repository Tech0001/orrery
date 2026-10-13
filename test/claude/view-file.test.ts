import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupMarker, viewFile } from "../../src/claude/paths.ts";
import { claudeSetup } from "../../src/claude/setup.ts";
import { laneMode, markedHere, readSetupMarker, refreshViewFile, VIEW_IMPORT, viewGate, viewImported, writeSetupMarker, writeViewFile } from "../../src/claude/view-file.ts";
import { memorySection } from "../../src/lane/view-text.ts";
import { MemoryStore, MemoryView } from "../../src/memory/index.ts";
import { brokenGit, cleanupDirs, gitIn, seed, type TestLane, testLane, withEnv, withGit } from "./support.ts";

afterEach(cleanupDirs);

/** A view over the lane's memory, read-only. */
function withView(t: TestLane, use: (view: MemoryView) => void): void {
	const store = MemoryStore.openReadOnly(join(t.lane.dir, "memory.sqlite"));
	try {
		use(new MemoryView(store, t.lane.memory.viewBytes));
	} finally {
		store.close();
	}
}

describe("the view file", () => {
	it("reads a mod-mode marker, and laneMode tells none, file and mod apart", () => {
		const t = testLane({ setup: false });
		expect(laneMode(t.lane)).toBe("none");
		writeSetupMarker(t.lane.dir, t.lane.workspace, "CLAUDE.md");
		expect(laneMode(t.lane)).toBe("file");
		writeSetupMarker(t.lane.dir, t.lane.workspace, "mod");
		expect(readSetupMarker(t.lane.dir)?.file).toBe("mod");
		expect(laneMode(t.lane)).toBe("mod");
		writeSetupMarker(t.lane.dir, "/somewhere/else", "mod");
		expect(laneMode(t.lane)).toBe("none");
	});

	it("in mod mode the gate writes nothing and deletes a stale view file", () => {
		const t = testLane();
		seed(t.lane, ["one", "two"]);
		writeFileSync(join(t.lane.workspace, "CLAUDE.md"), "@AGENTS.md\n@.orrery/view.md\n");
		mkdirSync(join(t.lane.workspace, ".orrery"), { recursive: true, mode: 0o700 });
		writeFileSync(viewFile(t.lane.workspace), "old view");
		writeSetupMarker(t.lane.dir, t.lane.workspace, "mod");
		expect(viewGate(t.lane)).toMatchObject({ open: false, mod: true });
		expect(existsSync(viewFile(t.lane.workspace))).toBe(false);
		expect(refreshViewFile(t.lane)).toBe(2);
		expect(existsSync(viewFile(t.lane.workspace))).toBe(false);
		expect(markedHere(t.lane)).toBe(true);
	});

	it("in mod mode the gate says why a stale view could not be deleted", () => {
		const t = testLane();
		const dir = join(t.lane.workspace, ".orrery");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(viewFile(t.lane.workspace), "old view");
		writeSetupMarker(t.lane.dir, t.lane.workspace, "mod");
		chmodSync(dir, 0o500);
		try {
			const gate = viewGate(t.lane);
			expect(gate).toMatchObject({ open: false, mod: true });
			expect(gate.failed).toEqual(expect.any(String));
		} finally {
			chmodSync(dir, 0o700);
		}
	});

	it("in mod mode the gate leaves a view file git tracks (the repo's), and one git cannot say about", () => {
		const t = testLane();
		const git = gitIn(t.lane.workspace);
		git("init", "-q");
		mkdirSync(join(t.lane.workspace, ".orrery"), { mode: 0o700 });
		writeFileSync(viewFile(t.lane.workspace), "the repo's own file");
		git("add", "-f", ".orrery/view.md");
		git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "view");
		writeSetupMarker(t.lane.dir, t.lane.workspace, "mod");
		expect(viewGate(t.lane)).toMatchObject({ open: false, mod: true, removed: false });
		expect(readFileSync(viewFile(t.lane.workspace), "utf8")).toBe("the repo's own file");
		// Untracked, but git cannot say this time: it stays until a later gate can ask.
		git("rm", "-q", "--cached", ".orrery/view.md");
		expect(withGit(brokenGit(t), () => viewGate(t.lane))).toMatchObject({ open: false, mod: true, removed: false });
		expect(existsSync(viewFile(t.lane.workspace))).toBe(true);
		expect(viewGate(t.lane)).toMatchObject({ open: false, mod: true, removed: true });
		expect(existsSync(viewFile(t.lane.workspace))).toBe(false);
	});

	it("is written only where claude-setup left its marker for this workspace, and CLAUDE.md imports it", () => {
		const t = testLane();
		seed(t.lane, ["Use pnpm here.", "Done."]);
		writeFileSync(join(t.workspace, "CLAUDE.md"), `${VIEW_IMPORT}\n`);
		// A repo that commits the import line gets nothing: the trusted marker is missing.
		withView(t, (view) => expect(writeViewFile(t.lane, view)).toBe(false));
		expect(refreshViewFile(t.lane)).toBe(2);
		expect(existsSync(join(t.workspace, ".orrery"))).toBe(false);
		// A marker that names another workspace does not count either.
		writeSetupMarker(t.lane.dir, join(t.dir, "elsewhere"), "CLAUDE.md");
		withView(t, (view) => expect(writeViewFile(t.lane, view)).toBe(false));
		expect(refreshViewFile(t.lane)).toBe(2);
		expect(existsSync(join(t.workspace, ".orrery"))).toBe(false);
		writeSetupMarker(t.lane.dir, t.workspace, "CLAUDE.md");
		expect(readSetupMarker(t.lane.dir)).toMatchObject({ workspace: t.workspace, file: "CLAUDE.md" });
		expect(statSync(setupMarker(t.lane.dir)).mode & 0o777).toBe(0o600);
		expect(refreshViewFile(t.lane)).toBe(2);
		withView(t, (view) => {
			expect(readFileSync(viewFile(t.workspace), "utf8")).toBe(memorySection(view, "claude-code"));
			expect(writeViewFile(t.lane, view)).toBe(true);
		});
	});

	it("counts only the import line in the file the marker names, and the marker's workspace however it is spelled", () => {
		const t = testLane();
		seed(t.lane, ["hello"]);
		// claude-setup put the line in CLAUDE.local.md, which is gone; a CLAUDE.md the repo commits does not count.
		writeFileSync(join(t.workspace, "CLAUDE.md"), `${VIEW_IMPORT}\n`);
		writeSetupMarker(t.lane.dir, t.workspace, "CLAUDE.local.md");
		expect(refreshViewFile(t.lane)).toBe(1);
		expect(existsSync(join(t.workspace, ".orrery"))).toBe(false);
		writeFileSync(join(t.workspace, "CLAUDE.local.md"), `${VIEW_IMPORT}\n`);
		refreshViewFile(t.lane);
		expect(existsSync(viewFile(t.workspace))).toBe(true);
		// The same folder through a symlink, or with a trailing slash, is the same workspace.
		rmSync(join(t.workspace, ".orrery"), { recursive: true });
		symlinkSync(t.workspace, join(t.dir, "ws-link"));
		writeSetupMarker(t.lane.dir, join(t.dir, "ws-link"), "CLAUDE.local.md");
		refreshViewFile(t.lane);
		expect(existsSync(viewFile(t.workspace))).toBe(true);
		rmSync(join(t.workspace, ".orrery"), { recursive: true });
		writeSetupMarker(t.lane.dir, `${t.workspace}/`, "CLAUDE.local.md");
		refreshViewFile(t.lane);
		expect(existsSync(viewFile(t.workspace))).toBe(true);
	});

	it("is never written where git would see it: the marker goes, and the view orrery wrote is deleted, never through a symlink", () => {
		// A repo where nothing ignores .orrery/: every writer (claude-setup, SessionStart, the holder) comes through here.
		const t = testLane({ setup: true });
		gitIn(t.workspace)("init", "-q");
		seed(t.lane, ["hello"]);
		mkdirSync(join(t.workspace, ".orrery"));
		writeFileSync(viewFile(t.workspace), "an older view\n");
		withView(t, (view) => expect(writeViewFile(t.lane, view)).toBe(false));
		expect([readSetupMarker(t.lane.dir), existsSync(viewFile(t.workspace))]).toEqual([undefined, false]);
		// The repo commits .orrery as a symlink: the view is withdrawn, and what the link points to stays.
		const u = testLane({ setup: true });
		gitIn(u.workspace)("init", "-q");
		seed(u.lane, ["hello"]);
		const outside = join(u.dir, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "view.md"), "outside\n");
		symlinkSync(outside, join(u.workspace, ".orrery"));
		gitIn(u.workspace)("add", ".orrery");
		expect(refreshViewFile(u.lane)).toBe(1);
		expect([readSetupMarker(u.lane.dir), readFileSync(join(outside, "view.md"), "utf8")]).toEqual([undefined, "outside\n"]);
		// view.md itself a symlink: unlink would take only the link, but a link is not orrery's view, so it stays.
		const w = testLane({ setup: true });
		gitIn(w.workspace)("init", "-q");
		seed(w.lane, ["hello"]);
		mkdirSync(join(w.workspace, ".orrery"));
		writeFileSync(join(w.dir, "target.md"), "target\n");
		symlinkSync(join(w.dir, "target.md"), viewFile(w.workspace));
		refreshViewFile(w.lane);
		expect([readSetupMarker(w.lane.dir), readFileSync(join(w.dir, "target.md"), "utf8")]).toEqual([undefined, "target\n"]);
		expect(lstatSync(viewFile(w.workspace)).isSymbolicLink()).toBe(true);
	});

	it("fails closed until git answers: the view is taken out, the setup stays, and the next write puts it back", () => {
		const t = testLane({ setup: true });
		seed(t.lane, ["hello"]);
		const empty = join(t.dir, "no-git");
		mkdirSync(empty);
		// No git installed: nothing can commit the view.
		withEnv({ PATH: empty }, () => refreshViewFile(t.lane));
		expect(existsSync(viewFile(t.workspace))).toBe(true);
		// A git that fails for another reason than "not a git repository" (a timeout, an unsafe repo): no write, and the
		// view already there goes too, since git might see it. The marker stays: no setup to redo.
		withGit(brokenGit(t), () => withView(t, (view) => expect(writeViewFile(t.lane, view)).toBe(false)));
		expect(existsSync(viewFile(t.workspace))).toBe(false);
		expect(readSetupMarker(t.lane.dir)).toBeDefined();
		// Git answers again: the next write puts the view back.
		withView(t, (view) => expect(writeViewFile(t.lane, view)).toBe(true));
		expect(existsSync(viewFile(t.workspace))).toBe(true);
	});

	it("leaves nothing for git to stage when a pulled .gitignore un-ignores .orrery/ and check-ignore cannot answer", () => {
		const t = testLane();
		const git = gitIn(t.workspace);
		git("init", "-q");
		seed(t.lane, ["hello"]);
		claudeSetup(t.lane);
		expect(existsSync(viewFile(t.workspace))).toBe(true);
		writeFileSync(join(t.workspace, ".gitignore"), "!.orrery/\n");
		const gate = withGit(brokenGit(t, "check-ignore"), () => viewGate(t.lane));
		expect(gate).toMatchObject({ open: false, unchecked: expect.stringContaining("git could not say") });
		expect(existsSync(viewFile(t.workspace))).toBe(false);
		expect(readSetupMarker(t.lane.dir)).toBeDefined();
		expect(git("add", "-A", "--dry-run")).not.toContain(".orrery");
	});

	it("withdraws the view before the marker: when the delete fails, the marker stays and the next gate finishes the job", () => {
		const t = testLane({ setup: true });
		gitIn(t.workspace)("init", "-q");
		seed(t.lane, ["hello"]);
		mkdirSync(join(t.workspace, ".orrery"));
		writeFileSync(viewFile(t.workspace), "an older view\n");
		chmodSync(join(t.workspace, ".orrery"), 0o500);
		try {
			const gate = viewGate(t.lane);
			// A failed withdrawal, said as such: git did answer.
			expect(gate).toMatchObject({ open: false, exposed: { kind: "not ignored" }, failed: expect.stringContaining("EACCES") });
			expect(gate.unchecked).toBeUndefined();
			expect([readSetupMarker(t.lane.dir) !== undefined, existsSync(viewFile(t.workspace))]).toEqual([true, true]);
		} finally {
			chmodSync(join(t.workspace, ".orrery"), 0o700);
		}
		const again = viewGate(t.lane);
		expect(again).toMatchObject({ open: false, exposed: { kind: "not ignored" } });
		expect(again.failed).toBeUndefined();
		expect([readSetupMarker(t.lane.dir), existsSync(viewFile(t.workspace))]).toEqual([undefined, false]);
	});

	it("treats a .orrery that is a symlink or a file as not set up, and writes nothing through it", () => {
		const t = testLane({ setup: true });
		seed(t.lane, ["hello"]);
		const outside = join(t.dir, "outside");
		mkdirSync(outside);
		chmodSync(outside, 0o755); // not through mkdir's mode, which the umask trims
		symlinkSync(outside, join(t.workspace, ".orrery"));
		withView(t, (view) => expect(writeViewFile(t.lane, view)).toBe(false));
		expect(refreshViewFile(t.lane)).toBe(1);
		expect(readdirSync(outside)).toEqual([]);
		expect(statSync(outside).mode & 0o777).toBe(0o755);
		const u = testLane({ setup: true });
		seed(u.lane, ["hello"]);
		writeFileSync(join(u.workspace, ".orrery"), "planted");
		withView(u, (view) => expect(writeViewFile(u.lane, view)).toBe(false));
		expect(refreshViewFile(u.lane)).toBe(1);
		expect(readFileSync(join(u.workspace, ".orrery"), "utf8")).toBe("planted");
	});

	it("reads CLAUDE.md only as a regular file: a symlink is never followed, so /dev/zero cannot hold it up", () => {
		const t = testLane();
		writeFileSync(join(t.dir, "real.md"), `${VIEW_IMPORT}\n`);
		symlinkSync(join(t.dir, "real.md"), join(t.workspace, "CLAUDE.md"));
		expect(viewImported(t.workspace)).toBe(false);
		const u = testLane();
		symlinkSync("/dev/zero", join(u.workspace, "CLAUDE.md"));
		const started = Date.now();
		expect(viewImported(u.workspace)).toBe(false);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("looks for the import line only in the first 256 KB of CLAUDE.md", () => {
		const t = testLane();
		writeFileSync(join(t.workspace, "CLAUDE.local.md"), `${"x".repeat(300 * 1024)}\n${VIEW_IMPORT}\n`);
		expect(viewImported(t.workspace)).toBe(false);
		writeFileSync(join(t.workspace, "CLAUDE.local.md"), `# Notes\n${VIEW_IMPORT}\n${"x".repeat(300 * 1024)}\n`);
		expect(viewImported(t.workspace)).toBe(true);
	});
});
