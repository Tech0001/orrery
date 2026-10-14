/**
 * The editor for an agent's instructions (spec 2026-10-13-orrery-agents-design §5): $EDITOR, else nano, else vi, and the
 * one edit flow `orrery agent edit` and the TUI's E share. Node only.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { LaneConfig } from "./config.ts";
import { instructionsPath, instructionsTemplate, writeInstructions } from "./instructions.ts";
import type { ToolExit } from "./launch.ts";
import type { LaneRow } from "./overview.ts";
import { findOnPath } from "./tools.ts";

export function editorCommand(env: NodeJS.ProcessEnv = process.env): string {
	const named = env.EDITOR?.trim();
	if (named) return named;
	return findOnPath("nano", env) !== undefined ? "nano" : "vi";
}

/**
 * Opens `path` in the editor with this terminal. $EDITOR may carry arguments ("code --wait"), so a shell reads it, as git
 * does; the path goes in as an argument, never into the shell's text. Ctrl-C goes to the editor, not to orrery.
 */
export function runEditor(path: string, options: { env?: NodeJS.ProcessEnv; spawn?: typeof spawn } = {}): Promise<ToolExit> {
	const env = options.env ?? process.env;
	const ignore = () => {};
	process.on("SIGINT", ignore);
	return new Promise((done, fail) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = (options.spawn ?? spawn)("sh", ["-c", `${editorCommand(env)} "$1"`, "sh", path], { stdio: "inherit", env });
		} catch (error) {
			process.off("SIGINT", ignore);
			fail(error);
			return;
		}
		child.on("error", (error) => {
			process.off("SIGINT", ignore);
			fail(error);
		});
		child.on("exit", (code, signal) => {
			process.off("SIGINT", ignore);
			done({ code, signal });
		});
	});
}

/** What an edit of an agent's instructions came to (editInstructionsFile). */
export interface InstructionsEdit {
	readonly path: string;
	readonly exit: ToolExit;
	/** The editor did not end cleanly: "exited with code 1" or "was stopped (SIGTERM)". The file is as it left it. */
	readonly failed?: string;
	/** When the agent's open session reads them: pi and OMP at their next start, Claude Code at its next session. */
	readonly readsAt?: "next start" | "next session";
}

/**
 * `orrery agent edit` and the TUI's E: writes the template when the agent has no instructions file yet, gives the file to
 * `edit` (the editor), and says what came of it. `open` gives the agent's row after the edit (a session may have opened
 * meanwhile): an open session reads the new instructions only when it next starts.
 */
export async function editInstructionsFile(
	lane: Pick<LaneConfig, "name" | "dir">,
	open: () => Pick<LaneRow, "state" | "openIn" | "tool"> | undefined,
	edit: (path: string) => Promise<ToolExit>,
): Promise<InstructionsEdit> {
	const path = instructionsPath(lane.dir);
	if (!existsSync(path)) writeInstructions(lane.dir, instructionsTemplate(lane.name));
	const exit = await edit(path);
	if (exit.signal !== null) return { path, exit, failed: `was stopped (${exit.signal})` };
	if (exit.code !== 0) return { path, exit, failed: `exited with code ${exit.code}` };
	const row = open();
	if (row === undefined || row.state === "closed") return { path, exit };
	return { path, exit, readsAt: (row.openIn ?? row.tool) === "claude-code" ? "next session" : "next start" };
}
