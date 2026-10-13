import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactorMenu, pickSummaryModel, laneTarget } from "../../src/lane/compactor-menu.ts";
import { FAUX_SUMMARY } from "./harness.ts";
import { cleanup, lastLane, pi, summarySourcesFor, world } from "./world.ts";

// The groups shown depend on keys in the environment; the user's shell may export some.
beforeEach(() => {
	for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) vi.stubEnv(name, "");
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await cleanup();
});

/** Answers select/input in order; records the titles and options it was shown. */
function scripted(answers: (string | undefined)[]) {
	const shown: { title: string; options?: string[] }[] = [];
	return {
		shown,
		ui: {
			select: async (title: string, options: string[]) => (shown.push({ title, options }), answers.shift()),
			input: async (title: string) => (shown.push({ title }), answers.shift()),
		},
	};
}

const summaries = `${FAUX_SUMMARY.provider}/${FAUX_SUMMARY.model}`;

describe("/compactor menu", () => {
	it("goes group → provider → model, skips a one-entry step, tests, then switches", async () => {
		const { root, config } = world();
		await pi(root, join(root, "agent-Atlas"), config);
		const lane = lastLane();
		const sources = summarySourcesFor(config); // the faux-backed sources world() gave the extension
		await sources.credentials.modify("openrouter", async () => ({ type: "api_key", key: "sk-test" }));
		// OpenRouter has > 30 models: the menu asks for words first.
		const { ui, shown } = scripted(["API key", undefined]);
		expect(await compactorMenu(ui, sources, laneTarget(lane))).toMatch(/^summaries: /);
		expect(shown[0].options).toEqual(["Sign in", "API key"]); // one OpenRouter slot in both groups
		expect(shown[1].title).toMatch(/OpenRouter: \d+ models\. Words to narrow/);
	});

	it("narrows a long list by words and shows each model's context and price", async () => {
		const { root, config } = world();
		await pi(root, join(root, "agent-Atlas"), config);
		const sources = summarySourcesFor(config);
		await sources.credentials.modify("openrouter", async () => ({ type: "api_key", key: "sk-test" }));
		const { ui, shown } = scripted(["API key", "claude haiku", undefined]);
		expect(await compactorMenu(ui, sources, laneTarget(lastLane()))).toBe(`summaries: ${summaries} (off) · from config`);
		expect(shown[2].title).toBe("OpenRouter model:");
		expect(shown[2].options?.length).toBeGreaterThan(0);
		for (const line of shown[2].options ?? []) expect(line).toMatch(/^\S*claude\S*haiku\S*  ·  \d+K  ·  \$\d+\.\d\d in \/ \$\d+\.\d\d out per M$/);
	});

	it("switches to a local model after its test call; a failed test keeps the current model and says why", async () => {
		const { root, config } = world({ local: true });
		await pi(root, join(root, "agent-Atlas"), config);
		const lane = lastLane();
		const sources = summarySourcesFor(config);
		sources.summary.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "connect ECONNREFUSED 127.0.0.1:9" })]);
		const failed = scripted(["Local", "faux-2  ·  128K"]);
		expect(await compactorMenu(failed.ui, sources, laneTarget(lane))).toMatch(new RegExp(`^Not switched: .+\\.\\nsummaries: ${summaries} \\(off\\) · from config$`));
		expect(failed.shown.map((s) => s.options)).toEqual([["Local", "Sign in"], ["faux-1  ·  128K", "faux-2  ·  128K"]]);
		expect(lane.compactorSource).toBe("config");

		sources.summary.setResponses([fauxAssistantMessage("OK")]);
		const { ui } = scripted(["Local", "faux-2  ·  128K"]);
		expect(await compactorMenu(ui, sources, laneTarget(lane))).toBe(`summaries: ${FAUX_SUMMARY.provider}/faux-2 (off) · set in chat`);
		expect(lane.compactorModel.modelId).toBe("faux-2");
		expect(lane.compactorSource).toBe("chat");
	});

	it("returns the current line unchanged when the menu is closed", async () => {
		const { root, config } = world();
		await pi(root, join(root, "agent-Atlas"), config);
		const { ui } = scripted([undefined]);
		const sources = summarySourcesFor(config);
		await sources.credentials.modify("openrouter", async () => ({ type: "api_key", key: "sk-test" }));
		expect(await compactorMenu(ui, sources, laneTarget(lastLane()))).toBe(`summaries: orrery-faux-summary/faux-1 (off) · from config`);
	});

	it("offers OpenRouter sign-in when nothing is saved", async () => {
		const { root, config } = world();
		await pi(root, join(root, "agent-Atlas"), config);
		const { ui, shown } = scripted([undefined]);
		await compactorMenu(ui, summarySourcesFor(config), laneTarget(lastLane()));
		expect(shown[0].options).toEqual(["Sign in"]);
	});
});


it("choosing OpenRouter signs in when needed, then shows its priced models", async () => {
	const { config } = world();
	const sources = summarySourcesFor(config);
	const { ui, shown } = scripted(["Sign in", "haiku", undefined]);
	const signed: string[] = [];
	await pickSummaryModel(ui, sources, { heading: "Summaries", thinking: "low", signIn: async (name) => {
		signed.push(name);
		await sources.credentials.modify("openrouter", async () => ({ type: "api_key", key: "synthetic-menu-key" }));
	} });
	expect(signed).toEqual(["openrouter"]);
	expect(shown.at(-1)?.title).toBe("OpenRouter model:");
	expect(shown.at(-1)?.options?.some((s) => s.includes("haiku") && s.includes("$"))).toBe(true);
});
