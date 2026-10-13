/** Fictional, offline data for `npm run demo`. Every file lives in the throwaway home. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/compat";
import { browseCommand } from "./cli/commands.ts";
import { loadConfig, type HarnessConfig } from "./lane/config.ts";
import { FileCredentialStore } from "./lane/credentials.ts";
import { loginRows } from "./lane/logins.ts";
import { laneOverview, laneUsage, TOOL_LABELS } from "./lane/overview.ts";
import type { LaneStatus } from "./lane/status-file.ts";
import type { SummarySources } from "./lane/summary-sources.ts";
import { orreryRoot } from "./lane/tools.ts";
import { MemoryStore, MemoryView, Part } from "./memory/index.ts";
import type { AppDeps } from "./tui/app.ts";
import { colorWanted, makeTheme } from "./tui/theme.ts";

const LANES = [
	{ name: "Bellwick", tool: "pi", state: "working", messages: 96, task: "a toy tram map" },
	{ name: "Mossmere", tool: "claude-code", state: "open", messages: 64, task: "a pretend seed catalogue" },
	{ name: "Puddleby", tool: "omp", state: "open", messages: 48, task: "a clockwork duck simulator" },
	{ name: "Kiteford", tool: "pi", state: "closed", messages: 32, task: "a paper kite colour picker" },
	{ name: "Cloudfen", tool: "codex", state: "closed", messages: 0, task: "a make-believe cloud atlas" },
] as const;
const MODEL = "demo-api/paper-summary";
const DISABLED = "This demo is for browsing fictional data. Changes, sign-ins and tool launches are disabled.";
const disabled = (): never => { throw new Error(DISABLED); };

export interface Demo {
	readonly home: string;
	readonly configPath: string;
	readonly now: number;
}

/** Only terminal presentation settings cross into the demo process. */
export function demoEnvironment(home: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return {
		HOME: home, PATH: "", TERM: env.TERM ?? "xterm-256color",
		...(env.COLORTERM === undefined ? {} : { COLORTERM: env.COLORTERM }),
		...(env.NO_COLOR === undefined ? {} : { NO_COLOR: env.NO_COLOR }),
		ORRERY_HOME: join(home, ".orrery"), ORRERY_CONFIG: join(home, ".orrery", "config.toml"), ORRERY_NO_OPEN: "1",
	};
}

