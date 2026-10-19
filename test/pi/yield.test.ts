import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Holder } from "../../src/claude/holder.ts";
import { readHolder } from "../../src/agent/handover.ts";
import type { ModelSource } from "../../src/agent/model-source.ts";
import { spool, waitUntil } from "../claude/support.ts";
import { cleanup, isolatedHome, lastAgent, pi, world } from "./world.ts";

afterEach(cleanup);
isolatedHome();

/** Summaries that never come until aborted: a holder whose session ended stays "finishing". */
const stuck: ModelSource = {
	find: (provider, id) => ({ api: "faux", provider, id, contextWindow: 200_000 }),
	streamSimple: (_model, _context, options) => ({
		result: () => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
	}),
};

describe("pi and a Claude Code holder", () => {
	it("a holder only finishing summaries yields the agent to pi, which then has that session's words", async () => {
		const { root, config } = world();
		const agent = config.agents.get("Atlas")!;
		const holder = await Holder.start({ agent, session: "s1", claudePid: 111, nonce: "n", models: stuck, alive: () => true, tickMs: 20 });
		try {
			expect(holder).toBeDefined();
			const now = Date.now();
			// A Claude Code prompt as its hook spools it, its transcript confirming it (test/claude/support.ts spool).
			spool(agent, "s1", { kind: "prompt", text: `A long prompt ${"detail ".repeat(200)}` }, 111, now);
			spool(agent, "s1", { kind: "end" }, 111, now + 1);
			await waitUntil(() => readHolder(agent.dir)?.state === "finishing");
			await pi(root, join(root, "agent-Atlas"), config);
			expect(lastAgent().view.stats().messages).toBe(1);
			await holder?.done;
		} finally {
			await holder?.stop("test over");
		}
	});
});
