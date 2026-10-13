import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../src/lane/config.ts";
import { FileCredentialStore } from "../../src/lane/credentials.ts";
import {
	explainFailure,
	KEY_NOT_NAME,
	listModels,
	listSources,
	moveOpenAIKey,
	providerFor,
	summarySources,
	testChoice,
} from "../../src/lane/summary-sources.ts";
import { tempDir } from "./support.ts";
import { rmSync } from "node:fs";

const dirs: string[] = [];
beforeEach(() => {
	for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ORI_OPENROUTER_SESSION_ID"]) vi.stubEnv(k, "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(extra = "") {
	const dir = tempDir("orrery-sources-");
	dirs.push(dir);
	const toml = `data_dir = ${JSON.stringify(dir)}\n${extra}\n[lanes.Test]\nworkspace = ${JSON.stringify(dir)}\nmodel = "openai/gpt-6.1-sol"\ncompactor_model = "openai/gpt-6.1-sol"\n`;
	const config = parseConfig(toml, dir);
	const credentials = new FileCredentialStore(join(dir, "c.json"));
	return { dir, config, credentials, sources: summarySources(config, credentials) };
}

const LOCAL = `[[providers]]\nid = "bonsai"\nbase_url = "http://127.0.0.1:9/v1"\nmodels = [ { id = "Bonsai-27B", context_window = 262144, max_tokens = 8192, reasoning = true } ]\n`;

describe("providerFor", () => {
	it("looks names up as own properties only", () => {
		const { config } = setup();
		expect(() => providerFor(config, "key", "constructor")).toThrow(/^API key has openai, anthropic, openrouter\.$/);
		expect(() => providerFor(config, "signin", "toString")).toThrow(/^Sign in has openai, openrouter\.$/);
		expect(() => providerFor(config, "local", "constructor")).toThrow("No Local sources are configured.");
	});

	it("never repeats an unknown name, and says so when a key was typed in its place", () => {
		const { config } = setup(LOCAL);
		for (const typed of ["sk-or-v1-0123456789abcdef", "x9".repeat(30)]) {
			for (const group of ["signin", "key", "local"] as const) {
				let message = "";
				try {
					providerFor(config, group, typed);
				} catch (error) {
					message = (error as Error).message;
				}
				expect(message).toBe(KEY_NOT_NAME);
				expect(message).not.toContain(typed);
			}
		}
		expect(KEY_NOT_NAME).toBe("That looks like a key, not a provider name: run `orrery login --key <openai|anthropic|openrouter>` and paste it at the hidden prompt.");
	});

	it("maps the picker's names to registry ids, and refuses others plainly", () => {
		const { config } = setup(LOCAL);
		expect(providerFor(config, "signin", "openai")).toBe("openai");
		expect(providerFor(config, "key", "openai")).toBe("openai-api");
		expect(providerFor(config, "key", "anthropic")).toBe("anthropic");
		expect(providerFor(config, "key", "openrouter")).toBe("openrouter");
		expect(providerFor(config, "local", "bonsai")).toBe("bonsai");
		expect(() => providerFor(config, "signin", "anthropic")).toThrow(/^Sign in has openai, openrouter\.$/);
		const plain = setup();
		expect(() => providerFor(plain.config, "local", "x")).toThrow("No Local sources are configured.");
	});
});

describe("listSources", () => {
	it("shows each group's entries and states; Local only when configured; Pro/Max Anthropic unusable", async () => {
		const { credentials, sources } = setup(LOCAL);
		await credentials.modify("openai", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 }) as never);
		await credentials.modify("anthropic", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 }) as never);
		const entries = await listSources(sources, { OPENROUTER_API_KEY: "x" });
		expect(entries.map((e) => [e.group, e.name, e.state])).toEqual([
			["signin", "openai", "saved"],
			["signin", "openrouter", "from env"],
			["key", "openai", "not saved"],
			["key", "anthropic", "unusable"],
			["key", "openrouter", "from env"],
			["local", "bonsai", "no login needed"],
		]);
		expect(entries[3].note).toMatch(/Pro\/Max.*orrery login --key anthropic/);
		const plain = await listSources(setup().sources, {});
		expect(plain.some((e) => e.group === "local")).toBe(false);
	});
});

