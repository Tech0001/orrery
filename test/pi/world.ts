import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach } from "vitest";
import { type HarnessConfig, parseConfig } from "../../src/agent/config.ts";
import { FileCredentialStore } from "../../src/agent/credentials.ts";
import { createAgentModels } from "../../src/agent/models.ts";
import type { SummarySources } from "../../src/agent/summary-sources.ts";
import { createOrrery, type OrreryOptions } from "../../src/pi/index.ts";
import type { PiAgent } from "../../src/pi/agent.ts";
import { FAUX, FAUX_SUMMARY, type PiRun, startPi } from "./harness.ts";

/** orrery's summary registry in tests, with the faux providers that answer for the summary and agent models. */
export type WorldSources = SummarySources & { readonly summary: FauxProviderHandle; readonly agent: FauxProviderHandle };

const sourcesByConfig = new WeakMap<HarnessConfig, WorldSources>();

/**
 * The registry orrery's summaries use in tests: orrery's own providers (so the picker lists real model catalogs), the
 * faux summary and agent providers (they replace any configured provider of the same id), and logins in the world's
 * data folder. One per config, so a test reaches the faux the extension summarizes with.
 */
export function summarySourcesFor(config: HarnessConfig): WorldSources {
	let sources = sourcesByConfig.get(config);
	if (sources === undefined) {
		const credentials = new FileCredentialStore(join(config.dataDir, "orrery-logins.json"));
		const models = createAgentModels({ credentials, providers: config.providers });
		// faux-2 gives /compactor's menu a second summary model to switch to.
		const summary = fauxProvider({ provider: FAUX_SUMMARY.provider, models: [{ id: FAUX_SUMMARY.model }, { id: "faux-2" }] });
		const agent = fauxProvider({ provider: FAUX.provider, models: [{ id: FAUX.model }] });
		models.setProvider(summary.provider);
		models.setProvider(agent.provider);
		sources = { config, credentials, models, summary, agent };
		sourcesByConfig.set(config, sources);
	}
	return sources;
}

const runs: PiRun[] = [];
const dirs: string[] = [];
let latest: PiAgent | undefined;

export async function cleanup(): Promise<void> {
	for (const run of runs.splice(0)) await run.dispose();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	latest = undefined;
}

export function lastAgent(): PiAgent {
	if (latest === undefined) throw new Error("no agent opened");
	return latest;
}

/**
 * Makes every visit mark under `dataDir` 10 s old, as if the visit began long before the owner opens. The owner keeps a
 * mark up to 2 s older than its load (src/agent/session-owner.ts), so after this only a later note of the visit keeps it.
 */
export function ageVisitMarks(dataDir: string): void {
	const dir = join(dataDir, "session-owners");
	const old = new Date(Date.now() - 10_000);
	for (const name of readdirSync(dir)) if (name.endsWith(".visited")) utimesSync(join(dir, name), old, old);
}

/** The guard's environment and home in a world `root`: scratch ones, so no test lists or stats the real ~/.omp. */
export function scratchHome(root: string): Pick<OrreryOptions, "env" | "home"> {
	return { env: {}, home: join(root, "home") };
}

/**
 * HOME as a fresh scratch folder for every test of the enclosing suite (a beforeEach sets it, an afterEach puts the
 * old one back and removes the folder), and a getter for the current one. A real pi runs its bash with this process's
 * environment and its tools expand "~" from os.homedir(), so a command the guard lets through (as it does in a run
 * against older code) would otherwise run under the user's own home. Every suite that starts a real pi calls this
 * once; a test that needs something in the home (a config, a credential file) puts it in the scratch one.
 */
export function isolatedHome(): () => string {
	let home: string | undefined;
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env.HOME;
		home = mkdtempSync(join(tmpdir(), "orrery-home-"));
		process.env.HOME = home;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.HOME;
		else process.env.HOME = saved;
		if (home !== undefined) rmSync(home, { recursive: true, force: true });
		home = undefined;
	});
	return () => {
		if (home === undefined) throw new Error("isolatedHome: no test is running");
		return home;
	};
}

