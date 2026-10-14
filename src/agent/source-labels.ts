/** Plain words for providers and their failures. Provider-free on purpose: memory-agent imports this without loading any model provider. */

import { scrub } from "../import/scrub.ts";

const LABELS: Record<string, string> = { openai: "ChatGPT", "openai-api": "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter" };

export function providerLabel(provider: string): string {
	return LABELS[provider] ?? provider;
}

/** The shell command that saves a login, by registry id (a null-prototype table: no inherited names). */
const LOGIN_HINTS: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
	openai: "orrery login openai",
	"openai-api": "orrery login --key openai",
	anthropic: "orrery login --key anthropic",
	openrouter: "orrery login --key openrouter",
});

/** A provider error in plain words. Never repeats the error's text where a key could be in it. */
export function explainFailure(provider: string, error: string | undefined): string {
	const who = providerLabel(provider);
	const signin = provider === "openai";
	const text = (error ?? "").toLowerCase();
	// orrery's own registry: a sign-in whose refresh failed, or a provider with no login at all.
	if (signin && /oauth refresh failed/.test(text)) return "the ChatGPT sign-in expired or was refused (orrery login openai)";
	if (/provider is not configured|no api key for provider/.test(text)) {
		return `no ${who} login saved (${LOGIN_HINTS[provider] ?? "check the local server's api_key_env"})`;
	}
	if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.{0,20}(api key|key|token)|incorrect api key/.test(text)) {
		return signin ? "the ChatGPT sign-in expired or was refused (orrery login openai)" : `${who} refused the key`;
	}
	const limit = /\b429\b|rate.?limit|usage limit|quota|too many requests/.test(text);
	const balance = /\b402\b|insufficient|credit|balance|billing|payment required/.test(text);
	// A ChatGPT sign-in has a plan, not a balance: its quota and billing messages mean the plan limit.
	if (signin && (limit || balance)) return "the ChatGPT plan limit was reached; retrying";
	if (balance) return `the ${who} account has no balance`;
	if (limit) return `${who} rate or usage limit reached; retrying`;
	if (/\b404\b|not found|does not exist|no such model|unknown model/.test(text)) return `this model isn't available on ${who}`;
	if (/econnrefused|enotfound|etimedout|eai_again|fetch failed|network|socket hang up/.test(text)) return `can't reach ${who}`;
	const line = safeText((error ?? "unknown error").split("\n")[0]);
	return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/** Text from outside orrery made safe to show: one line, no control characters (terminal escapes), secrets scrubbed. */
export function safeText(text: string): string {
	return scrub(text.replace(/\s*[\r\n]+\s*/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "")).text;
}
