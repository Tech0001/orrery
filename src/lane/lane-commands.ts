/** The lane commands shared by pi's /memory, /compactor and /browse and by Claude Code's holder; each returns the text shown, and nothing here reaches the model. */

import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderMemoryHtml } from "../memory/index.ts";
import { type ModelChoice, parseModelChoice } from "./config.ts";
import type { MemoryLane } from "./memory-lane.ts";

/** The /memory report: counts, summary model and trouble, token use, reads. */
export function memoryReport(lane: MemoryLane): string {
	const stats = lane.view.stats();
	const usage = lane.store.usageRows();
	const sum = (role: string, key: "input" | "cacheRead" | "output") => usage.filter((r) => r.role === role).reduce((total, r) => total + r[key], 0);
	return [
		`${lane.config.name}: ${stats.messages} messages, ${stats.nodes} summaries, view ${Math.round(stats.viewBytes / 1000)}/${Math.round(stats.viewBudget / 1000)} KB${stats.settled ? "" : ` (summarizing from #${stats.firstUnsummarized})`}`,
		`summaries: ${lane.compactorModel.provider}/${lane.compactorModel.modelId} (${lane.compactorModel.thinking})${troubleText(lane)}`,
		`tokens: agent ${sum("agent", "input")} in + ${sum("agent", "cacheRead")} cached, ${sum("agent", "output")} out; summaries ${sum("compactor", "input")} in + ${sum("compactor", "cacheRead")} cached, ${sum("compactor", "output")} out`,
		lane.config.reads.length > 0 ? `reads: ${lane.config.reads.join(", ")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

/** /compactor [provider/id [thinking] | reset]: switches the summary model if asked, then shows it. */
export function compactorCommand(lane: MemoryLane, args: string): string {
	const [ref, thinking] = args.trim().split(/\s+/).filter(Boolean);
	if (ref === "reset") lane.setCompactorModel(undefined);
	else if (ref !== undefined) lane.setCompactorModel(parseModelChoice(ref, thinking ?? lane.compactorModel.thinking));
	return `${summaryLine(lane.compactorModel, lane.compactorSource)}${troubleText(lane)}`;
}

/** "summaries: provider/id (thinking) · from config" or "· set in chat": the line /compactor and `orrery compactor` show. */
export function summaryLine(choice: ModelChoice, source: "config" | "chat"): string {
	return `summaries: ${choice.provider}/${choice.modelId} (${choice.thinking}) · ${source === "chat" ? "set in chat" : "from config"}`;
}

/** " · STOPPED: unknown model x/y", " · FAILING: quota exceeded", or "" when summaries work. */
function troubleText(lane: MemoryLane): string {
	const trouble = lane.summaryTrouble();
	if (trouble === undefined) return "";
	return ` · ${trouble.state.toUpperCase()}${`: ${trouble.plain}`}`;
}

/** Writes the lane's memory page (mode 0600) and returns its path. */
export function browse(lane: MemoryLane): string {
	const path = join(lane.config.dir, "memory.html");
	writeFileSync(path, renderMemoryHtml(lane.view, lane.config.name), { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

/** How /browse opens its page: xdg-open on a Linux desktop, open on macOS; none without a display (ssh, tests). */
export function pageOpener(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { command: string; open(path: string): void } | undefined {
	const command = platform === "darwin" ? "open" : platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY) ? "xdg-open" : undefined;
	if (command === undefined) return undefined;
	return {
		command,
		open: (path) => {
			// Detached and ignored: a missing opener or browser must not disturb pi; the notice names the page anyway.
			try {
				const child = spawn(command, [path], { detached: true, stdio: "ignore" });
				child.on("error", () => {});
				child.unref();
			} catch {
				// as above
			}
		},
	};
}
