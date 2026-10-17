/**
 * Orrery inside OpenCode (spec 2026-10-16-opencode-design): OpenCode's V2 server plugin, `export default { id, setup }`
 * (src/opencode/plugin.ts). `orrery agent <Name> --tool opencode` names this plugin's folder in OPENCODE_CONFIG_CONTENT
 * with the agent and its token file as options (src/opencode/options.ts); OpenCode loads the folder's server.* file in
 * its server process, on Bun, and its tui.* file in the TUI (tui.tsx: the footer status and the notices). A release
 * packs this file as extensions/opencode/server.js (scripts/build-release.ts); a checkout's folder is
 * src/opencode/plugin, which holds no other file OpenCode would load as an entry (index.*, rpc.*). Setup never throws:
 * a throw there fails the plugin's load.
 */

import { openCodePlugin } from "../plugin.ts";

// pi-ai imports its OAuth flows (the ChatGPT sign-in among them) by a file path that exists only in node_modules, not
// beside a packed extensions/opencode/server.js: register the flows packed with it, as omp.js does. Summaries use them.
(await import("@earendil-works/pi-ai/bun-oauth")).registerBunOAuthFlows();

export default openCodePlugin({ updates: { env: process.env } });
