/** Non-interactive and setup commands of agent. */

import { renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Models } from "@earendil-works/pi-ai";
import { acceptHostKey, scanHostKey } from "@earendil-works/pi-env";
import { readUnconfirmed } from "../claude/transcript.ts";
import { checkClaudeFiles, claudeProjectDir, claudeSessionFiles } from "../import/claude.ts";
import { checkCodexFiles, findCodexSessions } from "../import/codex.ts";
import { dryRun } from "../import/dry-run.ts";
import { commitPreview, readPreview } from "../import/preview.ts";
import { type AgentConfig, findAgent, type HarnessConfig, parseModelChoice } from "../agent/config.ts";
import { FileCredentialStore } from "../agent/credentials.ts";
import { sshTarget } from "../agent/env.ts";
import { writeBuild } from "../agent/build.ts";
import { agentOverview, agentUsage, summaryText, TOOL_LABELS, totalCost, usageCost } from "../agent/overview.ts";
import { agentCompactorTarget } from "../agent/compactor-target.ts";
import { createAgentCompactor } from "../agent/agent.ts";
import { createAgentModels, savedSummaryLoginsOnly } from "../agent/models.ts";
import { isOpenCodeChoice } from "../agent/opencode-source.ts";
import { openSummarySources, type SummarySources } from "../agent/summary-sources.ts";
import { runCompactorText } from "../agent/summary-text.ts";
import { type Compactor, MemoryStore, MemoryView, renderMemoryHtml } from "../memory/index.ts";
import { attachRemoteStore, withBriefCheckOut } from "../remote/checkout.ts";
import { clean } from "./printer.ts";
import { formatUsage } from "./run.ts";

/** What status and usage list, inside an agent's session: the agents it may read (src/cli/gate.ts readableBy). */
type Readable = (agent: AgentConfig) => boolean;

/** `config` with only the agents `readable` takes (all without it), so nothing of the others is even read. */
function readableOnly(config: HarnessConfig, readable: Readable | undefined): HarnessConfig {
	return readable === undefined ? config : { ...config, agents: new Map([...config.agents].filter(([, agent]) => readable(agent))) };
}

/**
 * `orrery status [<Name>] [--json]`: one line per agent (or the named one): state, tool, memory, summaries, and the Claude
 * Code prompts its transcript never confirmed, which were not recorded (src/claude/transcript.ts), once there are any.
 */
export function statusCommand(config: HarnessConfig, only?: string, options: { json?: boolean; readable?: Readable } = {}): string {
	const name = only === undefined ? undefined : findAgent(config, only).name;
	const rows = agentOverview(readableOnly(config, options.readable))
		.filter((row) => name === undefined || row.name === name)
		.map((row) => {
			const unconfirmed = readUnconfirmed(config.agents.get(row.name)?.dir ?? row.dataDir);
			return unconfirmed > 0 ? { ...row, unconfirmedPrompts: unconfirmed } : row;
		});
	if (options.json === true) return `${JSON.stringify({ agents: rows }, null, 2)}\n`;
	const toolWidth = Math.max(11, ...rows.map((row) => TOOL_LABELS[row.tool].length + (row.launcher === "ori" ? 6 : 0)));
	let out = "";
	for (const row of rows) {
		const memory = row.unreadable !== undefined ? `unreadable: ${row.unreadable}` : row.hasMemory ? `${row.messages} messages, view ${Math.round(row.viewBytes / 1000)}/${Math.round(row.viewBudget / 1000)} KB` : "no memory yet";
		const unconfirmed = "unconfirmedPrompts" in row ? ` · ${row.unconfirmedPrompts} unconfirmed ${row.unconfirmedPrompts === 1 ? "prompt" : "prompts"} not recorded` : "";
		out += `${row.name.padEnd(12)} ${row.state.padEnd(9)} ${`${TOOL_LABELS[row.tool]}${row.launcher === "ori" ? " · Ori" : ""}`.padEnd(toolWidth)} ${memory}  summaries ${summaryText(row)} · ${row.summaryModel.ref} ${row.summaryModel.thinking}${unconfirmed}\n`;
	}
	// status.json carries provider and model error text: never pass its control sequences to the terminal.
	return clean(out) || "No agents configured.\n";
}

