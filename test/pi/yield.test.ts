import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Holder } from "../../src/claude/holder.ts";
import { readHolder } from "../../src/agent/handover.ts";
import type { ModelSource } from "../../src/agent/model-source.ts";
import { pendingEvents, readEvent } from "../../src/claude/spool.ts";
import { readUnconfirmed } from "../../src/claude/transcript.ts";
import { spool, waitUntil } from "../claude/support.ts";
import { transcriptIn } from "../claude/transcript-lines.ts";
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

	it("a holder whose session ended while it still holds an unconfirmed prompt yields to pi as before; the prompt waits", async () => {
		const { root, config } = world();
		const agent = config.agents.get("Atlas")!;
		const holder = await Holder.start({ agent, session: "s1", claudePid: 111, nonce: "n", models: stuck, alive: () => true, tickMs: 20 });
		try {
			const transcript = transcriptIn(root);
			const now = Date.now();
			// Its transcript never shows the prompt (within the 30 s grace), and the session ends behind it.
			spool(agent, "s1", { kind: "transcript", path: transcript.path("s1"), projects: transcript.projects, offset: 0 }, 111, now);
			spool(agent, "s1", { kind: "prompt", text: "Not confirmed yet.", promptId: "p-1" }, 111, now + 1);
			spool(agent, "s1", { kind: "end" }, 111, now + 2);
			await waitUntil(() => readHolder(agent.dir)?.state === "finishing");
			await pi(root, join(root, "agent-Atlas"), config);
			await holder?.done;
			expect(lastAgent().view.stats().messages).toBe(0);
			// Left for the next recorder of the agent to confirm, or drop and count.
			expect(pendingEvents(agent.dir, "s1").map((event) => readEvent(event.path)?.kind)).toEqual(["prompt", "end"]);
			expect(readUnconfirmed(agent.dir)).toBe(0);
		} finally {
			await holder?.stop("test over");
		}
	});
});
