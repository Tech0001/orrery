import { rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ModelChoice, parseConfig } from "../../src/agent/config.ts";
import { FileCredentialStore } from "../../src/agent/credentials.ts";
import { KEY_NOT_NAME, providerFor, summarySources } from "../../src/agent/summary-sources.ts";
import { type CompactorTarget, formatSources, NotSwitched, parseCompactorArgs, runCompactorText, switchSummaryModel } from "../../src/agent/summary-text.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
beforeEach(() => {
	for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) vi.stubEnv(k, "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("formatSources", () => {
	it("prints one line per source under its group, with notes", () => {
		const text = formatSources([
			{ group: "signin", name: "openai", provider: "openai", state: "saved" },
			{ group: "key", name: "openai", provider: "openai-api", state: "not saved" },
			{ group: "key", name: "anthropic", provider: "anthropic", state: "unusable", note: "a Claude Pro/Max sign-in" },
			{ group: "local", name: "bonsai", provider: "bonsai", state: "no login needed" },
		]);
		expect(text).toBe(
			[
				"Sign in   openai       saved",
				"API key   openai       not saved",
				"          anthropic    unusable (a Claude Pro/Max sign-in)",
				"Local     bonsai       no login needed",
			].join("\n"),
		);
	});
});

const toml = (dir: string) => `data_dir = ${JSON.stringify(dir)}\n[agents.Test]\nfolder = ${JSON.stringify(dir)}\nmodel = "openai/gpt-6.1-sol"\ncompactor_model = "openai/gpt-6.1-sol"\n`;

describe("parseCompactorArgs", () => {
	const config = parseConfig(toml("/tmp/x"), "/tmp/x");
	it("reads groups, providers, filters and switches; OpenRouter ids keep their slashes and colons", () => {
		expect(parseCompactorArgs(config, [])).toEqual({ kind: "show" });
		expect(parseCompactorArgs(config, ["reset"])).toEqual({ kind: "reset" });
		expect(parseCompactorArgs(config, ["key"])).toEqual({ kind: "providers", group: "key" });
		expect(parseCompactorArgs(config, ["key", "openrouter", "llama", "free"])).toEqual({ kind: "models", group: "key", name: "openrouter", filter: "llama free" });
		expect(parseCompactorArgs(config, ["key", "openrouter/meta-llama/llama-3.3-8b-instruct:free", "low"])).toEqual({
			kind: "switch",
			ref: "openrouter/meta-llama/llama-3.3-8b-instruct:free",
			thinking: "low",
		});
		expect(parseCompactorArgs(config, ["key", "openai/gpt-4.1"])).toEqual({ kind: "switch", ref: "openai-api/gpt-4.1", thinking: undefined });
		expect(parseCompactorArgs(config, ["signin", "openai/gpt-6.1-sol"])).toEqual({ kind: "switch", ref: "openai/gpt-6.1-sol", thinking: undefined });
		expect(parseCompactorArgs(config, ["openai/gpt-6.1-sol", "low"])).toEqual({ kind: "switch", ref: "openai/gpt-6.1-sol", thinking: "low" });
		expect(() => parseCompactorArgs(config, ["haiku"])).toThrow(/^Unknown choice: use signin, key or local, or provider\/model\.$/);
	});

	it("never repeats a key typed in place of a choice or a provider", () => {
		for (const typed of ["sk-proj-0123456789abcdef", "x9".repeat(30)]) {
			for (const args of [[typed], ["key", typed], ["key", typed, "haiku"], ["signin", typed]]) {
				let message = "";
				try {
					parseCompactorArgs(config, args);
					// A provider listing checks its name when it runs.
					providerFor(config, "key", args[1] ?? "");
				} catch (error) {
					message = (error as Error).message;
				}
				expect(message).toBe(KEY_NOT_NAME);
				expect(message).not.toContain(typed);
			}
		}
	});
});

