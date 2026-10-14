import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HookContext, runHook } from "../../src/claude/hooks.ts";
import { modView } from "../../src/claude/mod-view.ts";
import { viewFile } from "../../src/claude/paths.ts";
import { claudeSetupMod } from "../../src/claude/setup.ts";
import { writeMode } from "../../src/claude/spool.ts";
import { refreshViewFile } from "../../src/claude/view-file.ts";
import { INSTRUCTIONS_MAX_BYTES, writeInstructions } from "../../src/lane/instructions.ts";
import { tempDir } from "../lane/support.ts";
import { cleanupDirs, seed, testLane } from "./support.ts";

const elsewheres: string[] = [];
afterEach(() => {
	cleanupDirs();
	for (const dir of elsewheres.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A folder of no lane's, in a temp folder of its own. */
const elsewhere = () => {
	const dir = tempDir("orrery-elsewhere-");
	elsewheres.push(dir);
	return dir;
};

/** SessionStart for `t`'s lane in `dir` (default its workspace) with `env` added, its holder answering "recording" at once. */
function hookContext(t: ReturnType<typeof testLane>, dir = t.workspace, env: NodeJS.ProcessEnv = {}): HookContext {
	return {
		config: t.config,
		env: { CLAUDE_PROJECT_DIR: dir, ...env },
		claudePid: 4242,
		modeWaitMs: 200,
		home: join(t.dir, "home"),
		startHolder: (lane, session, nonce, since) => writeMode(lane.dir, session, { mode: "recording", pid: 1, claudePid: 4242, nonce, since }),
	};
}

describe("an agent's instructions in Claude Code", () => {
	it("claude-mod view carries their section, named for the agent", async () => {
		const t = testLane();
		seed(t.lane, ["Use pnpm here.", "Switched to pnpm."]);
		claudeSetupMod(t.lane);
		writeInstructions(t.lane.dir, "You are Test.\n");
		expect(await modView(t.config, { cwd: t.workspace, env: {}, owner: 1 })).toMatchObject({ lane: "Test", mode: "mod", instructions: "# Agent: Test\n\nYou are Test." });
	});

	it("claude-mod view says null when there are none, also before the lane has memory", async () => {
		const t = testLane();
		claudeSetupMod(t.lane);
		expect(await modView(t.config, { cwd: t.workspace, env: {}, owner: 1 })).toMatchObject({ lane: "Test", mode: "mod", section: null, instructions: null });
		writeInstructions(t.lane.dir, "You are Test.\n");
		expect(await modView(t.config, { cwd: t.workspace, env: {}, owner: 1 })).toMatchObject({ section: null, instructions: "# Agent: Test\n\nYou are Test." });
	});

	it("claude-mod view sends them only in mod mode: in file mode and unset up the mod has no use for them", async () => {
		const t = testLane({ setup: true });
		seed(t.lane, ["Use pnpm here.", "Switched to pnpm."]);
		writeInstructions(t.lane.dir, "You are Test.\n");
		expect(await modView(t.config, { cwd: t.workspace, env: {}, owner: 1 })).toMatchObject({ lane: "Test", mode: "file", instructions: null });
		const u = testLane();
		writeInstructions(u.lane.dir, "You are Test.\n");
		expect(await modView(u.config, { cwd: u.workspace, env: {}, owner: 1 })).toMatchObject({ lane: "Test", mode: "none", instructions: null });
	});

	it("file mode with no memory yet: the view file holds the instructions alone", () => {
		const t = testLane({ setup: true });
		writeInstructions(t.lane.dir, "You are Test.\n");
		expect(refreshViewFile(t.lane)).toBeUndefined();
		expect(readFileSync(viewFile(t.workspace), "utf8")).toBe("# Agent: Test\n\n```text\nYou are Test.\n```");
	});

	// A guard: no memory and no instructions wrote nothing before, and still writes nothing.
	it("file mode with neither memory nor instructions: no view file", () => {
		const t = testLane({ setup: true });
		expect(refreshViewFile(t.lane)).toBeUndefined();
		expect(existsSync(viewFile(t.workspace))).toBe(false);
	});

	it("file mode: the view file starts with them, fenced (Claude Code imports no @path there)", () => {
		const t = testLane({ setup: true });
		seed(t.lane, ["Use pnpm here.", "Switched to pnpm."]);
		writeInstructions(t.lane.dir, "You are Test. See @~/.ssh/config.\n");
		refreshViewFile(t.lane);
		expect(readFileSync(viewFile(t.workspace), "utf8")).toMatch(/^# Agent: Test\n\n```text\nYou are Test\. See @~\/\.ssh\/config\.\n```\n\n# Memory\n/);
	});

	it("file mode without instructions: the view file is the memory section alone", () => {
		const t = testLane({ setup: true });
		seed(t.lane, ["Use pnpm here.", "Switched to pnpm."]);
		refreshViewFile(t.lane);
		expect(readFileSync(viewFile(t.workspace), "utf8")).toMatch(/^# Memory\n/);
	});

	it("SessionStart says when they are over 32 KB", async () => {
		const t = testLane();
		claudeSetupMod(t.lane);
		writeInstructions(t.lane.dir, "a".repeat(INSTRUCTIONS_MAX_BYTES + 10));
		const out = JSON.parse(await runHook("session-start", JSON.stringify({ session_id: "s1", cwd: t.workspace }), hookContext(t))) as { systemMessage?: string };
		expect(out.systemMessage).toContain("Orrery: Test's instructions are over 32 KB; only the first 32 KB reach the model. Shorten instructions.md.");
	});

	// A guard: the notice said this in every mode before; here it stays true.
	it("SessionStart over 32 KB in file mode in its folder: the first 32 KB reach the model (the view file)", async () => {
		const t = testLane({ setup: true });
		seed(t.lane, ["Use pnpm here.", "Switched to pnpm."]);
		writeInstructions(t.lane.dir, "a".repeat(INSTRUCTIONS_MAX_BYTES + 10));
		const out = JSON.parse(await runHook("session-start", JSON.stringify({ session_id: "s3", cwd: t.workspace }), hookContext(t))) as { systemMessage?: string };
		expect(out.systemMessage).toContain("Orrery: Test's instructions are over 32 KB; only the first 32 KB reach the model. Shorten instructions.md.");
	});

	it("SessionStart over 32 KB in file mode outside its folder, or not set up: says none of them reach the model", async () => {
		const none = "Orrery: Test's instructions are over 32 KB, and none of them reach the model in this session: only the Orrery mod, or the view file in Test's folder, brings them. Shorten instructions.md.";
		const t = testLane({ setup: true });
		seed(t.lane, ["Use pnpm here.", "Switched to pnpm."]);
		writeInstructions(t.lane.dir, "a".repeat(INSTRUCTIONS_MAX_BYTES + 10));
		const dir = elsewhere();
		const outside = JSON.parse(await runHook("session-start", JSON.stringify({ session_id: "s4", cwd: dir }), hookContext(t, dir, { ORRERY_AGENT: "Test" }))) as { systemMessage?: string };
		expect(outside.systemMessage).toContain(none);
		expect(outside.systemMessage).not.toContain("only the first 32 KB reach the model");
		const u = testLane();
		writeInstructions(u.lane.dir, "a".repeat(INSTRUCTIONS_MAX_BYTES + 10));
		const unset = JSON.parse(await runHook("session-start", JSON.stringify({ session_id: "s5", cwd: u.workspace }), hookContext(u))) as { systemMessage?: string };
		expect(unset.systemMessage).toContain(none);
	});

	it("SessionStart says nothing of instructions within 32 KB", async () => {
		const t = testLane();
		claudeSetupMod(t.lane);
		writeInstructions(t.lane.dir, "a".repeat(INSTRUCTIONS_MAX_BYTES));
		const out = await runHook("session-start", JSON.stringify({ session_id: "s2", cwd: t.workspace }), hookContext(t));
		expect(out).not.toContain("over 32 KB");
	});
});
