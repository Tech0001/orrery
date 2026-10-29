/** What Grok Build's process is called. Node built-ins only: src/agent/sessions.ts uses it. */

/**
 * Is `name` (a program's file name, without `.exe`) Grok Build's? Its npm shim starts the real program from a download
 * folder, where it is `grok-<os>-<arch>` (`grok-linux-x86_64` on Linux; the macOS and Windows names are not verified,
 * so any such name counts). The shim itself is `node`, which is no coding tool.
 */
export function isGrokProcess(name: string): boolean {
	return name === "grok" || /^grok-[a-z]+-[a-z0-9_]+$/.test(name);
}
