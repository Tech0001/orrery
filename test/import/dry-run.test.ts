import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dryRun, type DryRunInput, newPreviewFolder } from "../../src/import/dry-run.ts";
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

describe("newPreviewFolder", () => {
	const DAY = 24 * 60 * 60 * 1000;
	/** A folder `name` under `root` with one file, last changed `ago` ms before `now`. */
	function leftover(root: string, name: string, now: number, ago: number): string {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "preview.jsonl"), "{}\n");
		const at = new Date(now - ago);
		utimesSync(join(dir, "preview.jsonl"), at, at);
		utimesSync(dir, at, at);
		return dir;
	}

	it("makes a private folder under the data folder's imports, after sweeping away previews left more than a day ago", () => {
		const data = tempDir("orrery-previews-");
		dirs.push(data);
		const root = join(data, "imports");
		mkdirSync(root, { mode: 0o755 });
		chmodSync(root, 0o755);
		const now = Date.now();
		leftover(root, "preview-old", now, 2 * DAY);
		leftover(root, "preview-recent", now, 60 * 60 * 1000);
		leftover(root, "not-a-preview", now, 2 * DAY);
		const out = newPreviewFolder(data, now);
		expect(out.startsWith(join(root, "preview-"))).toBe(true);
		expect(statSync(out).mode & 0o777).toBe(0o700);
		expect(statSync(root).mode & 0o777).toBe(0o700);
		expect(readdirSync(root).sort()).toEqual(["not-a-preview", "preview-recent", out.slice(root.length + 1)].sort());
	});

	it("refuses an imports folder that is a symlink, and sweeps nothing through it", () => {
		const data = tempDir("orrery-previews-");
		const elsewhere = tempDir("orrery-previews-elsewhere-");
		dirs.push(data, elsewhere);
		const now = Date.now();
		leftover(elsewhere, "preview-old", now, 2 * DAY);
		symlinkSync(elsewhere, join(data, "imports"));
		expect(() => newPreviewFolder(data, now)).toThrow(/not a real folder/);
		expect(readdirSync(elsewhere)).toEqual(["preview-old"]);
	});
});
