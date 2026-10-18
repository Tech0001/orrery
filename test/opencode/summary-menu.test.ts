import { describe, expect, it } from "vitest";
import { type MenuData, type MenuDialogs, type MenuModel, pickSummaryModel, type SummaryRpc, summaryCommandLayer } from "../../src/opencode/summary-menu.ts";

const model = (provider: string, modelId: string, extra: Partial<MenuModel> = {}): MenuModel => ({ provider, modelId, title: modelId, thinking: ["off", "low", "high"], current: false, ...extra });

const DATA: MenuData = {
	line: "summaries: opencode/fake/fake-model (high) · set in chat",
	thinking: "high",
	configured: "faux-compactor/faux-1",
	groups: [
		{ key: "signin", title: "Sign in", current: false, providers: [{ key: "openai", title: "OpenAI", current: false, unavailable: "not saved; in a shell: orrery login openai" }] },
		{ key: "key", title: "API key", current: false, providers: [{ key: "anthropic", title: "Anthropic", current: false }] },
		{
			key: "opencode",
			title: "OpenCode",
			current: true,
			providers: [
				{ key: "opencode", title: "OpenCode · opencode", current: false, models: [model("opencode", "opencode/big-pickle", { unavailable: "OpenCode's free tier only works inside OpenCode chats; background summaries aren't allowed" })] },
				{ key: "fake", title: "OpenCode · fake", current: true, models: [model("opencode", "fake/other"), model("opencode", "fake/fake-model", { current: true, thinking: ["off", "high"] })] },
			],
		},
	],
};

/** Dialogs that answer from a script (by an option's title, or "first"), keeping what each showed. */
function scripted(answers: (string | undefined)[]) {
	const shown: { title: string; options: string[]; disabled: string[]; descriptions: (string | undefined)[] }[] = [];
	const dialogs: MenuDialogs = {
		select: async ({ title, options }) => {
			shown.push({ title, options: options.map((o) => o.title), disabled: options.filter((o) => "disabled" in o).map((o) => o.title), descriptions: options.map((o) => o.description) });
			const answer = answers.shift();
			if (answer === undefined) return undefined;
			const picked = answer === "first" ? options[0] : options.find((o) => o.title === answer);
			return picked?.value;
		},
	};
	return { dialogs, shown };
}

function rpc(data: MenuData = DATA) {
	const switched: unknown[] = [];
	const asked: string[] = [];
	const api: SummaryRpc = {
		menu: async () => data,
		models: async ({ provider }) => {
			asked.push(provider);
			return { models: [model(provider, "claude-haiku-4-5"), model(provider, "claude-sonnet-4-5")] };
		},
		switch: async (input) => {
			switched.push(input);
			return { ok: true, text: "summaries: switched" };
		},
	};
	return { api, switched, asked };
}

