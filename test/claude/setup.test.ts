import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { viewFile } from "../../src/claude/paths.ts";
import { claudeSetup, claudeSetupMod, gitExclude, modSetupReport, setupReport } from "../../src/claude/setup.ts";
import { laneMode, readSetupMarker, refreshViewFile, viewImported } from "../../src/claude/view-file.ts";
import { brokenGit, cleanupDirs, cleanEnv, gitIn, MAIN, seed, type TestLane, testLane, withEnv, withGit } from "./support.ts";

afterEach(cleanupDirs);

/** A git repo in the lane's workspace with CLAUDE.md and AGENTS.md committed, as a shared repo has them. */
function repo(t: TestLane): (...args: string[]) => string {
	const git = gitIn(t.workspace);
	git("init", "-q");
	writeFileSync(join(t.workspace, "CLAUDE.md"), "@AGENTS.md\n");
	writeFileSync(join(t.workspace, "AGENTS.md"), "You are Hazel.\n");
	git("add", ".");
	git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
	return git;
}

/** A folder outside the workspace, mode 0755, to plant symlinks to. */
function outsideFolder(t: TestLane): string {
	const dir = join(t.dir, "outside");
	mkdirSync(dir);
	chmodSync(dir, 0o755); // not through mkdir's mode, which the umask trims
	return dir;
}

/** The repo's .git/info/exclude as it stands, read only when it is a regular file. */
function excludeText(t: TestLane): string {
	const path = join(t.workspace, ".git", "info", "exclude");
	try {
		return lstatSync(path).isFile() ? readFileSync(path, "utf8") : "(not a file)";
	} catch {
		return "(none)";
	}
}

