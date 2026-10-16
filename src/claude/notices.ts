/**
 * Notices for Claude Code's and Codex's hooks, shown once per change per session through a hook's systemMessage, which
 * reaches the user, not the model:
 * - summary trouble, read from the agent's status.json (written in plain words by the holder);
 * - updates (spec 2026-10-15-update-notices): a newer release, from the daily check's cache, and an Orrery updated under
 *   the session, whose recorder (holder.json) runs another build than the installed one. Read from files only: the
 *   recorder refreshes the cache (runHolder), since a hook never waits on the network.
 * Imports no model provider: hooks run several times a turn.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../agent/config.ts";
import { holderFresh, readHolder } from "../agent/handover.ts";
import { noticeKey, noticeText, type TroubleState } from "../agent/notices.ts";
import { writePrivate } from "../agent/private-file.ts";
import { updateNotices } from "../agent/update-notices.ts";

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

/**
 * The notice for `session`, if the agent's summary state changed since that session last heard. Remembers what it said.
 * `command`: how this session switches the summary model (Claude Code's command; Codex has the CLI's).
 */
export function summaryNotice(agent: AgentConfig, session: string, command = "/orrery:compactor"): string | undefined {
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
	const message = noticeText(agent.name, status.trouble, previous, command);
	if (key !== previous) writePrivate(file, JSON.stringify({ session, key }));
	return message;
}

/** How many sessions update-notices.json remembers; older ones may hear a notice again, which is harmless. */
const SESSIONS_KEPT = 20;

/**
 * The update notices `session` has not heard yet, one per line, or undefined. Remembers what it said in
 * <agent.dir>/claude/update-notices.json. `enabled`: [updates] check; off, a newer release is not mentioned, but an
 * update under the session still is (no network). The restart line needs this session's own recorder, beating.
 */
export function updateNotice(agent: AgentConfig, session: string, env: NodeJS.ProcessEnv, enabled: boolean, now = Date.now()): string | undefined {
	const holder = readHolder(agent.dir);
	const own = holderFresh(holder, now) && holder.session === session && holder.state === "recording";
	const running = own && typeof holder.version === "string" ? holder.version : undefined;
	const notices = updateNotices(env, now, { enabled, running });
	if (notices.length === 0) return undefined;
	const file = join(agent.dir, "claude", "update-notices.json");
	let sessions: Record<string, string[]> = {};
	try {
		const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof saved === "object" && saved !== null && !Array.isArray(saved)) sessions = saved as Record<string, string[]>;
	} catch {
		sessions = {};
	}
	const heard = Array.isArray(sessions[session]) ? sessions[session].filter((key) => typeof key === "string") : [];
	const fresh = notices.filter((notice) => !heard.includes(notice.key));
	if (fresh.length === 0) return undefined;
	// This session last, so the oldest go first.
	const { [session]: _, ...others } = sessions;
	const kept = Object.entries(others).slice(-(SESSIONS_KEPT - 1));
	writePrivate(file, JSON.stringify(Object.fromEntries([...kept, [session, [...heard, ...fresh.map((notice) => notice.key)]]])));
	return fresh.map((notice) => notice.text).join("\n");
}
