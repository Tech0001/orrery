/** Fakes for TUI tests: an AppDeps that records what was asked of it, and lane rows. */

import type { HarnessConfig } from "../../src/lane/config.ts";
import { parseConfig } from "../../src/lane/config.ts";
import type { LaneRow } from "../../src/lane/overview.ts";
import { type AppDeps, App, type Page } from "../../src/tui/app.ts";
import { PLAIN } from "../../src/tui/theme.ts";

export const NOW = Date.parse("2026-10-08T12:00:00.000Z");

export function row(fields: Partial<LaneRow> & { name: string }): LaneRow {
	return {
		tool: "pi", toolSet: true, state: "closed", workspace: `/w/${fields.name.toLowerCase()}`, dataDir: `/d/${fields.name}`,
		hasMemory: true, messages: 10, summaries: 19, viewBytes: 64_000, viewBudget: 128_000, summaryContextBytes: 32_000, summaryJobs: 4, compactAt: 200_000,
		summary: { state: "ok", waiting: 0 }, summaryModel: { ref: "openai/gpt-6.1-sol", thinking: "low", source: "config" },
		lastMessageAt: "2026-10-08T11:55:00.000Z", reads: [], instructions: "ok",
		...fields,
	};
}

export const CONFIG_TEXT = `data_dir = "/d"\n[lanes.Alpha]\nworkspace = "/w/alpha"\ncompactor_model = "openai/gpt-6.1-sol"\n[lanes.Cedarn]\nworkspace = "/w/cedarn"\ncompactor_model = "openai/gpt-6.1-sol"\n`;
export const CONFIG: HarnessConfig = parseConfig(CONFIG_TEXT, "/d");

export type FakeDeps = AppDeps & { quits: number; edits: string[]; launched: string[]; instructions: [string, string][] };

/** Every dependency answers with a harmless default; tests override what they exercise. */
export function fakeDeps(overrides: Partial<AppDeps> = {}, rows: LaneRow[] = [row({ name: "Alpha" }), row({ name: "Cedarn" })]): FakeDeps {
	let text = CONFIG_TEXT;
	let config = CONFIG;
	const deps = {
		quits: 0, edits: [] as string[], launched: [] as string[], instructions: [] as [string, string][],
		configPath: "/c/config.toml", cwd: "/home/someone/project", theme: PLAIN,
		loadConfig: () => config,
		configWritable: () => true,
		editConfig: (edit: (text: string, dir: string) => string) => {
			text = edit(text, "/d");
			config = parseConfig(text, "/d");
			deps.edits.push(text);
			return config;
		},
		overview: () => rows,
		usage: () => [],
		tools: () => [],
		sources: async () => ({}) as never,
		target: () => { throw new Error("no target in this test"); },
		loginRows: async () => [],
		saveKey: async () => "Anthropic",
		signIn: async () => {},
		removeLogin: async () => "Removed.\n",
		testChoice: async () => ({ ok: true as const }),
		launch: async (plan: { lane: string }) => {
			deps.launched.push(plan.lane);
			return { code: 0, signal: null };
		},
		applyFix: () => "fixed",
		edit: async () => ({ code: 0, signal: null }),
		install: () => ({ ok: true, output: "done\n" }),
		installSteps: () => [],
		browse: () => ({ path: "/d/lanes/Alpha/memory.html" }),
		chats: () => ({ chats: [], bytesRead: 0 }),
		importPreview: async () => {
			throw new Error("no preview in this test");
		},
		importCommit: () => {
			throw new Error("no import in this test");
		},
		startBuild: () => {},
		writeInstructions: (dir: string, text: string) => {
			deps.instructions.push([dir, text]);
		},
		openUrl: () => undefined,
		about: () => ({ version: "0.1.0", root: "/opt/orrery" }),
		installedVersion: () => undefined,
		updateNotice: async () => undefined,
		rows: () => 30,
		now: () => NOW,
		quit: () => {
			deps.quits++;
		},
		requestRender: () => {},
		...overrides,
	};
	return deps as unknown as FakeDeps;
}

/** Lets pending promises (an action, a modal opening) run. */
export async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

export function screen(app: App, width = 120): string {
	return app.render(width).join("\n");
}

export function keys(app: App, ...data: string[]): void {
	for (const d of data) app.handleInput(d);
}

export function makeApp(deps: AppDeps, pages: Page[]): App {
	const app = new App(deps, pages);
	app.refresh();
	return app;
}

/** Checks the open dialog's title, sends keys to it, and lets the action move on. */
export async function answer(app: App, title: string, ...data: string[]): Promise<void> {
	await settle();
	// Real file work (a saved login) can take longer than one settle on a busy machine: wait up to 3 s for the dialog.
	for (let i = 0; i < 300 && !app.host.current?.title.includes(title); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	const current = app.host.current;
	if (current === undefined || !current.title.includes(title)) throw new Error(`expected a dialog "${title}", found "${current?.title ?? "none"}"`);
	for (const d of data) app.handleInput(d);
	await settle();
}

/** Types text, one key at a time. */
export const typed = (text: string) => [...text];
