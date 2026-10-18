/**
 * Orrery's plugin in OpenCode's plugin list (GET /api/plugin, `{data: [{id, source, features, state}]}`), found by its
 * source: a local plugin in Orrery's plugin folder. The launch's check reads it (src/opencode/check.ts), and so does the
 * TUI entry, to say when OpenCode has turned the plugin off (tui-feed.ts). Node built-ins only: the TUI entry packs it.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

/** Whether `path` is `folder` or inside it, by its given path or its real one (OpenCode lists a loaded plugin's real file). */
function within(path: string, folder: string): boolean {
	const folders = new Set([folder]);
	try {
		folders.add(realpathSync(folder));
	} catch {
		// not there: the given path only
	}
	for (const root of folders) {
		const rel = relative(root, path);
		if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
	}
	return false;
}

/** Orrery's plugin in OpenCode's plugin list (its source is the plugin folder), the list's size, or undefined for a list in a shape Orrery doesn't know. */
export function findPlugin(answer: unknown, folder: string): { readonly entry?: { readonly status?: unknown; readonly error?: unknown }; readonly size: number } | undefined {
	const data = (answer as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return undefined;
	for (const item of data as { source?: { type?: unknown; path?: unknown }; state?: { status?: unknown; error?: unknown } }[]) {
		const source = item?.source;
		if (source?.type === "local" && typeof source.path === "string" && within(source.path, folder)) return { entry: item.state ?? {}, size: data.length };
	}
	return { size: data.length };
}
