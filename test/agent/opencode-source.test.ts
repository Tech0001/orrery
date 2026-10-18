import { describe, expect, it } from "vitest";
import { compactorCommandIn, FREE_REASON, openCodeFree, openCodeModelOf, openCodeRef, openCodeVariant } from "../../src/agent/opencode-source.ts";

describe("the OpenCode model summary source's words and markers", () => {
	it("knows OpenCode's free tier by OpenCode's own rule (its gateway's models that charge nothing for input), and by a -free id", () => {
		const paid = [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }];
		const free = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }];
		expect(openCodeFree({ providerID: "opencode", id: "big-pickle", cost: free })).toBe(true);
		expect(openCodeFree({ providerID: "opencode", id: "deepseek-v4.1-flash-free", cost: free })).toBe(true);
		expect(openCodeFree({ providerID: "opencode-go", id: "cat-jam-free", cost: free })).toBe(true);
		expect(openCodeFree({ providerID: "opencode", id: "something-free", cost: paid })).toBe(true);
		expect(openCodeFree({ providerID: "opencode", id: "no-price-listed", cost: [] })).toBe(true);
		expect(openCodeFree({ providerID: "opencode", id: "claude-sonnet-4-5", cost: paid })).toBe(false);
		// Someone's own key or server is never OpenCode's free tier, whatever it costs.
		expect(openCodeFree({ providerID: "anthropic", id: "claude-sonnet-4-5", cost: paid })).toBe(false);
		expect(openCodeFree({ providerID: "fake", id: "fake-model", cost: free })).toBe(false);
		expect(openCodeFree({ providerID: "openrouter", id: "some-model:free", cost: free })).toBe(false);
		// A model of OpenCode's gateway under another provider's name, by its settings; a -free model id.
		expect(openCodeFree({ providerID: "my-zen", id: "big", cost: free, settings: { provider: "opencode" } })).toBe(true);
		expect(openCodeFree({ providerID: "my-zen", id: "big", cost: free, settings: { baseURL: "https://opencode.ai/zen/v1" } })).toBe(true);
		expect(openCodeFree({ providerID: "my-zen", id: "big", cost: free, settings: { baseURL: "https://api.opencode.ai/v1" } })).toBe(true);
		expect(openCodeFree({ providerID: "my-zen", id: "big", cost: paid, settings: { baseURL: "https://opencode.ai/zen/v1" } })).toBe(false);
		expect(openCodeFree({ providerID: "opencode", id: "alias", modelID: "deepseek-v4.1-flash-free", cost: paid })).toBe(true);
		expect(openCodeFree({ providerID: "fake", id: "x", cost: free, settings: { baseURL: "https://notopencode.ai.example/v1" } })).toBe(false);
		expect(FREE_REASON).toBe("OpenCode's free tier only works inside OpenCode chats; background summaries aren't allowed");
	});

	it("refs: opencode/<provider>/<model>, read back; thinking as OpenCode's variant of that name (off is none)", () => {
		expect(openCodeRef({ providerID: "anthropic", id: "claude-sonnet-4-5" })).toBe("opencode/anthropic/claude-sonnet-4-5");
		expect(openCodeModelOf("openrouter/qwen/qwen3-coder")).toEqual({ providerID: "openrouter", id: "qwen/qwen3-coder" });
		expect(openCodeModelOf("nomodel")).toBeUndefined();
		expect(openCodeModelOf("/x")).toBeUndefined();
		expect(openCodeVariant("high", ["low", "medium", "high"])).toBe("high");
		expect(openCodeVariant("off", ["none", "high"])).toBe("none");
		expect(openCodeVariant("off", ["high"])).toBeUndefined();
		expect(openCodeVariant("xhigh", ["low", "high"])).toBeUndefined();
	});

	it("names each tool's way to switch", () => {
		expect([compactorCommandIn("pi", "A"), compactorCommandIn("omp", "A"), compactorCommandIn("claude-code", "A"), compactorCommandIn("codex", "A"), compactorCommandIn("opencode", "A")]).toEqual(["/compactor", "/compactor", "/orrery:compactor", "orrery compactor A", "/compactor"]);
	});
});
