import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRequest } from "../../src/agent/settings-request.ts";
import { waitUntil } from "../claude/support.ts";
import { FAUX_SUMMARY } from "./harness.ts";
import { cleanup, isolatedHome, lastAgent, pi, world } from "./world.ts";

afterEach(cleanup);
isolatedHome();

describe("pi takes a summary-model change from outside", () => {
	it("applies request.json on its tick and tells the user", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { tickMs: 20 });
		const agent = lastAgent();
		writeRequest(agent.config.dir, { agent: "Atlas", kind: "compactor", args: `${FAUX_SUMMARY.provider}/${FAUX_SUMMARY.model} high`, at: Date.now() });
		await waitUntil(() => agent.compactorModel.thinking === "high");
		expect(agent.compactorSource).toBe("chat");
		expect(run.notices.some((n) => n.message.includes("changed from outside pi"))).toBe(true);
	});

	it("ignores a stale request, with one warning", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { tickMs: 20 });
		const agent = lastAgent();
		const before = agent.compactorModel;
		writeRequest(agent.config.dir, { agent: "Atlas", kind: "compactor", args: "x/y high", at: 0 });
		await waitUntil(() => run.notices.some((n) => n.message.includes("older than 15 s")));
		expect(agent.compactorModel).toEqual(before);
	});
});