describe("moveOpenAIKey", () => {
	it("moves an OpenAI key saved under the sign-in's id to openai-api, once", async () => {
		const { credentials } = setup();
		await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-old" }));
		expect(await moveOpenAIKey(credentials)).toBe(true);
		expect(await credentials.read("openai")).toBeUndefined();
		expect(await credentials.read("openai-api")).toEqual({ type: "api_key", key: "sk-old" });
		expect(await moveOpenAIKey(credentials)).toBe(false);
	});
});

describe("listModels", () => {
	it("filters by every word, prices key sources, and lists only the plan's models for the sign-in", () => {
		const { sources } = setup(LOCAL);
		const haiku = listModels(sources, "openrouter", "claude haiku");
		expect(haiku.map((m) => m.id)).toContain("anthropic/claude-haiku-4.5");
		expect(haiku.find((m) => m.id === "anthropic/claude-haiku-4.5")?.price).toEqual({ input: 1, output: 5 });
		const plan = listModels(sources, "openai");
		expect(plan.length).toBeGreaterThan(0);
		expect(plan.every((m) => m.price === undefined)).toBe(true);
		expect(plan.some((m) => m.id === "gpt-4")).toBe(false); // an API-only model is not on the plan
		expect(listModels(sources, "bonsai").map((m) => [m.id, m.price])).toEqual([["Bonsai-27B", undefined]]);
	});
});

describe("explainFailure", () => {
	it("strips control characters from a provider's own words", () => {
		const plain = explainFailure("openrouter", "odd \u001b[31mred\u001b]0;title\u0007 tail");
		expect(plain).not.toContain("\u001b");
		expect(plain).not.toContain("\u0007");
		expect(plain).toContain("red");
	});

	it("words Orrery's own registry's auth failures: an expired sign-in, a missing login", () => {
		expect(explainFailure("openai", "OAuth refresh failed for openai")).toBe("the ChatGPT sign-in expired or was refused (orrery login openai)");
		expect(explainFailure("openai", "Provider is not configured: openai")).toBe("no ChatGPT login saved (orrery login openai)");
		expect(explainFailure("openai-api", "No API key for provider: openai-api")).toBe("no OpenAI login saved (orrery login --key openai)");
		expect(explainFailure("anthropic", "Provider is not configured: anthropic")).toBe("no Anthropic login saved (orrery login --key anthropic)");
		expect(explainFailure("openrouter", "No API key for provider: openrouter")).toBe("no OpenRouter login saved (orrery login --key openrouter)");
		expect(explainFailure("bonsai", "No API key for provider: bonsai")).toBe("no bonsai login saved (check the local server's api_key_env)");
	});

	it("reads a quota or billing message on the ChatGPT sign-in as the plan limit, and on a key as no balance", () => {
		const quota = "You exceeded your current quota, please check your plan and billing details";
		expect(explainFailure("openai", quota)).toBe("the ChatGPT plan limit was reached; retrying");
		expect(explainFailure("openai", "402 Payment Required: billing")).toBe("the ChatGPT plan limit was reached; retrying");
		expect(explainFailure("openai-api", quota)).toBe("the OpenAI account has no balance");
	});

	it("says what went wrong in plain words, and never repeats a key", () => {
		expect(explainFailure("openrouter", "401 Incorrect API key provided: sk-or-v1-abcdef1234567890abcdef")).toBe("OpenRouter refused the key");
		expect(explainFailure("openai", "401 Unauthorized")).toBe("the ChatGPT sign-in expired or was refused (orrery login openai)");
		expect(explainFailure("openrouter", "402 Insufficient credits")).toBe("the OpenRouter account has no balance");
		expect(explainFailure("openai", "You've hit your usage limit. 429")).toBe("the ChatGPT plan limit was reached; retrying");
		expect(explainFailure("anthropic", "404 model: claude-x not found")).toBe("this model isn't available on Anthropic");
		expect(explainFailure("openrouter", "fetch failed: ENOTFOUND openrouter.ai")).toBe("can't reach OpenRouter");
		const odd = explainFailure("anthropic", "weird failure mentioning sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA\nsecond line");
		expect(odd).not.toContain("AAAAAAAAAAAA");
		expect(odd).not.toContain("second line");
	});
});

