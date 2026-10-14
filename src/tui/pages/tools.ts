/** Page 4, Tools (spec §3.4): pi, Claude Code, Codex and OMP (found, version, orrery's side), Wrangler, and Orrery itself. I installs or repairs Orrery extensions. */

import { join } from "node:path";
import { shortHome, toolVersionNumber, type ToolCheck } from "../../agent/tools.ts";
import type { App, Page } from "../app.ts";
import { ConfirmModal, MessageModal } from "../dialogs.ts";
import { safeLines } from "./agent-actions.ts";
import { type Column, renderTable } from "../table.ts";

const COLUMNS: readonly Column[] = [
	{ title: "Tool", width: 12 },
	{ title: "Found", width: 26, grow: true, truncate: "middle" },
	{ title: "Version", width: 10 },
	{ title: "Orrery", width: 17 },
	{ title: "Detail", width: 30, drop: 1, truncate: "middle" },
];

/** Checks run processes (`pi --version` …): keep them for 30 s rather than every refresh. */
const FRESH_MS = 30_000;
interface State {
	checks: ToolCheck[];
	at: number;
	cloudflare?: boolean;
	pending?: Promise<void>;
}
const states = new WeakMap<App, State>();
const state = (app: App): State => {
	let s = states.get(app);
	if (s === undefined) {
		s = { checks: [], at: Number.NEGATIVE_INFINITY };
		states.set(app, s);
	}
	return s;
};

function check(app: App, force = false): ToolCheck[] {
	const s = state(app);
	const now = app.deps.now();
	const cloudflare = [...(app.config?.remotes.values() ?? [])].some((remote) => remote.kind === "cloudflare");
	if (force || now - s.at > FRESH_MS || s.cloudflare !== cloudflare) {
		s.checks = app.deps.tools({ probeWrangler: true }).filter((tool) => tool.id !== "wrangler" || tool.path !== undefined || cloudflare);
		s.cloudflare = cloudflare;
		s.at = now;
		if (app.deps.ori !== undefined && s.pending === undefined) {
			s.pending = app.deps.ori().then((row) => {
				s.checks = s.checks.map((check) => check.id === "ori" ? row : check);
				app.deps.requestRender();
			}).catch(() => {}).finally(() => { s.pending = undefined; });
		}
	}
	return s.checks;
}

/** The newest backup's day across the agents, or undefined when no agent has one. */
function newestBackup(app: App): string | undefined {
	return app.agents.reduce<string | undefined>((newest, row) => (row.lastBackup !== undefined && (newest === undefined || row.lastBackup > newest) ? row.lastBackup : newest), undefined);
}

function rows(app: App): string[][] {
	const about = app.deps.about();
	const backup = newestBackup(app);
	return [
		...state(app).checks.map((t) => [t.label, t.path === undefined ? "not found" : shortHome(t.path), toolVersionNumber(t.version), t.id === "ori" ? t.signin ?? "unknown" : t.wiring, shortHome(t.detail)]),
		["Orrery", shortHome(about.root), toolVersionNumber(about.version), "—", backup === undefined ? "no backup yet" : `last backup ${backup}`],
	];
}

export const toolsPage: Page = {
	id: "tools",
	title: "Tools",
	hints: "Enter details · I install or repair",
	refresh: (app) => {
		check(app);
	},
	count: (app) => state(app).checks.length + 1,
	render(app, width, height) {
		check(app);
		const { theme } = app.deps;
		const list = rows(app);
		return renderTable(COLUMNS, list, width, {
			selected: app.sel(),
			height,
			theme,
			rowStyle: (i) => {
				const wiring = list[i][3];
				return wiring === "missing" || wiring === "other" || wiring === "update available" ? theme.yellow : wiring === "unknown" && state(app).checks[i]?.id !== "ori" ? theme.red : undefined;
			},
		});
	},
	enter(app) {
		const tool = state(app).checks[app.sel()];
		if (tool === undefined) {
			const about = app.deps.about();
			const backup = newestBackup(app);
			const data =
				app.config === undefined
					? ""
					: `\nMemory folder: ${app.config.dataDir}\nLast backup: ${backup === undefined ? "never (run orrery backup)" : `${backup} in ${join(app.config.dataDir, "backups")}`}`;
			void app.host.open(new MessageModal("Orrery", safeLines(`Version: ${about.version}${about.running === undefined ? "" : ` (${about.running})`}\nRuns from: ${about.root}\nConfig file: ${app.deps.configPath}${data}`)));
			return;
		}
		if (tool.id === "ori") {
			void app.host.open(new MessageModal("Ori", safeLines(`Found: ${tool.path ?? "not on PATH"}\nVersion: ${tool.version ?? "unknown"}\nSign-in: ${tool.signin ?? "unknown"}\n${tool.detail}\n\ncurl -fsSL https://openrouter.ai/labs/ori/install.sh | bash\nori login`)));
			return;
		}
		const steps = app.deps.installSteps(tool);
		const plan = steps.length === 0 ? "I does nothing here." : `I would:\n${steps.map((s) => `  ${s.describe}`).join("\n")}`;
		void app.host.open(new MessageModal(tool.label, safeLines(`Found: ${tool.path ?? "not on PATH"}\nVersion: ${tool.version ?? "—"}\nOrrery: ${tool.wiring}\n${tool.detail}\n\n${plan}`)));
	},
	key(app, data) {
		if (data.toLowerCase() !== "i") return false;
		const tool = state(app).checks[app.sel()];
		if (tool === undefined) {
			app.say("Orrery itself is updated with git in its folder.");
			return true;
		}
		if (tool.wiring === "installed") {
			app.say(`Already installed: ${tool.label}, ${tool.detail}.`);
			return true;
		}
		const steps = app.deps.installSteps(tool);
		if (steps.length === 0) {
			app.say(`Nothing Orrery can do for ${tool.label}: ${tool.detail}.`);
			return true;
		}
		app.run(`Installing Orrery's side of ${tool.label}`, async () => {
			if (!(await app.host.open(new ConfirmModal(safeLines(`Install or repair Orrery's side of ${tool.label}? It will:\n${steps.map((s) => `  ${s.describe}`).join("\n")}`))))) return undefined;
			const result = app.deps.install(steps);
			await app.host.open(new MessageModal(tool.label, safeLines(result.output)));
			check(app, true);
			if (!result.ok) throw new Error("It failed; nothing after the failing step ran.");
			return "Done.";
		});
		return true;
	},
};
