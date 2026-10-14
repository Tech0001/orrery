/** Non-interactive and setup commands of lane. */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Models } from "@earendil-works/pi-ai";
import { acceptHostKey, scanHostKey } from "@earendil-works/pi-env";
import { checkClaudeFiles, claudeProjectDir, claudeSessionFiles, extractClaudeFiles } from "../import/claude.ts";
import { checkCodexFiles, extractCodex, findCodexSessions } from "../import/codex.ts";
import { interleave, splitNote } from "../import/merge.ts";
import { buildPreview, commitPreview, readPreview, writePreview } from "../import/preview.ts";
import { type SplitResult, splitMessage } from "../import/split.ts";
import { emptyExtract } from "../import/turns.ts";
import { findLane, type HarnessConfig, parseModelChoice } from "../lane/config.ts";
import { FileCredentialStore } from "../lane/credentials.ts";
import { sshTarget } from "../lane/env.ts";
import { laneOverview, laneUsage, summaryText, TOOL_LABELS } from "../lane/overview.ts";
import { laneCompactorTarget } from "../lane/compactor-target.ts";
import { createLaneCompactor } from "../lane/lane.ts";
import { compactorModel, createLaneModels, savedSummaryLoginsOnly } from "../lane/models.ts";
import { openSummarySources, type SummarySources } from "../lane/summary-sources.ts";
import { runCompactorText } from "../lane/summary-text.ts";
import { type Compactor, type CompactorModel, MemoryStore, MemoryView, renderMemoryHtml } from "../memory/index.ts";
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

export async function compactCommand(config: HarnessConfig, laneName: string, models?: Models): Promise<void> {
	const lane = findLane(config, laneName);
	await withBriefCheckOut(config, lane, async (remote, writer) => {
		const store = MemoryStore.open(join(lane.dir, "memory.sqlite"), writer);
		let compactor: Compactor | undefined;
		const lost = Promise.withResolvers<void>();
		if (remote !== undefined) attachRemoteStore(remote, store, () => { lost.resolve(); void compactor?.close(); });
		try {
			const laneModels =
				models ?? createLaneModels({ credentials: new FileCredentialStore(config.credentialsPath), providers: config.providers, savedLoginsOnly: savedSummaryLoginsOnly(lane) });
			const view = new MemoryView(store, lane.memory.viewBytes);
			compactor = createLaneCompactor(lane, laneModels, store, view, (message) => process.stderr.write(`${message}\n`));
			const timer = setInterval(() => process.stdout.write(`${store.nodeCount} summaries for ${store.root.length} messages\n`), 5000);
			try {
				compactor.start();
				await Promise.race([compactor.drain(), lost.promise]);
				// Let withBriefCheckOut report fencing after it has closed and released the writer.
				if (remote?.lost) return;
				process.stdout.write(`Done: ${store.nodeCount} summaries for ${store.root.length} messages.\n`);
			} finally {
				clearInterval(timer);
				await compactor.close();
			}
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
	const claude = extractClaudeFiles([...foundClaude, ...namedClaude.filter((file) => !foundClaude.includes(file))]);
	const found = codexRoot === undefined || lane.workspace === undefined ? [] : findCodexSessions(codexRoot, lane.workspace).map((file) => resolve(file));
	const codex = extractCodex([...found, ...named.filter((file) => !found.includes(file))]);
	const notes = options.notes.flatMap((file) =>
		splitNote(basename(file), readFileSync(file, "utf8"), new Date(statSync(file).mtimeMs).toISOString()).map((message) => ({
			source: `note:${basename(file)}`,
			message,
		})),
	);
	const out = options.out ?? join(process.cwd(), `import-${lane.name}`);
	mkdirSync(out, { recursive: true, mode: 0o700 });
	const cachePath = join(out, "split-cache.json");
	const cache = new Map<string, SplitResult>(
		existsSync(cachePath) ? Object.entries(JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, SplitResult>) : [],
	);
	const usage = { calls: 0, input: 0, cacheRead: 0, output: 0 };
	// Resolve the split model up front, so a misconfigured model fails now rather than once per long message.
	const model: CompactorModel | undefined = options.split
		? compactorModel(
				models ?? createLaneModels({ credentials: new FileCredentialStore(config.credentialsPath), providers: config.providers, savedLoginsOnly: savedSummaryLoginsOnly(lane) }),
				lane.compactor.model,
				`import:${lane.name}`,
			)
		: undefined;
	const splitModel = {
		complete: async (system: string, user: string) => {
			if (model === undefined) throw new Error("the split model is off (--no-split)");
			usage.calls++;
			if (usage.calls % 10 === 0) process.stderr.write(`${usage.calls} long messages sent to the split model\n`);
			const reply = await model.complete(system, [{ role: "user", blocks: [user] }], AbortSignal.timeout(300_000));
			usage.input += reply.usage?.input ?? 0;
			usage.cacheRead += reply.usage?.cacheRead ?? 0;
			usage.output += reply.usage?.output ?? 0;
			return reply.text;
		},
	};
	let failures = 0;
	const split = async (text: string): Promise<SplitResult> => {
		const threshold = options.split ? options.pasteThreshold : Number.POSITIVE_INFINITY;
		const result = await splitMessage(text, splitModel, { threshold, lanes: [...config.lanes.keys()], lane: lane.name, cache });
		if (options.split) writeFileSync(cachePath, JSON.stringify(Object.fromEntries(cache)), { mode: 0o600 });
		// A model or transport error (not a bad answer) will repeat for every message: stop and say so.
		failures = result.note?.startsWith("split failed") ? failures + 1 : 0;
		if (failures >= 3) {
			throw new Error(`The split model failed 3 times in a row (${result.note}). Fix the model or credentials, or rerun with --no-split.`);
		}
		return result;
	};
	const omitted = [...claude.omitted, ...codex.omitted];
	const { lines, report } = await buildPreview({ turns: interleave(claude.turns, codex.turns), notes, split, omitted });
	const { previewPath, reportPath } = writePreview(out, lines, report);
	const splitLine = options.split
		? `Split model: ${usage.calls} calls, ${usage.input} input + ${usage.cacheRead} cache-read + ${usage.output} output tokens\n`
		: "Split model: skipped (--no-split; tagged pastes were still split)\n";
	return (
		`Claude: ${claude.stats.turns} turns from ${claude.stats.files} files (${claude.stats.skipped} unreadable lines skipped)\n` +
		`Codex: ${codex.stats.turns} turns from ${codex.stats.files} sessions (${codex.stats.skipped} unreadable lines skipped)\n` +
		omitted.map((line) => `${line}\n`).join("") +
		`Notes: ${notes.length} parts from ${options.notes.length} files\n` +
		splitLine +
		`${report.split("\n")[2]}\n` +
		`Preview: ${previewPath}\nReport:  ${reportPath}\n` +
		`Review the report, edit the preview if needed, then: orrery import ${lane.name} --commit ${previewPath}\n`
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
