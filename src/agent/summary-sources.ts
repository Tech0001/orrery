/**
 * Where an agent's summaries come from (spec 2026-10-07-summary-sources-design §4.1): the picker's groups, orrery's saved
 * logins, model lists, failure wording and the test call before a switch. Data only; the shell, pi, Claude Code and a
 * later TUI format it.
 */

import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import { agentForCwd, type HarnessConfig, type AgentConfig, type ModelChoice } from "./config.ts";
import { credentialOrigin, FileCredentialStore } from "./credentials.ts";
import { agentModelSource, sourceCompactorModel } from "./model-source.ts";
import { createAgentModels, savedSummaryLoginsOnly } from "./models.ts";
import { explainFailure, providerLabel } from "./source-labels.ts";

export { explainFailure, providerLabel } from "./source-labels.ts";

export type SourceGroup = "signin" | "key" | "local";
export const GROUP_TITLES: Record<SourceGroup, string> = { signin: "Sign in", key: "API key", local: "Local" };

/** OpenRouter sign-in and pasted keys share one slot; OpenAI keeps its subscription and key slots apart. */
// Null-prototype tables: a typed name such as "constructor" must not find an inherited member.
const plain = (entries: Record<string, string>): Record<string, string> => Object.assign(Object.create(null) as Record<string, string>, entries);
const SIGNIN = plain({ openai: "openai", openrouter: "openrouter" });
const KEYS = plain({ openai: "openai-api", anthropic: "anthropic", openrouter: "openrouter" });
const ENV = plain({ "openai-api": "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY" });
const KNOWN = new Set(["openai", ...Object.values(KEYS)]);

export interface SummarySources {
	readonly config: HarnessConfig;
	readonly credentials: CredentialStore;
	readonly models: Models;
	readonly savedLoginsOnly?: boolean;
}

/** orrery's own logins and models: the same for the shell, pi and Claude Code's holder. */
export function summarySources(config: HarnessConfig, credentials: CredentialStore = new FileCredentialStore(config.credentialsPath), agent: Pick<AgentConfig, "launcher"> | undefined = agentForCwd(config, process.cwd())): SummarySources {
	const savedLoginsOnly = savedSummaryLoginsOnly(agent);
	return { config, credentials, savedLoginsOnly, models: createAgentModels({ credentials, providers: config.providers, savedLoginsOnly }) };
}

/** summarySources, after the one-time move of an old OpenAI key. A credential file it cannot read is left for use to report. */
export async function openSummarySources(config: HarnessConfig, agent?: Pick<AgentConfig, "launcher">): Promise<SummarySources> {
	const sources = summarySources(config, undefined, agent);
	try {
		await moveOpenAIKey(sources.credentials);
	} catch {
		// The same error comes back, worded, where the login is used.
	}
	return sources;
}

/** Before sign-in and key were apart, an OpenAI key sat under "openai"; it moves to "openai-api" once. */
export async function moveOpenAIKey(credentials: CredentialStore): Promise<boolean> {
	const old = await credentials.read("openai");
	if (old?.type !== "api_key") return false;
	if ((await credentials.read("openai-api")) === undefined) await credentials.modify("openai-api", async () => old);
	await credentials.delete("openai");
	return true;
}

function localIds(config: HarnessConfig): Record<string, string> {
	return plain(Object.fromEntries(config.providers.map((p) => [p.id, p.id])));
}

function table(config: HarnessConfig, group: SourceGroup): Record<string, string> {
	return group === "signin" ? SIGNIN : group === "key" ? KEYS : localIds(config);
}

/** What a refusal says when a key was typed where a provider name goes. The typed text is never repeated. */
export const KEY_NOT_NAME = "That looks like a key, not a provider name: run `orrery login --key <openai|anthropic|openrouter>` and paste it at the hidden prompt.";

/** Whether text typed as a name looks like a key instead (kept simple on purpose). */
export function looksLikeKey(text: string): boolean {
	return /^sk-/i.test(text) || text.length > 40;
}

/** The registry id for a picker entry ("key", "openrouter" → "openrouter"), or a plain error that never repeats `name`. */
export function providerFor(config: HarnessConfig, group: SourceGroup, name: string): string {
	const names = table(config, group);
	const id = names[name];
	if (id !== undefined) return id;
	if (looksLikeKey(name)) throw new Error(KEY_NOT_NAME);
	const known = Object.keys(names);
	throw new Error(known.length === 0 ? `No ${GROUP_TITLES[group]} sources are configured.` : `${GROUP_TITLES[group]} has ${known.join(", ")}.`);
}

/** The picker entry a registry id belongs to, for display; undefined for providers outside the picker (tests' fakes). */
export function entryFor(config: HarnessConfig, provider: string): { group: SourceGroup; name: string } | undefined {
	for (const group of ["signin", "key", "local"] as const) {
		const found = Object.entries(table(config, group)).find(([, id]) => id === provider);
		if (found !== undefined) return { group, name: found[0] };
	}
	return undefined;
}

/** The shell command that saves a login for `provider`. */
export function loginHint(config: HarnessConfig, provider: string): string {
	const entry = entryFor(config, provider);
	if (entry?.group === "signin") return `orrery login ${entry.name}`;
	if (entry?.group === "key") return `orrery login --key ${entry.name}`;
	return "a local server needs no login";
}

export type SourceState = "saved" | "from env" | "not signed in" | "not saved" | "unusable" | "no login needed";

export interface SourceEntry {
	readonly group: SourceGroup;
	readonly name: string;
	readonly provider: string;
	readonly state: SourceState;
	readonly note?: string;
}

