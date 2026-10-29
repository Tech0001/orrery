/**
 * What Grok Build's process is called, and the hook events Orrery answers for it. Node built-ins only:
 * src/agent/sessions.ts uses it, and so does the install (src/grok/install.ts), which must not load the hooks.
 */

/** The events Orrery's Grok hooks answer, as their command line names them (pre-tool-use is the guard). */
export const GROK_HOOK_EVENTS = ["session-start", "user-prompt-submit", "pre-tool-use", "stop", "stop-cancelled", "session-end"] as const;

/**
 * Is `name` (a program's file name, without `.exe`) Grok Build's? Its npm launcher, node running the package's script
 * `bin/grok` (which counts as Grok too, a script of Grok's), starts the program as `~/.grok/bin/grok`, a link to its
 * download `grok-<os>-<arch>` (`grok-linux-x86_64` on Linux; the macOS and Windows names are not verified, so any such
 * name counts). Asked about its own host, Grok passes its npm launcher over (ownLauncher, src/agent/sessions.ts).
 */
export function isGrokProcess(name: string): boolean {
	return name === "grok" || /^grok-[a-z]+-[a-z0-9_]+$/.test(name);
}
