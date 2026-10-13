/**
 * The notice the user gets when a lane's summaries start failing, stop, or recover: once per change. Pure and
 * dependency-free, because Claude Code's hooks import it (they must not load model providers).
 */

export interface TroubleState {
	readonly state: "stopped" | "failing";
	readonly plain: string;
}

/**
 * What a notice was last given for: "ok", "failing" or "stopped". The state alone: each failed retry replaces the reason
 * (often with a new request id), and the user hears once per change of state, not once per retry (spec §4.5).
 */
export function noticeKey(trouble: TroubleState | null | undefined): string {
	return trouble ? trouble.state : "ok";
}

/** The notice for a change from `previousKey` (undefined: nothing known yet), or undefined when there is none. */
export function noticeText(lane: string, trouble: TroubleState | null | undefined, previousKey: string | undefined, command: string): string | undefined {
	if (noticeKey(trouble) === previousKey) return undefined;
	if (trouble) {
		return trouble.state === "failing"
			? `Orrery: ${lane}'s summaries are failing: ${trouble.plain}. They keep retrying; nothing is lost. Switch with ${command}.`
			: `Orrery: ${lane}'s summaries stopped: ${trouble.plain}. Switch with ${command}.`;
	}
	return previousKey === undefined ? undefined : `Orrery: ${lane}'s summaries are working again.`;
}