describe("testChoice", () => {
	function fauxSources(reply: () => ReturnType<typeof fauxAssistantMessage> | Error) {
		const { config, credentials } = setup();
		const faux = fauxProvider({ provider: "faux-test" });
		const step = reply();
		faux.setResponses(step instanceof Error ? [] : [step]);
		const models = createModels();
		(models as unknown as { setProvider(p: unknown): void }).setProvider(faux.provider);
		return { config, credentials, models };
	}

	it("passes when the model answers", async () => {
		const sources = fauxSources(() => fauxAssistantMessage("OK"));
		expect(await testChoice(sources, { provider: "faux-test", modelId: "faux-1", thinking: "off" })).toEqual({ ok: true });
	});

	it("gives up on a model that never answers, after the time allowed", async () => {
		const sources = fauxSources(() => fauxAssistantMessage("never sent"));
		const faux = fauxProvider({ provider: "faux-silent" });
		faux.setResponses([() => new Promise(() => {})]);
		(sources.models as unknown as { setProvider(p: unknown): void }).setProvider(faux.provider);
		expect(await testChoice(sources, { provider: "faux-silent", modelId: "faux-1", thinking: "off" }, 50)).toEqual({
			ok: false,
			reason: "faux-silent/faux-1 did not answer within 0.05 s",
		});
	});

	it("fails with the reason when the model errors, and on an unknown model", async () => {
		const sources = fauxSources(() => new Error("no responses"));
		const failed = await testChoice(sources, { provider: "faux-test", modelId: "faux-1", thinking: "off" });
		expect(failed.ok).toBe(false);
		expect(await testChoice(sources, { provider: "faux-test", modelId: "nope", thinking: "off" })).toEqual({ ok: false, reason: "unknown model faux-test/nope" });
	});

	it("takes no key from the environment in place of the ChatGPT sign-in, and no Pro/Max token in place of an Anthropic key", async () => {
		const { sources } = setup();
		// A 1 ms limit: should a refusal be missed, the test fails without waiting on a real request.
		vi.stubEnv("OPENAI_API_KEY", "sk-env-openai");
		expect(await testChoice(sources, { provider: "openai", modelId: "gpt-6.1-sol", thinking: "off" }, 1)).toEqual({
			ok: false,
			reason: "no ChatGPT sign-in saved; orrery login openai",
		});
		for (const name of ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]) {
			vi.stubEnv(name, "sk-ant-oat01-env");
			expect(await testChoice(sources, { provider: "anthropic", modelId: "claude-haiku-4-5", thinking: "off" }, 1)).toEqual({
				ok: false,
				reason: "Anthropic is signed in with Claude Pro/Max, which summaries may not use; save a key: orrery login --key anthropic",
			});
			vi.stubEnv(name, "");
		}
	});

	it("refuses a missing login and a Pro/Max Anthropic sign-in before any network call", async () => {
		const { credentials, sources } = setup();
		const saved = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			expect(await testChoice(sources, { provider: "anthropic", modelId: "claude-haiku-4-5", thinking: "off" })).toEqual({
				ok: false,
				reason: "no login saved for Anthropic; orrery login --key anthropic",
			});
			await credentials.modify("anthropic", async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }) as never);
			const refused = await testChoice(sources, { provider: "anthropic", modelId: "claude-haiku-4-5", thinking: "off" });
			expect(refused).toEqual({ ok: false, reason: "Anthropic is signed in with Claude Pro/Max, which summaries may not use; save a key: orrery login --key anthropic" });
		} finally {
			if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
		}
	});
});


