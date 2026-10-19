import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forgetSession } from "../../src/agent/sessions.ts";
import { createOrrery } from "../../src/pi/index.ts";
import { cleanup, scratchHome, summarySourcesFor, world } from "../pi/world.ts";
import { type FakeOmp, fakeOmp, ompCleanup, ompOrrery, track } from "./world.ts";

afterEach(async () => {
	await ompCleanup();
	await cleanup();
});

const NOTICE = "Orrery: OMP_TUI_DEBUG is set, so anything sent through OMP's debug socket would count as typed; this session opens no memory and records nothing.";
const DEBUG = { OMP_TUI_DEBUG: "/some/socket" };

const hosts = (dataDir: string): string[] => (existsSync(join(dataDir, "session-hosts")) ? readdirSync(join(dataDir, "session-hosts")) : []);

async function turn(host: FakeOmp, user: string, reply: string) {
	host.say("user", user);
	const [result] = await host.emit("before_agent_start", { prompt: user, systemPrompt: ["base"] });
	host.say("assistant", reply);
	await host.emit("message_end", { message: {} });
	await host.emit("agent_end", { messages: [] });
	return result;
}

describe("OMP_TUI_DEBUG (OMP's debug socket types for the user)", () => {
	it("OMP with it set: one notice, no memory written, no host record, the guard still on", async () => {
		const { root, config, configPath } = world();
		const dataDir = dirname(configPath);
		const omp = await ompOrrery(join(root, "agent-Atlas"), config, { env: DEBUG });
		expect(omp.notices).toEqual([{ type: "warning", message: NOTICE }]);
		expect(omp.status("orrery")).toBeUndefined();
		await turn(omp, "Hello.", "Hi.");
		await omp.emit("session_switch", { reason: "new" });
		expect(omp.notices).toHaveLength(1);
		expect(existsSync(join(dataDir, "agents"))).toBe(false);
		expect(hosts(dataDir)).toEqual([]);
		const [blocked] = await omp.emit("tool_call", { toolName: "write", toolCallId: "t1", input: { path: `${root}-escape.txt`, content: "x" } });
		expect(blocked).toMatchObject({ block: true });
		await omp.emit("session_shutdown");
		expect(existsSync(join(dataDir, "agents"))).toBe(false);
	});

	it("OMP with it empty or unset: unchanged, memory opens and records", async () => {
		const { root, config, configPath } = world();
		const dataDir = dirname(configPath);
		const omp = await ompOrrery(join(root, "agent-Atlas"), config, { env: { OMP_TUI_DEBUG: "" } });
		expect(omp.notices).toEqual([]);
		expect(omp.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		expect(existsSync(join(dataDir, "agents", "Atlas"))).toBe(true);
		for (const file of hosts(dataDir)) forgetSession(dataDir, Number.parseInt(file, 10));
	});

	it("pi with it set: unchanged (pi has no such socket)", async () => {
		const { root, config, configPath } = world();
		const dataDir = dirname(configPath);
		const pi = track(fakeOmp(join(root, "agent-Atlas"), [createOrrery({ config, summarySources: async (cfg) => summarySourcesFor(cfg), ...scratchHome(dirname(config.dataDir)), env: DEBUG })], { omp: false }));
		await pi.emit("session_start");
		expect(pi.notices).toEqual([]);
		expect(pi.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		expect(existsSync(join(dataDir, "agents", "Atlas"))).toBe(true);
		for (const file of hosts(dataDir)) forgetSession(dataDir, Number.parseInt(file, 10));
	});
});
