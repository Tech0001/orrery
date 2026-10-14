/** Non-interactive and setup commands of lane. */

import { chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Models } from "@earendil-works/pi-ai";
import { acceptHostKey, scanHostKey } from "@earendil-works/pi-env";
import { checkClaudeFiles, claudeProjectDir, claudeSessionFiles } from "../import/claude.ts";
import { checkCodexFiles, findCodexSessions } from "../import/codex.ts";
import { dryRun } from "../import/dry-run.ts";
import { commitPreview, readPreview } from "../import/preview.ts";
import { findLane, type HarnessConfig, parseModelChoice } from "../lane/config.ts";
import { FileCredentialStore } from "../lane/credentials.ts";
import { sshTarget } from "../lane/env.ts";
import { writeBuild } from "../lane/build.ts";
import { laneOverview, laneUsage, summaryText, TOOL_LABELS, totalCost, usageCost } from "../lane/overview.ts";
import { laneCompactorTarget } from "../lane/compactor-target.ts";
import { createLaneCompactor } from "../lane/lane.ts";
import { createLaneModels, savedSummaryLoginsOnly } from "../lane/models.ts";
import { openSummarySources, type SummarySources } from "../lane/summary-sources.ts";
import { runCompactorText } from "../lane/summary-text.ts";
import { type Compactor, MemoryStore, MemoryView, renderMemoryHtml } from "../memory/index.ts";
import { attachRemoteStore, withBriefCheckOut } from "../remote/checkout.ts";
import { clean } from "./printer.ts";
import { formatUsage } from "./run.ts";

/** `orrery status [<Lane>] [--json]`: one line per lane (or the named one): state, tool, memory, summaries. */
export function statusCommand(config: HarnessConfig, only?: string, options: { json?: boolean } = {}): string {
	const name = only === undefined ? undefined : findLane(config, only).name;
	const rows = laneOverview(config).filter((row) => name === undefined || row.name === name);
	if (options.json === true) return `${JSON.stringify({ lanes: rows }, null, 2)}\n`;
	const toolWidth = Math.max(11, ...rows.map((row) => TOOL_LABELS[row.tool].length + (row.launcher === "ori" ? 6 : 0)));
	let out = "";
	for (const row of rows) {
		const memory = row.unreadable !== undefined ? `unreadable: ${row.unreadable}` : row.hasMemory ? `${row.messages} messages, view ${Math.round(row.viewBytes / 1000)}/${Math.round(row.viewBudget / 1000)} KB` : "no memory yet";
		out += `${row.name.padEnd(12)} ${row.state.padEnd(9)} ${`${TOOL_LABELS[row.tool]}${row.launcher === "ori" ? " · Ori" : ""}`.padEnd(toolWidth)} ${memory}  summaries ${summaryText(row)} · ${row.summaryModel.ref} ${row.summaryModel.thinking}\n`;
	}
	// status.json carries provider and model error text: never pass its control sequences to the terminal.
	return clean(out) || "No lanes configured.\n";
}

export function usageCommand(config: HarnessConfig, laneName: string | undefined, days: number, options: { json?: boolean } = {}): string {
	const only = laneName === undefined ? undefined : findLane(config, laneName).name;
	const usage = laneUsage(config, days, only);
	if (options.json === true) return `${JSON.stringify({ days, lanes: usage }, null, 2)}\n`;
	return usage.map((lane) => `== ${lane.name}\n${formatUsage([...lane.rows])}`).join("") || "No usage recorded.\n";
}

