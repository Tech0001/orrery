import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkCaller, stdinPeer, unsupportedCause } from "../../src/claude/peer.ts";
import { claudeSession } from "../../src/claude/pick.ts";
import { newToken } from "../../src/agent/pick.ts";
import { forgetSession, processStart } from "../../src/agent/sessions.ts";
import { cleanupDirs, type TestAgent, testAgent } from "./support.ts";

afterEach(cleanupDirs);

/** The Claude Code the hooks run for: this test's process, live, so its start time can be read. */
const CLAUDE = process.pid;

/** Claude Code's first SessionStart (or MCP server) deciding for its process, as src/claude/pick.ts records it. */
const decide = (t: TestAgent, start?: (pid: number) => string | undefined) =>
	claudeSession(t.config, { env: { CLAUDE_PROJECT_DIR: t.folder }, cwd: t.folder, pid: CLAUDE, decide: true, ...(start === undefined ? {} : { start }) });

describe("stdinPeer", () => {
	// The suite run by Bun (test:bun-suite) asks for real; the built binary's tests check that.
	it.skipIf(process.versions.bun !== undefined)("cannot tell under Node, which has no getsockopt: unsupported, and says why", () => {
		expect(process.versions.bun).toBeUndefined();
		expect(stdinPeer()).toBe("unsupported");
		expect(unsupportedCause()).toBe("it runs under Node, not its own binary");
	});
});

describe("checkCaller: a writing hook's stdin peer must be the recorded Claude Code", () => {
	it("accepts the recorded Claude Code process, its start time known and equal to the record's", () => {
		const t = testAgent();
		decide(t);
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true, env: {} })).toBe("ok");
	});

	it("refuses another process on the other end, a pipe or a file (not a socket), and a runtime that cannot ask", () => {
		const t = testAgent();
		decide(t);
		expect(checkCaller(t.config, CLAUDE, CLAUDE + 1, { recorded: true, env: {} })).toBe("other-process");
		expect(checkCaller(t.config, CLAUDE, "not-socket", { recorded: true, env: {} })).toBe("not-socket");
		expect(checkCaller(t.config, CLAUDE, "unsupported", { recorded: true, env: {} })).toBe("unsupported");
	});

	it("refuses a Claude Code with no record, a record of another start (a reused pid), or a start it cannot read", () => {
		const t = testAgent();
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true, env: {} })).toBe("unrecorded");
		// Recorded by a process that started at another time under this pid.
		decide(t, () => "1");
		forgetSession(t.config.dataDir, CLAUDE);
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true, env: {} })).toBe("unrecorded");
		const u = testAgent();
		decide(u);
		expect(checkCaller(u.config, CLAUDE, CLAUDE, { recorded: true, env: {}, start: () => undefined })).toBe("unrecorded");
		expect(checkCaller(u.config, CLAUDE, CLAUDE, { recorded: true, env: {}, start: () => "another start" })).toBe("unrecorded");
	});

	it("takes the session's host record when the decision record is gone, with the same start rule", () => {
		const t = testAgent();
		// By its folder the pick is Test's, so the decider records this process as Test's session host as well.
		expect(decide(t).kind).toBe("agent");
		rmSync(join(t.config.dataDir, "claude-processes", `${CLAUDE}.json`));
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true, env: {} })).toBe("ok");
		forgetSession(t.config.dataDir, CLAUDE);
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true, env: {} })).toBe("unrecorded");
	});

	it("across the update: a decision recorded before start times (0.8.0) stands for an ORRERY_AGENT launch whose token's digest the hook's environment holds", () => {
		const t = testAgent();
		const records = join(t.config.dataDir, "claude-processes");
		mkdirSync(records, { recursive: true, mode: 0o700 });
		const token = newToken();
		const digest = createHash("sha256").update(token).digest("hex");
		const launched = { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token };
		// As 0.8.0 wrote it: whose (ORRERY_AGENT and the token's digest) and what, no start; and no host record.
		const old = (record: object) => writeFileSync(join(records, `${CLAUDE}.json`), JSON.stringify({ kind: "agent", name: "Test", by: "env", ...record }));
		old({ agent: "Test", token: digest });
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true, env: launched })).toBe("ok");
		// The peer must still be that Claude Code.
		expect(checkCaller(t.config, CLAUDE, CLAUDE + 1, { recorded: true, env: launched })).toBe("other-process");
		// Another token, another ORRERY_AGENT, or none: not this launch's record.
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true, env: { ...launched, ORRERY_AGENT_TOKEN: newToken() } })).toBe("unrecorded");
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true, env: { ...launched, ORRERY_AGENT: "Other" } })).toBe("unrecorded");
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true, env: {} })).toBe("unrecorded");
		// A record with no token (ORRERY_AGENT alone) and no start is no one's: refused.
		old({ agent: "Test", token: "" });
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true, env: { ORRERY_AGENT: "Test" } })).toBe("unrecorded");
		// A start that can't be read now is refused all the same.
		old({ agent: "Test", token: digest });
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: true, env: launched, start: () => undefined })).toBe("unrecorded");
		rmSync(join(records, `${CLAUDE}.json`));
	});

	it("at SessionStart takes the peer alone, before any record: the pick that follows reads the start and records it", () => {
		const t = testAgent();
		expect(processStart(CLAUDE)).toBeDefined();
		expect(checkCaller(t.config, CLAUDE, CLAUDE, { recorded: false, env: {} })).toBe("ok");
		expect(checkCaller(t.config, CLAUDE, CLAUDE + 1, { recorded: false, env: {} })).toBe("other-process");
		expect(checkCaller(t.config, CLAUDE, "not-socket", { recorded: false, env: {} })).toBe("not-socket");
		expect(checkCaller(t.config, CLAUDE, "unsupported", { recorded: false, env: {} })).toBe("unsupported");
	});
});