describe("claude-setup --mod", () => {
	it("removes the view import, deletes the view and .orrery when empty, and marks the lane mod", () => {
		const t = testLane({ setup: false });
		seed(t.lane, ["a"]);
		claudeSetup(t.lane);
		expect(existsSync(viewFile(t.lane.workspace))).toBe(true);
		const result = claudeSetupMod(t.lane);
		expect(readFileSync(join(t.lane.workspace, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
		expect(result).toMatchObject({ lane: t.lane.name, removedFrom: [join(t.lane.workspace, "CLAUDE.md")], viewDeleted: true, messages: 1 });
		expect(existsSync(join(t.lane.workspace, ".orrery"))).toBe(false);
		expect(laneMode(t.lane)).toBe("mod");
		expect(modSetupReport(result)).toContain("mod mode");
	});

	it("removes the line from CLAUDE.local.md too, keeps other lines, and never writes through a symlinked CLAUDE.md", () => {
		const t = testLane({ setup: false });
		writeFileSync(join(t.lane.workspace, "AGENTS.md"), "rules\n");
		symlinkSync("AGENTS.md", join(t.lane.workspace, "CLAUDE.md"));
		writeFileSync(join(t.lane.workspace, "CLAUDE.local.md"), "# mine\n@.orrery/view.md\nkeep me\n");
		const result = claudeSetupMod(t.lane);
		expect(readFileSync(join(t.lane.workspace, "CLAUDE.local.md"), "utf8")).toBe("# mine\nkeep me\n");
		expect(readFileSync(join(t.lane.workspace, "AGENTS.md"), "utf8")).toBe("rules\n");
		expect(result.removedFrom).toEqual([join(t.lane.workspace, "CLAUDE.local.md")]);
	});

	it("refuses, writing nothing, when a CLAUDE file is over 256 KB or not a regular file", () => {
		const t = testLane({ setup: false });
		const claudeMd = join(t.lane.workspace, "CLAUDE.md");
		writeFileSync(claudeMd, "@AGENTS.md\n@.orrery/view.md\n");
		writeFileSync(join(t.lane.workspace, "CLAUDE.local.md"), `@.orrery/view.md\n${"x".repeat(300 * 1024)}`);
		expect(() => claudeSetupMod(t.lane)).toThrow(/larger than 256 KB/);
		expect(laneMode(t.lane)).toBe("none");
		expect(readFileSync(claudeMd, "utf8")).toBe("@AGENTS.md\n@.orrery/view.md\n");
		rmSync(join(t.lane.workspace, "CLAUDE.local.md"));
		mkdirSync(join(t.lane.workspace, "CLAUDE.local.md"));
		expect(() => claudeSetupMod(t.lane)).toThrow(/cannot be edited safely/);
		expect(laneMode(t.lane)).toBe("none");
		expect(readFileSync(claudeMd, "utf8")).toBe("@AGENTS.md\n@.orrery/view.md\n");
	});

	it("in a git repo leaves a committed CLAUDE.md import (the repo's) and removes the CLAUDE.local.md one", () => {
		const t = testLane({ setup: false });
		const git = repo(t);
		writeFileSync(join(t.workspace, "CLAUDE.md"), "@AGENTS.md\n@.orrery/view.md\n");
		git("add", ".");
		git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "import");
		writeFileSync(join(t.workspace, "CLAUDE.local.md"), "@.orrery/view.md\nmine\n");
		const result = claudeSetupMod(t.lane);
		expect(readFileSync(join(t.workspace, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n@.orrery/view.md\n");
		expect(git("status", "--porcelain")).not.toContain("CLAUDE.md");
		expect(readFileSync(join(t.workspace, "CLAUDE.local.md"), "utf8")).toBe("mine\n");
		expect(result.removedFrom).toEqual([join(t.workspace, "CLAUDE.local.md")]);
		expect(result.keptIn).toBe(join(t.workspace, "CLAUDE.md"));
		expect(modSetupReport(result)).toContain("that line is the repo's and stays");
	});

	it("leaves a .orrery/view.md that git tracks", () => {
		const t = testLane({ setup: false });
		const git = repo(t);
		mkdirSync(join(t.workspace, ".orrery"), { mode: 0o700 });
		writeFileSync(viewFile(t.workspace), "the repo's own file");
		git("add", "-f", ".orrery/view.md");
		git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "view");
		const result = claudeSetupMod(t.lane);
		expect(result.viewDeleted).toBe(false);
		expect(readFileSync(viewFile(t.workspace), "utf8")).toBe("the repo's own file");
		expect(git("status", "--porcelain")).toBe("");
		expect(laneMode(t.lane)).toBe("mod");
	});

	it("leaves CLAUDE.md alone when git cannot say whether the workspace is a repo", () => {
		const t = testLane({ setup: false });
		writeFileSync(join(t.workspace, "CLAUDE.md"), "@AGENTS.md\n@.orrery/view.md\n");
		const result = withGit(brokenGit(t), () => claudeSetupMod(t.lane));
		expect(readFileSync(join(t.workspace, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n@.orrery/view.md\n");
		expect(result.removedFrom).toEqual([]);
		expect(result.keptIn).toBe(join(t.workspace, "CLAUDE.md"));
		expect(laneMode(t.lane)).toBe("mod");
	});

	it("is not blocked by a repo's own CLAUDE.md over 256 KB or not a regular file, which it does not edit", () => {
		const t = testLane({ setup: false });
		repo(t);
		const claudeMd = join(t.workspace, "CLAUDE.md");
		const big = `@AGENTS.md\n@.orrery/view.md\n${"x".repeat(300 * 1024)}\n`;
		writeFileSync(claudeMd, big);
		writeFileSync(join(t.workspace, "CLAUDE.local.md"), "@.orrery/view.md\n");
		const result = claudeSetupMod(t.lane);
		expect(readFileSync(claudeMd, "utf8")).toBe(big);
		expect(result.keptIn).toBe(claudeMd);
		expect(result.removedFrom).toEqual([join(t.workspace, "CLAUDE.local.md")]);
		expect(laneMode(t.lane)).toBe("mod");
		rmSync(claudeMd);
		mkdirSync(claudeMd);
		expect(claudeSetupMod(t.lane)).not.toHaveProperty("keptIn");
		expect(laneMode(t.lane)).toBe("mod");
	});

	it("succeeds with a planted .orrery symlink, touching nothing inside its target", () => {
		const t = testLane({ setup: false });
		const outside = outsideFolder(t);
		writeFileSync(join(outside, "view.md"), "not orrery's");
		symlinkSync(outside, join(t.workspace, ".orrery"));
		claudeSetupMod(t.lane);
		expect(laneMode(t.lane)).toBe("mod");
		expect(readFileSync(join(outside, "view.md"), "utf8")).toBe("not orrery's");
	});

	it("switches back: plain claude-setup puts the import back and marks the file", () => {
		const t = testLane({ setup: false });
		seed(t.lane, ["a"]);
		claudeSetupMod(t.lane);
		claudeSetup(t.lane);
		expect(readFileSync(join(t.lane.workspace, "CLAUDE.md"), "utf8")).toContain("@.orrery/view.md");
		expect(laneMode(t.lane)).toBe("file");
		expect(existsSync(viewFile(t.lane.workspace))).toBe(true);
	});

	it("is run by `orrery claude-setup <Lane> --mod`", () => {
		const t = testLane({ setup: false });
		const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, "--config", t.configPath, "claude-setup", t.lane.name, "--mod"], { env: cleanEnv({}), encoding: "utf8", timeout: 20_000 });
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("mod mode");
		expect(laneMode(t.lane)).toBe("mod");
	});
});

describe("orrery claude-setup", () => {
	it("gives a lane folder of its own a CLAUDE.md that loads AGENTS.md and the view, keeps what was there, and is safe to rerun", () => {
		const t = testLane();
		writeFileSync(join(t.workspace, "CLAUDE.md"), "# Notes\nKeep it short.");
		chmodSync(t.workspace, 0o755);
		seed(t.lane, ["hello", "hi"]);
		const first = claudeSetup(t.lane);
		// The workspace is the user's folder, not orrery's: its mode stays.
		expect(statSync(t.workspace).mode & 0o777).toBe(0o755);
		expect(first).toMatchObject({ file: join(t.workspace, "CLAUDE.md"), added: ["@AGENTS.md", "@.orrery/view.md"], messages: 2 });
		expect(first.exclude).toBeUndefined();
		const expected = "# Notes\nKeep it short.\n@AGENTS.md\n@.orrery/view.md\n";
		expect(readFileSync(join(t.workspace, "CLAUDE.md"), "utf8")).toBe(expected);
		expect(readSetupMarker(t.lane.dir)).toMatchObject({ workspace: t.workspace, file: "CLAUDE.md" });
		expect(claudeSetup(t.lane).added).toEqual([]);
		expect(readFileSync(join(t.workspace, "CLAUDE.md"), "utf8")).toBe(expected);
		expect(readSetupMarker(t.lane.dir)).toMatchObject({ workspace: t.workspace, file: "CLAUDE.md" });
		expect(viewImported(t.workspace)).toBe(true);
		expect(statSync(viewFile(t.workspace)).mode & 0o777).toBe(0o600);
		expect(setupReport(claudeSetup(t.lane))).toContain("already loads the memory view");
	});

	it("leaves a shared repo untouched: CLAUDE.local.md, excluded locally, and AGENTS.md imported once", () => {
		const t = testLane();
		const git = repo(t);
		seed(t.lane, ["hello"]);
		const result = claudeSetup(t.lane);
		expect(result).toMatchObject({ file: join(t.workspace, "CLAUDE.local.md"), added: ["@.orrery/view.md"], exclude: { added: ["CLAUDE.local.md", ".orrery/"] } });
		expect(git("status", "--porcelain")).toBe("");
		expect(readFileSync(join(t.workspace, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
		expect(existsSync(viewFile(t.workspace))).toBe(true);
		expect(readSetupMarker(t.lane.dir)).toMatchObject({ workspace: t.workspace, file: "CLAUDE.local.md" });
		const again = claudeSetup(t.lane);
		expect([again.added, again.exclude?.added]).toEqual([[], []]);
		expect(readSetupMarker(t.lane.dir)).toMatchObject({ workspace: t.workspace, file: "CLAUDE.local.md" });
		expect(readFileSync(gitExclude(t.workspace)!, "utf8").split("\n").filter((line) => line === "CLAUDE.local.md")).toHaveLength(1);
	});

	it("puts the lines in CLAUDE.local.md when CLAUDE.md is a symlink, and never writes through it", () => {
		const t = testLane();
		writeFileSync(join(t.workspace, "AGENTS.md"), "You are Rowan.\n");
		symlinkSync("AGENTS.md", join(t.workspace, "CLAUDE.md"));
		seed(t.lane, ["hello"]);
		const result = claudeSetup(t.lane);
		// CLAUDE.md -> AGENTS.md already loads AGENTS.md: only the view is imported.
		expect(result).toMatchObject({ file: join(t.workspace, "CLAUDE.local.md"), added: ["@.orrery/view.md"], claudeMdLink: "AGENTS.md" });
		expect(setupReport(result)).toContain("CLAUDE.md is a symlink");
		expect(lstatSync(join(t.workspace, "CLAUDE.md")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(t.workspace, "AGENTS.md"), "utf8")).toBe("You are Rowan.\n");
		expect(readSetupMarker(t.lane.dir)).toMatchObject({ file: "CLAUDE.local.md" });
		expect(existsSync(viewFile(t.workspace))).toBe(true);
		// A link to a file elsewhere: that file is never touched, and AGENTS.md is imported.
		const u = testLane();
		const outside = join(outsideFolder(u), "notes.md");
		writeFileSync(outside, "outside\n");
		symlinkSync(outside, join(u.workspace, "CLAUDE.md"));
		expect(claudeSetup(u.lane)).toMatchObject({ file: join(u.workspace, "CLAUDE.local.md"), added: ["@AGENTS.md", "@.orrery/view.md"] });
		expect(readFileSync(outside, "utf8")).toBe("outside\n");
	});

	it("prints a CLAUDE.md link's target escaped: a repo's terminal escapes never reach the terminal", () => {
		const t = testLane();
		// ESC sequences, BEL, DEL and an 8-bit CSI (U+009B), which JSON.stringify alone leaves as they are.
		const target = "AGENTS.md\x1b[2J\x1b]0;owned\x07\x7f\u009b31m";
		symlinkSync(target, join(t.workspace, "CLAUDE.md"));
		const result = claudeSetup(t.lane);
		expect(result.claudeMdLink).toBe(target);
		const report = setupReport(result);
		expect(report).toContain('CLAUDE.md is a symlink (to "AGENTS.md\\u001b[2J\\u001b]0;owned\\u0007\\u007f\\u009b31m")');
		expect(report).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
	});

	it("refuses a symlink where it would write (CLAUDE.local.md, .orrery, .git/info, its exclude), writing nothing anywhere", () => {
		const plants: Array<[string, (t: TestLane, outside: string) => void, RegExp]> = [
			["CLAUDE.local.md", (t, outside) => symlinkSync(join(outside, "file"), join(t.workspace, "CLAUDE.local.md")), /CLAUDE\.local\.md is a symlink/],
			[".orrery", (t, outside) => symlinkSync(outside, join(t.workspace, ".orrery")), /\.orrery is not a real folder/],
			[
				".git/info",
				(t, outside) => {
					rmSync(join(t.workspace, ".git", "info"), { recursive: true, force: true });
					symlinkSync(outside, join(t.workspace, ".git", "info"));
				},
				/info is not a real folder/,
			],
			[
				".git/info/exclude",
				(t, outside) => {
					rmSync(join(t.workspace, ".git", "info", "exclude"), { force: true });
					symlinkSync(join(outside, "file"), join(t.workspace, ".git", "info", "exclude"));
				},
				/exclude is a symlink/,
			],
		];
		for (const [, plant, refusal] of plants) {
			const t = testLane();
			repo(t);
			seed(t.lane, ["hello"]);
			const outside = outsideFolder(t);
			writeFileSync(join(outside, "file"), "outside\n");
			plant(t, outside);
			const before = [readdirSync(t.workspace).sort(), excludeText(t)];
			expect(() => claudeSetup(t.lane)).toThrow(refusal);
			expect(readdirSync(outside)).toEqual(["file"]);
			expect(readFileSync(join(outside, "file"), "utf8")).toBe("outside\n");
			expect(statSync(outside).mode & 0o777).toBe(0o755);
			expect([readdirSync(t.workspace).sort(), excludeText(t)]).toEqual(before);
			expect(readSetupMarker(t.lane.dir)).toBeUndefined();
		}
	});

	it("refuses a repo where git would see .orrery/: a .gitignore that un-ignores it, or a tracked file there", () => {
		const t = testLane();
		const git = repo(t);
		writeFileSync(join(t.workspace, ".gitignore"), "!.orrery/\n");
		seed(t.lane, ["hello"]);
		expect(() => claudeSetup(t.lane)).toThrow(/not ignored by git/);
		expect(existsSync(viewFile(t.workspace))).toBe(false);
		expect(existsSync(join(t.workspace, "CLAUDE.local.md"))).toBe(false);
		expect(readSetupMarker(t.lane.dir)).toBeUndefined();
		// Set up once it is ignored, then un-ignored again: a rerun refuses and takes the marker back.
		rmSync(join(t.workspace, ".gitignore"));
		claudeSetup(t.lane);
		expect(readSetupMarker(t.lane.dir)).toBeDefined();
		expect(existsSync(viewFile(t.workspace))).toBe(true);
		writeFileSync(join(t.workspace, ".gitignore"), "!.orrery/\n");
		expect(() => claudeSetup(t.lane)).toThrow(/not ignored by git/);
		expect(readSetupMarker(t.lane.dir)).toBeUndefined();
		// The view orrery wrote there is gone too, so git has nothing of it to show.
		expect(existsSync(viewFile(t.workspace))).toBe(false);
		expect(git("status", "--porcelain")).not.toContain(".orrery");

		const u = testLane();
		const ugit = repo(u);
		mkdirSync(join(u.workspace, ".orrery"));
		writeFileSync(viewFile(u.workspace), "tracked\n");
		ugit("add", ".orrery/view.md");
		seed(u.lane, ["hello"]);
		expect(() => claudeSetup(u.lane)).toThrow(/git tracks/);
		expect(readFileSync(viewFile(u.workspace), "utf8")).toBe("tracked\n");
		expect(existsSync(join(u.workspace, "CLAUDE.local.md"))).toBe(false);
		expect(readSetupMarker(u.lane.dir)).toBeUndefined();
	});

	it("refuses a folder named like .orrery in another case, which a case-insensitive disk takes for .orrery", () => {
		// Tracked as .Orrery/view.md with core.ignorecase (git sets it on such a disk), and not even on disk: only git knows.
		const t = testLane();
		const git = repo(t);
		git("config", "core.ignorecase", "true");
		mkdirSync(join(t.workspace, ".Orrery"));
		writeFileSync(join(t.workspace, ".Orrery", "view.md"), "tracked\n");
		git("add", ".Orrery/view.md");
		rmSync(join(t.workspace, ".Orrery"), { recursive: true });
		seed(t.lane, ["hello"]);
		expect(() => claudeSetup(t.lane)).toThrow(/git tracks/);
		expect([existsSync(viewFile(t.workspace)), existsSync(join(t.workspace, "CLAUDE.local.md")), readSetupMarker(t.lane.dir)]).toEqual([false, false, undefined]);
		// On disk and untracked: such a disk would write the view into it.
		const u = testLane();
		repo(u);
		mkdirSync(join(u.workspace, ".ORRERY"));
		seed(u.lane, ["hello"]);
		expect(() => claudeSetup(u.lane)).toThrow(/\.ORRERY/);
		expect([existsSync(viewFile(u.workspace)), existsSync(join(u.workspace, "CLAUDE.local.md")), readSetupMarker(u.lane.dir)]).toEqual([false, false, undefined]);
	});

	it("judges the workspace's own repo, whatever git variables it inherits", () => {
		const t = testLane();
		const git = repo(t);
		mkdirSync(join(t.workspace, ".orrery"));
		writeFileSync(viewFile(t.workspace), "tracked\n");
		git("add", ".orrery/view.md");
		const other = join(t.dir, "other");
		mkdirSync(other);
		gitIn(other)("init", "-q");
		const otherExclude = excludeText({ ...t, workspace: other });
		seed(t.lane, ["hello"]);
		// Inherited, these would make git judge (and take the exclude lines into) another repo, with another index.
		const elsewhere = { GIT_DIR: join(other, ".git"), GIT_INDEX_FILE: join(other, ".git", "index") };
		expect(() => withEnv(elsewhere, () => claudeSetup(t.lane))).toThrow(/git tracks/);
		expect(readFileSync(viewFile(t.workspace), "utf8")).toBe("tracked\n");
		expect(excludeText({ ...t, workspace: other })).toBe(otherExclude);
		expect(readSetupMarker(t.lane.dir)).toBeUndefined();
		// GIT_LITERAL_PATHSPECS would read ':(icase).orrery' as a file name, and a tracked .Orrery/view.md would pass.
		const u = testLane();
		const ugit = repo(u);
		ugit("config", "core.ignorecase", "true");
		mkdirSync(join(u.workspace, ".Orrery"));
		writeFileSync(join(u.workspace, ".Orrery", "view.md"), "tracked\n");
		ugit("add", ".Orrery/view.md");
		rmSync(join(u.workspace, ".Orrery"), { recursive: true });
		seed(u.lane, ["hello"]);
		expect(() => withEnv({ GIT_LITERAL_PATHSPECS: "1" }, () => claudeSetup(u.lane))).toThrow(/git tracks/);
		expect(readSetupMarker(u.lane.dir)).toBeUndefined();
	});

	it("fails closed: a git that cannot say whether it would see .orrery/ means no setup, and an earlier one stays", () => {
		const t = testLane();
		const broken = brokenGit(t);
		seed(t.lane, ["hello"]);
		expect(() => withGit(broken, () => claudeSetup(t.lane))).toThrow(/git could not say/);
		expect([existsSync(viewFile(t.workspace)), existsSync(join(t.workspace, "CLAUDE.md")), readSetupMarker(t.lane.dir)]).toEqual([false, false, undefined]);
		// Set up while git answers, then rerun while it cannot: the view is taken out until git answers, and the marker
		// stays, so the next write puts it back with no setup to redo.
		claudeSetup(t.lane);
		expect(() => withGit(broken, () => claudeSetup(t.lane))).toThrow(/git could not say/);
		expect([existsSync(viewFile(t.workspace)), readSetupMarker(t.lane.dir)?.file]).toEqual([false, "CLAUDE.md"]);
		refreshViewFile(t.lane);
		expect(existsSync(viewFile(t.workspace))).toBe(true);
	});

	it("works on a workspace configured through a symlink, and records it as configured", () => {
		const t = testLane();
		const link = join(t.dir, "ws-link");
		symlinkSync(t.workspace, link);
		const lane = { ...t.lane, workspace: link };
		seed(lane, ["hello"]);
		expect(claudeSetup(lane)).toMatchObject({ file: join(link, "CLAUDE.md"), messages: 1 });
		expect(readFileSync(join(t.workspace, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n@.orrery/view.md\n");
		expect(readSetupMarker(t.lane.dir)).toMatchObject({ workspace: link, file: "CLAUDE.md" });
		expect(existsSync(viewFile(t.workspace))).toBe(true);
	});

	it("refuses a lane whose workspace does not exist", () => {
		const t = testLane();
		rmSync(t.workspace, { recursive: true });
		expect(() => claudeSetup(t.lane)).toThrow(/does not exist/);
	});
});
