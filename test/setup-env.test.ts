import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// A guard: it passes trivially in a plain shell, and matters in a run started inside an agent (`orrery agent`).
it("starts every test file without an agent session's markers (test/setup-env.ts)", () => {
	for (const key of ["ORRERY_AGENT", "ORRERY_AGENT_TOKEN", "CLAUDE_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "OPENCODE_CONFIG_CONTENT"]) expect(process.env[key], key).toBeUndefined();
});

it("points every test's update check at a closed local port (test/setup-env.ts)", () => {
	expect(process.env.ORRERY_RELEASES_URL).toBe("http://127.0.0.1:9/releases");
});

it("runs every test in the run's scratch home, never the person's own (test/global-env.ts)", () => {
	const scratch = process.env.ORRERY_TEST_SCRATCH as string;
	expect(scratch).toBeTruthy();
	expect(process.env.HOME).toBe(join(scratch, "home"));
	expect(homedir()).toBe(join(scratch, "home"));
	expect(process.env.ORRERY_HOME).toBe(join(scratch, "home", ".orrery"));
	for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) expect(process.env[key]?.startsWith(`${scratch}/`), key).toBe(true);
	expect(process.env.ORRERY_CONFIG).toBeUndefined();
});