/**
 * Two agent folders and a plain folder; the agent uses FAUX, summaries use FAUX_SUMMARY (or `compactorModel`). `local`
 * adds a local server under FAUX_SUMMARY's id, so the picker's Local group reaches the summary faux.
 */
export function world(options: { compactorModel?: string; local?: boolean } = {}): { root: string; config: HarnessConfig; configPath: string } {
	const root = mkdtempSync(join(tmpdir(), "orrery-pi-"));
	dirs.push(root);
	for (const folder of ["agent-Atlas", "agent-Birch", "plain"]) mkdirSync(join(root, folder));
	writeFileSync(join(root, "agent-Atlas", "AGENTS.md"), "You are Atlas.");
	const model = `${FAUX.provider}/${FAUX.model}`;
	const summaries = options.compactorModel ?? `${FAUX_SUMMARY.provider}/${FAUX_SUMMARY.model}`;
	const agent = (name: string, extra = "") =>
		`[agents.${name}]\nfolder = ${JSON.stringify(join(root, `agent-${name}`))}\nmodel = "${model}"\ncompactor_model = "${summaries}"\ncompactor_thinking = "off"\n${extra}`;
	const local = options.local
		? `[[providers]]\nid = "${FAUX_SUMMARY.provider}"\nbase_url = "http://127.0.0.1:9"\n[[providers.models]]\nid = "${FAUX_SUMMARY.model}"\ncontext_window = 128000\nmax_tokens = 16384\n`
		: "";
	const toml = `data_dir = ${JSON.stringify(join(root, "data"))}\n${local}${agent("Atlas")}${agent("Birch", 'reads = ["*"]\n')}`;
	// In its data folder, as ~/.orrery keeps it: from inside an agent's session, the CLI takes only the config that holds
	// the session's memory (src/cli/gate.ts).
	mkdirSync(join(root, "data"), { recursive: true });
	const configPath = join(root, "data", "config.toml");
	writeFileSync(configPath, toml);
	return { root, config: parseConfig(toml, root), configPath };
}

/**
 * A pi session with orrery in `cwd`; all sessions of one world share an agent dir, so a session id can be resumed.
 * `config` undefined makes orrery load its config from the default path (ORRERY_CONFIG). `session` is a session id, or
 * `{ forkFrom: file }` to start as `pi --fork <file>` does.
 */
export async function pi(root: string, cwd: string, config: HarnessConfig | undefined, session?: string | { forkFrom: string }, options: Omit<OrreryOptions, "config" | "onAgent"> = {}): Promise<PiRun> {
	const where = typeof session === "string" ? { sessionId: session } : (session ?? {});
	// With `config` undefined orrery loads its own (a new object per session): summaries use the latest one's faux.
	let loaded = config;
	const summarySources = async (cfg: HarnessConfig) => summarySourcesFor((loaded = cfg));
	const run = await startPi({
		cwd,
		agentDir: join(root, "agent"),
		extensions: [createOrrery({ summarySources, ...scratchHome(root), ...options, config, onAgent: (agent) => (latest = agent ?? latest) })],
		setSummaryResponses: (steps) => {
			if (loaded === undefined) throw new Error("orrery opened no config, so it has no summary faux");
			summarySourcesFor(loaded).summary.setResponses(steps);
		},
		...where,
	});
	runs.push(run);
	return run;
}

/** A pi session without orrery (to leave messages orrery never saw). */
export async function plainPi(root: string, cwd: string, sessionId: string): Promise<PiRun> {
	const run = await startPi({ cwd, agentDir: join(root, "agent"), extensions: [], sessionId });
	runs.push(run);
	return run;
}

export async function close(run: PiRun): Promise<void> {
	runs.splice(runs.indexOf(run), 1);
	await run.dispose();
}
