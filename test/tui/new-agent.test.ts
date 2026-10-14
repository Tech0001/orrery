import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listChats } from "../../src/import/chats.ts";
import { createFromPreview } from "../../src/import/create-agent.ts";
import { dryRun, type DryRunInput } from "../../src/import/dry-run.ts";
import { editConfigFile } from "../../src/lane/config-edit.ts";
import { loadConfig } from "../../src/lane/config.ts";
import { saveKey } from "../../src/lane/logins.ts";
import { instructionsTemplate } from "../../src/lane/instructions.ts";
import { laneOverview } from "../../src/lane/overview.ts";
import { summarySources } from "../../src/lane/summary-sources.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import type { AppDeps } from "../../src/tui/app.ts";
import { lanesPage } from "../../src/tui/pages/lanes.ts";
import { fauxModels, tempDir } from "../lane/support.ts";
import { answer, fakeDeps, keys, makeApp, row, screen, settle, typed } from "./support.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const dirs: string[] = [];
beforeEach(() => {
	for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) vi.stubEnv(name, "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const line = (record: object) => JSON.stringify(record);

/** A scratch home with one Claude Code chat being written now (its last line half written), and a config with no agent. */
function scene() {
	const root = tempDir("orrery-tui-import-");
	dirs.push(root);
	const home = join(root, "home");
	const chat = join(home, ".claude", "projects", "-w-rpcs3", "s-1.jsonl");
	mkdirSync(dirname(chat), { recursive: true });
	writeFileSync(chat, [
		line({ type: "user", uuid: "u1", sessionId: "s-1", cwd: "/w/rpcs3", timestamp: "2026-10-13T11:55:00.000Z", message: { role: "user", content: "Install RPCS3 AppImage for me." } }),
		line({ type: "assistant", uuid: "a1", sessionId: "s-1", timestamp: "2026-10-13T11:56:00.000Z", message: { id: "m1", content: [{ type: "text", text: "Done: it is in ~/Applications." }] } }),
		line({ type: "ai-title", aiTitle: "Install RPCS3 AppImage", sessionId: "s-1" }),
		'{"type":"user","mess',
	].join("\n"));
	const configPath = join(root, "config.toml");
	writeFileSync(configPath, `data_dir = ${JSON.stringify(join(root, "data"))}\n`);
	return { root, home, chat, configPath };
}

/** The TUI on that scene: real config file, chat list, dry run (on a fake summary model), commit; builds are only noted. */
async function tui(s: ReturnType<typeof scene>, overrides: Partial<AppDeps> = {}) {
	const sources = summarySources(loadConfig(s.configPath));
	await saveKey(sources, "anthropic", "sk-" + "ant-test");
	const faux = fauxModels();
	const builds: string[] = [];
	const outs: string[] = [];
	const inputs: DryRunInput[] = [];
	const deps = fakeDeps({
		configPath: s.configPath,
		loadConfig: () => loadConfig(s.configPath),
		editConfig: (edit) => editConfigFile(s.configPath, edit),
		overview: (config) => laneOverview(config),
		sources: async () => sources,
		chats: () => listChats({ env: {}, home: s.home, now: Date.now() }),
		importPreview: (input: DryRunInput) => {
			outs.push(input.out);
			inputs.push(input);
			return dryRun({ ...input, summaryModel: { provider: "faux-compactor", modelId: "faux-1", thinking: "off" }, models: faux.models });
		},
		importCommit: (request) => createFromPreview(s.configPath, request),
		startBuild: (name) => builds.push(name),
		writeInstructions: () => {},
		...overrides,
	}, []);
	return { app: makeApp(deps, [lanesPage]), deps, builds, outs, inputs };
}

/** N, From an existing chat, the chat, yes to "in use", the suggested name, pi, a summary model, no folder. */
async function throughToPreview(app: ReturnType<typeof makeApp>) {
	keys(app, "N");
	await answer(app, "New agent:", DOWN, ENTER);
	await answer(app, "Turn which chat into an agent?", ENTER);
	await answer(app, "In use", "y");
	await answer(app, "Agent name", ENTER);
	await answer(app, "It continues in", ENTER);
	await answer(app, "Summaries from:", ENTER);
	await answer(app, "Anthropic model:", ...typed("haiku-4-5"), ENTER);
	await answer(app, "Thinking", ...typed("low"), ENTER);
	await answer(app, "Its default folder", ENTER);
}

describe("N: an agent from an existing chat", () => {
	it("lists the chat, asks before an in-use one, previews, and imports into a new agent whose memory is then built", async () => {
		const s = scene();
		const { app, builds, outs } = await tui(s);
		await throughToPreview(app);
		await answer(app, "Import preview for Install-RPCS3-AppImage", "r");
		await answer(app, "Full report", ENTER);
		await answer(app, "Import preview for Install-RPCS3-AppImage", ENTER);
		await app.idle();
		const lane = loadConfig(s.configPath).lanes.get("Install-RPCS3-AppImage");
		expect(lane).toMatchObject({ tool: "pi", compactor: { model: { provider: "anthropic", modelId: "claude-haiku-4-5" } } });
		expect(lane?.workspace).toBeUndefined();
		expect(readFileSync(join(lane!.dir, "instructions.md"), "utf8")).toBe(instructionsTemplate("Install-RPCS3-AppImage", 'Continues the chat "Install RPCS3 AppImage".'));
		const store = MemoryStore.openReadOnly(join(lane!.dir, "memory.sqlite"));
		try {
			expect(store.root.map((m) => `${m.kind}: ${m.text}`)).toEqual(["user: Install RPCS3 AppImage for me.", "talk: Done: it is in ~/Applications."]);
		} finally {
			store.close();
		}
		expect(builds).toEqual(["Install-RPCS3-AppImage"]);
		expect(outs).toHaveLength(1);
		expect(outs.every((out) => !existsSync(out))).toBe(true);
		expect(screen(app)).toContain("Imported 2 messages into Install-RPCS3-AppImage");
		// The source chat is only read.
		expect(readFileSync(s.chat, "utf8").endsWith('{"type":"user","mess')).toBe(true);
	});

	it("the short report counts the half-written line; Esc leaves without writing anything", async () => {
		const s = scene();
		const { app, builds, outs } = await tui(s);
		await throughToPreview(app);
		await answer(app, "Import preview for Install-RPCS3-AppImage");
		expect(screen(app)).toContain("2 messages, 2026-10-13 to 2026-10-13");
		expect(screen(app)).toContain("Chats: Install RPCS3 AppImage");
		expect(screen(app)).toContain("Unreadable lines skipped: 1");
		keys(app, ESC);
		await app.idle();
		expect(loadConfig(s.configPath).lanes.size).toBe(0);
		expect(existsSync(join(s.root, "data", "lanes", "Install-RPCS3-AppImage"))).toBe(false);
		expect(outs).toHaveLength(1);
		expect(outs.every((out) => !existsSync(out))).toBe(true);
		expect(builds).toEqual([]);
		expect(screen(app)).toContain("Not imported; nothing was written.");
	});

	it("Esc while the preview is prepared cancels it: nothing is written", async () => {
		const s = scene();
		const { app, builds, outs } = await tui(s, {
			importPreview: (input) => {
				outs.push(input.out);
				return new Promise((_, reject) => input.signal?.addEventListener("abort", () => reject(input.signal?.reason)));
			},
		});
		await throughToPreview(app);
		await answer(app, "Preparing Install-RPCS3-AppImage's memory", ESC);
		await app.idle();
		expect(screen(app)).toContain("Not imported; nothing was written.");
		expect(loadConfig(s.configPath).lanes.size).toBe(0);
		expect(outs.every((out) => !existsSync(out))).toBe(true);
		expect(builds).toEqual([]);
	});

	it("a preview that fails says why, and writes nothing", async () => {
		const s = scene();
		const { app, outs } = await tui(s, {
			importPreview: async (input) => {
				outs.push(input.out);
				throw new Error("The split model failed 3 times in a row (split failed: offline).");
			},
		});
		await throughToPreview(app);
		await app.idle();
		expect(screen(app)).toContain("The split model failed 3 times in a row");
		expect(loadConfig(s.configPath).lanes.size).toBe(0);
		expect(outs.every((out) => !existsSync(out))).toBe(true);
	});

	it("previews several marked chats of one folder together, each by its tool, and names the agent from the newest", async () => {
		const s = scene();
		const codex = join(s.home, ".codex", "sessions", "rollout-2026-10-12T10-00-00-c.jsonl");
		mkdirSync(dirname(codex), { recursive: true });
		writeFileSync(codex, [
			line({ timestamp: "2026-10-12T10:00:00.000Z", type: "session_meta", payload: { id: "c", cwd: "/w/rpcs3" } }),
			line({ timestamp: "2026-10-12T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Which emulator for PS3?" } }),
		].join("\n"));
		const hourAgo = new Date(Date.now() - 3_600_000);
		utimesSync(codex, hourAgo, hourAgo);
		const { app, inputs } = await tui(s);
		keys(app, "N");
		await answer(app, "New agent:", ...typed("existing"), ENTER);
		await answer(app, "Turn which chat into an agent?", " ", DOWN, " ", ENTER);
		await answer(app, "In use", "y");
		await answer(app, "Agent name", ENTER);
		await answer(app, "It continues in", ...typed("Claude"), ENTER);
		await answer(app, "Summaries from:", ENTER);
		await answer(app, "Anthropic model:", ...typed("haiku-4-5"), ENTER);
		await answer(app, "Thinking", ENTER);
		await answer(app, "Its default folder", ...typed("/w/rpcs3"), ENTER);
		await answer(app, "Import preview for Install-RPCS3-AppImage", ESC);
		await app.idle();
		expect(inputs).toHaveLength(1);
		expect(inputs[0]).toMatchObject({ name: "Install-RPCS3-AppImage", claudeFiles: [s.chat], codexFiles: [codex], split: true, pasteThreshold: 1200, notes: [] });
		expect(inputs[0]!.names).toContain("Install-RPCS3-AppImage");
	});

	it("starts the memory build even when the wiring after the import fails", async () => {
		const s = scene();
		const { app, builds } = await tui(s, {
			tools: () => {
				throw new Error("the tool check broke");
			},
		});
		await throughToPreview(app);
		await answer(app, "Import preview for Install-RPCS3-AppImage", ENTER);
		await app.idle();
		expect(builds).toEqual(["Install-RPCS3-AppImage"]);
		expect(loadConfig(s.configPath).lanes.has("Install-RPCS3-AppImage")).toBe(true);
		expect(screen(app, 160)).toContain("Imported 2 messages into Install-RPCS3-AppImage; its memory is being built, but its setup stopped: the tool check broke.");
	});

	it("the short report shows a Codex id with escape sequences in it as plain text", async () => {
		const s = scene();
		const fork = join(s.home, ".codex", "sessions", "rollout-2026-08-22T09-00-00-f.jsonl");
		mkdirSync(dirname(fork), { recursive: true });
		writeFileSync(fork, [
			line({ timestamp: "2026-08-21T18:41:08.000Z", type: "session_meta", payload: { id: "01910000-0000-7000-8000-000000000002", forked_from_id: "\u001b]0;owned\u0007\u001b[31mparent", cwd: "/w/fork" } }),
			line({ timestamp: "2026-08-21T18:41:08.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "01900000-1000-7000-8000-000000000003" } }),
			line({ timestamp: "2026-08-21T18:41:08.000Z", type: "event_msg", payload: { type: "user_message", message: "Old question." } }),
			line({ timestamp: "2026-08-22T09:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "01910000-1000-7000-8000-000000000004" } }),
			line({ timestamp: "2026-08-22T09:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "New question." } }),
		].join("\n"));
		const hourAgo = new Date(Date.now() - 3_600_000);
		utimesSync(fork, hourAgo, hourAgo);
		const { app } = await tui(s);
		keys(app, "N");
		await answer(app, "New agent:", DOWN, ENTER);
		await answer(app, "Turn which chat into an agent?", ...typed("old"), ENTER);
		await answer(app, "Agent name", ENTER);
		await answer(app, "It continues in", ENTER);
		await answer(app, "Summaries from:", ENTER);
		await answer(app, "Anthropic model:", ...typed("haiku-4-5"), ENTER);
		await answer(app, "Thinking", ENTER);
		await answer(app, "Its default folder", ENTER);
		await answer(app, "Import preview for Old-question");
		const shown = screen(app);
		expect(shown).toContain("Left out: Warning: 1 messages replayed from parent ]0;owned[31mparent in Codex");
		expect(shown).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
		keys(app, ESC);
		await app.idle();
	});

	it("says No to an in-use chat and leaves; a taken name is refused; no chats, it says so", async () => {
		const s = scene();
		const { app, outs } = await tui(s);
		keys(app, "N");
		await answer(app, "New agent:", DOWN, ENTER);
		await answer(app, "Turn which chat into an agent?", ENTER);
		await answer(app, "In use", "n");
		await app.idle();
		expect(outs).toEqual([]);
		writeFileSync(s.configPath, `${readFileSync(s.configPath, "utf8")}[lanes.install-rpcs3-appimage]\ncompactor_model = "openai/gpt-6.1-sol"\n`);
		app.refresh();
		keys(app, "N");
		await answer(app, "New agent:", DOWN, ENTER);
		await answer(app, "Turn which chat into an agent?", ENTER);
		await answer(app, "In use", "y");
		await answer(app, "Agent name", "\x15", ...typed("Install-RPCS3-APPIMAGE"), ENTER);
		await app.idle();
		expect(screen(app)).toContain("A lane named Install-RPCS3-APPIMAGE already exists.");
		const empty = makeApp(fakeDeps({ chats: () => ({ chats: [], bytesRead: 0 }) }), [lanesPage]);
		keys(empty, "N");
		await answer(empty, "New agent:", DOWN, ENTER);
		await empty.idle();
		await settle();
		expect(screen(empty)).toContain("No Claude Code or Codex chats were found.");
	});

	it("suggests a free name when the title's is taken", async () => {
		const s = scene();
		writeFileSync(s.configPath, `${readFileSync(s.configPath, "utf8")}[lanes.Install-RPCS3-AppImage]\ncompactor_model = "openai/gpt-6.1-sol"\n`);
		const { app } = await tui(s);
		keys(app, "N");
		await answer(app, "New agent:", DOWN, ENTER);
		await answer(app, "Turn which chat into an agent?", ENTER);
		await answer(app, "In use", "y");
		await answer(app, "Agent name");
		expect(screen(app)).toContain("Install-RPCS3-AppImage-2");
		keys(app, ESC);
		await app.idle();
	});
});

describe("the memory build on the Agents page", () => {
	it("shows in the row's state cell and, whole, on the agent's page", () => {
		const building = "building memory: 3 summaries for 800 messages · $0.02 so far";
		const app = makeApp(fakeDeps({}, [row({ name: "Atlas", hasMemory: true, messages: 800, building }), row({ name: "Birch" })]), [lanesPage]);
		expect(screen(app)).toContain("closed · building memory: 3 summaries");
		for (const width of [60, 80, 100, 120]) expect(app.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		keys(app, "i");
		expect(screen(app)).toContain(`Memory build      ${building}`);
	});
});
