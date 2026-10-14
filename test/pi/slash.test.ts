import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { FAUX } from "./harness.ts";
import { cleanup, isolatedHome, lastLane, pi, summarySourcesFor, world } from "./world.ts";

afterEach(cleanup);
isolatedHome();

describe("commands typed into pi", () => {
	it("/memory, /compactor and /browse run through pi's prompt and show their text", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		await run.session.prompt("/memory");
		await run.session.prompt("/compactor");
		const texts = run.notices.map((n: { message: string }) => n.message);
		expect(texts.some((t: string) => /Atlas: 0 messages/.test(t))).toBe(true);
		expect(texts.some((t: string) => /^summaries: /.test(t))).toBe(true);
	});
	it("/compactor provider/id thinking switches the summary model", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		summarySourcesFor(config).agent.setResponses([fauxAssistantMessage("OK")]); // the test call before the switch
		await run.session.prompt(`/compactor ${FAUX.provider}/${FAUX.model} low`);
		const texts = run.notices.map((n: { message: string }) => n.message);
		expect(texts.at(-1)).toBe(`summaries: ${FAUX.provider}/${FAUX.model} (low) · set in chat`);
		expect(lastLane().compactorSource).toBe("chat");
	});
});