describe("Ori summaries use only Orrery's saved logins", () => {
	const ambient = { OPENROUTER_API_KEY: "synthetic-router-env", ANTHROPIC_API_KEY: "synthetic-anthropic-env", OPENAI_API_KEY: "synthetic-openai-env" };
	it.each(["configured", "manual"])("ignores ambient provider keys in a %s Ori lane and offers sign-in", async (mode) => {
		for (const [name, value] of Object.entries(ambient)) vi.stubEnv(name, value);
		if (mode === "manual") vi.stubEnv("ORI_OPENROUTER_SESSION_ID", "synthetic-session");
		const { config, credentials } = setup();
		const sources = summarySources(config, credentials, { launcher: mode === "configured" ? "ori" : "direct" });
		for (const provider of ["openrouter", "anthropic", "openai", "openai-api"]) expect(await sources.models.getAuth(provider)).toBeUndefined();
		const rows = await listSources(sources);
		expect(rows.some((row) => row.state === "from env")).toBe(false);
		expect(rows.find((row) => row.group === "signin" && row.name === "openrouter")?.state).toBe("not signed in");
		const { pickSummaryModel } = await import("../../src/lane/compactor-menu.ts");
		const signIn = vi.fn(async () => {});
		await pickSummaryModel({ select: async (_heading: string, choices: string[]) => choices.includes("Sign in") ? "Sign in" : choices.includes("OpenRouter") ? "OpenRouter" : undefined, input: async () => undefined } as never, sources, { heading: "Summaries", thinking: "off", signIn });
		expect(signIn).toHaveBeenCalledWith("openrouter");
		for (const provider of ["openrouter", "anthropic", "openai-api"]) {
			await credentials.modify(provider, async () => ({ type: "api_key", key: `synthetic-saved-${provider}` }));
			expect((await sources.models.getAuth(provider))?.auth.apiKey).toBe(`synthetic-saved-${provider}`);
		}
		await credentials.modify("openai", async () => ({ type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 60_000 }) as never);
		expect((await sources.models.checkAuth("openai"))?.type).toBe("oauth");
		for (const [name, value] of Object.entries(ambient)) expect(process.env[name]).toBe(value);
	});

	it("keeps all direct-lane environment fallbacks, even beside an Ori lane", async () => {
		for (const [name, value] of Object.entries(ambient)) vi.stubEnv(name, value);
		const { config, credentials } = setup('[lanes.Ori]\nworkspace = "/w/ori"\nlauncher = "ori"\ncompactor_model = "openrouter/openai/gpt-4.1-mini"');
		const sources = summarySources(config, credentials, { launcher: "direct" });
		for (const [provider, key] of [["openrouter", ambient.OPENROUTER_API_KEY], ["anthropic", ambient.ANTHROPIC_API_KEY], ["openai", ambient.OPENAI_API_KEY], ["openai-api", ambient.OPENAI_API_KEY]]) expect((await sources.models.getAuth(provider))?.auth.apiKey).toBe(key);
		expect((await listSources(sources)).filter((row) => row.state === "from env")).toHaveLength(4);
	});
});


it("uses the current lane's launcher for shell login rows", async () => {
	const { config: original, credentials, dir } = setup();
	vi.spyOn(process, "cwd").mockReturnValue(dir);
	vi.stubEnv("OPENROUTER_API_KEY", "synthetic-router-env");
	const lane = original.lanes.get("Test")!;
	const config = { ...original, lanes: new Map([["Test", { ...lane, launcher: "ori" as const }]]) };
	try {
		expect((await listSources(summarySources(config, credentials))).find((row) => row.group === "signin" && row.name === "openrouter")?.state).toBe("not signed in");
	} finally { vi.restoreAllMocks(); }
});
