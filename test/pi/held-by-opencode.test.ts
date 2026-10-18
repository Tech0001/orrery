import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAgent } from "../../src/agent/memory-agent.ts";
import { agentModelSource } from "../../src/agent/model-source.ts";
import { fauxModels } from "../agent/support.ts";
import { cleanup, isolatedHome, pi, world } from "./world.ts";

afterEach(cleanup);
isolatedHome();

describe("pi in an agent an OpenCode session has open", () => {
	it("says the agent is open in OpenCode, and runs without memory", async () => {
		const { root, config } = world();
		const agent = config.agents.get("Atlas")!;
		// What Orrery's OpenCode plugin holds: the agent's memory, its status.json naming OpenCode.
		const open = MemoryAgent.open({ agent, models: agentModelSource(fauxModels().models), report: () => {}, host: "opencode" });
		try {
			open.writeStatus(false);
			const run = await pi(root, join(root, "agent-Atlas"), config);
			expect(run.notices).toContainEqual({ message: "Atlas is open in OpenCode; this pi runs without memory.", type: "warning" });
		} finally {
			await open.close();
		}
	});
});
