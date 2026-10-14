import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { viewFile } from "../../src/claude/paths.ts";
import { claudeSetup, claudeSetupMod, gitExclude, modSetupReport, setupReport } from "../../src/claude/setup.ts";
import { agentMode, readSetupMarker, refreshViewFile, viewImported } from "../../src/claude/view-file.ts";
import { brokenGit, cleanupDirs, cleanEnv, gitIn, MAIN, seed, type TestAgent, testAgent, withEnv, withGit } from "./support.ts";

afterEach(cleanupDirs);

/** A git repo in the agent's folder with CLAUDE.md and AGENTS.md committed, as a shared repo has them. */
function repo(t: TestAgent): (...args: string[]) => string {
	const git = gitIn(t.folder);
	git("init", "-q");
	writeFileSync(join(t.folder, "CLAUDE.md"), "@AGENTS.md\n");
	writeFileSync(join(t.folder, "AGENTS.md"), "You are Hazel.\n");
	git("add", ".");
	git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
	return git;
}

/** A folder outside the folder, mode 0755, to plant symlinks to. */
function outsideFolder(t: TestAgent): string {
	const dir = join(t.dir, "outside");
	mkdirSync(dir);
	chmodSync(dir, 0o755); // not through mkdir's mode, which the umask trims
	return dir;
}

/** The repo's .git/info/exclude as it stands, read only when it is a regular file. */
function excludeText(t: TestAgent): string {
	const path = join(t.folder, ".git", "info", "exclude");
	try {
		return lstatSync(path).isFile() ? readFileSync(path, "utf8") : "(not a file)";
	} catch {
		return "(none)";
	}
}

