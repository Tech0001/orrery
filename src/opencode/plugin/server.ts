/**
 * Orrery inside OpenCode (spec 2026-10-16-opencode-design): OpenCode's V2 server plugin, `export default { id, setup }`.
 * `orrery agent <Name> --tool opencode` names this plugin's folder in OPENCODE_CONFIG_CONTENT with the agent and its
 * token file as options (src/opencode/options.ts); OpenCode loads the folder's server.* file in its server process,
 * on Bun. A release packs this file as extensions/opencode/server.js (scripts/build-release.ts); a checkout's folder is
 * src/opencode/plugin, which must hold nothing else OpenCode would load (index.*, tui.*, rpc.*).
 *
 * For now it only reads its options and says on stderr that it loaded (seen with `opencode --print-logs`); recording,
 * the memory view and the guard come next. Setup never throws: a throw there fails the plugin's load.
 */

import { PLUGIN_ID, readPluginOptions } from "../options.ts";

/** The part of OpenCode's plugin context this file reads. */
interface PluginContext {
	readonly options?: unknown;
}

export default {
	id: PLUGIN_ID,
	setup(ctx: PluginContext): void {
		try {
			const options = readPluginOptions(ctx.options);
			process.stderr.write("problem" in options ? `Orrery: loaded without an agent (${options.problem}).\n` : `Orrery: loaded for ${options.agent}.\n`);
		} catch {
			// stderr is gone: nothing to say
		}
	},
};
