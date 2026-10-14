/**
 * Questions during install, setup and uninstall. Under `curl … | sh` the process's stdin is the download, so questions
 * go to the terminal itself (/dev/tty). --yes answers yes; with no terminal the answer is no, and the caller lists what
 * was left (spec 2026-10-13-orrery-releases-design §5).
 *
 * A question is plain synchronous writes and reads on one /dev/tty descriptor, closed once. Stream wrappers closed the
 * descriptor again on their own schedule (Bun), which could close a file opened after the question, or kept terminal
 * descriptors open (Node). The terminal stays in its own line mode, so it echoes and edits the answer itself. Ctrl-D
 * (end of input) or a failed read is no; Ctrl-C keeps its default and stops the process.
 */

import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { delimiter, join } from "node:path";

export type Confirm = (what: string) => Promise<boolean>;

/** Longest answer kept; the rest of a longer line is read and dropped. */
const MAX_ANSWER = 1024;

/** The line typed on /dev/tty after `question`: undefined when there is no terminal, "" at end of input or on an error. */
function onTerminal(question: string): string | undefined {
	let fd: number;
	try {
		fd = openSync("/dev/tty", "r+");
	} catch {
		return undefined; // ENXIO: no controlling terminal
	}
	try {
		writeSync(fd, question);
		const bytes: number[] = [];
		const one = Buffer.alloc(1);
		for (;;) {
			if (readSync(fd, one, 0, 1, null) === 0) {
				writeSync(fd, "\n"); // Ctrl-D echoes no newline; what follows starts on its own line
				return ""; // end of input: no
			}
			if (one[0] === 0x0a) break;
			if (bytes.length < MAX_ANSWER) bytes.push(one[0] as number);
		}
		return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
	} catch {
		return ""; // a failed write or read: no
	} finally {
		try {
			closeSync(fd);
		} catch {
			// nothing more to do with it
		}
	}
}

export function terminalConfirm(options: { yes: boolean; say: (line: string) => void }): Confirm {
	return async (what) => {
		if (options.yes) return true;
		const answer = onTerminal(`${what} (y/N) `);
		if (answer === undefined) {
			options.say(`Skipped (no terminal to ask; rerun with --yes): ${what}`);
			return false;
		}
		return /^y(es)?$/i.test(answer.trim());
	};
}

/** True only when the person types `word` exactly; "no terminal" when there is none to ask. */
export async function askTyped(question: string, word: string): Promise<boolean | "no terminal"> {
	const answer = onTerminal(`${question} Type ${word} to go ahead: `);
	return answer === undefined ? "no terminal" : answer.trim() === word;
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
