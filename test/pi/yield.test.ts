import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Holder } from "../../src/claude/holder.ts";
import { spoolEvent } from "../../src/claude/spool.ts";
import { readHolder } from "../../src/lane/handover.ts";
import type { ModelSource } from "../../src/lane/model-source.ts";
import { waitUntil } from "../claude/support.ts";
import { cleanup, isolatedHome, lastLane, pi, world } from "./world.ts";

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
	it("a holder only finishing summaries yields the lane to pi, which then has that session's words", async () => {
		const { root, config } = world();
		const lane = config.lanes.get("Atlas")!;
		const holder = await Holder.start({ lane, session: "s1", claudePid: 111, nonce: "n", models: stuck, alive: () => true, tickMs: 20 });
		try {
			expect(holder).toBeDefined();
			const now = Date.now();
			spoolEvent(lane.dir, "s1", { kind: "prompt", at: now, claudePid: 111, text: `A long prompt ${"detail ".repeat(200)}` });
			spoolEvent(lane.dir, "s1", { kind: "end", at: now + 1, claudePid: 111 });
			await waitUntil(() => readHolder(lane.dir)?.state === "finishing");
			await pi(root, join(root, "agent-Atlas"), config);
			expect(lastLane().view.stats().messages).toBe(1);
			await holder?.done;
		} finally {
			await holder?.stop("test over");
		}
	});
});
