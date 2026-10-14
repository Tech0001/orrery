import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryStats } from "../memory/index.ts";
import type { ThinkingLevel } from "./config.ts";
import { runningVersion } from "./running.ts";

export interface AgentStatus {
	readonly agent: string;
	readonly pid: number;
	/** False once the agent closed the agent. */
	readonly open?: boolean;
	readonly busy: boolean;
	readonly model: string;
	readonly thinking: ThinkingLevel;
	readonly memory: MemoryStats;
	readonly modelSource: ModelSource;
	readonly compactor: {
		readonly stopped: boolean;
		readonly failing: number;
		readonly model: string;
		readonly thinking: ThinkingLevel;
		readonly source: ModelSource;
	};
	readonly lastError: string | null;
	/** Why summaries cannot come, in plain words (absent in files from before it existed). */
	readonly trouble?: { readonly state: "stopped" | "failing"; readonly plain: string } | null;
	readonly updatedAt: string;
	/** The installed version the agent's process runs, "checkout", or "unknown" (absent in files from before it existed). */
	readonly version?: string;
	/**
	 * instructions.md's modification time when the session read it, or 0 when the agent had none then (absent in files
	 * from before it existed). The Agents page compares it with the file's (src/agent/overview.ts).
	 */
	readonly instructionsAt?: number;
}

/** The version field a status file records: what runningVersion says, or "unknown" when ORRERY_HOME cannot be read. */
export function statusVersion(): string {
	try {
		return runningVersion();
	} catch {
		return "unknown";
	}
}

/** Where an agent's model comes from: the config, or a choice made in chat (/model, /compactor) that survives restarts. */
export type ModelSource = "config" | "chat";

/** A trouble field as orrery writes it: absent, null, or a state with its plain words. */
function troubleValid(trouble: unknown): boolean {
	if (trouble === undefined || trouble === null) return true;
	if (typeof trouble !== "object") return false;
	const { state, plain } = trouble as { state?: unknown; plain?: unknown };
	return (state === "stopped" || state === "failing") && typeof plain === "string";
}

/** The agent's status.json, or undefined when there is none or it is not one orrery wrote (every field read is checked). */
export function readStatus(dir: string): AgentStatus | undefined {
	const file = join(dir, "status.json");
	if (!existsSync(file)) return undefined;
	try {
		const status = JSON.parse(readFileSync(file, "utf8")) as Partial<AgentStatus> | null;
		// A truncated or foreign status.json reads as "no status", never as a crash in orrery status or the TUI.
		const valid =
			typeof status === "object" &&
			status !== null &&
			Number.isInteger(status.pid) &&
			typeof status.busy === "boolean" &&
			typeof status.model === "string" &&
			typeof status.updatedAt === "string" &&
			typeof status.compactor === "object" &&
			status.compactor !== null &&
			typeof status.compactor.stopped === "boolean" &&
			typeof status.compactor.model === "string" &&
			typeof status.compactor.thinking === "string" &&
			typeof status.compactor.source === "string" &&
			(status.version === undefined || typeof status.version === "string") &&
			(status.instructionsAt === undefined || typeof status.instructionsAt === "number") &&
			troubleValid(status.trouble);
		return valid ? (status as AgentStatus) : undefined;
	} catch {
		return undefined;
	}
}
