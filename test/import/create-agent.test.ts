import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFromPreview, type NewAgentFromChat } from "../../src/import/create-agent.ts";
import { writePreview } from "../../src/import/preview.ts";
import { loadConfig } from "../../src/lane/config.ts";
import { instructionsTemplate } from "../../src/lane/instructions.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { tempDir } from "../lane/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T = "2026-10-13T11:55:00.000Z";

/** A config with no agent, and a reviewed preview of two messages. */
function scene() {
	const dir = tempDir("orrery-create-agent-");
	dirs.push(dir);
	const configPath = join(dir, "config.toml");
	writeFileSync(configPath, `data_dir = ${JSON.stringify(join(dir, "data"))}\n`);
	const { previewPath } = writePreview(join(dir, "out"), [
		{ kind: "user", text: "Install RPCS3 AppImage for me.", date: T, source: "claude:s-1.jsonl" },
		{ kind: "talk", text: "Done.", date: T, source: "claude:s-1.jsonl" },
	], "# Import preview\n");
	const request: NewAgentFromChat = { name: "Rpcs3", tool: "pi", summary: { provider: "anthropic", modelId: "claude-haiku-4-5", thinking: "low" }, previewPath, title: "Install RPCS3 AppImage" };
	return { dir, configPath, request, laneDir: join(dir, "data", "lanes", "Rpcs3") };
}

const texts = (laneDir: string) => {
	const store = MemoryStore.openReadOnly(join(laneDir, "memory.sqlite"));
	try {
		return store.root.map((m) => m.text);
	} finally {
		store.close();
	}
};

describe("createFromPreview", () => {
	it("adds the agent, writes its instructions from the template, and commits the preview into its memory", () => {
		const s = scene();
		expect(createFromPreview(s.configPath, { ...s.request, folder: s.dir })).toEqual({ laneDir: s.laneDir, messages: 2 });
		expect(loadConfig(s.configPath).lanes.get("Rpcs3")).toMatchObject({ workspace: s.dir, tool: "pi", compactor: { model: { provider: "anthropic", modelId: "claude-haiku-4-5", thinking: "low" } } });
		expect(readFileSync(join(s.laneDir, "instructions.md"), "utf8")).toBe(instructionsTemplate("Rpcs3", 'Continues the chat "Install RPCS3 AppImage".'));
		expect(texts(s.laneDir)).toEqual(["Install RPCS3 AppImage for me.", "Done."]);
	});

	it("never imports into a folder that already holds memory (an archived agent's), and writes nothing then", () => {
		const s = scene();
		mkdirSync(s.laneDir, { recursive: true });
		const store = MemoryStore.open(join(s.laneDir, "memory.sqlite"));
		store.append("user", "an archived agent's memory");
		store.close();
		const before = readFileSync(s.configPath, "utf8");
		expect(() => createFromPreview(s.configPath, s.request)).toThrow(/already holds memory/);
		expect(readFileSync(s.configPath, "utf8")).toBe(before);
		expect(existsSync(join(s.laneDir, "instructions.md"))).toBe(false);
		expect(texts(s.laneDir)).toEqual(["an archived agent's memory"]);
	});

	it("keeps instructions already in the folder", () => {
		const s = scene();
		mkdirSync(s.laneDir, { recursive: true });
		writeFileSync(join(s.laneDir, "instructions.md"), "You are Rpcs3.\n");
		createFromPreview(s.configPath, s.request);
		expect(readFileSync(join(s.laneDir, "instructions.md"), "utf8")).toBe("You are Rpcs3.\n");
	});

	it("refuses a bad name or a broken preview before writing anything", () => {
		const s = scene();
		const before = readFileSync(s.configPath, "utf8");
		expect(() => createFromPreview(s.configPath, { ...s.request, name: "push" })).toThrow(/a word orrery agent uses/);
		writeFileSync(s.request.previewPath, `${JSON.stringify({ kind: "thought", text: "x", date: T, source: "a" })}\n`);
		expect(() => createFromPreview(s.configPath, s.request)).toThrow(/Invalid preview/);
		expect(readFileSync(s.configPath, "utf8")).toBe(before);
		expect(existsSync(s.laneDir)).toBe(false);
	});
});
