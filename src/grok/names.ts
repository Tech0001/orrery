/**
 * What Grok Build's process is called, the hook events Orrery answers for it, and how its command line reads (its
 * options that take a value, its commands). Node built-ins only: src/agent/sessions.ts uses it, and so does the install
 * (src/grok/install.ts), which must not load the hooks.
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

/**
 * Grok 1.0.70's options that take a value (`grok --help`): the word after one is its value, never a command. The optional
 * values of --resume and --worktree are not among them, so a command after either is still read as one.
 */
export const GROK_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	...["--add-dir", "--agent", "--agents", "--allow", "--allowedTools", "--allowed-tools", "--cwd", "--debug-file", "--deny", "--disallowedTools", "--disallowed-tools"],
	...["--json-schema", "--leader-socket", "-m", "--model", "--output-format", "-p", "--single", "--permission-mode", "--prompt-file", "--prompt-json"],
	...["--reasoning-effort", "--effort", "--rules", "--append-system-prompt", "-s", "--session-id", "--sandbox", "--system-prompt-override", "--system-prompt"],
	...["--tools", "--worktree-ref", "--ref"],
]);

/** Grok 1.0.70's commands (`grok --help`): Grok takes its first word that is one as its command, any other as its prompt. */
export const GROK_COMMANDS: ReadonlySet<string> = new Set([
	...["agent", "clone", "completions", "dashboard", "doctor", "du", "disk-usage", "export", "help", "inspect", "leader", "login", "logout", "mcp"],
	...["memory", "models", "plugin", "sessions", "setup", "trace", "update", "usage", "version", "v", "worker", "worktree", "wrap"],
]);
