/**
 * The [guard] preset in an older config (spec 2026-10-16-guard-presets): setup adds the block new configs start with
 * (GUARD_PRESET) to the config in use once, so its user sees where more protected files go. "Once" is kept in Orrery's
 * home, in guard-preset.json: the configs it was offered to, by path. A config is offered when setup finds it with no
 * [guard] table (the block is added), with one (nothing to add), or not there yet (a new config starts with the block);
 * after that it is left alone, so a block the user deletes does not come back. A config Orrery cannot read, or may not
 * write, is left alone and not counted: it is offered once it reads again.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { addGuardPreset, configWritable, saveConfigText, userConfigPath } from "../agent/config-edit.ts";
import { orreryHome } from "../agent/home.ts";
import { writePrivate } from "../agent/private-file.ts";

const markerFile = (env: NodeJS.ProcessEnv) => join(orreryHome(env), "guard-preset.json");

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
 * Offers the preset to the config in use (ORRERY_CONFIG, else <home>/config.toml): the line setup prints when it adds the
 * block, or undefined when it adds nothing. Never throws: setup goes on whatever happens here.
 */
export function offerGuardPreset(env: NodeJS.ProcessEnv): string | undefined {
	try {
		const path = userConfigPath(env);
		const names = spellings(path);
		const done = offered(env);
		if (names.some((name) => done.includes(name))) return undefined;
		if (!existsSync(path)) {
			remember(env, names);
			return undefined;
		}
		let next: string | undefined;
		try {
			next = addGuardPreset(readFileSync(path, "utf8"), dirname(resolve(path)));
		} catch {
			return undefined; // a config Orrery cannot read: left alone
		}
		if (next === undefined) {
			remember(env, names);
			return undefined;
		}
		if (!configWritable(path)) return undefined;
		const real = names.at(-1) as string;
		try {
			saveConfigText(path, next);
		} catch (error) {
			return `config: could not add a [guard] example to ${path}: ${error instanceof Error ? error.message : String(error)}`;
		}
		remember(env, names);
		return `config: added a [guard] example to ${path}, where you can list more files and folders to keep from agents (the old file is ${real}.bak)`;
	} catch {
		return undefined;
	}
}
