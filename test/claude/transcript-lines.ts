/**
 * Claude Code transcript lines, in the shapes Claude Code 2.1.302 writes them (field names from a real run; the words are
 * made up). For the transcript check's tests (src/claude/transcript.ts).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const base = (extra: object) => ({ parentUuid: null, isSidechain: false, cwd: "/w", sessionId: "s1", version: "2.1.302", uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), ...extra });

export const line = {
	/** An interactive prompt the user typed. */
	typed: (promptId: string, text: string, extra: object = {}) =>
		JSON.stringify(base({ type: "user", message: { role: "user", content: text }, promptId, promptSource: "typed", turnOrigin: "human", origin: { kind: "human" }, ...extra })),
	/** A `claude -p` prompt: promptSource sdk, no origin. */
	sdk: (promptId: string, text: string) => JSON.stringify(base({ type: "user", message: { role: "user", content: text }, promptId, promptSource: "sdk", turnOrigin: "sdk" })),
	/** A tool's result: a user line under the turn's promptId too. */
	toolResult: (promptId: string) =>
		JSON.stringify(base({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }] }, promptId, toolUseResult: { stdout: "done" }, sourceToolAssistantUUID: "a-1" })),
	/** A message sent to the session's inbox by a peer (the shell's own socket, or a subagent's report). */
	peer: (text: string) => line.queued(text, { kind: "peer", from: "unknown", verifiedPeerPid: 4242, verifiedPeerProcStart: "1" }),
	/** A queued command attachment with `origin`. */
	queued: (text: string, origin: object | undefined) =>
		JSON.stringify(base({ type: "attachment", attachment: { type: "queued_command", prompt: text, commandMode: "prompt", ...(origin === undefined ? {} : { origin }), isMeta: true } })),
};

/** A transcript file under a scratch Claude Code config folder, as CLAUDE_CONFIG_DIR names it. */
export interface Transcript {
	/** The CLAUDE_CONFIG_DIR to give the hooks. */
	readonly configDir: string;
	readonly projects: string;
	/** The session's transcript file (not made until a line is added). */
	path(session: string): string;
	/** Appends lines to the session's transcript, as Claude Code does. */
	add(session: string, ...lines: string[]): void;
}

export function transcriptIn(dir: string): Transcript {
	const configDir = join(dir, "claude-config");
	const projects = join(configDir, "projects");
	const path = (session: string) => join(projects, "-w", `${session}.jsonl`);
	return {
		configDir,
		projects,
		path,
		add: (session, ...lines) => {
			mkdirSync(dirname(path(session)), { recursive: true, mode: 0o700 });
			appendFileSync(path(session), lines.map((l) => `${l}\n`).join(""), { mode: 0o600 });
		},
	};
}
