/**
 * Summary logins (spec 2026-10-08-orrery-tui-design §3.2, §4.1): saving a key, the ChatGPT sign-in, removing one, and
 * which lanes summarize with each. Shared by `orrery login | logins | logout` and the TUI. Keys are never returned,
 * shown or put in an error. Node only.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { credentialOrigin, type OrreryCredential } from "./credentials.ts";
import type { LaneRow } from "./overview.ts";
import { listSources, providerFor, providerLabel, type SourceEntry, type SummarySources } from "./summary-sources.ts";

export interface LoginRow extends SourceEntry {
	readonly label: string;
	/** The lanes whose summary model uses this login. */
	readonly lanes: readonly string[];
}

/** Every login in picker order, with what is saved and the lanes that use it. */
export async function loginRows(sources: SummarySources, lanes: readonly LaneRow[], env: NodeJS.ProcessEnv = process.env): Promise<LoginRow[]> {
	return (await listSources(sources, env)).map((entry) => ({
		...entry,
		label: providerLabel(entry.provider),
		lanes: lanes.filter((lane) => lane.summaryModel.ref.startsWith(`${entry.provider}/`)).map((lane) => lane.name),
	}));
}

/** Saves an API key for `name` (openai, anthropic, openrouter), trimmed; returns the provider's label. */
export async function saveKey(sources: SummarySources, name: string, key: string, notice?: (text: string) => void): Promise<string> {
	const provider = providerFor(sources.config, "key", name);
	const clean = key.trim();
	if (!clean) throw new Error("No key entered; nothing saved.");
	let replaced = false;
	await sources.credentials.modify(provider, async (current) => {
		replaced = provider === "openrouter" && credentialOrigin(current) === "signin";
		return { type: "api_key", key: clean } as OrreryCredential;
	});
	if (replaced) notice?.("Replaced the OpenRouter key from sign-in with a pasted key.");
	return providerLabel(provider);
}

export { signIn } from "./summary-signin.ts";

/** The API key pi's /login saved for `name` (pi's ids: openai, anthropic, openrouter). Copies keys only. */
export function readPiKey(name: string, env: NodeJS.ProcessEnv = process.env): string {
	const file = join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "auth.json");
	let data: Record<string, { type?: unknown; key?: unknown }>;
	try {
		data = JSON.parse(readFileSync(file, "utf8")) as typeof data;
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") throw new Error(`pi has no saved logins (${file} is missing).`);
		// Never the parser's message: it quotes the file, which holds keys.
		throw new Error(`${file} could not be read as JSON.`);
	}
	const entry = Object.hasOwn(data, name) ? data[name] : undefined;
	if (entry === undefined) throw new Error(`pi has no ${name} login saved.`);
	if (entry.type !== "api_key" || typeof entry.key !== "string" || !entry.key.trim()) {
		throw new Error(`pi's ${name} login is a sign-in, not an API key; only keys are copied.`);
	}
	const key = entry.key.trim();
	if (key.startsWith("!")) throw new Error(`pi gets its ${name} key from a command; enter the key with orrery login --key ${name}.`);
	// pi reads "$VAR" and "${VAR}" from its environment ("$$" and "$!" are escapes): a template, not the key itself.
	if (/\$(\{[A-Za-z_]\w*\}|[A-Za-z_])/.test(key.replace(/\$[$!]/g, ""))) {
		throw new Error(`pi gets its ${name} key from an environment variable; enter the key with orrery login --key ${name}.`);
	}
	return key;
}

/** Removes one login; says what it did. */
export async function removeLogin(sources: SummarySources, request: { readonly signin?: string; readonly key?: string }): Promise<string> {
	const provider = request.key !== undefined ? providerFor(sources.config, "key", request.key) : providerFor(sources.config, "signin", request.signin ?? "");
	const what = request.key !== undefined ? `the ${providerLabel(provider)} key` : provider === "openrouter" ? "the OpenRouter key (shared by sign-in and API key)" : "the ChatGPT sign-in";
	if ((await sources.credentials.read(provider)) === undefined) return `No ${what.replace(/^the /, "")} was saved.\n`;
	await sources.credentials.delete(provider);
	return `Removed ${what}.\n`;
}
