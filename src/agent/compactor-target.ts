/**
 * The summary-model target for an agent seen from outside it (the shell, the TUI): spec 2026-10-08-orrery-tui-design
 * §4.3. One process writes an agent's memory, so the change goes to whoever has it:
 * - closed: written to memory.sqlite directly;
 * - open in Claude Code: sent to its recorder through the spool;
 * - open in anything else (pi): written to request.json, which pi's tick takes.
 * It then waits for the agent's stored choice to change. Node only: pi never loads this file.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { holderLog, sessionDir } from "../claude/paths.ts";
import { spoolEvent } from "../claude/spool.ts";
import { MemoryStore } from "../memory/index.ts";
import { holdWriterLock } from "../memory/store.ts";
import { attachRemoteStore, withBriefCheckOut } from "../remote/checkout.ts";
import { COMPACTOR_MODEL_KEY, storedChoice } from "./choices.ts";
import { findAgent, type HarnessConfig, type ModelChoice } from "./config.ts";
import { holderFresh, readHolder } from "./handover.ts";
import { summaryLine } from "./agent-commands.ts";
import { requestFile, writeRequest } from "./settings-request.ts";
import { readStatus } from "./status-file.ts";
import type { CompactorTarget } from "./summary-text.ts";

/** How long an open agent gets to take a change. */
export const ANSWER_MS = 15_000;

/** The CompactorTarget for `agentName` as the shell and the TUI see it. */
export function agentCompactorTarget(
	config: HarnessConfig,
	agentName: string,
	options: { waitMs?: number; exists?: (provider: string, modelId: string) => boolean; report?: (message: string) => void } = {},
): CompactorTarget {
	const agent = findAgent(config, agentName);
	const file = join(agent.dir, "memory.sqlite");
	const exists = options.exists ?? (() => true);
	const stored = (): { choice?: ModelChoice; raw?: string } => {
		if (!existsSync(file)) return {};
		const store = MemoryStore.openReadOnly(file);
		try {
			return { ...storedChoice(store, COMPACTOR_MODEL_KEY, exists), raw: store.getMeta(COMPACTOR_MODEL_KEY) };
		} finally {
			store.close();
		}
	};
	const current = () => {
		const { choice } = stored();
		return { choice: choice ?? agent.compactor.model, source: choice === undefined ? ("config" as const) : ("chat" as const) };
	};
	return {
		current,
		configured: () => agent.compactor.model,
		apply: async (choice) => {
			const value = choice === undefined ? "" : JSON.stringify(choice);
			const args = choice === undefined ? "reset" : `${choice.provider}/${choice.modelId} ${choice.thinking}`;
			let store: MemoryStore | undefined;
			let locallyHeld = false;
			try {
				if (agent.remote === undefined) store = MemoryStore.open(file);
				else {
					// Probe only the local writer lock. Opening memory before remote checkout could create stale data.
					holdWriterLock(file)();
				}
			} catch (error) {
				locallyHeld = true;
				if (!/already open/i.test(error instanceof Error ? error.message : String(error))) throw error;
			}
			if (agent.remote !== undefined && !locallyHeld) {
				await withBriefCheckOut(config, agent, (remote, reservation) => {
					const writer = MemoryStore.open(file, reservation);
					attachRemoteStore(remote!, writer);
					writer.setMeta(COMPACTOR_MODEL_KEY, value);
				}, options.report ?? ((message) => process.stderr.write(`${message}\n`)));
				const now = current();
				return summaryLine(now.choice, now.source);
			}
			if (store !== undefined) {
				try {
					store.setMeta(COMPACTOR_MODEL_KEY, value);
				} finally {
					store.close();
				}
				const now = current();
				return summaryLine(now.choice, now.source);
			}
			const holder = readHolder(agent.dir);
			const claude = holderFresh(holder);
			const spooled = claude ? spoolEvent(agent.dir, holder.session, { kind: "compactor", at: Date.now(), claudePid: holder.claudePid, args }) : undefined;
			if (!claude) writeRequest(agent.dir, { agent: agent.name, kind: "compactor", args, at: Date.now() });
			const waitMs = options.waitMs ?? ANSWER_MS;
			const deadline = Date.now() + waitMs;
			while (stored().raw !== value) {
				if (Date.now() >= deadline) {
					// A late holder or pi must not apply what the user was told did not happen.
					let taken = false;
					if (spooled !== undefined && holder !== undefined) rmSync(join(sessionDir(agent.dir, holder.session), spooled), { force: true });
					else if (existsSync(requestFile(agent.dir))) rmSync(requestFile(agent.dir), { force: true });
					else taken = true;
					if (taken) {
						// pi took the request just as the wait ran out: give it a moment to store the choice.
						await sleep(200);
						if (stored().raw === value) break;
					}
					const status = readStatus(agent.dir);
					const piOpen = status !== undefined && status.open !== false && status.model !== "claude-code" && Date.now() - Date.parse(status.updatedAt) < 30_000;
					const who = claude ? "Claude Code" : piOpen ? "pi" : "another Orrery process (an import or build?)";
					throw new Error(`${agent.name} (open in ${who}) didn't answer within ${waitMs / 1000} s; the change was not applied.${claude ? ` See ${holderLog(agent.dir)}.` : ""}`);
				}
				await sleep(100);
			}
			const now = current();
			return summaryLine(now.choice, now.source);
		},
	};
}
