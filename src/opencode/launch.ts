/**
 * What `orrery agent <Name> --tool opencode` runs (spec 2026-10-16-opencode-design, "Launch"): `opencode --standalone
 * <folder> [the person's arguments]`, with OPENCODE_CONFIG_CONTENT naming Orrery's plugin folder, the agent and its
 * token file (src/opencode/options.ts). --standalone gives the session a private server, a child of the TUI with the
 * TUI's environment; without it the TUI talks to OpenCode's shared background service, which never sees a launch's
 * config: no memory, no guard, and no word about it. Nothing is written to OpenCode's own config. A version of OpenCode
 * this Orrery has not seen is checked first (src/opencode/check.ts).
 */

import { wiringRoot } from "../agent/running.ts";
import { entries, namesOrreryPlugin } from "../install/layout.ts";

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
			return typeof target === "string" && namesOrreryPlugin(target);
		});
	} catch {
		return false; // not JSON (OpenCode also reads JSONC): the person's own
	}
}

/**
 * OPENCODE_CONFIG_CONTENT for a launch (spec 2026-10-16-opencode-design, "Launch"): the person's own (`theirs`, JSON or
 * JSONC, as OpenCode reads it) kept, with Orrery's plugin entry (`ours`, configContent) after their own plugins, and any
 * entry naming an Orrery plugin folder (inherited from the shell of a session Orrery opened) dropped first. When theirs
 * can't be read or merged (no JSON or JSONC, no object, "plugins" no list), Orrery's alone, and `unread` says why.
 */
export function launchConfigContent(theirs: string | undefined, ours: string): { readonly content: string; readonly unread?: string } {
	if (theirs === undefined || theirs.trim() === "") return { content: ours };
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsoncAsJson(theirs));
	} catch (error) {
		return { content: ours, unread: `isn't JSON or JSONC (${error instanceof Error ? error.message : String(error)})` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { content: ours, unread: "isn't a JSON object" };
	const config = parsed as Record<string, unknown>;
	const plugins = config.plugins ?? [];
	if (!Array.isArray(plugins)) return { content: ours, unread: '"plugins" isn\'t a list' };
	const kept = plugins.filter((entry: unknown) => {
		const target = typeof entry === "string" ? entry : (entry as { package?: unknown } | null)?.package;
		return !(typeof target === "string" && namesOrreryPlugin(target));
	});
	const own = (JSON.parse(ours) as { plugins: unknown[] }).plugins;
	return { content: JSON.stringify({ ...config, plugins: [...kept, ...own] }) };
}

/**
 * JSONC as JSON, as OpenCode reads its config (jsonc-parser: comments and trailing commas allowed): a byte-order mark,
 * "//" and "/* … *\/" comments outside strings, and a comma before "}" or "]", gone. Throws on a comment that never ends.
 */
function jsoncAsJson(text: string): string {
	const source = text.replace(/^\uFEFF/, "");
	let bare = "";
	for (let at = 0; at < source.length; at++) {
		const char = source.charAt(at);
		if (char === '"') {
			let end = at + 1;
			while (end < source.length && source.charAt(end) !== '"') end += source.charAt(end) === "\\" ? 2 : 1;
			bare += source.slice(at, end + 1);
			at = end;
		} else if (char === "/" && source.charAt(at + 1) === "/") {
			const end = source.indexOf("\n", at);
			at = end === -1 ? source.length : end - 1;
		} else if (char === "/" && source.charAt(at + 1) === "*") {
			const end = source.indexOf("*/", at + 2);
			if (end === -1) throw new SyntaxError("a comment that never ends");
			bare += " ";
			at = end + 1;
		} else bare += char;
	}
	// Trailing commas, outside strings.
	let json = "";
	for (let at = 0; at < bare.length; at++) {
		const char = bare.charAt(at);
		if (char === '"') {
			let end = at + 1;
			while (end < bare.length && bare.charAt(end) !== '"') end += bare.charAt(end) === "\\" ? 2 : 1;
			json += bare.slice(at, end + 1);
			at = end;
		} else if (char === "," && /^\s*[}\]]/.test(bare.slice(at + 1))) {
			continue;
		} else json += char;
	}
	return json;
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
