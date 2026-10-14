/**
 * Summary-trouble notices for Claude Code's hooks: read from the agent's status.json (written in plain words by the
 * holder), shown once per change per session through a hook's systemMessage, which reaches the user, not the model.
 * Imports no model provider: hooks run several times a turn.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../agent/config.ts";
import { noticeKey, noticeText, type TroubleState } from "../agent/notices.ts";
import { writePrivate } from "../agent/private-file.ts";

function readTrouble(agentDir: string): { trouble: TroubleState | null } | undefined {
	try {
		const status = JSON.parse(readFileSync(join(agentDir, "status.json"), "utf8")) as { trouble?: unknown };
		const t = status.trouble as Partial<TroubleState> | null | undefined;
		if (t === null || t === undefined) return { trouble: null };
		if ((t.state === "failing" || t.state === "stopped") && typeof t.plain === "string") return { trouble: { state: t.state, plain: t.plain } };
		return { trouble: null };
	} catch {
		return undefined;
	}
}

/** The notice for `session`, if the agent's summary state changed since that session last heard. Remembers what it said. */
export function summaryNotice(agent: AgentConfig, session: string): string | undefined {
	const status = readTrouble(agent.dir);
	if (status === undefined) return undefined;
	const file = join(agent.dir, "claude", "notice.json");
	let previous: string | undefined;
	try {
		const saved = JSON.parse(readFileSync(file, "utf8")) as { session?: unknown; key?: unknown };
		if (saved.session === session && typeof saved.key === "string") previous = saved.key;
	} catch {
		previous = undefined;
	}
	const key = noticeKey(status.trouble);
	const message = noticeText(agent.name, status.trouble, previous, "/orrery:compactor");
	if (key !== previous) writePrivate(file, JSON.stringify({ session, key }));
	return message;
}
