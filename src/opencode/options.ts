/**
 * What `orrery agent <Name> --tool opencode` hands Orrery's OpenCode plugin (spec 2026-10-16-opencode-design,
 * "Launch"): the plugin's entry in OPENCODE_CONFIG_CONTENT, `{"plugins":[{"package":<plugin folder>,"options":{"agent",
 * "tokenFile"}}]}`, which OpenCode 2.0.30 gives the plugin as `ctx.options`. The agent's token itself is never in it:
 * the config content reaches the model's shell and MCP servers through the environment, so it carries only the path
 * of a file only this user can read (src/opencode/token-file.ts). Node built-ins only: the plugin packs this file.
 */

import { isAbsolute } from "node:path";

/** The plugin's id, as OpenCode lists it (GET /api/plugin). */
export const PLUGIN_ID = "orrery";

/** The plugin's options. */
export interface PluginOptions {
	/** The agent's name, as the config spells it. */
	readonly agent: string;
	/** The absolute path of the file holding the agent's launch token (32 lowercase hex digits). */
	readonly tokenFile: string;
}

/** OPENCODE_CONFIG_CONTENT for a launch: Orrery's plugin folder (absolute; OpenCode reads a relative one from the session's folder) and its options. */
export function configContent(pluginFolder: string, options: PluginOptions): string {
	return JSON.stringify({ plugins: [{ package: pluginFolder, options: { agent: options.agent, tokenFile: options.tokenFile } }] });
}

/** The options as the plugin got them, or what is wrong with them. Never throws: a plugin whose setup throws fails to load. */
export function readPluginOptions(given: unknown): PluginOptions | { readonly problem: string } {
	const { agent, tokenFile } = (given ?? {}) as { agent?: unknown; tokenFile?: unknown };
	if (typeof agent !== "string" || agent.trim() === "") return { problem: "no agent named in the plugin's options" };
	if (typeof tokenFile !== "string" || !isAbsolute(tokenFile)) return { problem: "no token file named in the plugin's options" };
	return { agent, tokenFile };
}