export function usageCommand(config: HarnessConfig, agentName: string | undefined, days: number, options: { json?: boolean; readable?: Readable } = {}): string {
	const only = agentName === undefined ? undefined : findAgent(config, agentName).name;
	const usage = agentUsage(readableOnly(config, options.readable), days, only);
	if (options.json === true) return `${JSON.stringify({ days, agents: usage }, null, 2)}\n`;
	return usage.map((agent) => `== ${agent.name}\n${formatUsage([...agent.rows])}`).join("") || "No usage recorded.\n";
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
 * `orrery compact <Name> [--progress FILE]`: builds every missing summary. With `progress`, FILE (the agent's build.json,
 * src/agent/build.ts) says how far it is and what its summaries cost so far, every 5 s and when it ends.
 */
export async function compactCommand(config: HarnessConfig, agentName: string, models?: Models, options: { readonly progress?: string } = {}): Promise<void> {
	const agent = findAgent(config, agentName);
	// An OpenCode model makes summaries only through Orrery's plugin, while the agent is open in OpenCode.
	const chosen = agent.compactor.model;
	if (isOpenCodeChoice(chosen)) {
		throw new Error(`${agent.name}'s summary model in the config (${chosen.provider}/${chosen.modelId}) is an OpenCode model, which works only while ${agent.name} is open in OpenCode: build its summaries there, or set another compactor_model in Orrery's config to build them here.`);
	}
	await withBriefCheckOut(config, agent, async (remote, writer) => {
		const store = MemoryStore.open(join(agent.dir, "memory.sqlite"), writer);
		let compactor: Compactor | undefined;
		const lost = Promise.withResolvers<void>();
		if (remote !== undefined) attachRemoteStore(remote, store, () => { lost.resolve(); void compactor?.close(); });
		const startedAt = Date.now();
		let agentModels: Models | undefined;
		let counts = { messages: 0, summaries: 0 };
		// build.json for the Agents page (src/agent/build.ts): how far the build is, and what its summaries cost so far.
		// Writing it never stops the build.
		const progress = (fields: { done?: true; error?: string } = {}) => {
			const file = options.progress;
			if (file === undefined) return;
			let dollars: number | undefined;
			try {
				counts = { messages: store.root.length, summaries: store.nodeCount };
				const price = (provider: string, modelId: string) => agentModels?.getModel(provider, modelId)?.cost;
				const total = totalCost(store.usageRows().filter((row) => row.role === "compactor" && Date.parse(row.at) >= startedAt).map((row) => usageCost(row, config, price)));
				if (total?.kind === "api") dollars = total.dollars;
			} catch {
				// the store went with the agent (to another machine): its last counts, no price
			}
			try {
				writeBuild(file, { pid: process.pid, startedAt, ...counts, ...(dollars === undefined ? {} : { dollars }), ...fields });
			} catch (error) {
				process.stderr.write(`Could not write ${file}: ${errorText(error)}\n`);
			}
		};
		try {
			agentModels =
				models ?? createAgentModels({ credentials: new FileCredentialStore(config.credentialsPath), providers: config.providers, savedLoginsOnly: savedSummaryLoginsOnly(agent) });
			const view = new MemoryView(store, agent.memory.viewBytes);
			compactor = createAgentCompactor(agent, agentModels, store, view, (message) => process.stderr.write(`${message}\n`));
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

export async function importDryRunCommand(config: HarnessConfig, agentName: string, options: ImportOptions, models?: Models): Promise<string> {
	const agent = findAgent(config, agentName);
	const namedClaude = checkClaudeFiles(options.claudeFiles ?? []);
	const named = checkCodexFiles(options.codexFiles ?? []);
	const claudeDir = options.claude === "none" ? undefined : (options.claude ?? (agent.folder === undefined ? undefined : claudeProjectDir(agent.folder)));
	const codexRoot = options.codex === "none" ? undefined : (options.codex ?? join(homedir(), ".codex", "sessions"));
	const foundClaude = claudeDir === undefined ? [] : claudeSessionFiles(claudeDir);
	const found = codexRoot === undefined || agent.folder === undefined ? [] : findCodexSessions(codexRoot, agent.folder).map((file) => resolve(file));
	const result = await dryRun({
		config,
		name: agent.name,
		names: [...config.agents.keys()],
		summaryModel: agent.compactor.model,
		savedLoginsOnly: savedSummaryLoginsOnly(agent),
		claudeFiles: [...foundClaude, ...namedClaude.filter((file) => !foundClaude.includes(file))],
		codexFiles: [...found, ...named.filter((file) => !found.includes(file))],
		notes: options.notes,
		pasteThreshold: options.pasteThreshold,
		split: options.split,
		out: options.out ?? join(process.cwd(), `import-${agent.name}`),
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
		`Review the report, edit the preview if needed, then: orrery import ${agent.name} --commit ${result.previewPath}\n`
	);
}

export function importCommitCommand(config: HarnessConfig, agentName: string, previewPath: string): string {
	const agent = findAgent(config, agentName);
	if (agent.remote !== undefined) throw new Error(`${agent.name} keeps its memory on remote ${agent.remote}; run orrery agent local ${agent.name} first`);
	const lines = readPreview(previewPath);
	const store = MemoryStore.open(join(agent.dir, "memory.sqlite"));
	try {
		const count = commitPreview(store, lines);
		return `Imported ${count} messages into ${agent.name}. Build the summaries with: orrery compact ${agent.name}\n`;
	} finally {
		store.close();
	}
}

export function browseCommand(config: HarnessConfig, agentName: string, out?: string): string {
	const agent = findAgent(config, agentName);
	const store = MemoryStore.openReadOnly(join(agent.dir, "memory.sqlite"));
	try {
		const html = renderMemoryHtml(new MemoryView(store, agent.memory.viewBytes), agent.name);
		const path = out ?? join(process.cwd(), `${agent.name}-memory.html`);
		// A new file renamed into place: a link (soft or hard) already at `path` is replaced, never written through, so the
		// page can't land in the config or a memory file it points at.
		const temporary = join(dirname(path), `.${basename(path)}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
		writeFileSync(temporary, html, { mode: 0o600, flag: "wx" });
		try {
			renameSync(temporary, path);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
		return path;
	} finally {
		store.close();
	}
}

/**
 * `orrery compactor <Name> [signin|key|local ... | provider/id [thinking] | reset]`, which Claude Code's /orrery:compactor runs, shows or
 * switches the agent's summary model.
 * - The choice lives where pi's /compactor keeps it (COMPACTOR_MODEL_KEY), so both agents share it.
 * - It is tested with one call first (summary-sources testChoice), with orrery's own logins, which Claude Code's holder summarizes with.
 * - While a Claude Code session records the agent, its holder applies the choice, through the spool. While pi holds
 *   the agent, it goes through request.json (compactor-target.ts).
 */
export async function compactorCliCommand(
	config: HarnessConfig,
	agentName: string,
	args: readonly string[],
	options: { sources?: SummarySources; waitMs?: number; prefix?: string; interactive?: boolean } = {},
): Promise<string> {
	const agent = findAgent(config, agentName);
	const sources = options.sources ?? (await openSummarySources(config, agent));
	const exists = (provider: string, modelId: string) => sources.models.getModel(provider, modelId) !== undefined;
	const target = agentCompactorTarget(config, agent.name, { ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }), exists });
	// A sign-in's flow needs a terminal, and never starts inside an agent's session (`interactive` false): there the
	// existing logins, keys and local endpoints are all it chooses among.
	const signin = options.interactive !== false && process.stdin.isTTY ? async (name: string) => {
		const { loginCommand } = await import("./logins.ts");
		process.stdout.write(await loginCommand(config, { signin: name }));
	} : undefined;
	const text = await runCompactorText(sources, args, options.prefix ?? `orrery compactor ${agent.name}`, target, signin);
	return `${text}\n`;
}
