import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dryRun, type DryRunInput } from "../../src/import/dry-run.ts";
import { parseConfig } from "../../src/lane/config.ts";
import { fauxModels, laneConfigToml, tempDir } from "../lane/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const jsonl = (records: object[]) => records.map((r) => JSON.stringify(r)).join("\n");

/** One Claude Code chat (with a key in it) and one Codex chat, and the dry run's input for them. */
function fixture(): DryRunInput & { dir: string } {
	const dir = tempDir("orrery-dry-run-");
	dirs.push(dir);
	const claude = join(dir, "s.jsonl");
	writeFileSync(
		claude,
		jsonl([
			{ type: "user", timestamp: "2026-07-20T10:00:00.000Z", sessionId: "s", message: { role: "user", content: "Use pnpm here." } },
			{ type: "assistant", timestamp: "2026-07-20T10:00:05.000Z", sessionId: "s", message: { id: "m", role: "assistant", content: [{ type: "text", text: `The key was ${"sk-ant-" + "oat01-AbCdEfGhIjKlMnOpQrStUvWxYz"}.` }] } },
		]),
	);
	mkdirSync(join(dir, "codex"));
	const codex = join(dir, "codex", "rollout-x.jsonl");
	writeFileSync(
		codex,
		jsonl([
			{ timestamp: "2026-08-01T09:00:00.000Z", type: "session_meta", payload: { id: "x", cwd: dir } },
			{ timestamp: "2026-08-01T09:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Codename Cedar." } },
			{ timestamp: "2026-08-01T09:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "Noted: Cedar.", phase: "final_answer" } },
		]),
	);
	const config = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace: dir }), dir);
	return {
		dir,
		config,
		name: "Test",
		names: ["Test"],
		summaryModel: { provider: "faux-compactor", modelId: "faux-1", thinking: "off" },
		savedLoginsOnly: true,
		claudeFiles: [claude],
		codexFiles: [codex],
		notes: [],
		pasteThreshold: 1200,
		split: true,
		out: join(dir, "out"),
		models: fauxModels().models,
	};
}

describe("dryRun", () => {
	it("reads the chats, says how far it is, and writes the preview and report for review", async () => {
		const input = fixture();
		const said: string[] = [];
		const result = await dryRun({ ...input, progress: (line) => said.push(line) });
		expect([result.claude.turns, result.codex.turns, result.splitCalls]).toEqual([1, 1, 0]);
		expect(result.summary).toEqual({ messages: 4, first: "2026-07-20T10:00:00.000Z", last: "2026-08-01T09:00:02.000Z", redactions: { "anthropic-key": 1 }, splits: 0, unsplit: 0 });
		expect(said).toEqual(["Reading 2 chats…", "Preparing the preview: 2 of 2 turns"]);
		expect(readFileSync(result.previewPath, "utf8").trim().split("\n")).toHaveLength(4);
		expect(readFileSync(result.reportPath, "utf8")).toBe(result.report);
		expect(result.report).not.toContain("oat01");
	});

	it("stops when its signal is aborted, and writes no preview", async () => {
		const input = fixture();
		const controller = new AbortController();
		const run = dryRun({ ...input, signal: controller.signal, progress: (line) => line.startsWith("Preparing") && controller.abort() });
		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(existsSync(join(input.out, "preview.jsonl"))).toBe(false);
		expect(existsSync(join(input.out, "report.md"))).toBe(false);
	});
});
