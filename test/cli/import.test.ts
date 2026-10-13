import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importDryRunCommand } from "../../src/cli/commands.ts";
import { parseConfig } from "../../src/lane/config.ts";
import { cleanEnv, cliCommand } from "../claude/support.ts";
import { fauxModels, laneConfigToml, tempDir } from "../lane/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const orrery = (args: string[], cwd?: string) => {
	const c = cliCommand(args);
	return spawnSync(c.cmd, c.args, { encoding: "utf8", cwd });
};
const jsonl = (records: object[]) => records.map((r) => JSON.stringify(r)).join("\n");

function fixture() {
	const dir = tempDir("orrery-import-");
	dirs.push(dir);
	const workspace = join(dir, "ws");
	const config = join(dir, "config.toml");
	writeFileSync(config, laneConfigToml({ dataDir: join(dir, "data"), workspace }));
	const claude = join(dir, "claude");
	mkdirSync(claude);
	writeFileSync(
		join(claude, "s.jsonl"),
		jsonl([
			{ type: "user", timestamp: "2026-07-20T10:00:00.000Z", sessionId: "s", message: { role: "user", content: "Use pnpm here." } },
			{ type: "assistant", timestamp: "2026-07-20T10:00:05.000Z", sessionId: "s", message: { id: "m", role: "assistant", content: [{ type: "text", text: "Switched to pnpm." }] } },
		]),
	);
	const codexDay = join(dir, "codex", "2026", "08", "01");
	mkdirSync(codexDay, { recursive: true });
	writeFileSync(
		join(codexDay, "rollout-x.jsonl"),
		jsonl([
			{ timestamp: "2026-08-01T09:00:00.000Z", type: "session_meta", payload: { id: "x", cwd: workspace } },
			{ timestamp: "2026-08-01T09:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: `Codename Cedar. ${"Background detail. ".repeat(80)}` } },
			{ timestamp: "2026-08-01T09:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "Noted: Cedar.", phase: "final_answer" } },
		]),
	);
	return { dir, config, claude, codex: join(dir, "codex") };
}

describe("orrery import and browse", () => {
	it("previews Claude and Codex history, commits it once, and browses the result", () => {
		const { dir, config, claude, codex } = fixture();
		const out = join(dir, "out");
		const dry = orrery(["import", "Test", "--config", config, "--dry-run", "--claude", claude, "--codex", codex, "--no-split", "--out", out]);
		expect(dry.status).toBe(0);
		expect(dry.stdout).toContain("4 messages");
		expect(dry.stdout).not.toContain("pnpm");
		const preview = readFileSync(join(out, "preview.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).text);
		expect(preview.map((text: string) => text.slice(0, 15))).toEqual(["Use pnpm here.", "Switched to pnp", "Codename Cedar.", "Noted: Cedar."]);

		const commit = orrery(["import", "test", "--config", config, "--commit", join(out, "preview.jsonl")]);
		expect(commit.status).toBe(0);
		expect(commit.stdout).toContain("Imported 4 messages");
		const again = orrery(["import", "Test", "--config", config, "--commit", join(out, "preview.jsonl")]);
		expect(again.status).toBe(1);
		expect(again.stderr).toContain("already has 4 messages");

		const page = join(dir, "test.html");
		const browse = orrery(["browse", "Test", "--config", config, "--out", page]);
		expect(browse.status).toBe(0);
		expect(statSync(page).mode & 0o777).toBe(0o600);
		expect(readFileSync(page, "utf8")).toContain("Codename Cedar.");
	});

	it("asks the split model only about long untagged messages and reports its token use", async () => {
		const { dir, config, claude, codex } = fixture();
		const { models, compactor } = fauxModels();
		compactor.setResponses([]);
		const summary = await importDryRunCommand(
			parseConfig(readFileSync(config, "utf8"), dir),
			"Test",
			{ claude, codex, notes: [], pasteThreshold: 1200, split: true, out: join(dir, "out") },
			models,
		);
		expect(summary).toMatch(/Split model: 1 calls/);
		expect(readFileSync(join(dir, "out", "report.md"), "utf8")).toContain("needs review: 1");
	});

	it("fails fast on an unknown split model, and stops after three split errors in a row", async () => {
		const { dir, config, claude, codex } = fixture();
		const text = readFileSync(config, "utf8");
		const options = { claude, codex, notes: [], pasteThreshold: 1200, split: true, out: join(dir, "out") };
		const unknown = parseConfig(text.replace('compactor_model = "faux-compactor/faux-1"', 'compactor_model = "faux-compactor/nope"'), dir);
		await expect(importDryRunCommand(unknown, "Test", options, fauxModels().models)).rejects.toThrow(/nope/);

		const day = join(codex, "2026", "08", "02");
		mkdirSync(day, { recursive: true });
		const long = (n: number) => ({
			timestamp: `2026-08-02T09:00:0${n}.000Z`,
			type: "event_msg",
			payload: { type: "user_message", message: `Report ${n}. ${"Long pasted detail. ".repeat(80)}` },
		});
		writeFileSync(
			join(day, "rollout-y.jsonl"),
			jsonl([{ timestamp: "2026-08-02T09:00:00.000Z", type: "session_meta", payload: { id: "y", cwd: join(dir, "ws") } }, long(1), long(2), long(3)]),
		);
		const { models, compactor } = fauxModels();
		compactor.setResponses([]);
		await expect(importDryRunCommand(parseConfig(text, dir), "Test", options, models)).rejects.toThrow(/split model failed 3 times in a row.*--no-split/s);
	});

	describe("--codex-file", () => {
		function elsewhere(dir: string) {
			const file = join(dir, "resumed", "rollout-z.jsonl");
			mkdirSync(join(dir, "resumed"), { recursive: true });
			writeFileSync(
				file,
				jsonl([
					{ timestamp: "2026-08-03T09:00:00.000Z", type: "session_meta", payload: { id: "z", cwd: join(dir, "elsewhere") } },
					{ timestamp: "2026-08-03T09:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Resumed here." } },
					{ timestamp: "2026-08-03T09:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "Welcome back.", phase: "final_answer" } },
				]),
			);
			return file;
		}
		const run = (f: ReturnType<typeof fixture>, extra: string[], codex = f.codex) =>
			orrery(["import", "Test", "--config", f.config, "--dry-run", "--claude", f.claude, "--codex", codex, "--no-split", "--out", join(f.dir, "out"), ...extra]);

		it("is not found by default, is included when named, and is not duplicated", () => {
			const f = fixture();
			const file = elsewhere(f.dir);
			expect(run(f, []).stdout).toContain("Codex: 1 turns from 1 sessions");
			expect(run(f, ["--codex-file", file]).stdout).toContain("Codex: 2 turns from 2 sessions");
			const found = join(f.codex, "2026", "08", "01", "rollout-x.jsonl");
			expect(run(f, ["--codex-file", found, "--codex-file", file, "--codex-file", file]).stdout).toContain("Codex: 2 turns from 2 sessions");
		});

		it("imports exactly the named files with --codex none, and accepts a relative path", () => {
			const f = fixture();
			const file = elsewhere(f.dir);
			const out = run(f, ["--codex-file", file], "none");
			expect(out.stdout).toContain("Codex: 1 turns from 1 sessions");
			const rel = orrery(["import", "Test", "--config", f.config, "--dry-run", "--claude", "none", "--codex", "none", "--codex-file", "resumed/rollout-z.jsonl", "--no-split", "--out", join(f.dir, "out2")], f.dir);
			expect(rel.stdout).toContain("Codex: 1 turns from 1 sessions");
		});

		it("says what it left out, in the summary and the report: a fork's replayed parent history and copied Claude records", () => {
			const f = fixture();
			writeFileSync(join(f.claude, "s.jsonl"), `${readFileSync(join(f.claude, "s.jsonl"), "utf8")}\n`.replace(/"type":"user"/, '"uuid":"u1","type":"user"'));
			writeFileSync(
				join(f.claude, "t.jsonl"),
				jsonl([{ type: "user", uuid: "u1", timestamp: "2026-07-20T10:00:00.000Z", sessionId: "t", message: { role: "user", content: "Use pnpm here." } }]),
			);
			const file = join(f.dir, "rollout-fork.jsonl");
			writeFileSync(
				file,
				jsonl([
					{ timestamp: "2026-08-21T18:41:08.000Z", type: "session_meta", payload: { id: "01910000-0000-7000-8000-000000000002", forked_from_id: "01900000-0000-7000-8000-000000000001", cwd: f.dir } },
					{ timestamp: "2026-08-21T18:41:08.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "01900000-1000-7000-8000-000000000003" } },
					{ timestamp: "2026-08-21T18:41:08.000Z", type: "event_msg", payload: { type: "user_message", message: "Old question." } },
					{ timestamp: "2026-08-22T09:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "01910000-1000-7000-8000-000000000004" } },
					{ timestamp: "2026-08-22T09:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "New question." } },
				]),
			);
			const out = run(f, ["--codex-file", file]);
			expect(out.status).toBe(0);
			const warning = "Warning: 1 messages replayed from parent 01900000-0000-7000-8000-000000000001 in Codex session 01910000-0000-7000-8000-000000000002 were skipped";
			const copies = "Skipped 1 copied Claude Code records";
			expect(out.stdout).toContain(warning);
			expect(out.stdout).toContain(copies);
			expect(out.stdout).toContain("Codex: 2 turns from 2 sessions");
			const report = readFileSync(join(f.dir, "out", "report.md"), "utf8");
			expect(report).toContain(`## Left out\n\n- ${copies}`);
			expect(report).toContain(warning);
		});

		it("fails before any work on a missing file or a non-rollout file", () => {
			const f = fixture();
			const missing = run(f, ["--codex-file", join(f.dir, "nope.jsonl")]);
			expect(missing.status).toBe(1);
			expect(missing.stderr).toContain("--codex-file");
			const notRollout = join(f.dir, "claude", "s.jsonl");
			const bad = run(f, ["--codex-file", notRollout]);
			expect(bad.status).toBe(1);
			expect(bad.stderr).toContain("not a Codex rollout");
			expect(() => statSync(join(f.dir, "out"))).toThrow();
		});
	});

	describe("--claude-file", () => {
		function elsewhere(dir: string) {
			const file = join(dir, "other-project", "o.jsonl");
			mkdirSync(join(dir, "other-project"), { recursive: true });
			writeFileSync(
				file,
				jsonl([
					{ type: "user", timestamp: "2026-07-21T10:00:00.000Z", sessionId: "o", uuid: "o1", message: { role: "user", content: "Started in sample-project." } },
					{ type: "assistant", timestamp: "2026-07-21T10:00:05.000Z", sessionId: "o", uuid: "o2", message: { id: "m", role: "assistant", content: [{ type: "text", text: "Noted, harness." }] } },
				]),
			);
			return file;
		}
		const spawn = (f: ReturnType<typeof fixture>, args: string[], cwd?: string) => {
			const c = cliCommand(["import", "Test", "--config", f.config, "--dry-run", "--codex", "none", "--no-split", ...args]);
			return spawnSync(c.cmd, c.args, { encoding: "utf8", cwd, env: cleanEnv({ HOME: f.dir }) });
		};
		const run = (f: ReturnType<typeof fixture>, extra: string[], claude = f.claude) => spawn(f, ["--claude", claude, "--out", join(f.dir, "out"), ...extra]);

		it("is not found by default, is included when named, and is not duplicated", () => {
			const f = fixture();
			const file = elsewhere(f.dir);
			expect(run(f, []).stdout).toContain("Claude: 1 turns from 1 files");
			expect(run(f, ["--claude-file", file]).stdout).toContain("Claude: 2 turns from 2 files");
			expect(run(f, ["--claude-file", join(f.claude, "s.jsonl"), "--claude-file", file, "--claude-file", file]).stdout).toContain("Claude: 2 turns from 2 files");
		});

		it("imports exactly the named files with --claude none, and accepts a relative path", () => {
			const f = fixture();
			elsewhere(f.dir);
			const rel = spawn(f, ["--claude", "none", "--claude-file", "other-project/o.jsonl", "--out", join(f.dir, "out2")], f.dir);
			expect(rel.stdout).toContain("Claude: 1 turns from 1 files");
		});

		it("fails before any work on a missing file or a file that is no Claude Code session", () => {
			const f = fixture();
			const missing = run(f, ["--claude-file", join(f.dir, "nope.jsonl")]);
			expect(missing.status).toBe(1);
			expect(missing.stderr).toContain("--claude-file");
			const rollout = join(f.codex, "2026", "08", "01", "rollout-x.jsonl");
			const bad = run(f, ["--claude-file", rollout]);
			expect(bad.status).toBe(1);
			expect(bad.stderr).toContain("is not a Claude Code session");
			expect(() => statSync(join(f.dir, "out"))).toThrow();
		});
	});
});
