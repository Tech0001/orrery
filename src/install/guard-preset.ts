/**
 * The [guard] preset in an older config (spec 2026-10-16-guard-presets): setup adds the block new configs start with
 * (GUARD_PRESET) to the config in use once, so its user sees where more protected files go. "Once" is kept in Orrery's
 * home, in guard-preset.json: the configs it was offered to, by path. A config is offered when setup finds it with no
 * [guard] table (the block is added), with one (nothing to add), or not there yet (a new config starts with the block);
 * after that it is left alone, so a block the user deletes does not come back. A config Orrery cannot read (a link that
 * leads nowhere yet among them), or may not write, is left alone and not counted: it is offered once it reads again.
 * Setup keeps the config's last text as .bak, as every edit Orrery makes to it does.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { addGuardPreset, configText, configWritable, userConfigPath, writeConfigOnce } from "../agent/config-edit.ts";
import type { ConfigFile } from "../agent/config.ts";
import { orreryHome } from "../agent/home.ts";
import { writePrivate } from "../agent/private-file.ts";

/** The marker in Orrery's home, where the home really is: a home that is a link to another folder keeps it too. */
function markerFile(env: NodeJS.ProcessEnv): string {
	const home = orreryHome(env);
	try {
		return join(realpathSync(home), "guard-preset.json");
	} catch {
		return join(home, "guard-preset.json");
	}
}

/** Whether nothing at all is at `path`: no file, and no link, not even one that leads nowhere yet. */
function absent(path: string): boolean {
	try {
		lstatSync(path);
		return false;
	} catch (error) {
		return (error as { code?: unknown }).code === "ENOENT";
	}
}

/** The configs the preset was offered to; none when the file is missing or unreadable. */
function offered(env: NodeJS.ProcessEnv): string[] {
	try {
		const read = JSON.parse(readFileSync(markerFile(env), "utf8")) as { offered?: unknown };
		return Array.isArray(read.offered) ? read.offered.filter((path): path is string => typeof path === "string") : [];
	} catch {
		return [];
	}
}

/** Counts `paths` as offered. A marker that cannot be written is not fatal: setup goes on, and may offer again. */
function remember(env: NodeJS.ProcessEnv, paths: readonly string[]): void {
	try {
		writePrivate(markerFile(env), `${JSON.stringify({ offered: [...new Set([...offered(env), ...paths])] }, null, 2)}\n`, { keepFolderMode: true });
	} catch {
		// not counted
	}
}

/** A path and where it really is, when it is there. */
function spellings(path: string): string[] {
	const given = resolve(path);
	try {
		return [...new Set([given, realpathSync(given)])];
	} catch {
		return [given];
	}
}

/**
 * Offers the preset to the user's own config (ORRERY_CONFIG, else <home>/config.toml), as 0.9.0 did: through the file
 * the gate read for this command (`judged`, src/cli/gate.ts Gated.configFile) when that is the same file, however it
 * was spelled. A config the gate read elsewhere (--config, the server path's when the home has none) is left alone. The
 * line setup prints when it adds the block, or undefined when it adds nothing. The gate's config is written back as
 * every command writes it (writeConfigOnce): in a coding tool's session only while the file is as the gate read it,
 * never read again. Never throws: setup goes on whatever happens here.
 */
export function offerGuardPreset(env: NodeJS.ProcessEnv, judged?: ConfigFile): string | undefined {
	try {
		const own = userConfigPath(env);
		const path = judged?.path ?? own;
		const names = spellings(path);
		if (judged !== undefined && !spellings(own).some((name) => names.includes(name))) return undefined;
		const done = offered(env);
		if (names.some((name) => done.includes(name))) return undefined;
		if (absent(path)) {
			remember(env, names);
			return undefined;
		}
		// No gate's read: the file at the path, read when written, as 0.9.0 did.
		const file: ConfigFile = judged ?? { path: resolve(path) };
		let next: string | undefined;
		try {
			const text = configText(file);
			if (text === undefined) return undefined;
			next = addGuardPreset(text, dirname(resolve(path)));
		} catch {
			return undefined; // a config Orrery cannot read (a link that leads nowhere yet among them): left alone
		}
		if (next === undefined) {
			remember(env, names);
			return undefined;
		}
		if (!configWritable(path)) return undefined;
		const real = names.at(-1) as string;
		try {
			writeConfigOnce(file, next);
		} catch (error) {
			return `config: could not add a [guard] example to ${path}: ${error instanceof Error ? error.message : String(error)}`;
		}
		remember(env, names);
		return `config: added a [guard] example to ${path}, where you can list more files and folders to keep from agents (the old file is ${real}.bak)`;
	} catch {
		return undefined;
	}
}
