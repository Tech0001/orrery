/**
 * What Orrery's own writes touch in Grok's settings, so that they keep the record of approved settings in step
 * (src/grok/settings.ts keepInStep; spec 2026-11-10-grok-settings-check-design, Goal 6): where the record is, and the
 * keys of Orrery's hook file and two config tables in Grok's folder with the programs they run, of the programs in
 * Orrery's app folder (an install's, update's or rollback's swap), and of Orrery's Claude Code plugin, which Grok loads
 * too. Each names what the write will leave as discovery names it (src/grok/settings-sources.ts sourceKey), before it
 * is there.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { realish, under } from "../agent/appended-lines.ts";
import { defaultConfigPath, loadConfig } from "../agent/config.ts";
import { orreryHome } from "../agent/home.ts";
import { grokHome } from "./log.ts";
import { sourceKey } from "./settings-sources.ts";

/**
 * The folder of the record of approved Grok settings for a command that has no config of its own to hand (setup,
 * install, update, uninstall, the tools check): the data folder of the config Orrery runs with ($ORRERY_CONFIG, else
 * the home's, else the server path's), else Orrery's home, where a config made later keeps its data by default.
 */
export function settingsDataDir(env: NodeJS.ProcessEnv): string {
	try {
		return loadConfig(defaultConfigPath(env)).dataDir;
	} catch {
		// no config yet, or one that doesn't load
	}
	try {
		return orreryHome(env);
	} catch {
		// an ORRERY_HOME that is no absolute path
		return join(env.HOME || homedir(), ".orrery");
	}
}

const grokFolder = (env: NodeJS.ProcessEnv) => grokHome(env, env.HOME || homedir());
const PROGRAM = "global program ";
const program = (path: string) => `${PROGRAM}${normalize(path)}`;

/** Orrery's hook file in Grok's folder (src/grok/install.ts grokHookFile), and the program it runs. */
export function grokHookKeys(env: NodeJS.ProcessEnv): string[] {
	return [sourceKey("global", "hook-file", join(grokFolder(env), "hooks", "orrery.json")), program("/bin/sh")];
}

/** Orrery's two tables in Grok's config (src/grok/install.ts addGrokConfig), and the Orrery commands they may run. */
export function grokConfigKeys(env: NodeJS.ProcessEnv, orrery: readonly string[]): string[] {
	const config = sourceKey("global", "config-keys", join(grokFolder(env), "config.toml"));
	return [`${config}\0mcp_servers.orrery`, `${config}\0ui.status_line`, ...orrery.map(program)];
}

/** The programs in Orrery's app folder, app/current's command among them: an install, update or rollback swaps them. */
export function appPrograms(env: NodeJS.ProcessEnv): (entry: string) => boolean {
	const app = join(orreryHome(env), "app");
	const folders = [...new Set([app, realish(app)])];
	return (entry) => entry.startsWith(PROGRAM) && folders.some((folder) => under(entry.slice(PROGRAM.length), folder));
}

/** The Claude Code plugin Orrery installs, by its id in Claude Code's plugin list. */
const PLUGIN = "orrery@orrery";

/** Where Claude Code's plugin list puts each install of Orrery's plugin; none when the list can't be read. */
function pluginRoots(list: string): string[] {
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(list, "utf8"));
	} catch {
		return [];
	}
	const plugins = (json as { plugins?: unknown } | null)?.plugins;
	const installs = typeof plugins === "object" && plugins !== null && Object.hasOwn(plugins, PLUGIN) ? (plugins as Record<string, unknown>)[PLUGIN] : undefined;
	return [installs].flat().flatMap((install) => {
		const root = (install as { installPath?: unknown } | null)?.installPath;
		return typeof root === "string" && isAbsolute(root) ? [normalize(root)] : [];
	});
}

/**
 * Orrery's Claude Code plugin as Grok loads it (src/grok/settings-sources.ts: every plugin Claude Code installed): each
 * install of it in Claude Code's plugin list, the programs under one, which the list is read for each time it is asked
 * (an update puts the new copy at a new place: keepInStep asks before the write and after it), and Claude Code's
 * enabledPlugins and extraKnownMarketplaces, which installing it writes.
 */
export function orreryPluginEntries(env: NodeJS.ProcessEnv): (entry: string) => boolean {
	const claude = join(env.HOME || homedir(), ".claude");
	const list = join(claude, "plugins", "installed_plugins.json");
	const installs = `global plugin ${realish(list)}\0${PLUGIN}\0`;
	const settings = ["settings.json", "settings.local.json"].flatMap((name) => {
		const key = sourceKey("global", "claude-settings", join(claude, name));
		return [`${key}\0enabledPlugins`, `${key}\0extraKnownMarketplaces`];
	});
	return (entry) => {
		if (entry.startsWith(installs) || settings.includes(entry)) return true;
		if (!entry.startsWith(PROGRAM)) return false;
		const path = entry.slice(PROGRAM.length);
		return pluginRoots(list).some((root) => under(path, root));
	};
}
