import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Holder } from "../../src/claude/holder.ts";
import { agentModelSource } from "../../src/agent/model-source.ts";
import { fauxModels } from "../agent/support.ts";
import { cleanup, isolatedHome, pi, world } from "./world.ts";

afterEach(cleanup);
isolatedHome();

describe("pi in an agent a Codex session records", () => {
	it("says the agent is open in Codex, and runs without memory", async () => {
		const { root, config } = world();
		const agent = config.agents.get("Atlas")!;
		const holder = await Holder.start({ agent, session: "s1", claudePid: 111, host: "codex", nonce: "n", models: agentModelSource(fauxModels().models), alive: () => true, tickMs: 20 });
		try {
			expect(holder).toBeDefined();
			const run = await pi(root, join(root, "agent-Atlas"), config);
			expect(run.notices).toContainEqual({ message: "Atlas is open in Codex; this pi runs without memory.", type: "warning" });
		} finally {
			await holder?.stop("test over");
		}
	});
});
