/**
 * What `orrery agent <Name> --tool opencode` runs (spec 2026-10-16-opencode-design, "Launch"): `opencode --standalone
 * <folder> [the person's arguments]`, with OPENCODE_CONFIG_CONTENT naming Orrery's plugin folder, the agent and its
 * token file (src/opencode/options.ts). --standalone gives the session a private server, a child of the TUI with the
 * TUI's environment; without it the TUI talks to OpenCode's shared background service, which never sees a launch's
 * config: no memory, no guard, and no word about it. Nothing is written to OpenCode's own config. A version of OpenCode
 * this Orrery has not seen is checked first (src/opencode/check.ts).
 */

import { resolve } from "node:path";
import { wiringRoot } from "../agent/running.ts";
import { endsWithSegments, ENTRY_TAILS, entries } from "../install/layout.ts";

/** OpenCode 2.0.30's subcommands that open a session and take --standalone of their own: it goes after their name. */
const SESSION_SUBCOMMANDS: ReadonlySet<string> = new Set(["run", "mini"]);

/** Its other subcommands (`opencode --help`): none opens a session Orrery could record, and acp would use the shared service. */
const OTHER_SUBCOMMANDS: ReadonlySet<string> = new Set(["upgrade", "update", "uninstall", "acp", "api", "debug", "auth", "mcp", "plugin", "models", "stats", "session", "service", "reload", "pair", "serve"]);

/** Orrery's plugin folder for OpenCode under `root` (default: what wiring names, app/current for an install). */
export function pluginFolder(env: NodeJS.ProcessEnv = process.env, root: string = wiringRoot(env).root): string {
	return entries(root).opencode;
}

/**
 * Whether the OPENCODE_CONFIG_CONTENT in `env` names an Orrery plugin folder: an orrery started from the shell of an
 * OpenCode that Orrery opened inherits that session's. Plain OpenCode must not take it along (withoutOrrery).
 */
export function inheritsOrreryPlugin(env: NodeJS.ProcessEnv): boolean {
	const content = env.OPENCODE_CONFIG_CONTENT;
	if (content === undefined || content === "") return false;
	try {
		const plugins = (JSON.parse(content) as { plugins?: unknown } | null)?.plugins;
		if (!Array.isArray(plugins)) return false;
		return plugins.some((entry: unknown) => {
			const target = typeof entry === "string" ? entry : (entry as { package?: unknown } | null)?.package;
			return typeof target === "string" && ENTRY_TAILS.opencode.some((tail) => endsWithSegments(resolve(target), tail));
		});
	} catch {
		return false; // not JSON (OpenCode also reads JSONC): the person's own
	}
}

/**
 * OpenCode's arguments: --standalone and the folder before the person's arguments, or --standalone right after a
 * session subcommand they start with (`run …`, `mini`), which opens in the folder it starts in.
 */
export function opencodeArgs(folder: string, args: readonly string[]): string[] {
	const [first, ...rest] = args;
	if (first !== undefined && SESSION_SUBCOMMANDS.has(first)) return [first, "--standalone", ...rest];
	return ["--standalone", folder, ...args];
}

/**
 * Why the person's arguments can't open `name` in OpenCode with Orrery, or undefined: --server (another server, which
 * never loads this launch's plugin) or a subcommand that opens no session of its own. Refused, never guessed at.
 */
export function argsRefusal(name: string, args: readonly string[]): string | undefined {
	for (const word of args) {
		if (word === "--") break;
		if (word === "--server" || word.startsWith("--server=")) return `OpenCode's --server connects to another server, which doesn't load Orrery's plugin (no memory, no guard): open ${name} without it.`;
	}
	const first = args[0];
	if (first !== undefined && OTHER_SUBCOMMANDS.has(first)) return `opencode ${first} opens no session for ${name}: run it as plain opencode, or open ${name} in OpenCode's TUI, run or mini.`;
	return undefined;
}