export async function trustHostCommand(config: HarnessConfig, hostName: string): Promise<void> {
	const host = config.hosts.get(hostName);
	if (host === undefined || host.kind !== "ssh") throw new Error(`No SSH host named ${hostName}`);
	const target = sshTarget(host, config.sshDir);
	const { lines, fingerprints } = await scanHostKey(target);
	process.stdout.write(`Host key fingerprints for ${host.host}:\n${fingerprints.join("\n")}\n`);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = (await rl.question("Compare them with the host itself. Trust this key? (yes/no) ")).trim();
	rl.close();
	if (answer !== "yes") throw new Error("Not trusted.");
	await acceptHostKey(target, lines);
	process.stdout.write(`Trusted ${host.host} as ${host.hostKeyAlias}.\n`);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * `orrery compact <Lane> [--progress FILE]`: builds every missing summary. With `progress`, FILE (the lane's build.json,
 * src/lane/build.ts) says how far it is and what its summaries cost so far, every 5 s and when it ends.
 */
export async function compactCommand(config: HarnessConfig, laneName: string, models?: Models, options: { readonly progress?: string } = {}): Promise<void> {
	const lane = findLane(config, laneName);
	await withBriefCheckOut(config, lane, async (remote, writer) => {
		const store = MemoryStore.open(join(lane.dir, "memory.sqlite"), writer);
		let compactor: Compactor | undefined;
		const lost = Promise.withResolvers<void>();
		if (remote !== undefined) attachRemoteStore(remote, store, () => { lost.resolve(); void compactor?.close(); });
		const startedAt = Date.now();
		let laneModels: Models | undefined;
		let counts = { messages: 0, summaries: 0 };
		// build.json for the Agents page (src/lane/build.ts): how far the build is, and what its summaries cost so far.
		// Writing it never stops the build.
		const progress = (fields: { done?: true; error?: string } = {}) => {
			const file = options.progress;
			if (file === undefined) return;
			let dollars: number | undefined;
			try {
				counts = { messages: store.root.length, summaries: store.nodeCount };
				const price = (provider: string, modelId: string) => laneModels?.getModel(provider, modelId)?.cost;
				const total = totalCost(store.usageRows().filter((row) => row.role === "compactor" && Date.parse(row.at) >= startedAt).map((row) => usageCost(row, config, price)));
				if (total?.kind === "api") dollars = total.dollars;
			} catch {
				// the store went with the lane (to another machine): its last counts, no price
			}
			try {
				writeBuild(file, { pid: process.pid, startedAt, ...counts, ...(dollars === undefined ? {} : { dollars }), ...fields });
			} catch (error) {
				process.stderr.write(`Could not write ${file}: ${errorText(error)}\n`);
			}
		};
		try {
			laneModels =
				models ?? createLaneModels({ credentials: new FileCredentialStore(config.credentialsPath), providers: config.providers, savedLoginsOnly: savedSummaryLoginsOnly(lane) });
			const view = new MemoryView(store, lane.memory.viewBytes);
			compactor = createLaneCompactor(lane, laneModels, store, view, (message) => process.stderr.write(`${message}\n`));
			const timer = setInterval(() => {
				process.stdout.write(`${store.nodeCount} summaries for ${store.root.length} messages\n`);
				progress();
			}, 5000);
			try {
				progress();
				compactor.start();
				await Promise.race([compactor.drain(), lost.promise]);
				// Let withBriefCheckOut report fencing after it has closed and released the writer.
				if (remote?.lost) {
					progress({ error: "it moved to another machine" });
					return;
				}
				progress({ done: true });
				process.stdout.write(`Done: ${store.nodeCount} summaries for ${store.root.length} messages.\n`);
			} finally {
				clearInterval(timer);
				await compactor.close();
			}
		} catch (error) {
			progress({ error: errorText(error) });
			throw error;
		} finally {
			if (remote === undefined) store.close();
		}
	}, (message) => process.stderr.write(`${message}\n`));
}

export interface ImportOptions {
	readonly claude?: string;
	readonly claudeFiles?: readonly string[];
	readonly codex?: string;
	readonly codexFiles?: readonly string[];
	readonly notes: readonly string[];
	readonly pasteThreshold: number;
	readonly split: boolean;
	readonly out?: string;
}

export async function importDryRunCommand(config: HarnessConfig, laneName: string, options: ImportOptions, models?: Models): Promise<string> {
	const lane = findLane(config, laneName);
	const namedClaude = checkClaudeFiles(options.claudeFiles ?? []);
	const named = checkCodexFiles(options.codexFiles ?? []);
	const claudeDir = options.claude === "none" ? undefined : (options.claude ?? (lane.workspace === undefined ? undefined : claudeProjectDir(lane.workspace)));
	const codexRoot = options.codex === "none" ? undefined : (options.codex ?? join(homedir(), ".codex", "sessions"));
	const foundClaude = claudeDir === undefined ? [] : claudeSessionFiles(claudeDir);
	const found = codexRoot === undefined || lane.workspace === undefined ? [] : findCodexSessions(codexRoot, lane.workspace).map((file) => resolve(file));
	const result = await dryRun({
		config,
		name: lane.name,
		names: [...config.lanes.keys()],
		summaryModel: lane.compactor.model,
		savedLoginsOnly: savedSummaryLoginsOnly(lane),
		claudeFiles: [...foundClaude, ...namedClaude.filter((file) => !foundClaude.includes(file))],
		codexFiles: [...found, ...named.filter((file) => !found.includes(file))],
		notes: options.notes,
		pasteThreshold: options.pasteThreshold,
		split: options.split,
		out: options.out ?? join(process.cwd(), `import-${lane.name}`),
		...(models === undefined ? {} : { models }),
		progress: (line) => process.stderr.write(`${line}\n`),
	});
	const { claude, codex, usage } = result;
	const splitLine = options.split
		? `Split model: ${result.splitCalls} calls, ${usage.input} input + ${usage.cacheRead} cache-read + ${usage.output} output tokens\n`
		: "Split model: skipped (--no-split; tagged pastes were still split)\n";
	return (
		`Claude: ${claude.turns} turns from ${claude.files} files (${claude.skipped} unreadable lines skipped)\n` +
		`Codex: ${codex.turns} turns from ${codex.files} sessions (${codex.skipped} unreadable lines skipped)\n` +
		result.omitted.map((line) => `${line}\n`).join("") +
		`Notes: ${result.noteParts} parts from ${options.notes.length} files\n` +
		splitLine +
		`${result.report.split("\n")[2]}\n` +
		`Preview: ${result.previewPath}\nReport:  ${result.reportPath}\n` +
		`Review the report, edit the preview if needed, then: orrery import ${lane.name} --commit ${result.previewPath}\n`
	);
}

export function importCommitCommand(config: HarnessConfig, laneName: string, previewPath: string): string {
	const lane = findLane(config, laneName);
	if (lane.remote !== undefined) throw new Error(`${lane.name} keeps its memory on remote ${lane.remote}; run orrery lane local ${lane.name} first`);
	const lines = readPreview(previewPath);
	const store = MemoryStore.open(join(lane.dir, "memory.sqlite"));
	try {
		const count = commitPreview(store, lines);
		return `Imported ${count} messages into ${lane.name}. Build the summaries with: orrery compact ${lane.name}\n`;
	} finally {
		store.close();
	}
}

export function browseCommand(config: HarnessConfig, laneName: string, out?: string): string {
	const lane = findLane(config, laneName);
	const store = MemoryStore.openReadOnly(join(lane.dir, "memory.sqlite"));
	try {
		const html = renderMemoryHtml(new MemoryView(store, lane.memory.viewBytes), lane.name);
		const path = out ?? join(process.cwd(), `${lane.name}-memory.html`);
		writeFileSync(path, html, { mode: 0o600 });
		chmodSync(path, 0o600);
		return path;
	} finally {
		store.close();
	}
}

/**
 * `orrery compactor <Lane> [signin|key|local ... | provider/id [thinking] | reset]`, which Claude Code's /orrery:compactor runs, shows or
 * switches the lane's summary model.
 * - The choice lives where pi's /compactor keeps it (COMPACTOR_MODEL_KEY), so both agents share it.
 * - It is tested with one call first (summary-sources testChoice), with orrery's own logins, which Claude Code's holder summarizes with.
 * - While a Claude Code session records the lane, its holder applies the choice, through the spool. While pi holds
 *   the lane, it goes through request.json (compactor-target.ts).
 */
export async function compactorCliCommand(
	config: HarnessConfig,
	laneName: string,
	args: readonly string[],
	options: { sources?: SummarySources; waitMs?: number; prefix?: string } = {},
): Promise<string> {
	const lane = findLane(config, laneName);
	const sources = options.sources ?? (await openSummarySources(config, lane));
	const exists = (provider: string, modelId: string) => sources.models.getModel(provider, modelId) !== undefined;
	const target = laneCompactorTarget(config, lane.name, { ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }), exists });
	const signin = process.stdin.isTTY ? async (name: string) => {
		const { loginCommand } = await import("./logins.ts");
		process.stdout.write(await loginCommand(config, { signin: name }));
	} : undefined;
	const text = await runCompactorText(sources, args, options.prefix ?? `orrery compactor ${lane.name}`, target, signin);
	return `${text}\n`;
}
