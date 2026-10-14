/** The text the shell, Claude Code and pi (with arguments) show for summary sources (spec 2026-10-07-summary-sources-design §3). */

import { type HarnessConfig, type ModelChoice, parseModelChoice } from "./config.ts";
import { summaryLine } from "./agent-commands.ts";
import {
	GROUP_TITLES,
	KEY_NOT_NAME,
	listModels,
	listSources,
	usable,
	looksLikeKey,
	type ModelEntry,
	providerFor,
	providerLabel,
	type SourceEntry,
	type SourceGroup,
	type SummarySources,
	type TestResult,
	testChoice,
} from "./summary-sources.ts";

/** "Sign in   openai       saved", one line per source, the group named on its first line. */
export function formatSources(entries: readonly SourceEntry[]): string {
	let group: string | undefined;
	return entries
		.map((entry) => {
			const title = entry.group === group ? "" : GROUP_TITLES[entry.group];
			group = entry.group;
			return `${title.padEnd(10)}${entry.name.padEnd(13)}${entry.state}${entry.note ? ` (${entry.note})` : ""}`;
		})
		.join("\n");
}

export type CompactorRequest =
	| { readonly kind: "show" }
	| { readonly kind: "reset" }
	| { readonly kind: "providers"; readonly group: SourceGroup }
	| { readonly kind: "models"; readonly group: SourceGroup; readonly name: string; readonly filter: string }
	| { readonly kind: "switch"; readonly ref: string; readonly thinking?: string };

const GROUP_WORDS: Record<string, SourceGroup> = Object.assign(Object.create(null) as Record<string, SourceGroup>, { signin: "signin", "sign-in": "signin", key: "key", local: "local" });

/** `/compactor` arguments. The provider is the text before the first "/"; the rest, slashes and colons kept, is the model. */
export function parseCompactorArgs(config: HarnessConfig, args: readonly string[]): CompactorRequest {
	const [first, second, ...rest] = args;
	if (first === undefined) return { kind: "show" };
	if (first === "reset") return { kind: "reset" };
	const group = GROUP_WORDS[first];
	if (group === undefined) {
		// Never the typed text: it may be a key pasted in the wrong place.
		if (!first.includes("/")) throw new Error(looksLikeKey(first) ? KEY_NOT_NAME : "Unknown choice: use signin, key or local, or provider/model.");
		return { kind: "switch", ref: first, thinking: second };
	}
	if (second === undefined) return { kind: "providers", group };
	const slash = second.indexOf("/");
	if (slash < 0) return { kind: "models", group, name: second, filter: rest.join(" ") };
	return { kind: "switch", ref: `${providerFor(config, group, second.slice(0, slash))}${second.slice(slash)}`, thinking: rest[0] };
}

const MODEL_LINES = 40;

function money(n: number): string {
	return `$${n.toFixed(2)}`;
}

/** A context window as model lists show it: "200K". */
export function contextText(tokens: number): string {
	return `${Math.round(tokens / 1000)}K`;
}

/** A key source's price as model lists show it: "$1.00 in / $5.00 out per M". */
export function priceText(price: NonNullable<ModelEntry["price"]>): string {
	return `${money(price.input)} in / ${money(price.output)} out per M`;
}

/** One model per line (id, context, price), at most MODEL_LINES, then how to switch. */
export function formatModels(models: readonly ModelEntry[], heading: string, switchHint: string): string {
	const width = Math.max(0, ...models.slice(0, MODEL_LINES).map((m) => m.id.length));
	const lines = models.slice(0, MODEL_LINES).map((m) => `  ${m.id.padEnd(width)}  ${contextText(m.contextWindow).padStart(5)}${m.price ? `  ${priceText(m.price)}` : ""}`);
	if (models.length > MODEL_LINES) lines.push(`  … and ${models.length - MODEL_LINES} more; add words to narrow`);
	return [heading, ...lines, switchHint].join("\n");
}

/** What `/compactor` acts on: the agent's current choice, its config model, and how to apply a new one (undefined: back to the config). */
export interface CompactorTarget {
	current(): { choice: ModelChoice; source: "config" | "chat" };
	configured(): ModelChoice;
	apply(choice: ModelChoice | undefined): Promise<string>;
}

/** A switch refused because its test call failed; the agent keeps its current model. */
export class NotSwitched extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotSwitched";
	}
}

/**
 * The one test-then-switch every surface uses (spec §4.4): tests `choice`, or for a reset (undefined) the agent's config
 * model, and applies it only after the test passes. Throws NotSwitched, naming the model the agent stays on, otherwise.
 */
export async function switchSummaryModel(sources: SummarySources, target: CompactorTarget, choice: ModelChoice | undefined, test: (sources: SummarySources, choice: ModelChoice) => Promise<TestResult> = testChoice): Promise<string> {
	const result = await test(sources, choice ?? target.configured());
	if (!result.ok) {
		const { choice: current } = target.current();
		throw new NotSwitched(`Not switched: ${result.reason}. Still on ${current.provider}/${current.modelId}.`);
	}
	return target.apply(choice);
}

/** `/compactor <args>` for the shell, Claude Code and pi: lists, or tests then switches. Throws on a refused switch. */
export async function runCompactorText(sources: SummarySources, args: readonly string[], prefix: string, target: CompactorTarget, signin?: (name: string) => Promise<void>): Promise<string> {
	const request = parseCompactorArgs(sources.config, args);
	if ((args[0] === "signin" || args[0] === "sign-in") && args[1]?.split("/")[0] === "openrouter") {
		const entry = (await listSources(sources)).find((e) => e.group === "signin" && e.name === "openrouter");
		if (entry !== undefined && !usable(entry)) {
			if (signin === undefined) return "No OpenRouter login saved. In a terminal: orrery login openrouter (or --manual over SSH), then repeat this command.";
			await signin("openrouter");
		}
	}
	const { choice: current, source } = target.current();
	const how = [
		`Models:  ${prefix} key openrouter <words>   (or signin openai, signin openrouter, key openai, key anthropic, local <name>)`,
		`Switch:  ${prefix} key openrouter/<model> [thinking] · ${prefix} reset`,
		"Logins:  orrery login openai|openrouter · orrery login --key <openai|anthropic|openrouter>",
	].join("\n");
	switch (request.kind) {
		case "show":
			return `${summaryLine(current, source)}\n${formatSources(await listSources(sources))}\n${how}`;
		case "providers":
			return `${formatSources((await listSources(sources)).filter((e) => e.group === request.group))}\n${how}`;
		case "models": {
			const provider = providerFor(sources.config, request.group, request.name);
			const models = listModels(sources, provider, request.filter);
			const label = `${GROUP_TITLES[request.group]} · ${providerLabel(provider)}`;
			const heading = request.filter ? `${label} models matching "${request.filter}" (${models.length}):` : `${label} models (${models.length}):`;
			return formatModels(models, heading, `Switch:  ${prefix} ${request.group} ${request.name}/<model> [thinking]`);
		}
		case "reset":
		case "switch": {
			// A switch tests the new model; a reset tests the agent's config model it goes back to.
			const choice = request.kind === "switch" ? parseModelChoice(request.ref, request.thinking ?? current.thinking) : undefined;
			return switchSummaryModel(sources, target, choice);
		}
	}
}
