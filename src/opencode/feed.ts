/**
 * What Orrery's plugin tells OpenCode's TUI (spec 2026-10-16-opencode-design, "Status and notices"). The plugin runs in
 * OpenCode's server; its TUI entry (src/opencode/plugin/tui.tsx) runs in the TUI, a separate process, and gets no
 * options. So the server side writes a small file beside the launch's token file (<token file>.feed.json, 0600 in
 * Orrery's tokens folder; src/opencode/token-file.ts) and the TUI side reads it: the footer's status line and the
 * notices to show as toasts, each numbered so it is shown once. The TUI finds the file through its plugin folder's entry
 * in OPENCODE_CONFIG_CONTENT, which it has in its environment, and takes it only when it names this TUI (`tui`, the
 * server's parent with --standalone): an OpenCode started from the model's shell inherits that config, and must not show
 * another TUI's status. Node built-ins only: the TUI entry packs the reading side.
 */

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { writePrivate } from "../agent/private-file.ts";
import { feedFileOf } from "./token-file.ts";

export type FeedLevel = "info" | "warning" | "error";

export interface FeedNotice {
	/** Numbered from 1 in the order said: the TUI shows each number once. */
	readonly n: number;
	readonly text: string;
	readonly level: FeedLevel;
}

export interface Feed {
	/** The pid of the TUI this is for (the server's parent). */
	readonly tui: number;
	/** The footer's status: "Orrery · <Name> · <n> msgs · recording". */
	readonly line: string;
	/** The latest notices, oldest first (at most FEED_NOTICES). */
	readonly notices: readonly FeedNotice[];
}

/** How many notices the feed keeps: the TUI reads it every second, so it misses none. */
export const FEED_NOTICES = 20;
/** The most of a feed file read. */
const FEED_MAX = 256 * 1024;

/** Writes the feed (private, atomic). Throws when it cannot. */
export function writeFeed(file: string, feed: Feed): void {
	writePrivate(file, JSON.stringify(feed));
}

/** A feed's notice, if it is one. */
function noticeOf(value: unknown): FeedNotice | undefined {
	const { n, text, level } = (value ?? {}) as { n?: unknown; text?: unknown; level?: unknown };
	if (!Number.isInteger(n) || typeof text !== "string" || (level !== "info" && level !== "warning" && level !== "error")) return undefined;
	return { n: n as number, text, level };
}

/** The feed in `file`, or undefined when there is none, it can't be read, or it is not one the plugin wrote. Never throws. */
export function readFeed(file: string): Feed | undefined {
	let fd: number;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return undefined;
	}
	try {
		if (!fstatSync(fd).isFile()) return undefined;
		const buffer = Buffer.alloc(FEED_MAX);
		const length = readSync(fd, buffer, 0, FEED_MAX, 0);
		const value = JSON.parse(buffer.toString("utf8", 0, length)) as { tui?: unknown; line?: unknown; notices?: unknown };
		if (!Number.isInteger(value?.tui) || typeof value.line !== "string" || !Array.isArray(value.notices)) return undefined;
		return { tui: value.tui as number, line: value.line, notices: value.notices.map(noticeOf).filter((notice): notice is FeedNotice => notice !== undefined) };
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** A folder by its real path, or as given when it has none (not there). */
function realFolder(folder: string): string {
	try {
		return realpathSync(folder);
	} catch {
		return resolve(folder);
	}
}

/**
 * The feed file of the plugin in `folder` (the TUI entry's own folder) as `content` (OPENCODE_CONFIG_CONTENT) names it,
 * or undefined when it names none: the entry whose package is that folder and whose options name a token file.
 */
export function feedFileIn(content: string | undefined, folder: string): string | undefined {
	if (content === undefined || content === "") return undefined;
	try {
		const plugins = (JSON.parse(content) as { plugins?: unknown } | null)?.plugins;
		if (!Array.isArray(plugins)) return undefined;
		const own = realFolder(folder);
		for (const entry of plugins as { package?: unknown; options?: { tokenFile?: unknown } }[]) {
			const target = entry?.package;
			const tokenFile = entry?.options?.tokenFile;
			if (typeof target !== "string" || typeof tokenFile !== "string" || !tokenFile.startsWith("/")) continue;
			if (realFolder(target) === own) return feedFileOf(tokenFile);
		}
	} catch {
		// not JSON (OpenCode reads JSONC too): no Orrery launch's
	}
	return undefined;
}

/**
 * The TUI side: what changed in the feed since the last look, for the TUI whose pid is `tui`. `line` is the status to
 * show (undefined while there is no feed for this TUI), `fresh` the notices not shown yet.
 */
export class FeedReader {
	readonly #file: string;
	readonly #tui: number;
	#shown = 0;

	constructor(file: string, tui: number) {
		this.#file = file;
		this.#tui = tui;
	}

	look(): { readonly line?: string; readonly fresh: readonly FeedNotice[] } {
		const feed = readFeed(this.#file);
		if (feed === undefined || feed.tui !== this.#tui) return { fresh: [] };
		const fresh = feed.notices.filter((notice) => notice.n > this.#shown);
		if (fresh.length > 0) this.#shown = Math.max(...fresh.map((notice) => notice.n));
		return { line: feed.line, fresh };
	}
}
