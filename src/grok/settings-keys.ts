/**
 * What Orrery's own writes touch in Grok's settings, so that they keep the record of approved settings in step
 * (src/grok/settings.ts keepInStep; spec 2026-11-10-grok-settings-check-design, Goal 6): where the record is, and the
 * keys of Orrery's hook file and two config tables in Grok's folder with the programs they run, of the programs in
 * Orrery's app folder (an install's, update's or rollback's swap), and of Orrery's Claude Code plugin, which Grok loads
 * too. Each names what the write will leave as discovery names it (src/grok/settings-sources.ts sourceKey), before it
 * is there.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { realish, under } from "../agent/appended-lines.ts";
import { defaultConfigPath, loadConfig } from "../agent/config.ts";
import { orreryHome } from "../agent/home.ts";
import { grokHome } from "./log.ts";
import type { StepTest } from "./settings.ts";
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
export function appPrograms(env: NodeJS.ProcessEnv): () => StepTest {
	const app = join(orreryHome(env), "app");
	const folders = [...new Set([app, realish(app)])];
	const covers = (entry: string) => entry.startsWith(PROGRAM) && folders.some((folder) => under(entry.slice(PROGRAM.length), folder));
	return () => ({ covers, after: () => covers });
}

/** The Claude Code plugin Orrery installs, by its id in Claude Code's plugin list. */
const PLUGIN = "orrery@orrery";

/**
 * Where Claude Code's plugin list puts each install of Orrery's plugin, by its place in the list (as the plugin's entry key
 * names it: src/grok/settings-sources.ts discover); undefined for one with no absolute path, none when the list can't be read.
 */
function pluginRoots(list: string): (string | undefined)[] {
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(list, "utf8"));
	} catch {
		return [];
	}
	const plugins = (json as { plugins?: unknown } | null)?.plugins;
	const installs = typeof plugins === "object" && plugins !== null && Object.hasOwn(plugins, PLUGIN) ? (plugins as Record<string, unknown>)[PLUGIN] : undefined;
	return [installs].flat().map((install) => {
		const root = (install as { installPath?: unknown } | null)?.installPath;
		return typeof root === "string" && isAbsolute(root) ? normalize(root) : undefined;
	});
}

/** The names in a folder (real path), undefined when it can't be listed. */
function names(folder: string): Set<string> | undefined {
	try {
		return new Set(readdirSync(folder));
	} catch {
		return undefined;
	}
}

/**
 * The names in the folders a plugin's new copy may go in, read before a write, by real path: Claude Code's plugins folder,
 * its cache and the two levels below it (so the names in cache/<marketplace>/<plugin>, the versions), and the folder of
 * each install of Orrery's plugin then. `existed(root)`, after the write: whether `root` was there before it, by the
 * nearest folder above it that was read; true when none was (it can't be told, so as if it had been).
 */
function folderListing(plugins: string, roots: readonly string[]): { existed(root: string): boolean } {
	const listed = new Map<string, Set<string>>();
	const list = (folder: string, depth: number) => {
		const real = realish(folder);
		if (listed.has(real)) return;
		const here = names(real);
		if (here === undefined) return;
		listed.set(real, here);
		if (depth > 0) for (const name of here) list(join(real, name), depth - 1);
	};
	list(plugins, 0);
	list(join(plugins, "cache"), 2);
	for (const root of roots) list(dirname(root), 0);
	return {
		existed(root) {
			const real = join(realish(dirname(root)), basename(root));
			for (let child = real, folder = dirname(real); folder !== child; child = folder, folder = dirname(folder)) {
				const there = listed.get(folder);
				if (there !== undefined) return there.has(basename(child));
			}
			return true;
		},
	};
}

/**
 * Orrery's Claude Code plugin as Grok loads it (src/grok/settings-sources.ts: every plugin Claude Code installed): each
 * install of it in Claude Code's plugin list, the programs under one, and Claude Code's enabledPlugins and
 * extraKnownMarketplaces, which installing it writes. The list is read once before the write and once after it (an
 * update puts the new copy at a new place). An install at a place that is new to the list but was there before the write
 * (something may have put files there first) is left out after it, with the programs under it: the next check lists it.
 */
export function orreryPluginEntries(env: NodeJS.ProcessEnv): () => StepTest {
	const claude = join(env.HOME || homedir(), ".claude");
	const plugins = join(claude, "plugins");
	const list = join(plugins, "installed_plugins.json");
	const settings = ["settings.json", "settings.local.json"].flatMap((name) => {
		const key = sourceKey("global", "claude-settings", join(claude, name));
		return [`${key}\0enabledPlugins`, `${key}\0extraKnownMarketplaces`];
	});
	return () => {
		const installs = `global plugin ${realish(list)}\0${PLUGIN}\0`;
		/** A test of entry keys for the list's installs `roots`, but for the `held` ones (by their place in the list). */
		const test =
			(roots: readonly (string | undefined)[], held: readonly number[] = []) =>
			(entry: string): boolean => {
				if (settings.includes(entry)) return true;
				if (entry.startsWith(installs)) return !held.includes(Number(entry.slice(installs.length)));
				if (!entry.startsWith(PROGRAM)) return false;
				const path = entry.slice(PROGRAM.length);
				const places = roots.flatMap((root, index) => (root !== undefined && under(path, root) ? [index] : []));
				return places.length > 0 && !places.some((index) => held.includes(index));
			};
		const before = pluginRoots(list);
		const known = before.filter((root) => root !== undefined);
		const listing = folderListing(plugins, known);
		return {
			covers: test(before),
			after: () => {
				const now = pluginRoots(list);
				const held = now.flatMap((root, index) => (root !== undefined && !known.includes(root) && listing.existed(root) ? [index] : []));
				return test(now, held);
			},
		};
	};
}
