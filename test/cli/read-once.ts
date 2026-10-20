/**
 * A config that can be read once (src/cli/gate.ts reads it once, so it can't change between the gate and the command):
 * a FIFO, each of whose reads takes what one writer gives it.
 * The first read is the gate's; a command that read the file again would get another config.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type ConfigFile, readConfigFile } from "../../src/agent/config.ts";

/** Whether this system makes FIFOs (mkfifo is a POSIX tool). */
export const fifos = spawnSync("mkfifo", ["--version"]).error === undefined;

const writers: ChildProcess[] = [];
let made = 0;

/** Stops the writers no read took (afterEach). */
export function stopWriters(): void {
	for (const writer of writers.splice(0)) writer.kill("SIGKILL");
}

/**
 * A writer that gives `text` to the next read of the FIFO `path`. With `marks`, it makes `ready` just before it opens
 * the FIFO, and `done` once a read took the text.
 */
function writer(path: string, text: string, marks?: { readonly ready: string; readonly done: string }): ChildProcess {
	const script = marks === undefined ? 'printf "%s" "$CONFIG" > "$0"' : ': > "$1"; printf "%s" "$CONFIG" > "$0" && : > "$2"';
	const child = spawn("sh", ["-c", script, path, ...(marks === undefined ? [] : [marks.ready, marks.done])], { env: { PATH: process.env.PATH, CONFIG: text }, stdio: "ignore" });
	writers.push(child);
	return child;
}

/**
 * Makes a FIFO at `path` and reads `first` from it as the gate does in a coding tool's session (readConfigFile, checked:
 * `file`); then the next read of `path` gets `second`. `readAgain()` says whether one did, and stops that writer.
 * Nothing reads it in between.
 */
export async function readOnce(path: string, first: string, second: string): Promise<{ readonly file: ConfigFile; readAgain(): Promise<boolean> }> {
	if (spawnSync("mkfifo", [path]).status !== 0) throw new Error(`mkfifo ${path} failed`);
	const one = writer(path, first);
	const file = { ...readConfigFile(path), checked: true };
	if (one.exitCode === null) await once(one, "exit");
	const tag = `${path}.${++made}`;
	const marks = { ready: `${tag}.ready`, done: `${tag}.read-again` };
	const two = writer(path, second, marks);
	for (let waited = 0; !existsSync(marks.ready); waited += 5) {
		if (waited > 10_000) throw new Error("the second writer never started");
		await sleep(5);
	}
	return {
		file,
		async readAgain() {
			// A read takes the second config at once, and its writer then makes the mark.
			if (two.exitCode === null) await Promise.race([once(two, "exit"), sleep(300)]);
			two.kill("SIGKILL");
			return existsSync(marks.done);
		},
	};
}

/** Starts a writer that gives `text` to one read of the FIFO `path` (made here), for a command run in another process. */
export function readableOnce(path: string, text: string): void {
	if (spawnSync("mkfifo", [path]).status !== 0) throw new Error(`mkfifo ${path} failed`);
	writer(path, text);
}

/**
 * A stand-in coding tool in `dir`: a script named claude that runs its arguments as its child and waits, as a coding
 * tool runs a command (Linux names a script's process after the script; macOS's ps shows it as sh running it). A command
 * run under it is in a coding tool's session, whatever runs these tests.
 */
export function standInTool(dir: string): string {
	const program = join(dir, "tool-bin", "claude");
	mkdirSync(dirname(program), { recursive: true });
	writeFileSync(program, '#!/bin/sh\n"$@"\nexit $?\n', { mode: 0o755 });
	return program;
}