describe("claude-setup --mod", () => {
	it("refuses the file setup for an agent without a folder, writing nothing (--mod takes it: test/claude/agent-pick.test.ts)", () => {
		const t = testAgent();
		const { folder: _, ...nomad } = t.agent;
		expect(() => claudeSetup(nomad)).toThrow("Test has no folder; Claude Code's file setup needs one. Use orrery claude-setup Test --mod.");
		expect(readSetupMarker(t.agent.dir)).toBeUndefined();
	});

	it("removes the view import, deletes the view and .orrery when empty, and marks the agent mod", () => {
		const t = testAgent({ setup: false });
		seed(t.agent, ["a"]);
		claudeSetup(t.agent);
		expect(existsSync(viewFile(t.agent.folder))).toBe(true);
		const result = claudeSetupMod(t.agent);
		expect(readFileSync(join(t.agent.folder, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
		expect(result).toMatchObject({ agent: t.agent.name, removedFrom: [join(t.agent.folder, "CLAUDE.md")], viewDeleted: true, messages: 1 });
		expect(existsSync(join(t.agent.folder, ".orrery"))).toBe(false);
		expect(agentMode(t.agent)).toBe("mod");
		expect(modSetupReport(result)).toContain("mod mode");
	});

	it("removes the line from CLAUDE.local.md too, keeps other lines, and never writes through a symlinked CLAUDE.md", () => {
		const t = testAgent({ setup: false });
		writeFileSync(join(t.agent.folder, "AGENTS.md"), "rules\n");
		symlinkSync("AGENTS.md", join(t.agent.folder, "CLAUDE.md"));
		writeFileSync(join(t.agent.folder, "CLAUDE.local.md"), "# mine\n@.orrery/view.md\nkeep me\n");
		const result = claudeSetupMod(t.agent);
		expect(readFileSync(join(t.agent.folder, "CLAUDE.local.md"), "utf8")).toBe("# mine\nkeep me\n");
		expect(readFileSync(join(t.agent.folder, "AGENTS.md"), "utf8")).toBe("rules\n");
		expect(result.removedFrom).toEqual([join(t.agent.folder, "CLAUDE.local.md")]);
	});

	it("refuses, writing nothing, when a CLAUDE file is over 256 KB or not a regular file", () => {
		const t = testAgent({ setup: false });
		const claudeMd = join(t.agent.folder, "CLAUDE.md");
		writeFileSync(claudeMd, "@AGENTS.md\n@.orrery/view.md\n");
		writeFileSync(join(t.agent.folder, "CLAUDE.local.md"), `@.orrery/view.md\n${"x".repeat(300 * 1024)}`);
		expect(() => claudeSetupMod(t.agent)).toThrow(/larger than 256 KB/);
		expect(agentMode(t.agent)).toBe("none");
		expect(readFileSync(claudeMd, "utf8")).toBe("@AGENTS.md\n@.orrery/view.md\n");
		rmSync(join(t.agent.folder, "CLAUDE.local.md"));
		mkdirSync(join(t.agent.folder, "CLAUDE.local.md"));
		expect(() => claudeSetupMod(t.agent)).toThrow(/cannot be edited safely/);
		expect(agentMode(t.agent)).toBe("none");
		expect(readFileSync(claudeMd, "utf8")).toBe("@AGENTS.md\n@.orrery/view.md\n");
	});

	it("in a git repo leaves a committed CLAUDE.md import (the repo's) and removes the CLAUDE.local.md one", () => {
		const t = testAgent({ setup: false });
		const git = repo(t);
		writeFileSync(join(t.folder, "CLAUDE.md"), "@AGENTS.md\n@.orrery/view.md\n");
		git("add", ".");
		git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "import");
		writeFileSync(join(t.folder, "CLAUDE.local.md"), "@.orrery/view.md\nmine\n");
		const result = claudeSetupMod(t.agent);
		expect(readFileSync(join(t.folder, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n@.orrery/view.md\n");
		expect(git("status", "--porcelain")).not.toContain("CLAUDE.md");
		expect(readFileSync(join(t.folder, "CLAUDE.local.md"), "utf8")).toBe("mine\n");
		expect(result.removedFrom).toEqual([join(t.folder, "CLAUDE.local.md")]);
		expect(result.keptIn).toBe(join(t.folder, "CLAUDE.md"));
		expect(modSetupReport(result)).toContain("that line is the repo's and stays");
	});

	it("leaves a .orrery/view.md that git tracks", () => {
		const t = testAgent({ setup: false });
		const git = repo(t);
		mkdirSync(join(t.folder, ".orrery"), { mode: 0o700 });
		writeFileSync(viewFile(t.folder), "the repo's own file");
		git("add", "-f", ".orrery/view.md");
		git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "view");
		const result = claudeSetupMod(t.agent);
		expect(result.viewDeleted).toBe(false);
		expect(readFileSync(viewFile(t.folder), "utf8")).toBe("the repo's own file");
		expect(git("status", "--porcelain")).toBe("");
		expect(agentMode(t.agent)).toBe("mod");
	});

	it("leaves CLAUDE.md alone when git cannot say whether the folder is a repo", () => {
		const t = testAgent({ setup: false });
		writeFileSync(join(t.folder, "CLAUDE.md"), "@AGENTS.md\n@.orrery/view.md\n");
		const result = withGit(brokenGit(t), () => claudeSetupMod(t.agent));
		expect(readFileSync(join(t.folder, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n@.orrery/view.md\n");
		expect(result.removedFrom).toEqual([]);
		expect(result.keptIn).toBe(join(t.folder, "CLAUDE.md"));
		expect(agentMode(t.agent)).toBe("mod");
	});

	it("is not blocked by a repo's own CLAUDE.md over 256 KB or not a regular file, which it does not edit", () => {
		const t = testAgent({ setup: false });
		repo(t);
		const claudeMd = join(t.folder, "CLAUDE.md");
		const big = `@AGENTS.md\n@.orrery/view.md\n${"x".repeat(300 * 1024)}\n`;
		writeFileSync(claudeMd, big);
		writeFileSync(join(t.folder, "CLAUDE.local.md"), "@.orrery/view.md\n");
		const result = claudeSetupMod(t.agent);
		expect(readFileSync(claudeMd, "utf8")).toBe(big);
		expect(result.keptIn).toBe(claudeMd);
		expect(result.removedFrom).toEqual([join(t.folder, "CLAUDE.local.md")]);
		expect(agentMode(t.agent)).toBe("mod");
		rmSync(claudeMd);
		mkdirSync(claudeMd);
		expect(claudeSetupMod(t.agent)).not.toHaveProperty("keptIn");
		expect(agentMode(t.agent)).toBe("mod");
	});

	it("succeeds with a planted .orrery symlink, touching nothing inside its target", () => {
		const t = testAgent({ setup: false });
		const outside = outsideFolder(t);
		writeFileSync(join(outside, "view.md"), "not orrery's");
		symlinkSync(outside, join(t.folder, ".orrery"));
		claudeSetupMod(t.agent);
		expect(agentMode(t.agent)).toBe("mod");
		expect(readFileSync(join(outside, "view.md"), "utf8")).toBe("not orrery's");
	});

	it("switches back: plain claude-setup puts the import back and marks the file", () => {
		const t = testAgent({ setup: false });
		seed(t.agent, ["a"]);
		claudeSetupMod(t.agent);
		claudeSetup(t.agent);
		expect(readFileSync(join(t.agent.folder, "CLAUDE.md"), "utf8")).toContain("@.orrery/view.md");
		expect(agentMode(t.agent)).toBe("file");
		expect(existsSync(viewFile(t.agent.folder))).toBe(true);
	});

	it("is run by `orrery claude-setup <Agent> --mod`", () => {
		const t = testAgent({ setup: false });
		const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, "--config", t.configPath, "claude-setup", t.agent.name, "--mod"], { env: cleanEnv({}), encoding: "utf8", timeout: 20_000 });
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("mod mode");
		expect(agentMode(t.agent)).toBe("mod");
	});
});

describe("orrery claude-setup", () => {
	it("gives an agent folder of its own a CLAUDE.md that loads AGENTS.md and the view, keeps what was there, and is safe to rerun", () => {
		const t = testAgent();
		writeFileSync(join(t.folder, "CLAUDE.md"), "# Notes\nKeep it short.");
		chmodSync(t.folder, 0o755);
		seed(t.agent, ["hello", "hi"]);
		const first = claudeSetup(t.agent);
		// The folder is the user's folder, not orrery's: its mode stays.
		expect(statSync(t.folder).mode & 0o777).toBe(0o755);
		expect(first).toMatchObject({ file: join(t.folder, "CLAUDE.md"), added: ["@AGENTS.md", "@.orrery/view.md"], messages: 2 });
		expect(first.exclude).toBeUndefined();
		const expected = "# Notes\nKeep it short.\n@AGENTS.md\n@.orrery/view.md\n";
		expect(readFileSync(join(t.folder, "CLAUDE.md"), "utf8")).toBe(expected);
		expect(readSetupMarker(t.agent.dir)).toMatchObject({ folder: t.folder, file: "CLAUDE.md" });
		expect(claudeSetup(t.agent).added).toEqual([]);
		expect(readFileSync(join(t.folder, "CLAUDE.md"), "utf8")).toBe(expected);
		expect(readSetupMarker(t.agent.dir)).toMatchObject({ folder: t.folder, file: "CLAUDE.md" });
		expect(viewImported(t.folder)).toBe(true);
		expect(statSync(viewFile(t.folder)).mode & 0o777).toBe(0o600);
		expect(setupReport(claudeSetup(t.agent))).toContain("already loads the memory view");
	});

	it("leaves a shared repo untouched: CLAUDE.local.md, excluded locally, and AGENTS.md imported once", () => {
		const t = testAgent();
		const git = repo(t);
		seed(t.agent, ["hello"]);
		const result = claudeSetup(t.agent);
		expect(result).toMatchObject({ file: join(t.folder, "CLAUDE.local.md"), added: ["@.orrery/view.md"], exclude: { added: ["CLAUDE.local.md", ".orrery/"] } });
		expect(git("status", "--porcelain")).toBe("");
		expect(readFileSync(join(t.folder, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
		expect(existsSync(viewFile(t.folder))).toBe(true);
		expect(readSetupMarker(t.agent.dir)).toMatchObject({ folder: t.folder, file: "CLAUDE.local.md" });
		const again = claudeSetup(t.agent);
		expect([again.added, again.exclude?.added]).toEqual([[], []]);
		expect(readSetupMarker(t.agent.dir)).toMatchObject({ folder: t.folder, file: "CLAUDE.local.md" });
		expect(readFileSync(gitExclude(t.folder)!, "utf8").split("\n").filter((line) => line === "CLAUDE.local.md")).toHaveLength(1);
	});

	it("puts the lines in CLAUDE.local.md when CLAUDE.md is a symlink, and never writes through it", () => {
		const t = testAgent();
		writeFileSync(join(t.folder, "AGENTS.md"), "You are Rowan.\n");
		symlinkSync("AGENTS.md", join(t.folder, "CLAUDE.md"));
		seed(t.agent, ["hello"]);
		const result = claudeSetup(t.agent);
		// CLAUDE.md -> AGENTS.md already loads AGENTS.md: only the view is imported.
		expect(result).toMatchObject({ file: join(t.folder, "CLAUDE.local.md"), added: ["@.orrery/view.md"], claudeMdLink: "AGENTS.md" });
		expect(setupReport(result)).toContain("CLAUDE.md is a symlink");
		expect(lstatSync(join(t.folder, "CLAUDE.md")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(t.folder, "AGENTS.md"), "utf8")).toBe("You are Rowan.\n");
		expect(readSetupMarker(t.agent.dir)).toMatchObject({ file: "CLAUDE.local.md" });
		expect(existsSync(viewFile(t.folder))).toBe(true);
		// A link to a file elsewhere: that file is never touched, and AGENTS.md is imported.
		const u = testAgent();
		const outside = join(outsideFolder(u), "notes.md");
		writeFileSync(outside, "outside\n");
		symlinkSync(outside, join(u.folder, "CLAUDE.md"));
		expect(claudeSetup(u.agent)).toMatchObject({ file: join(u.folder, "CLAUDE.local.md"), added: ["@AGENTS.md", "@.orrery/view.md"] });
		expect(readFileSync(outside, "utf8")).toBe("outside\n");
	});

	it("prints a CLAUDE.md link's target escaped: a repo's terminal escapes never reach the terminal", () => {
		const t = testAgent();
		// ESC sequences, BEL, DEL and an 8-bit CSI (U+009B), which JSON.stringify alone leaves as they are.
		const target = "AGENTS.md\x1b[2J\x1b]0;owned\x07\x7f\u009b31m";
		symlinkSync(target, join(t.folder, "CLAUDE.md"));
		const result = claudeSetup(t.agent);
		expect(result.claudeMdLink).toBe(target);
		const report = setupReport(result);
		expect(report).toContain('CLAUDE.md is a symlink (to "AGENTS.md\\u001b[2J\\u001b]0;owned\\u0007\\u007f\\u009b31m")');
		expect(report).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
	});

	it("refuses a symlink where it would write (CLAUDE.local.md, .orrery, .git/info, its exclude), writing nothing anywhere", () => {
		const plants: Array<[string, (t: TestAgent, outside: string) => void, RegExp]> = [
			["CLAUDE.local.md", (t, outside) => symlinkSync(join(outside, "file"), join(t.folder, "CLAUDE.local.md")), /CLAUDE\.local\.md is a symlink/],
			[".orrery", (t, outside) => symlinkSync(outside, join(t.folder, ".orrery")), /\.orrery is not a real folder/],
			[
				".git/info",
				(t, outside) => {
					rmSync(join(t.folder, ".git", "info"), { recursive: true, force: true });
					symlinkSync(outside, join(t.folder, ".git", "info"));
				},
				/info is not a real folder/,
			],
			[
				".git/info/exclude",
				(t, outside) => {
					rmSync(join(t.folder, ".git", "info", "exclude"), { force: true });
					symlinkSync(join(outside, "file"), join(t.folder, ".git", "info", "exclude"));
				},
				/exclude is a symlink/,
			],
		];
		for (const [, plant, refusal] of plants) {
			const t = testAgent();
			repo(t);
			seed(t.agent, ["hello"]);
			const outside = outsideFolder(t);
			writeFileSync(join(outside, "file"), "outside\n");
			plant(t, outside);
			const before = [readdirSync(t.folder).sort(), excludeText(t)];
			expect(() => claudeSetup(t.agent)).toThrow(refusal);
			expect(readdirSync(outside)).toEqual(["file"]);
			expect(readFileSync(join(outside, "file"), "utf8")).toBe("outside\n");
			expect(statSync(outside).mode & 0o777).toBe(0o755);
			expect([readdirSync(t.folder).sort(), excludeText(t)]).toEqual(before);
			expect(readSetupMarker(t.agent.dir)).toBeUndefined();
		}
	});

	it("refuses a repo where git would see .orrery/: a .gitignore that un-ignores it, or a tracked file there", () => {
		const t = testAgent();
		const git = repo(t);
		writeFileSync(join(t.folder, ".gitignore"), "!.orrery/\n");
		seed(t.agent, ["hello"]);
		expect(() => claudeSetup(t.agent)).toThrow(/not ignored by git/);
		expect(existsSync(viewFile(t.folder))).toBe(false);
		expect(existsSync(join(t.folder, "CLAUDE.local.md"))).toBe(false);
		expect(readSetupMarker(t.agent.dir)).toBeUndefined();
		// Set up once it is ignored, then un-ignored again: a rerun refuses and takes the marker back.
		rmSync(join(t.folder, ".gitignore"));
		claudeSetup(t.agent);
		expect(readSetupMarker(t.agent.dir)).toBeDefined();
		expect(existsSync(viewFile(t.folder))).toBe(true);
		writeFileSync(join(t.folder, ".gitignore"), "!.orrery/\n");
		expect(() => claudeSetup(t.agent)).toThrow(/not ignored by git/);
		expect(readSetupMarker(t.agent.dir)).toBeUndefined();
		// The view orrery wrote there is gone too, so git has nothing of it to show.
		expect(existsSync(viewFile(t.folder))).toBe(false);
		expect(git("status", "--porcelain")).not.toContain(".orrery");

		const u = testAgent();
		const ugit = repo(u);
		mkdirSync(join(u.folder, ".orrery"));
		writeFileSync(viewFile(u.folder), "tracked\n");
		ugit("add", ".orrery/view.md");
		seed(u.agent, ["hello"]);
		expect(() => claudeSetup(u.agent)).toThrow(/git tracks/);
		expect(readFileSync(viewFile(u.folder), "utf8")).toBe("tracked\n");
		expect(existsSync(join(u.folder, "CLAUDE.local.md"))).toBe(false);
		expect(readSetupMarker(u.agent.dir)).toBeUndefined();
	});

	it("refuses a folder named like .orrery in another case, which a case-insensitive disk takes for .orrery", () => {
		// Tracked as .Orrery/view.md with core.ignorecase (git sets it on such a disk), and not even on disk: only git knows.
		const t = testAgent();
		const git = repo(t);
		git("config", "core.ignorecase", "true");
		mkdirSync(join(t.folder, ".Orrery"));
		writeFileSync(join(t.folder, ".Orrery", "view.md"), "tracked\n");
		git("add", ".Orrery/view.md");
		rmSync(join(t.folder, ".Orrery"), { recursive: true });
		seed(t.agent, ["hello"]);
		expect(() => claudeSetup(t.agent)).toThrow(/git tracks/);
		expect([existsSync(viewFile(t.folder)), existsSync(join(t.folder, "CLAUDE.local.md")), readSetupMarker(t.agent.dir)]).toEqual([false, false, undefined]);
		// On disk and untracked: such a disk would write the view into it.
		const u = testAgent();
		repo(u);
		mkdirSync(join(u.folder, ".ORRERY"));
		seed(u.agent, ["hello"]);
		expect(() => claudeSetup(u.agent)).toThrow(/\.ORRERY/);
		expect([existsSync(viewFile(u.folder)), existsSync(join(u.folder, "CLAUDE.local.md")), readSetupMarker(u.agent.dir)]).toEqual([false, false, undefined]);
	});

	it("judges the folder's own repo, whatever git variables it inherits", () => {
		const t = testAgent();
		const git = repo(t);
		mkdirSync(join(t.folder, ".orrery"));
		writeFileSync(viewFile(t.folder), "tracked\n");
		git("add", ".orrery/view.md");
		const other = join(t.dir, "other");
		mkdirSync(other);
		gitIn(other)("init", "-q");
		const otherExclude = excludeText({ ...t, folder: other });
		seed(t.agent, ["hello"]);
		// Inherited, these would make git judge (and take the exclude lines into) another repo, with another index.
		const elsewhere = { GIT_DIR: join(other, ".git"), GIT_INDEX_FILE: join(other, ".git", "index") };
		expect(() => withEnv(elsewhere, () => claudeSetup(t.agent))).toThrow(/git tracks/);
		expect(readFileSync(viewFile(t.folder), "utf8")).toBe("tracked\n");
		expect(excludeText({ ...t, folder: other })).toBe(otherExclude);
		expect(readSetupMarker(t.agent.dir)).toBeUndefined();
		// GIT_LITERAL_PATHSPECS would read ':(icase).orrery' as a file name, and a tracked .Orrery/view.md would pass.
		const u = testAgent();
		const ugit = repo(u);
		ugit("config", "core.ignorecase", "true");
		mkdirSync(join(u.folder, ".Orrery"));
		writeFileSync(join(u.folder, ".Orrery", "view.md"), "tracked\n");
		ugit("add", ".Orrery/view.md");
		rmSync(join(u.folder, ".Orrery"), { recursive: true });
		seed(u.agent, ["hello"]);
		expect(() => withEnv({ GIT_LITERAL_PATHSPECS: "1" }, () => claudeSetup(u.agent))).toThrow(/git tracks/);
		expect(readSetupMarker(u.agent.dir)).toBeUndefined();
	});

	it("fails closed: a git that cannot say whether it would see .orrery/ means no setup, and an earlier one stays", () => {
		const t = testAgent();
		const broken = brokenGit(t);
		seed(t.agent, ["hello"]);
		expect(() => withGit(broken, () => claudeSetup(t.agent))).toThrow(/git could not say/);
		expect([existsSync(viewFile(t.folder)), existsSync(join(t.folder, "CLAUDE.md")), readSetupMarker(t.agent.dir)]).toEqual([false, false, undefined]);
		// Set up while git answers, then rerun while it cannot: the view is taken out until git answers, and the marker
		// stays, so the next write puts it back with no setup to redo.
		claudeSetup(t.agent);
		expect(() => withGit(broken, () => claudeSetup(t.agent))).toThrow(/git could not say/);
		expect([existsSync(viewFile(t.folder)), readSetupMarker(t.agent.dir)?.file]).toEqual([false, "CLAUDE.md"]);
		refreshViewFile(t.agent);
		expect(existsSync(viewFile(t.folder))).toBe(true);
	});

	it("works on a folder configured through a symlink, and records it as configured", () => {
		const t = testAgent();
		const link = join(t.dir, "ws-link");
		symlinkSync(t.folder, link);
		const agent = { ...t.agent, folder: link };
		seed(agent, ["hello"]);
		expect(claudeSetup(agent)).toMatchObject({ file: join(link, "CLAUDE.md"), messages: 1 });
		expect(readFileSync(join(t.folder, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n@.orrery/view.md\n");
		expect(readSetupMarker(t.agent.dir)).toMatchObject({ folder: link, file: "CLAUDE.md" });
		expect(existsSync(viewFile(t.folder))).toBe(true);
	});

	it("refuses an agent whose folder does not exist", () => {
		const t = testAgent();
		rmSync(t.folder, { recursive: true });
		expect(() => claudeSetup(t.agent)).toThrow(/does not exist/);
	});
});
