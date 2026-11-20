import { describe, expect, it } from "vitest";
import { agyStatus } from "../../src/antigravity/status.ts";
import { newToken } from "../../src/agent/pick.ts";
import { cleanupDirs, testAgent } from "../claude/support.ts";

describe("Antigravity's status row", () => {
	it("shows nothing for a plain agy, for an agy whose start environment names another agent, or for input it can't read", () => {
		const t = testAgent();
		const status = '{"conversation_id":"e6f5acd5-ee5c-4b2b-b2c4-bbcbda5781a2","cwd":"/w"}';
		// A plain agy: no ORRERY_AGENT.
		expect(agyStatus(status, { config: t.config, env: {}, agyPid: process.pid })).toBe("");
		// The row's own environment names an agent agy wasn't started with.
		const token = newToken();
		expect(agyStatus(status, { config: t.config, env: { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token }, agyPid: process.pid, envOf: () => ({}) })).toBe("");
		// agy started as the agent, but its token claimed by no one: no row (the hooks claim it at the first model call).
		const started = { ORRERY_AGENT: "Test", ORRERY_AGENT_TOKEN: token };
		expect(agyStatus(status, { config: t.config, env: started, agyPid: process.pid, envOf: () => started })).toBe("");
		expect(agyStatus("not json", { config: t.config, env: {}, agyPid: process.pid })).toBe("");
		cleanupDirs();
	});
});
