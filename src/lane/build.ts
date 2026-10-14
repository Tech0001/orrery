/**
 * An imported agent's memory, built in the background (spec 2026-10-13-orrery-agents-design §6, step 4): `orrery compact
 * <Name> --progress <lane folder>/build.json` runs detached, its output in build.log, and rewrites build.json every few
 * seconds; the Agents page reads it, and the agent opens once it says done. Node only.
 */

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "./private-file.ts";
import { processAlive } from "./process.ts";
import { selfCommand } from "./running.ts";

export const BUILD_FILE = "build.json";
export const BUILD_LOG = "build.log";

/**
 * A build rewrites build.json every 5 s; one not rewritten for this long has stopped, whatever its pid says (after a
 * restart another process may have that pid).
 */
export const BUILD_STALE_MS = 2 * 60_000;

export interface BuildState {
	readonly pid: number;
	readonly startedAt: number;
	readonly messages: number;
	readonly summaries: number;
	/** What the build's summaries cost so far on API keys; absent on a plan or a local model. */
	readonly dollars?: number;
	readonly done?: true;
	readonly error?: string;
	/** When build.json was last written (ms); writeBuild sets it. */
	readonly updatedAt?: number;
}

export function writeBuild(file: string, state: BuildState): void {
	writePrivate(file, `${JSON.stringify({ ...state, updatedAt: Date.now() })}\n`);
}

/** The lane's build.json, or undefined when there is none or it is not one Orrery wrote. */
export function readBuild(laneDir: string): BuildState | undefined {
	try {
		const value = JSON.parse(readFileSync(join(laneDir, BUILD_FILE), "utf8")) as Partial<BuildState> | null;
		if (value === null || typeof value !== "object" || !Number.isInteger(value.pid) || typeof value.startedAt !== "number" || typeof value.messages !== "number" || typeof value.summaries !== "number") return undefined;
		return value as BuildState;
	} catch {
		return undefined;
	}
}

/** Whether the build still runs: not done, no error, build.json rewritten lately, and its process alive. */
export function buildRunning(state: BuildState | undefined, alive: (pid: number) => boolean = processAlive, now = Date.now()): boolean {
	if (state === undefined || state.done === true || state.error !== undefined) return false;
	return now - (state.updatedAt ?? state.startedAt) < BUILD_STALE_MS && alive(state.pid);
}

/** Starts the build detached, so it outlives the TUI; returns at once. */
export function startBuild(name: string, laneDir: string, options: { configPath?: string; spawn?: typeof spawn } = {}): void {
	const file = join(laneDir, BUILD_FILE);
	const logPath = join(laneDir, BUILD_LOG);
	mkdirSync(laneDir, { recursive: true, mode: 0o700 });
	const log = openSync(logPath, "a", 0o600);
	try {
		const self = selfCommand(["compact", name, "--progress", file, ...(options.configPath === undefined ? [] : ["--config", options.configPath])]);
		const child = (options.spawn ?? spawn)(self.cmd, self.args, { detached: true, stdio: ["ignore", log, log] });
		const state: BuildState = { pid: child.pid ?? 0, startedAt: Date.now(), messages: 0, summaries: 0 };
		// It could not start (no such program, say): say so in both files, so the row names it.
		child.on("error", (error) => {
			try {
				writeFileSync(logPath, `${error.message}\n`, { flag: "a", mode: 0o600 });
				writeBuild(file, { ...state, error: error.message });
			} catch {
				// the lane folder is gone: nothing to tell
			}
		});
		writeBuild(file, state);
		child.unref();
	} finally {
		closeSync(log);
	}
}
