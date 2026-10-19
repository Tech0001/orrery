import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkCaller, stdinPeer, unsupportedCause } from "../../src/claude/peer.ts";
import { claudeSession } from "../../src/claude/pick.ts";
import { forgetSession, processStart } from "../../src/agent/sessions.ts";
import { cleanupDirs, type TestAgent, testAgent } from "./support.ts";

afterEach(cleanupDirs);

/** The Claude Code the hooks run for: this test's process, live, so its start time can be read. */
const CLAUDE = process.pid;

/** Claude Code's first SessionStart (or MCP server) deciding for its process, as src/claude/pick.ts records it. */
const decide = (t: TestAgent, start?: (pid: number) => string | undefined) =>
	claudeSession(t.config, { env: { CLAUDE_PROJECT_DIR: t.folder }, cwd: t.folder, pid: CLAUDE, decide: true, ...(start === undefined ? {} : { start }) });

describe("stdinPeer", () => {
	it("cannot tell under Node, which has no getsockopt: unsupported, and says why", () => {
		expect(process.versions.bun).toBeUndefined();
		expect(stdinPeer()).toBe("unsupported");
		expect(unsupportedCause()).toBe("it runs under Node, not its own binary");
	});
});

describe("checkCaller: a writing hook's stdin peer must be the recorded Claude Code", () => {
	it("accepts the recorded Claude Code process, its start time known and equal to the record's", () => {
		const t = testAgent();
		decide(t);
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true })).toBe("ok");
	});

	it("refuses another process on the other end, a pipe or a file (not a socket), and a runtime that cannot ask", () => {
		const t = testAgent();
		decide(t);
		expect(checkCaller(t.config, CLAUDE, CLAUDE + 1, { recorded: true })).toBe("other-process");
		expect(checkCaller(t.config, CLAUDE, "not-socket", { recorded: true })).toBe("not-socket");
		expect(checkCaller(t.config, CLAUDE, "unsupported", { recorded: true })).toBe("unsupported");
	});

	it("refuses a Claude Code with no record, a record of another start (a reused pid), or a start it cannot read", () => {
		const t = testAgent();
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true })).toBe("unrecorded");
		// Recorded by a process that started at another time under this pid.
		decide(t, () => "1");
		forgetSession(t.config.dataDir, CLAUDE);
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true })).toBe("unrecorded");
		const u = testAgent();
		decide(u);
		expect(checkCaller(u.config, CLAUDE, CLAUDE, { recorded: true, start: () => undefined })).toBe("unrecorded");
		expect(checkCaller(u.config, CLAUDE, CLAUDE, { recorded: true, start: () => "another start" })).toBe("unrecorded");
	});

	it("takes the session's host record when the decision record is gone, with the same start rule", () => {
		const t = testAgent();
		// By its folder the pick is Test's, so the decider records this process as Test's session host as well.
		expect(decide(t).kind).toBe("agent");
		rmSync(join(t.config.dataDir, "claude-processes", `${CLAUDE}.json`));
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true })).toBe("ok");
		forgetSession(t.config.dataDir, CLAUDE);
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true })).toBe("unrecorded");
	});

	it("at SessionStart takes the peer alone, before any record: the pick that follows reads the start and records it", () => {
		const t = testAgent();
		expect(processStart(CLAUDE)).toBeDefined();
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: false })).toBe("ok");
		expect(checkCaller(t.config, CLAUDE, CLAUDE + 1, { recorded: false })).toBe("other-process");
		expect(checkCaller(t.config, CLAUDE, "not-socket", { recorded: false })).toBe("not-socket");
		expect(checkCaller(t.config, CLAUDE, "unsupported", { recorded: false })).toBe("unsupported");
	});
});
