/**
 * request.json (spec 2026-10-08-orrery-tui-design §4.3): a summary-model change for an agent pi holds, written by
 * `orrery compactor` or the TUI, taken by pi's tick. pi loads this file: node built-ins and private-file only.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "./private-file.ts";

export interface SettingsRequest {
	readonly agent: string;
	readonly kind: "compactor";
	/** "provider/id thinking", or "reset": the words Claude Code's holder takes too. */
	readonly args: string;
	readonly at: number;
}

/** A request older than this is dropped: whoever wrote it has stopped waiting. */
export const REQUEST_FRESH_MS = 15_000;

/** The agent's request file, next to its status.json. */
export const requestFile = (agentDir: string) => join(agentDir, "request.json");

/** Writes the request (0600, atomic), replacing any earlier one. */
export function writeRequest(agentDir: string, request: SettingsRequest): void {
	writePrivate(requestFile(agentDir), JSON.stringify(request));
}

/** Takes the agent's request and removes the file. `ignored` says, without repeating it, why one was dropped. */
export function takeRequest(agentDir: string, agent: string, now = Date.now()): { request?: SettingsRequest; ignored?: string } {
	let text: string;
	try {
		text = readFileSync(requestFile(agentDir), "utf8");
	} catch {
		return {};
	}
	rmSync(requestFile(agentDir), { force: true });
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { ignored: "a settings request that is not JSON" };
	}
	const r = (typeof value === "object" && value !== null ? value : {}) as Partial<SettingsRequest>;
	if (r.kind !== "compactor" || typeof r.args !== "string" || typeof r.at !== "number" || typeof r.agent !== "string") return { ignored: "a settings request Orrery does not know" };
	if (r.agent !== agent) return { ignored: "a settings request for another agent" };
	if (now - r.at > REQUEST_FRESH_MS) return { ignored: "a settings request older than 15 s" };
	return { request: { agent: r.agent, kind: r.kind, args: r.args, at: r.at } };
}
