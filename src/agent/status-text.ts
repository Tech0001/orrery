/**
 * The status line a coding tool's session shows for its agent: `Orrery · <Name> · <count> msgs · <state>`, as Claude
 * Code's and Codex's SessionStart say it, Grok's SessionStart and its status row (src/grok/status.ts). No imports: the
 * Claude Code plugin's hooks load it.
 */

/** Whether the session is recorded, and if not, why: what follows the count. */
export type StatusState = "recording" | "not recording yet" | { readonly readOnly: string } | { readonly notRecording: string };

/** A session that reads its agent's memory but isn't recorded into it (SessionStart's word for every such case). */
export const NOT_RECORDED: StatusState = { readOnly: "this session is not recorded" };

/** The status line: the agent, its message count (none yet: "no memory yet"), the state, then `extra`, each after a dot. */
export function statusText(input: { readonly name: string; readonly count: number | undefined; readonly state: StatusState; readonly extra?: readonly string[] }): string {
	const { state } = input;
	const said = typeof state === "string" ? state : "readOnly" in state ? `read-only: ${state.readOnly}` : `not recording: ${state.notRecording}`;
	return ["Orrery", input.name, input.count === undefined ? "no memory yet" : `${input.count} msgs`, said, ...(input.extra ?? [])].join(" · ");
}
