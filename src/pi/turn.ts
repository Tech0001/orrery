/** OptChat's fresh context per run inside pi (spec §4): the view goes into the system prompt, older turns stay out. */

export { memorySection } from "../agent/view-text.ts";

/**
 * The current run: from its first user message. A call a prompt did not start (continue, a sent message that triggers a
 * turn, a resumed session) has none at or after `runStart`; then keep from the last user message, one run at most.
 * With no user message at all the transcript is only this run's tool traffic.
 *
 * The user's `!cmd` output (pi's bashExecution messages, sent to the model as user text) sits just before the run's
 * first user message: keep those run after `since` (when the previous run ended), never older ones. A command run while
 * the agent works is queued by pi and lands after that run, but it ran before the run ended: it goes to memory only.
 */
export function trimToRun<T extends { role: string; timestamp?: number }>(messages: readonly T[], runStart: number, since = Number.POSITIVE_INFINITY): T[] {
	let start = messages.findIndex((m) => m.role === "user" && (m.timestamp ?? 0) >= runStart);
	if (start === -1) start = messages.findLastIndex((m) => m.role === "user");
	if (start === -1) return [...messages];
	while (start > 0 && messages[start - 1].role === "bashExecution" && (messages[start - 1].timestamp ?? 0) > since) start--;
	return messages.slice(start);
}

export function compactionDecision(reason: "manual" | "threshold" | "overflow"): { cancel: true } | undefined {
	return reason === "overflow" ? undefined : { cancel: true };
}
