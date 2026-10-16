/**
 * The shell Codex runs Orrery's hooks in, and whether it prints when it starts. Codex 0.162.1 runs a command hook as
 * `<shell> -c <command>` (not a login shell; codex-rs core/src/session/mod.rs build_hooks_config), the shell being
 * (shell-command/src/shell_detect.rs default_user_shell) the account's own, from its passwd entry, when that is bash, zsh
 * or sh (its name decides) and the file is there; else that kind found on PATH; else, on Linux bash then zsh, on macOS
 * zsh then bash; else /bin/sh. $SHELL plays no part, and fish is never used.
 *
 * Such a shell reads only bash's $BASH_ENV, and zsh's .zshenv (in $ZDOTDIR, else the home folder) and /etc/zshenv.
 * Whatever they print reaches Codex ahead of the hook's answer, and Codex then cannot read it: the memory view arrives
 * as raw text inside that output, the status line never shows, every prompt adds the output to the model's context, and
 * each turn's end shows an error. The hooks still record, and a refusal still holds (exit 2, stderr). So before Codex
 * opens an agent, the shell is started the same way once, with Codex's environment, and must print nothing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, extname, join } from "node:path";
import { findOnPath } from "../agent/tools.ts";

export type ShellKind = "bash" | "zsh" | "sh" | "pwsh";

export interface HookShell {
	readonly path: string;
	readonly kind: ShellKind;
}

/** A shell's kind by its name, as Codex reads it: the whole path, else its file name without an extension. */
function kindOf(path: string): ShellKind | undefined {
	const named: Record<string, ShellKind> = { bash: "bash", zsh: "zsh", sh: "sh", pwsh: "pwsh", powershell: "pwsh" };
	const whole = named[path];
	if (whole !== undefined) return whole;
	const stem = basename(path, extname(path));
	return stem !== path ? named[stem] : undefined;
}

const isFile = (path: string) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

const FALLBACKS: Record<ShellKind, readonly string[]> = { bash: ["/bin/bash", "/usr/bin/bash"], zsh: ["/bin/zsh"], sh: ["/bin/sh"], pwsh: ["/usr/local/bin/pwsh"] };

/** The shell of `kind`: the account's when it is that kind and there, else the first on PATH, else a usual place. */
function shellOf(kind: ShellKind, account: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
	if (account !== undefined && kindOf(account) === kind && isFile(account)) return account;
	const onPath = kind === "pwsh" ? (findOnPath("pwsh", env) ?? findOnPath("powershell", env)) : findOnPath(kind, env);
	return onPath ?? FALLBACKS[kind].find(isFile);
}

/** The account's shell from its passwd entry, or undefined when there is none to read. */
export function accountShell(): string | undefined {
	try {
		return userInfo().shell ?? undefined;
	} catch {
		return undefined;
	}
}

/** The shell Codex runs hooks in, picked as Codex picks it (module doc). `env`: Codex's environment (its PATH). */
export function hookShell(env: NodeJS.ProcessEnv, options: { readonly account?: string; readonly platform?: NodeJS.Platform } = {}): HookShell {
	const account = "account" in options ? options.account : accountShell();
	const kind = account === undefined ? undefined : kindOf(account);
	const own = kind === undefined ? undefined : shellOf(kind, account, env);
	if (own !== undefined && kind !== undefined) return { path: own, kind };
	const order: ShellKind[] = (options.platform ?? process.platform) === "darwin" ? ["zsh", "bash"] : ["bash", "zsh"];
	for (const fallback of order) {
		const path = shellOf(fallback, account, env);
		if (path !== undefined) return { path, kind: fallback };
	}
	return { path: "/bin/sh", kind: "sh" };
}

/** Where the output most likely comes from, for the person to look. */
function likelySource(shell: HookShell, env: NodeJS.ProcessEnv): string {
	if (shell.kind === "bash") return env.BASH_ENV ? `$BASH_ENV (${env.BASH_ENV})` : "bash's startup";
	if (shell.kind === "zsh") {
		const own = join(env.ZDOTDIR || env.HOME || homedir(), ".zshenv");
		if (existsSync(own)) return own;
		const system = ["/etc/zshenv", "/etc/zsh/zshenv"].find((path) => existsSync(path));
		return system ?? `${env.ZDOTDIR ? "$ZDOTDIR" : "~"}/.zshenv`;
	}
	return "the shell's startup";
}

export type ShellCheck = { readonly quiet: true } | { readonly quiet: false; readonly shell: HookShell; readonly source: string };

/** The longest the shell may take to start (a slow one is let be: its hooks only take longer). */
const SHELL_MS = 5_000;

/** The most output the check keeps: more than this is printing, whatever it is. */
const SHELL_OUTPUT_MAX = 1024 * 1024;

/**
 * Starts the hooks' shell as Codex starts a hook (`-c`, Codex's environment, in the session's folder) with a command
 * that prints nothing, and says whether anything but blank space came out, or more than SHELL_OUTPUT_MAX of anything.
 * Its input is no socket, as Codex's pipe is none: bash given a socket for input takes itself for a remote shell and
 * reads ~/.bashrc in place of $BASH_ENV (Node's own pipes are sockets). PowerShell is run with -NoProfile, which reads
 * nothing. A shell still running after `timeoutMs` (default 5 s) is killed with SIGKILL, which a startup file cannot
 * trap, and judged by what it printed by then. A shell that cannot start, or prints nothing before its time runs out,
 * counts as quiet: the check never stands in the way of what it cannot see.
 */
export function checkHookShell(env: NodeJS.ProcessEnv, cwd: string, options: { readonly shell?: HookShell; readonly timeoutMs?: number } = {}): ShellCheck {
	const shell = options.shell ?? hookShell(env);
	if (shell.kind === "pwsh") return { quiet: true };
	const run = spawnSync(shell.path, ["-c", ":"], {
		env,
		cwd: existsSync(cwd) ? cwd : homedir(),
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		timeout: options.timeoutMs ?? SHELL_MS,
		killSignal: "SIGKILL",
		maxBuffer: SHELL_OUTPUT_MAX,
	});
	const flooded = (run.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS";
	if (!flooded && (run.stdout ?? "").trim() === "") return { quiet: true };
	return { quiet: false, shell, source: likelySource(shell, env) };
}

/** What the person is told when the shell prints (default no to starting all the same). */
export function noisyShellText(name: string, check: Extract<ShellCheck, { quiet: false }>): string {
	return `Codex runs Orrery's hooks through ${check.shell.path} -c, which prints when it starts (most likely from ${check.source}). Codex then can't read the hooks' answers, so ${name}'s memory won't load and its status won't show until that shell prints nothing when it isn't interactive; its turns are still recorded and the guard still works.`;
}

/** The question after noisyShellText. */
export const NOISY_SHELL_QUESTION = "Start Codex anyway?";
