import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/lane/config.ts";
import { FileCredentialStore } from "../../src/lane/credentials.ts";
import { availableModels, compatApi, compactorModel, createLaneModels, ensureDeviceId, modelContextWindow } from "../../src/lane/models.ts";
import { contextLines, fauxModels, tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const signal = new AbortController().signal;

describe("the workstation example config", () => {
	it("uses openai/gpt-6.1-sol (the ChatGPT sign-in in pi and in orrery), and Orrery's own model lookup resolves it offline", () => {
		const dir = tempDir("orrery-models-");
		dirs.push(dir);
		const example = new URL("../../deploy/workstation/config.example.toml", import.meta.url).pathname;
		const config = parseConfig(readFileSync(example, "utf8"), dir);
		const models = createLaneModels({ credentials: new FileCredentialStore(join(dir, "c.json")), providers: config.providers });
		for (const lane of config.lanes.values()) {
			for (const choice of [lane.model ?? lane.compactor.model, lane.compactor.model]) {
				expect(`${choice.provider}/${choice.modelId}`).toBe("openai/gpt-6.1-sol");
				expect(modelContextWindow(models, choice)).toBeGreaterThan(0);
			}
		}
	});
});

describe("createLaneModels", () => {
	it("registers built-in and custom OpenAI-compatible providers", () => {
		const dir = tempDir("orrery-models-");
		dirs.push(dir);
		const models = createLaneModels({
			credentials: new FileCredentialStore(join(dir, "c.json")),
			providers: [
				{
					id: "omlx",
					baseUrl: "http://127.0.0.1:9/v1",
					apiKeyEnv: "ORRERY_TEST_OMLX_KEY",
					models: [{ id: "Bonsai-27B-mlx-1bit", name: "Bonsai", contextWindow: 262144, maxTokens: 8192, reasoning: true }],
				},
			],
		});
		const bonsai = models.getModel("omlx", "Bonsai-27B-mlx-1bit");
		expect(bonsai?.api).toBe("openai-completions");
		expect(bonsai?.baseUrl).toBe("http://127.0.0.1:9/v1");
		expect(bonsai?.contextWindow).toBe(262144);
		expect(models.getModel("openai", "gpt-6.1-sol")).toBeDefined();
		expect(models.getModel("anthropic", "claude-sonnet-5-5")).toBeDefined();
		expect(modelContextWindow(models, { provider: "omlx", modelId: "Bonsai-27B-mlx-1bit", thinking: "off" })).toBe(262144);
	});
});

describe("compactorModel", () => {
	it("sends the system prompt and turns, and returns text with usage", async () => {
		const { compactor, models } = fauxModels();
		let seen: string[] = [];
		compactor.setResponses([
			(context) => {
				seen = contextLines(context);
				return fauxAssistantMessage("user: a summary");
			},
		]);
		const model = compactorModel(models, { provider: "faux-compactor", modelId: "faux-1", thinking: "off" }, "compactor:Test");
		expect(model.id).toBe("faux-compactor/faux-1");
		const reply = await model.complete(
			"SYSTEM PROMPT",
			[
				{ role: "user", blocks: ["<chat>\n\n</chat>", "Compress this"] },
				{ role: "assistant", text: "too long" },
				{ role: "user", blocks: ["shorter please"] },
			],
			signal,
		);
		expect(reply.text).toBe("user: a summary");
		expect(reply.usage).toEqual({ input: expect.any(Number), cacheRead: expect.any(Number), cacheWrite: expect.any(Number), output: expect.any(Number) });
		expect(seen[0]).toBe("system:SYSTEM PROMPT");
		expect(seen.slice(1)).toEqual(["user:<chat>\n\n</chat>Compress this", "assistant:too long", "user:shorter please"]);
	});

	it("throws when the provider reports an error", async () => {
		const { compactor, models } = fauxModels();
		compactor.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limited" })]);
		const model = compactorModel(models, { provider: "faux-compactor", modelId: "faux-1", thinking: "off" }, "s");
		await expect(model.complete("S", [{ role: "user", blocks: ["x"] }], signal)).rejects.toThrow("rate limited");
	});

	it("refuses an unknown model", () => {
		const { models } = fauxModels();
		expect(() => compactorModel(models, { provider: "nope", modelId: "x", thinking: "off" }, "s")).toThrow(/Unknown model nope\/x/);
	});
});

describe("ensureDeviceId", () => {
	it("creates one UUID and reuses it", () => {
		const dir = tempDir("orrery-device-");
		dirs.push(dir);
		const file = join(dir, "sub", "device-id");
		const first = ensureDeviceId(file);
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(ensureDeviceId(file)).toBe(first);
		expect(readFileSync(file, "utf8").trim()).toBe(first);
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});
});

describe("availableModels", () => {
	it("lists only signed-in providers, and for a ChatGPT sign-in only the ChatGPT-plan models", async () => {
		const dir = tempDir("orrery-avail-");
		dirs.push(dir);
		const path = join(dir, "credentials.json");
		const expires = Date.now() + 3_600_000;
		writeFileSync(path, JSON.stringify({ openai: { type: "oauth", access: "a", refresh: "r", expires, clientId: "c", scopes: [] } }), { mode: 0o600 });
		const models = createLaneModels({ credentials: new FileCredentialStore(path), providers: [] });
		const groups = await availableModels(models);
		expect(groups.map((g) => g.provider)).toEqual(["openai"]);
		expect(groups[0].label).toBe("ChatGPT sign-in");
		expect(groups[0].ids).toContain("gpt-6.1-sol");
		expect(groups[0].ids).not.toContain("gpt-4");
		expect(groups[0].ids.every((id) => models.getModel("openai-codex", id) !== undefined)).toBe(true);
	});
});

describe("summary providers", () => {
	it("registers OpenRouter and an OpenAI key provider beside the ChatGPT one", () => {
		const dir = tempDir("orrery-models-");
		dirs.push(dir);
		const models = createLaneModels({ credentials: new FileCredentialStore(join(dir, "c.json")), providers: [] });
		const haiku = models.getModel("openrouter", "anthropic/claude-haiku-4.5");
		expect(haiku?.cost.input).toBe(1);
		expect(models.getModels("openrouter").length).toBeGreaterThan(300);
		expect(models.getModels("openrouter").some((m) => m.id.includes("flux"))).toBe(false); // chat models only
		expect(models.getModel("openai-api", "gpt-4.1")?.provider).toBe("openai-api");
		expect(models.getModel("openai", "gpt-4.1")?.provider).toBe("openai");
	});

	it("keeps an OpenAI key apart from the ChatGPT sign-in in one credential file", async () => {
		const dir = tempDir("orrery-models-");
		dirs.push(dir);
		const credentials = new FileCredentialStore(join(dir, "c.json"));
		await credentials.modify("openai", async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }) as never);
		await credentials.modify("openai-api", async () => ({ type: "api_key", key: "sk-test" }));
		expect(await credentials.list()).toEqual([
			{ providerId: "openai", type: "oauth" },
			{ providerId: "openai-api", type: "api_key" },
		]);
	});
});

describe("compatApi (OMP serves pi-ai/compat from its own pi-ai, which has no model registry)", () => {
	it("keeps the host's pi-ai when it has createModels, and never loads the fallback", async () => {
		const host = { createModels: () => "host" };
		expect(await compatApi(host, () => Promise.reject(new Error("must not load")))).toBe(host);
	});

	it("loads orrery's own pi-ai when the host's has no createModels", async () => {
		type PiAi = { createModels?: () => string };
		const own: PiAi = { createModels: () => "own" };
		expect(await compatApi<PiAi>({ createModels: undefined }, async () => own)).toBe(own);
		expect(await compatApi<PiAi>({}, async () => own)).toBe(own);
	});

	it("falls back to a real pi-ai compat build that has the registry", async () => {
		const own = await import("../../node_modules/@earendil-works/pi-ai/dist/compat.js");
		for (const name of ["createModels", "createProvider", "envApiKeyAuth", "openAICompletionsApi", "openAIResponsesApi"] as const) {
			expect(typeof own[name]).toBe("function");
		}
	});
});
