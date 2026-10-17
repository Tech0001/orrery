import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SignalTarget } from "../../src/agent/signal-cleanup.ts";
import { pruneTokenFiles, removeOnSignals, tokenFilePath, writeTokenFile } from "../../src/opencode/token-file.ts";
import { tempDir } from "../agent/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
	const dir = tempDir("orrery-token-file-");
	dirs.push(dir);
	return dir;
};
const TOKEN = "0123456789abcdef0123456789abcdef";

describe("the OpenCode token file", () => {
	it("lives in Orrery's home, in a 0700 folder, named by this process; written 0600 with the token alone", () => {
		const home = join(scratch(), "orrery-home");
		const file = tokenFilePath({ ORRERY_HOME: home });
		expect(dirname(file)).toBe(join(home, "tokens"));
		expect(basename(file)).toMatch(new RegExp(`^opencode-${process.pid}-[0-9a-f]{12}$`));
		expect(tokenFilePath({ ORRERY_HOME: home })).not.toBe(file);
		writeTokenFile(file, TOKEN);
		expect(readFileSync(file, "utf8")).toBe(TOKEN);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
	});

	it("is never written through a link put in the folder's place", () => {
		const dir = scratch();
		mkdirSync(join(dir, "elsewhere"));
		symlinkSync(join(dir, "elsewhere"), join(dir, "tokens"));
		expect(() => writeTokenFile(join(dir, "tokens", "opencode-1-aaaaaaaaaaaa"), TOKEN)).toThrow("is not a real folder of this user's");
		expect(readdirSync(join(dir, "elsewhere"))).toEqual([]);
	});

	it("prunes nothing through a link put in the folder's place: files there named like a gone launcher's stay", () => {
		const dir = scratch();
		const elsewhere = join(dir, "elsewhere");
		mkdirSync(elsewhere);
		// A pid no process has: its file would be pruned in a real tokens folder.
		const theirs = "opencode-999999999-aaaaaaaaaaaa";
		writeFileSync(join(elsewhere, theirs), "theirs");
		symlinkSync(elsewhere, join(dir, "tokens"));
		expect(() => writeTokenFile(join(dir, "tokens", `opencode-${process.pid}-bbbbbbbbbbbb`), TOKEN)).toThrow("is not a real folder of this user's");
		pruneTokenFiles(join(dir, "tokens"), () => false);
		expect(readdirSync(elsewhere)).toEqual([theirs]);
	});

	it("takes out the files of launchers that are gone, and nothing else", () => {
		const folder = join(scratch(), "tokens");
		mkdirSync(folder);
		for (const name of ["opencode-111-aaaaaaaaaaaa", "opencode-222-bbbbbbbbbbbb", "notes.txt", "opencode-333-short"]) writeFileSync(join(folder, name), "x");
		pruneTokenFiles(folder, (pid) => pid === 222);
		expect(readdirSync(folder).sort()).toEqual(["notes.txt", "opencode-222-bbbbbbbbbbbb", "opencode-333-short"]);
		pruneTokenFiles(join(folder, "none")); // a folder that is not there: nothing to do
	});
});

/** A process stand-in: listeners as Node keeps them, kill recorded. */
function fakeProcess() {
	const emitter = new EventEmitter();
	const killed: string[] = [];
	const target = Object.assign(emitter, { pid: 4242, kill: (_pid: number, signal?: string | number) => (killed.push(String(signal)), true) }) as unknown as SignalTarget & EventEmitter;
	return { target, killed };
}

describe("removeOnSignals", () => {
	it("removes the file on SIGTERM or SIGHUP and then stops the process by the signal, as Node would without a handler", () => {
		for (const signal of ["SIGTERM", "SIGHUP"] as const) {
			const file = join(scratch(), "token");
			writeFileSync(file, TOKEN);
			const { target, killed } = fakeProcess();
			removeOnSignals(file, target);
			target.emit(signal);
			expect(existsSync(file)).toBe(false);
			expect(killed).toEqual([signal]);
			expect(target.listenerCount(signal)).toBe(0);
		}
	});

	it("runs before a handler already there (the TUI's restores the terminal and exits), and leaves the stopping to it", () => {
		const file = join(scratch(), "token");
		writeFileSync(file, TOKEN);
		const { target, killed } = fakeProcess();
		const seen: boolean[] = [];
		target.on("SIGTERM", () => seen.push(existsSync(file)));
		removeOnSignals(file, target);
		target.emit("SIGTERM");
		expect(seen).toEqual([false]);
		expect(killed).toEqual([]);
	});

	it("removes the file when the process exits, and its undo takes every handler away", () => {
		const file = join(scratch(), "token");
		writeFileSync(file, TOKEN);
		const { target } = fakeProcess();
		const undo = removeOnSignals(file, target);
		target.emit("exit");
		expect(existsSync(file)).toBe(false);
		undo();
		for (const name of ["SIGTERM", "SIGHUP", "exit"]) expect(target.listenerCount(name)).toBe(0);
	});
});
