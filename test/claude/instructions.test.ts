import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HookContext, runHook } from "../../src/claude/hooks.ts";
import { modView } from "../../src/claude/mod-view.ts";
import { viewFile } from "../../src/claude/paths.ts";
import { claudeSetupMod } from "../../src/claude/setup.ts";
import { writeMode } from "../../src/claude/spool.ts";
import { refreshViewFile } from "../../src/claude/view-file.ts";
import { INSTRUCTIONS_MAX_BYTES, writeInstructions } from "../../src/agent/instructions.ts";
import { tempDir } from "../agent/support.ts";
import { cleanupDirs, seed, testAgent } from "./support.ts";

const elsewheres: string[] = [];
afterEach(() => {
	cleanupDirs();
	for (const dir of elsewheres.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A folder of no agent's, in a temp folder of its own. */
const elsewhere = () => {
	const dir = tempDir("orrery-elsewhere-");
	elsewheres.push(dir);
	return dir;
};

/** SessionStart for `t`'s agent in `dir` (default its folder) with `env` added, its holder answering "recording" at once. */
function hookContext(t: ReturnType<typeof testAgent>, dir = t.folder, env: NodeJS.ProcessEnv = {}): HookContext {
	return {
		config: t.config,
		env: { CLAUDE_PROJECT_DIR: dir, ...env },
		claudePid: process.pid,
		modeWaitMs: 200,
		home: join(t.dir, "home"),
		startHolder: (agent, session, nonce, since) => writeMode(agent.dir, session, { mode: "recording", pid: 1, claudePid: process.pid, nonce, since }),
	};
}

describe("an agent's instructions in Claude Code", () => {
	it("claude-mod view carries their section, named for the agent", async () => {
		const t = testAgent();
		seed(t.agent, ["Use pnpm here.", "Switched to pnpm."]);
		claudeSetupMod(t.agent);
		writeInstructions(t.agent.dir, "You are Test.\n");
		expect(await modView(t.config, { cwd: t.folder, env: {}, owner: 1 })).toMatchObject({ lane: "Test", mode: "mod", instructions: "# Agent: Test\n\nYou are Test." });
	});

	it("claude-mod view says null when there are none, also before the agent has memory", async () => {
		const t = testAgent();
		claudeSetupMod(t.agent);
		expect(await modView(t.config, { cwd: t.folder, env: {}, owner: 1 })).toMatchObject({ lane: "Test", mode: "mod", section: null, instructions: null });
		writeInstructions(t.agent.dir, "You are Test.\n");
		expect(await modView(t.config, { cwd: t.folder, env: {}, owner: 1 })).toMatchObject({ section: null, instructions: "# Agent: Test\n\nYou are Test." });
	});

	it("claude-mod view sends them only in mod mode: in file mode and unset up the mod has no use for them", async () => {
		const t = testAgent({ setup: true });
		seed(t.agent, ["Use pnpm here.", "Switched to pnpm."]);
		writeInstructions(t.agent.dir, "You are Test.\n");
		expect(await modView(t.config, { cwd: t.folder, env: {}, owner: 1 })).toMatchObject({ lane: "Test", mode: "file", instructions: null });
		const u = testAgent();
		writeInstructions(u.agent.dir, "You are Test.\n");
		expect(await modView(u.config, { cwd: u.folder, env: {}, owner: 1 })).toMatchObject({ lane: "Test", mode: "none", instructions: null });
	});

	it("file mode with no memory yet: the view file holds the instructions alone", () => {
		const t = testAgent({ setup: true });
		writeInstructions(t.agent.dir, "You are Test.\n");
		expect(refreshViewFile(t.agent)).toBeUndefined();
		expect(readFileSync(viewFile(t.folder), "utf8")).toBe("# Agent: Test\n\n```text\nYou are Test.\n```");
	});

	// A guard: no memory and no instructions wrote nothing before, and still writes nothing.
	it("file mode with neither memory nor instructions: no view file", () => {
		const t = testAgent({ setup: true });
		expect(refreshViewFile(t.agent)).toBeUndefined();
		expect(existsSync(viewFile(t.folder))).toBe(false);
	});

	it("file mode: the view file starts with them, fenced (Claude Code imports no @path there)", () => {
		const t = testAgent({ setup: true });
		seed(t.agent, ["Use pnpm here.", "Switched to pnpm."]);
		writeInstructions(t.agent.dir, "You are Test. See @~/.ssh/config.\n");
		refreshViewFile(t.agent);
		expect(readFileSync(viewFile(t.folder), "utf8")).toMatch(/^# Agent: Test\n\n```text\nYou are Test\. See @~\/\.ssh\/config\.\n```\n\n# Memory\n/);
	});

	it("file mode without instructions: the view file is the memory section alone", () => {
		const t = testAgent({ setup: true });
		seed(t.agent, ["Use pnpm here.", "Switched to pnpm."]);
		refreshViewFile(t.agent);
		expect(readFileSync(viewFile(t.folder), "utf8")).toMatch(/^# Memory\n/);
	});

	it("SessionStart says when they are over 32 KB", async () => {
		const t = testAgent();
		claudeSetupMod(t.agent);
		writeInstructions(t.agent.dir, "a".repeat(INSTRUCTIONS_MAX_BYTES + 10));
		const out = JSON.parse(await runHook("session-start", JSON.stringify({ session_id: "s1", cwd: t.folder }), hookContext(t))) as { systemMessage?: string };
		expect(out.systemMessage).toContain("Orrery: Test's instructions are over 32 KB; only the first 32 KB reach the model. Shorten instructions.md.");
	});

	// A guard: the notice said this in every mode before; here it stays true.
	it("SessionStart over 32 KB in file mode in its folder: the first 32 KB reach the model (the view file)", async () => {
		const t = testAgent({ setup: true });
		seed(t.agent, ["Use pnpm here.", "Switched to pnpm."]);
		writeInstructions(t.agent.dir, "a".repeat(INSTRUCTIONS_MAX_BYTES + 10));
		const out = JSON.parse(await runHook("session-start", JSON.stringify({ session_id: "s3", cwd: t.folder }), hookContext(t))) as { systemMessage?: string };
		expect(out.systemMessage).toContain("Orrery: Test's instructions are over 32 KB; only the first 32 KB reach the model. Shorten instructions.md.");
	});

	it("SessionStart over 32 KB in file mode outside its folder, or not set up: says none of them reach the model", async () => {
		const none = "Orrery: Test's instructions are over 32 KB, and none of them reach the model in this session: only the Orrery mod, or the view file in Test's folder, brings them. Shorten instructions.md.";
		const t = testAgent({ setup: true });
		seed(t.agent, ["Use pnpm here.", "Switched to pnpm."]);
		writeInstructions(t.agent.dir, "a".repeat(INSTRUCTIONS_MAX_BYTES + 10));
		const dir = elsewhere();
		const outside = JSON.parse(await runHook("session-start", JSON.stringify({ session_id: "s4", cwd: dir }), hookContext(t, dir, { ORRERY_AGENT: "Test" }))) as { systemMessage?: string };
		expect(outside.systemMessage).toContain(none);
		expect(outside.systemMessage).not.toContain("only the first 32 KB reach the model");
		const u = testAgent();
		writeInstructions(u.agent.dir, "a".repeat(INSTRUCTIONS_MAX_BYTES + 10));
		const unset = JSON.parse(await runHook("session-start", JSON.stringify({ session_id: "s5", cwd: u.folder }), hookContext(u))) as { systemMessage?: string };
		expect(unset.systemMessage).toContain(none);
	});

	it("SessionStart says nothing of instructions within 32 KB", async () => {
		const t = testAgent();
		claudeSetupMod(t.agent);
		writeInstructions(t.agent.dir, "a".repeat(INSTRUCTIONS_MAX_BYTES));
		const out = await runHook("session-start", JSON.stringify({ session_id: "s2", cwd: t.folder }), hookContext(t));
		expect(out).not.toContain("over 32 KB");
	});
});
