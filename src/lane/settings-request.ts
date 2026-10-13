/**
 * request.json (spec 2026-10-08-orrery-tui-design §4.3): a summary-model change for a lane pi holds, written by
 * `orrery compactor` or the TUI, taken by pi's tick. pi loads this file: node built-ins and private-file only.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "./private-file.ts";

export interface SettingsRequest {
	readonly lane: string;
	readonly kind: "compactor";
	/** "provider/id thinking", or "reset": the words Claude Code's holder takes too. */
	readonly args: string;
	readonly at: number;
}

/** A request older than this is dropped: whoever wrote it has stopped waiting. */
export const REQUEST_FRESH_MS = 15_000;

/** The lane's request file, next to its status.json. */
export const requestFile = (laneDir: string) => join(laneDir, "request.json");

/** Writes the request (0600, atomic), replacing any earlier one. */
export function writeRequest(laneDir: string, request: SettingsRequest): void {
	writePrivate(requestFile(laneDir), JSON.stringify(request));
}

/** Takes the lane's request and removes the file. `ignored` says, without repeating it, why one was dropped. */
export function takeRequest(laneDir: string, lane: string, now = Date.now()): { request?: SettingsRequest; ignored?: string } {
	let text: string;
	try {
		text = readFileSync(requestFile(laneDir), "utf8");
	} catch {
		return {};
	}
	rmSync(requestFile(laneDir), { force: true });
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { ignored: "a settings request that is not JSON" };
	}
	const r = (typeof value === "object" && value !== null ? value : {}) as Partial<SettingsRequest>;
	if (r.kind !== "compactor" || typeof r.args !== "string" || typeof r.at !== "number" || typeof r.lane !== "string") return { ignored: "a settings request Orrery does not know" };
	if (r.lane !== lane) return { ignored: "a settings request for another lane" };
	if (now - r.at > REQUEST_FRESH_MS) return { ignored: "a settings request older than 15 s" };
	return { request: { lane: r.lane, kind: r.kind, args: r.args, at: r.at } };
}
