import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newToken } from "../../src/agent/pick.ts";
import { cleanEnv, cleanupDirs, cliCommand, testAgent } from "../claude/support.ts";

afterEach(cleanupDirs);

/** Runs `orrery codex-hook <event>` as Codex does: its input as JSON on stdin (a string as it is). */
function hook(event: string, input: object | string, env: Record<string, string> = {}) {
	const c = cliCommand(["codex-hook", event]);
	return spawnSync(c.cmd, c.args, { input: typeof input === "string" ? input : JSON.stringify(input), env: cleanEnv(env), encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
}

/** Agent Test, its config naming `protected.txt` in [guard] protect, and the environment its Codex gives a hook. */
function guarded() {
	const t = testAgent();
	writeFileSync(t.configPath, `${readFileSync(t.configPath, "utf8")}\n[guard]\nprotect = ["protected.txt"]\n`);
	writeFileSync(join(t.folder, "protected.txt"), "x");
	mkdirSync(join(t.folder, "src"));
	return { t, env: { ORRERY_CONFIG: t.configPath, ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: newToken() } };
}

const call = (cwd: string, tool_name: string, tool_input: unknown) => ({ session_id: "s", turn_id: "t", cwd, hook_event_name: "PreToolUse", model: "m", permission_mode: "default", tool_name, tool_input, tool_use_id: "c" });
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

describe("orrery codex-hook pre-tool-use (the guard)", () => {
	it("lets an ordinary call through: exit 0 and nothing on stdout or stderr, which Codex reads as no objection", () => {
		const { t, env } = guarded();
		for (const [tool, input] of [
			["Bash", { command: "ls -la && git status" }],
			["apply_patch", { command: patch("*** Add File: src/a.ts", "+export {};") }],
			["view_image", { path: "shot.png" }],
			["mcp__orrery__zoom", { id: "7" }],
		] as const) {
			const r = hook("pre-tool-use", call(t.folder, tool, input), env);
			expect([tool, r.status, r.stdout, r.stderr]).toEqual([tool, 0, "", ""]);
		}
	});

	it("refuses by exit code 2 with the reason on stderr, no final period, nothing on stdout", () => {
		const { t, env } = guarded();
		const shell = hook("pre-tool-use", call(t.folder, "Bash", { command: "cat protected.txt" }), env);
		expect([shell.status, shell.stdout, shell.stderr]).toEqual([2, "", "Orrery guard: This command touches protected.txt, protected by [guard] protect in Orrery's config"]);
		const patched = hook("pre-tool-use", call(t.folder, "apply_patch", { command: patch("*** Update File: protected.txt", "@@", "+edited") }), env);
		expect([patched.status, patched.stdout, patched.stderr]).toEqual([2, "", "Orrery guard: protected.txt is protected by [guard] protect in Orrery's config"]);
		const plumbing = hook("pre-tool-use", call(t.folder, "Bash", { command: "echo '{}' | orrery codex-hook user-prompt-submit" }), env);
		expect([plumbing.status, plumbing.stderr]).toEqual([2, "Orrery guard: This command runs Orrery's hook plumbing (codex-hook, claude-hook, orrery holder), which only Orrery's own hooks run"]);
	});

	it("refuses what it cannot judge: a config it cannot read, input that is no JSON, input over 1 MB", () => {
		const { t, env } = guarded();
		const noConfig = hook("pre-tool-use", call(t.folder, "Bash", { command: "ls" }), { ...env, ORRERY_CONFIG: "/nonexistent/orrery/config.toml" });
		expect([noConfig.status, noConfig.stdout]).toEqual([2, ""]);
		expect(noConfig.stderr).toMatch(/^Orrery guard: Orrery's config could not be read \(.*\), so no call can be checked; nothing was run\. Fix the config file$/);
		const garbled = hook("pre-tool-use", "not json", env);
		expect([garbled.status, garbled.stdout, garbled.stderr]).toEqual([2, "", "Orrery guard: Orrery could not read this call; nothing was run"]);
		const huge = hook("pre-tool-use", call(t.folder, "Bash", { command: `echo ${"x".repeat(1024 * 1024)}` }), env);
		expect([huge.status, huge.stdout, huge.stderr]).toEqual([2, "", "Orrery guard: this call's input is too large for Orrery's guard to check (over 1 MB); nothing was run"]);
	});

	it("refuses when its own command line fails before the guard runs: an error anywhere is exit 2, never Codex's fail-open", () => {
		const { t, env } = guarded();
		const c = cliCommand(["codex-hook", "pre-tool-use", "--no-such-option"]);
		const r = spawnSync(c.cmd, c.args, { input: JSON.stringify(call(t.folder, "Bash", { command: "ls" })), env: cleanEnv(env), encoding: "utf8", timeout: 20_000 });
		expect([r.status, r.stdout]).toEqual([2, ""]);
		expect(r.stderr).toMatch(/^Orrery guard: this call could not be checked \(.+\); nothing was run$/);
	});

	it("answers within its deadline on the slowest input it reads, well inside the 10 s Codex gives it", () => {
		const { t, env } = guarded();
		// 15 command lines of 64 KB of brace groups at the readings' cap, in short words: the slowest to read, about 1 MB.
		const group = `{${Array.from({ length: 63 }, () => "a").join(",")},b} `;
		const slow = group.repeat(Math.floor((64 * 1024 - 8) / group.length));
		const started = performance.now();
		const r = hook("pre-tool-use", call(t.folder, "mcp__box__batch", { steps: Array.from({ length: 15 }, () => ({ cmd: slow })) }), env);
		const took = performance.now() - started;
		expect([r.status, r.stdout]).toEqual([2, ""]);
		expect(r.stderr).toMatch(/than the guard can check in time; nothing was run$/);
		expect(took).toBeLessThan(6000);
	}, 30_000);

	it("refuses when it is still waiting at its watchdog's time (input that never ends), before Codex's timeout", async () => {
		const { t, env } = guarded();
		const c = cliCommand(["codex-hook", "pre-tool-use"]);
		const child = spawn(c.cmd, c.args, { env: cleanEnv(env), stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		// Part of a call, and the input left open.
		child.stdin.write(JSON.stringify(call(t.folder, "Bash", { command: "ls" })).slice(0, 40));
		const started = performance.now();
		const status = await new Promise<number | null>((done) => child.on("exit", done));
		child.stdin.destroy();
		expect([status, stdout, stderr]).toEqual([2, "", "Orrery guard: this call could not be checked in time; nothing was run"]);
		expect(performance.now() - started).toBeLessThan(9000);
	}, 30_000);

	it("without a config, says so at SessionStart and nothing at the other events, and never fails the session", () => {
		const env = { ORRERY_CONFIG: "/nonexistent/orrery/config.toml" };
		const start = hook("session-start", { session_id: "s", source: "startup" }, env);
		expect([start.status, start.stderr]).toEqual([0, ""]);
		expect(JSON.parse(start.stdout)).toEqual({ systemMessage: expect.stringMatching(/^Orrery: the config could not be read \(.*\); this session runs without memory\.$/) });
		for (const event of ["user-prompt-submit", "stop", "session-end"]) {
			const r = hook(event, { session_id: "s", prompt: "Codename Saffron.", last_assistant_message: "Noted." }, env);
			// Exit 0 always: a 2 would block the prompt, or keep a turn going.
			expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		}
	});

	it("says an unknown event on stderr, never quoting the input, and still exits 0", () => {
		const t = testAgent();
		const r = hook("post-compact", { session_id: "s", prompt: "Codename Saffron." }, { ORRERY_CONFIG: t.configPath });
		expect([r.status, r.stdout]).toEqual([0, ""]);
		expect(r.stderr).toContain("unknown hook event post-compact");
		expect(r.stderr).not.toContain("Saffron");
	});
});