describe("OpenCode's /compactor picker (its TUI side)", () => {
	it("offers the current group, provider, model and thinking level first, so Enter keeps each", async () => {
		const { dialogs, shown } = scripted(["first", "first", "first", "first"]);
		const server = rpc();
		expect(await pickSummaryModel(dialogs, server.api)).toEqual({ ok: true, text: "summaries: switched" });
		expect(shown.map((s) => s.options[0])).toEqual(["OpenCode", "OpenCode · fake", "fake/fake-model", "high"]);
		expect(shown[0]).toMatchObject({ title: "summaries: opencode/fake/fake-model (high) · set in chat\nSummaries from:", options: ["OpenCode", "Sign in", "API key", "Back to the config's (faux-compactor/faux-1)"] });
		expect(shown[3]).toMatchObject({ title: "Thinking (now high):", options: ["high", "off"] });
		expect(server.switched).toEqual([{ provider: "opencode", modelId: "fake/fake-model", thinking: "high" }]);
	});

	it("lists OpenCode's free tier as unavailable, with the reason, and never switches to it", async () => {
		const { dialogs, shown } = scripted(["OpenCode", "OpenCode · opencode", "opencode/big-pickle  ·  unavailable"]);
		const server = rpc();
		expect(await pickSummaryModel(dialogs, server.api)).toEqual({ ok: false, text: "opencode/big-pickle: OpenCode's free tier only works inside OpenCode chats; background summaries aren't allowed." });
		// Shown, not disabled (OpenCode's dialog drops a disabled option, reason and all): the reason as its description.
		expect(shown[2]).toMatchObject({ options: ["opencode/big-pickle  ·  unavailable"], disabled: [], descriptions: ["OpenCode's free tier only works inside OpenCode chats; background summaries aren't allowed"] });
		expect(server.switched).toEqual([]);
		// A title that says so already is kept as it is.
		const titled = { ...DATA, groups: DATA.groups.map((group) => (group.key !== "opencode" ? group : { ...group, providers: group.providers.map((provider) => ({ ...provider, models: provider.models?.map((each) => (each.unavailable === undefined ? each : { ...each, title: "big-pickle  ·  free tier, unavailable" })) })) })) };
		const again = scripted(["OpenCode", "OpenCode · opencode", "big-pickle  ·  free tier, unavailable"]);
		expect(await pickSummaryModel(again.dialogs, rpc(titled).api)).toMatchObject({ ok: false });
		expect(again.shown[2]?.options).toEqual(["big-pickle  ·  free tier, unavailable"]);
	});

	it("lists a provider that can't be used (no login saved) with the reason, and picking it says why", async () => {
		const signin = { key: "signin", title: "Sign in", current: false, providers: [{ key: "openai", title: "OpenAI", current: false, unavailable: "not saved; in a shell: orrery login openai" }, { key: "anthropic", title: "Anthropic", current: false }] };
		const data: MenuData = { ...DATA, groups: [signin, ...DATA.groups.filter((group) => group.key !== "signin")] };
		const { dialogs, shown } = scripted(["Sign in", "OpenAI  ·  unavailable"]);
		const server = rpc(data);
		expect(await pickSummaryModel(dialogs, server.api)).toEqual({ ok: false, text: "OpenAI: not saved; in a shell: orrery login openai." });
		expect(shown[1]).toMatchObject({ options: ["OpenAI  ·  unavailable", "Anthropic"], disabled: [], descriptions: ["not saved; in a shell: orrery login openai", undefined] });
		expect(server.switched).toEqual([]);
		expect(server.asked).toEqual([]);
	});

	it("registers /compactor and its palette entry in OpenCode's global keymap mode, where slash completion and the palette see it", () => {
		let ran = 0;
		const layer = summaryCommandLayer(() => ran++);
		expect(layer.mode).toBe("global");
		expect(layer.commands).toEqual([expect.objectContaining({ id: "orrery.compactor", title: "Orrery: summary model", palette: true, slash: { name: "compactor" } })]);
		layer.commands[0]?.run();
		expect(ran).toBe(1);
	});

	it("asks the server for an Orrery source's models, then the thinking level, then switches; goes back to the config's; stops on a cancel", async () => {
		const server = rpc();
		expect(await pickSummaryModel(scripted(["API key", "claude-sonnet-4-5", "low"]).dialogs, server.api)).toEqual({ ok: true, text: "summaries: switched" });
		expect(server.asked).toEqual(["anthropic"]);
		expect(await pickSummaryModel(scripted(["Back to the config's (faux-compactor/faux-1)"]).dialogs, server.api)).toEqual({ ok: true, text: "summaries: switched" });
		expect(await pickSummaryModel(scripted(["Sign in"]).dialogs, server.api)).toEqual({ ok: false, text: "OpenAI: not saved; in a shell: orrery login openai." });
		expect(await pickSummaryModel(scripted([undefined]).dialogs, server.api)).toBeUndefined();
		expect(await pickSummaryModel(scripted(["API key", "claude-sonnet-4-5", undefined]).dialogs, server.api)).toBeUndefined();
		expect(server.switched).toEqual([{ provider: "anthropic", modelId: "claude-sonnet-4-5", thinking: "low" }, { reset: true }]);
	});

	it("says why when the server can't offer a pick", async () => {
		const server = rpc({ line: "", thinking: "off", groups: [], problem: "Orrery: this agent's memory is not open for writing in this OpenCode." });
		expect(await pickSummaryModel(scripted([]).dialogs, server.api)).toEqual({ ok: false, text: "Orrery: this agent's memory is not open for writing in this OpenCode." });
	});
});