/** Whether a source can be picked now. */
export function usable(entry: SourceEntry): boolean {
	return entry.state === "saved" || entry.state === "from env" || entry.state === "no login needed";
}

/** Every source in picker order, with what is saved. Never reads a key's value. */
export async function listSources(sources: SummarySources, env: NodeJS.ProcessEnv = process.env): Promise<SourceEntry[]> {
	const savedOnly = sources.savedLoginsOnly || savedSummaryLoginsOnly(undefined, env);
	const saved = new Map((await sources.credentials.list()).map((c) => [c.providerId, c]));
	const openrouter = saved.get("openrouter");
	const routerNote = openrouter === undefined ? {} : { note: credentialOrigin(openrouter) === "signin" ? "from sign-in" : "pasted key" };
	const entries: SourceEntry[] = [];
	for (const [name, provider] of Object.entries(SIGNIN)) {
		entries.push({ group: "signin", name, provider, state: provider === "openrouter" ? (openrouter?.type === "api_key" ? "saved" : !savedOnly && env.OPENROUTER_API_KEY ? "from env" : savedOnly ? "not signed in" : "not saved") : saved.get(provider)?.type === "oauth" ? "saved" : "not saved", ...(provider === "openrouter" ? routerNote : {}) });
	}
	for (const [name, provider] of Object.entries(KEYS)) {
		const type = saved.get(provider)?.type;
		if (provider === "anthropic" && type === "oauth") {
			entries.push({ group: "key", name, provider, state: "unusable", note: "a Claude Pro/Max sign-in; summaries need an API key: orrery login --key anthropic" });
		} else {
			entries.push({ group: "key", name, provider, state: type !== undefined ? "saved" : !savedOnly && env[ENV[provider]] ? "from env" : "not saved", ...(provider === "openrouter" ? routerNote : {}) });
		}
	}
	for (const name of Object.keys(localIds(sources.config))) entries.push({ group: "local", name, provider: name, state: "no login needed" });
	return entries;
}

export interface ModelEntry {
	readonly id: string;
	readonly name: string;
	readonly contextWindow: number;
	/** Dollars per million tokens, for key sources. */
	readonly price?: { readonly input: number; readonly output: number };
}

/** A source's chat models, sorted by id, keeping those whose id or name holds every word of `filter`. */
export function listModels(sources: SummarySources, provider: string, filter = ""): ModelEntry[] {
	let models = sources.models.getModels(provider);
	// A ChatGPT sign-in reaches only the plan's models, which are pi's Codex catalog (as availableModels does).
	if (provider === "openai") {
		const plan = new Set(sources.models.getModels("openai-codex").map((m) => m.id));
		models = models.filter((m) => plan.has(m.id));
	}
	const priced = provider !== "openai" && !(provider in localIds(sources.config));
	const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
	return models
		.filter((m) => words.every((w) => `${m.id} ${m.name}`.toLowerCase().includes(w)))
		.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, ...(priced ? { price: { input: m.cost.input, output: m.cost.output } } : {}) }))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** Environment variables pi-ai reads Anthropic bearer tokens from (checkAuth's `source`): Pro/Max-style, not API keys. */
const PRO_MAX_ENV = new Set(["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]);

/** A failure's reason is a clause without its closing period: every caller ends the sentence ("Not switched: <reason>. …"). */
export type TestResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** One small call with `choice` before a switch (spec §4.4). Login checks come first, so they cost no request. */
export async function testChoice(sources: SummarySources, choice: ModelChoice, timeoutMs = 60_000): Promise<TestResult> {
	const name = `${choice.provider}/${choice.modelId}`;
	if (sources.models.getModel(choice.provider, choice.modelId) === undefined) return { ok: false, reason: `unknown model ${name}` };
	if (KNOWN.has(choice.provider)) {
		const auth = await sources.models.checkAuth(choice.provider);
		if (auth === undefined) return { ok: false, reason: `no login saved for ${providerLabel(choice.provider)}; ${loginHint(sources.config, choice.provider)}` };
		// Sign in means the ChatGPT sign-in: an exported OPENAI_API_KEY must not stand in for it.
		if (choice.provider === "openai" && auth.type !== "oauth") return { ok: false, reason: "no ChatGPT sign-in saved; orrery login openai" };
		// Anthropic is key-only: neither a stored Pro/Max sign-in nor a Pro/Max-style token from the environment.
		if (choice.provider === "anthropic" && (auth.type === "oauth" || PRO_MAX_ENV.has(auth.source ?? ""))) {
			return { ok: false, reason: "Anthropic is signed in with Claude Pro/Max, which summaries may not use; save a key: orrery login --key anthropic" };
		}
	}
	const { model } = sourceCompactorModel(agentModelSource(sources.models), choice, "compactor-test");
	const signal = AbortSignal.timeout(timeoutMs);
	// The limit holds even for a model that ignores its abort signal: the call is raced against it.
	const call = model.complete("Reply with one word.", [{ role: "user", blocks: ["Reply with OK."] }], signal);
	call.catch(() => {}); // a late failure after the time is up is not this test's
	const timeUp = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
	try {
		const reply = await Promise.race([call, timeUp]);
		return reply.text.trim() ? { ok: true } : { ok: false, reason: `${name} answered with nothing` };
	} catch (error) {
		if (signal.aborted) return { ok: false, reason: `${name} did not answer within ${timeoutMs / 1000} s` };
		// A provider's own message may end its sentence ("Connection error."); an ellipsis stays.
		return { ok: false, reason: explainFailure(choice.provider, error instanceof Error ? error.message : String(error)).replace(/(?<!\.)\.$/, "") };
	}
}