/** The parent owns cleanup, including when the TUI child fails or exits on a signal. */
export async function withDemoHome<T>(run: (home: string) => Promise<T>): Promise<T> {
	const home = mkdtempSync(join(tmpdir(), "orrery-demo-"));
	try { return await run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

export function createDemo(home: string, now = Date.now()): Demo {
	const configPath = join(home, ".orrery", "config.toml");
	mkdirSync(join(home, ".orrery"), { recursive: true });
	writeFileSync(configPath, [
		...LANES.map((lane) => `\n[lanes.${lane.name}]\nworkspace = ${JSON.stringify(join(home, "workspaces", lane.name))}\ntool = "${lane.tool}"\ncompactor_model = "${MODEL}"\ncompactor_thinking = "off"`), "",
	].join("\n"), { mode: 0o600 });
	const config = loadConfig(configPath);
	for (const [index, fixture] of LANES.entries()) {
		const lane = config.lanes.get(fixture.name)!;
		mkdirSync(lane.workspace, { recursive: true });
		writeFileSync(join(lane.workspace, "README.md"), `# ${fixture.name}\n\nA fictional demo project: ${fixture.task}.\n`);
		// Codex is launch-only: do not imply that it records Orrery memory.
		if (fixture.tool === "codex") continue;
		const store = MemoryStore.open(join(lane.dir, "memory.sqlite"));
		try {
			for (let i = 0; i < fixture.messages; i++) {
				store.append(i % 2 === 0 ? "user" : "talk", i % 2 === 0
					? `For ${fixture.task}, review sample ${Math.floor(i / 2) + 1}. Keep the labels short, the colours distinct and keyboard navigation predictable. This is a fictional design exercise.`
					: `Sample ${Math.floor(i / 2) + 1} is ready. The labels now fit the small layout, focus moves in reading order, and the contrast checks pass. Next we will compare the compact and wide views.`,
					new Date(now - (fixture.messages - i) * 90_000 - index * 3_600_000).toISOString());
			}
			const built = fixture.state === "closed" || fixture.name === "Puddleby" ? fixture.messages - 8 : fixture.messages;
			for (let level = 0; 2 ** level <= built; level++) {
				for (let i = 0; (i + 1) * 2 ** level <= built; i++) {
					const part = new Part(level, i);
					store.saveNode(part, `Canned summary for ${fixture.task}, messages ${part.start + 1}–${part.end}: short labels, distinct colours and predictable keyboard navigation; compare compact and wide layouts next.`);
				}
			}
			for (let day = 0; day < 5; day++) {
				const at = new Date(now - day * 86_400_000).toISOString();
				store.appendBatch([], {}, [
					{ at, role: "agent", model: "demo-api/paper-agent", input: 45_000 + index * 5000, cacheRead: 28_000, cacheWrite: 2000, output: 2400, ok: true },
					{ at, role: "compactor", model: MODEL, input: 18_000 + index * 1000, cacheRead: 6000, cacheWrite: 1000, output: 900, ok: fixture.name !== "Puddleby" || day !== 0 },
				]);
			}
			const failing = fixture.name === "Puddleby";
			const status: LaneStatus = {
				lane: lane.name, pid: process.pid, open: fixture.state !== "closed", busy: fixture.state === "working",
				model: fixture.tool, thinking: "off", modelSource: "config", memory: new MemoryView(store).stats(),
				compactor: { stopped: false, failing: failing ? 2 : 0, model: MODEL, thinking: "off", source: "config" },
				trouble: failing ? { state: "failing", plain: "Demo summary service is temporarily unavailable." } : null,
				lastError: null, updatedAt: new Date(now).toISOString(),
			};
			writeFileSync(join(lane.dir, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
		} finally { store.close(); }
	}
	return { home, configPath, now };
}

/** Real read paths, a static fictional price catalogue, and no network or tool execution capabilities. */
export function demoDeps(demo: Demo, controls: Pick<AppDeps, "rows" | "quit" | "requestRender">): AppDeps {
	const credentials = new FileCredentialStore(loadConfig(demo.configPath).credentialsPath);
	const models = createModels({ credentials });
	models.setProvider({
		id: "demo-api", name: "Demo prices (illustrative)",
		auth: { apiKey: { name: "Demo", resolve: async () => undefined } },
		stream: disabled, streamSimple: disabled,
		getModels: () => [{
			id: "paper-summary", name: "Paper summary", provider: "demo-api", api: "demo", baseUrl: "https://demo.invalid",
			reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4000,
			cost: { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0.25 },
		}],
	});
	const sources = async (config: HarnessConfig): Promise<SummarySources> => ({ config, credentials, models, savedLoginsOnly: true });
	return {
		...controls, configPath: demo.configPath, cwd: demo.home, theme: makeTheme(colorWanted()),
		loadConfig: () => loadConfig(demo.configPath), configWritable: () => false, editConfig: disabled,
		// Keep this staged snapshot fresh without a background writer pretending to be a live agent.
		overview: (config) => laneOverview(config, { now: demo.now }),
		usage: (config, days, only) => laneUsage(config, days, only, demo.now),
		tools: () => (["pi", "claude-code", "omp", "codex"] as const).map((id) => ({
			id, label: TOOL_LABELS[id], path: join(demo.home, "bin", id), version: "1.0.0",
			wiring: id === "codex" ? "none" : "installed", detail: "Fictional demo tool; launches disabled.", blocked: DISABLED,
		})),
		sources, target: disabled, loginRows: (source, rows) => loginRows(source, rows, {}),
		saveKey: async () => disabled(), signIn: async () => disabled(), removeLogin: async () => disabled(),
		testChoice: async () => disabled(), launch: async () => disabled(), applyFix: disabled,
		installSteps: disabled, install: disabled, openUrl: () => undefined,
		browse: (config, lane) => ({ path: browseCommand(config, lane, join(config.lanes.get(lane)!.dir, "memory.html")) }),
		about: () => ({ version: `${JSON.parse(readFileSync(join(orreryRoot(), "package.json"), "utf8")).version} (demo)`, root: orreryRoot() }),
		now: () => demo.now,
	};
}
