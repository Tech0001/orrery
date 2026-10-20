/** `orrery` in a terminal: starts the TUI on the alternate screen, refreshes it every 2 s, and restores the terminal on exit. */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ProcessTerminal, type TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import { defaultConfigPath, userConfigPath } from "../agent/config.ts";
import { App, type Page } from "./app.ts";
import { type JudgedConfig, realDeps } from "./deps.ts";
import { agentsPage } from "./pages/agents.ts";
import { loginsPage } from "./pages/logins.ts";
import { toolsPage } from "./pages/tools.ts";
import { usagePage } from "./pages/usage.ts";
import { firstRun } from "./setup.ts";

/** The pages, in order. */
export const PAGES: Page[] = [agentsPage, loginsPage, usagePage, toolsPage];

/** The config the TUI reads and edits: --config (absolute), else the usual places, else where a new one goes. */
export function tuiConfigPath(option: string | undefined): string {
	if (option !== undefined) return resolve(option);
	return existsSync(defaultConfigPath()) ? defaultConfigPath() : userConfigPath();
}

/**
 * With --config, sets ORRERY_CONFIG to its absolute path, so everything the TUI starts or asks (a launched tool and
 * its plugin or extension, first run) uses the same config as the TUI.
 */
export function useConfigOption(option: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
	if (option !== undefined) env.ORRERY_CONFIG = resolve(option);
}

/** Restores the terminal on SIGTERM or SIGHUP (a closed window, kill), then exits 128 + the signal; returns the undo. */
export function restoreOnSignals(
	restore: () => void,
	exit: (code: number) => void = (code) => process.exit(code),
	target: Pick<NodeJS.Process, "on" | "off"> | NodeJS.EventEmitter = process,
): () => void {
	const codes = { SIGTERM: 143, SIGHUP: 129 } as const;
	const handlers = (Object.keys(codes) as (keyof typeof codes)[]).map((signal) => {
		const handler = () => {
			restore();
			exit(codes[signal]);
		};
		target.on(signal, handler);
		return () => target.off(signal, handler);
	});
	return () => {
		for (const off of handlers) off();
	};
}

/**
 * Stops the TUI and leaves the alternate screen without drawing the last frame again, so a page that cannot draw
 * cannot keep the shell on the alternate screen. Never throws.
 */
export function stopTui(tui: TUI): void {
	try {
		tui.stop({ preserveScreen: true });
	} catch {
		// the terminal is already gone
	}
}

/**
 * Runs the TUI until q (or Ctrl+C); returns the exit code. An uncaught error restores the terminal before it is printed.
 * `config`: the config as orrery's gate read and judged it, and how to judge it again (src/tui/deps.ts JudgedConfig);
 * every config the TUI reads after is judged first.
 */
export async function runTui(configOption?: string, options: { createDeps?: typeof realDeps; notice?: string; config?: JudgedConfig } = {}): Promise<number> {
	useConfigOption(configOption);
	const configPath = options.config?.file.path ?? tuiConfigPath(configOption);
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal);
	let finish: (code: number) => void = () => {};
	const finished = new Promise<number>((resolve) => {
		finish = resolve;
	});
	const app = new App((options.createDeps ?? realDeps)({ configPath, tui, quit: () => finish(0), ...(options.config === undefined ? {} : { config: options.config }) }), PAGES);
	let stopped = false;
	const restore = () => {
		if (stopped) return;
		stopped = true;
		stopTui(tui);
	};
	const crash = (error: unknown) => {
		restore();
		process.stderr.write(`Orrery: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exit(1);
	};
	process.on("uncaughtException", crash);
	process.on("unhandledRejection", crash);
	const releaseSignals = restoreOnSignals(restore);
	let timer: NodeJS.Timeout | undefined;
	try {
		tui.addChild(app);
		tui.setFocus(app);
		app.refresh();
		if (options.notice !== undefined && options.notice !== "") app.say(options.notice);
		tui.start();
		if (!existsSync(configPath)) {
			firstRun(app).then((ok) => {
				if (!ok) finish(0);
			}, crash);
		}
		timer = setInterval(() => {
			app.refresh();
			tui.requestRender();
		}, 2000);
		return await finished;
	} finally {
		clearInterval(timer);
		app.host.closeAll();
		restore();
		releaseSignals();
		process.off("uncaughtException", crash);
		process.off("unhandledRejection", crash);
	}
}