describe("runCompactorText", () => {
	function fixture(replies: number) {
		const dir = tempDir("orrery-text-");
		dirs.push(dir);
		const config = parseConfig(toml(dir), dir);
		const faux = fauxProvider({ provider: "faux-test" });
		faux.setResponses(Array.from({ length: replies }, () => fauxAssistantMessage("OK")));
		const base = summarySources(config, new FileCredentialStore(join(dir, "c.json")));
		(base.models as unknown as { setProvider(p: unknown): void }).setProvider(faux.provider);
		let current: ModelChoice = { provider: "openai", modelId: "gpt-6.1-sol", thinking: "low" };
		let source: "config" | "chat" = "config";
		const applied: (ModelChoice | undefined)[] = [];
		const target: CompactorTarget = {
			current: () => ({ choice: current, source }),
			configured: () => ({ provider: "openai", modelId: "gpt-6.1-sol", thinking: "low" }),
			apply: async (choice) => {
				applied.push(choice);
				if (choice) [current, source] = [choice, "chat"];
				return `applied ${choice ? `${choice.provider}/${choice.modelId}` : "reset"}`;
			},
		};
		return { sources: base, target, applied };
	}

	it("shows the current model, the sources and how to pick", async () => {
		const { sources, target } = fixture(0);
		const text = await runCompactorText(sources, [], "/orrery:compactor", target);
		expect(text.split("\n")[0]).toBe("summaries: openai/gpt-6.1-sol (low) · from config");
		expect(text).toContain("API key   openai       not saved");
		expect(text).toContain("Models:  /orrery:compactor key openrouter <words>");
	});

	it("lists matching models with prices, capped with a hint", async () => {
		const { sources, target } = fixture(0);
		const text = await runCompactorText(sources, ["key", "openrouter", "claude", "haiku"], "/orrery:compactor", target);
		expect(text).toMatch(/anthropic\/claude-haiku-4\.5\s+\d+K\s+\$1\.00 in \/ \$5\.00 out per M/);
		expect(text).toContain("Switch:  /orrery:compactor key openrouter/<model> [thinking]");
		const all = await runCompactorText(sources, ["key", "openrouter"], "/orrery:compactor", target);
		expect(all).toMatch(/… and \d+ more; add words to narrow/);
	});

	it("switches only after the test call passes, keeping thinking unless given", async () => {
		const ok = fixture(1);
		expect(await runCompactorText(ok.sources, ["faux-test/faux-1"], "/compactor", ok.target)).toBe("applied faux-test/faux-1");
		expect(ok.applied).toEqual([{ provider: "faux-test", modelId: "faux-1", thinking: "low" }]);
		const bad = fixture(0);
		await expect(runCompactorText(bad.sources, ["faux-test/faux-1"], "/compactor", bad.target)).rejects.toThrow(/^Not switched: .+\. Still on openai\/gpt-6\.1-sol\.$/);
		expect(bad.applied).toEqual([]);
	});

	it("tests the config's model before a reset", async () => {
		const { sources, target, applied } = fixture(0);
		await expect(runCompactorText(sources, ["reset"], "/compactor", target)).rejects.toThrow(/^Not switched: no login saved for ChatGPT; orrery login openai\. Still on openai\/gpt-6\.1-sol\.$/);
		expect(applied).toEqual([]);
	});

	it("switches through the one shared test-then-apply, which every surface uses", async () => {
		const ok = fixture(1);
		expect(await switchSummaryModel(ok.sources, ok.target, { provider: "faux-test", modelId: "faux-1", thinking: "off" })).toBe("applied faux-test/faux-1");
		const bad = fixture(0);
		const refused = await switchSummaryModel(bad.sources, bad.target, { provider: "faux-test", modelId: "faux-1", thinking: "off" }).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(NotSwitched);
		expect((refused as Error).message).toMatch(/^Not switched: .+\. Still on openai\/gpt-6\.1-sol\.$/);
		const reset = await switchSummaryModel(bad.sources, bad.target, undefined).catch((error: unknown) => error);
		expect((reset as Error).message).toBe("Not switched: no login saved for ChatGPT; orrery login openai. Still on openai/gpt-6.1-sol.");
		expect(bad.applied).toEqual([]);
	});
});
