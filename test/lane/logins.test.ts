import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginsCommand } from "../../src/cli/logins.ts";
import { parseConfig } from "../../src/lane/config.ts";
import { loginRows, removeLogin, saveKey } from "../../src/lane/logins.ts";
import type { LaneRow } from "../../src/lane/overview.ts";
import { summarySources } from "../../src/lane/summary-sources.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
beforeEach(() => {
	for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) vi.stubEnv(name, "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
	const dir = tempDir("orrery-lane-logins-");
	dirs.push(dir);
	const config = parseConfig(`data_dir = ${JSON.stringify(dir)}\n[lanes.A]\nworkspace = "/w/a"\ncompactor_model = "anthropic/claude-haiku-4-5"\n`, dir);
	return { config, sources: summarySources(config) };
}

const row = (name: string, ref: string) => ({ name, summaryModel: { ref, thinking: "low", source: "config" } }) as unknown as LaneRow;

describe("logins", () => {
	it("saves a key trimmed, lists it with the lanes that use it, and removes it", async () => {
		const { sources } = setup();
		expect(await saveKey(sources, "anthropic", "  sk-ant-SECRET-1234 \n")).toBe("Anthropic");
		expect(await sources.credentials.read("anthropic")).toEqual({ type: "api_key", key: "sk-ant-SECRET-1234" });
		const rows = await loginRows(sources, [row("A", "anthropic/claude-haiku-4-5"), row("B", "openai/gpt-6.1-sol"), row("C", "openai-api/gpt-6.1")]);
		expect(rows.find((r) => r.provider === "anthropic")).toMatchObject({ state: "saved", label: "Anthropic", lanes: ["A"] });
		expect(rows.find((r) => r.provider === "openai")).toMatchObject({ state: "not saved", lanes: ["B"] });
		expect(rows.find((r) => r.provider === "openai-api")?.lanes).toEqual(["C"]);
		expect(await removeLogin(sources, { key: "anthropic" })).toBe("Removed the Anthropic key.\n");
		expect(await removeLogin(sources, { key: "anthropic" })).toBe("No Anthropic key was saved.\n");
	});

	it("refuses an empty key and a key typed where the provider name goes, never repeating it", async () => {
		const { sources } = setup();
		await expect(saveKey(sources, "anthropic", "   ")).rejects.toThrow("No key entered; nothing saved.");
		const error = await saveKey(sources, "sk-ant-SECRET-5678", "x").catch((e: Error) => e);
		expect(String(error)).not.toContain("SECRET-5678");
	});

	it("orrery logins --json lists logins and lanes, never a key", async () => {
		const { config, sources } = setup();
		await saveKey(sources, "anthropic", "sk-ant-SECRET-9999");
		const out = await loginsCommand(config, { json: true });
		const parsed = JSON.parse(out) as { logins: { provider: string; lanes: string[] }[] };
		expect(parsed.logins.find((l) => l.provider === "anthropic")?.lanes).toEqual(["A"]);
		expect(out).not.toContain("SECRET-9999");
	});
});
