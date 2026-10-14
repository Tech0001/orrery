/**
 * Questions during install, setup and uninstall. Under `curl … | sh` the process's stdin is the download, so questions
 * go to the terminal itself (/dev/tty). --yes answers yes; with no terminal the answer is no, and the caller lists what
 * was left (spec 2026-10-13-orrery-releases-design §5).
 */

import { closeSync, openSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ReadStream, WriteStream } from "node:tty";

export type Confirm = (what: string) => Promise<boolean>;

/** The answer typed on /dev/tty, or undefined when there is no terminal. */
async function onTerminal(question: string): Promise<string | undefined> {
	let fd: number;
	try {
		fd = openSync("/dev/tty", "r+");
	} catch {
		return undefined;
	}
	const input = new ReadStream(fd);
	const output = new WriteStream(fd);
	const rl = createInterface({ input, output });
	try {
		return await rl.question(question);
	} finally {
		rl.close();
		input.destroy();
		output.destroy();
		try {
			closeSync(fd);
		} catch {
			// closed with the streams
		}
	}
}

export function terminalConfirm(options: { yes: boolean; say: (line: string) => void }): Confirm {
	return async (what) => {
		if (options.yes) return true;
		const answer = await onTerminal(`${what} (y/N) `);
		if (answer === undefined) {
			options.say(`Skipped (no terminal to ask; rerun with --yes): ${what}`);
			return false;
		}
		return /^y(es)?$/i.test(answer.trim());
	};
}

/** True only when the person types `word` exactly. */
export async function askTyped(question: string, word: string): Promise<boolean> {
	return (await onTerminal(`${question} Type ${word} to go ahead: `))?.trim() === word;
}

/** The line to add when `bin` is not on PATH, for the person's shell; undefined when it is on PATH. */
export function pathAdvice(env: NodeJS.ProcessEnv, bin: string): string | undefined {
	const trimmed = (dir: string) => (dir.length > 1 ? dir.replace(/\/+$/, "") : dir);
	if ((env.PATH ?? "").split(delimiter).some((dir) => trimmed(dir) === trimmed(bin))) return undefined;
	const shell = (env.SHELL ?? "").split("/").at(-1);
	const file = shell === "zsh" ? "~/.zshrc" : shell === "bash" ? "~/.bashrc" : shell === "fish" ? undefined : "~/.profile";
	const local = bin === join(env.HOME ?? "", ".local", "bin");
	const shown = local ? "~/.local/bin" : bin;
	if (file === undefined) return `${shown} is not on your PATH. Add it: fish_add_path ${shown}, then open a new terminal.`;
	return `${shown} is not on your PATH. Add it: echo 'export PATH="${local ? "$HOME/.local/bin" : bin}:$PATH"' >> ${file}, then open a new terminal.`;
}
