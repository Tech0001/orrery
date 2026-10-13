import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Holder } from "../../src/claude/holder.ts";
import { laneModelSource } from "../../src/lane/model-source.ts";
import { fauxModels } from "../lane/support.ts";
import { cleanup, pi, world } from "./world.ts";

afterEach(cleanup);

describe("pi in a lane a Claude Code session records", () => {
	it("says the lane is open in Claude Code, and runs without memory", async () => {
		const { root, config } = world();
		const lane = config.lanes.get("Atlas")!;
		const holder = await Holder.start({ lane, session: "s1", claudePid: 111, nonce: "n", models: laneModelSource(fauxModels().models), alive: () => true, tickMs: 20 });
		try {
			expect(holder).toBeDefined();
			const run = await pi(root, join(root, "agent-Atlas"), config);
			expect(run.notices).toContainEqual({ message: "Atlas is open in Claude Code; this pi runs without memory.", type: "warning" });
			expect(run.notices.some((n) => n.message.includes("another pi"))).toBe(false);
		} finally {
			await holder?.stop("test over");
		}
	});
});
