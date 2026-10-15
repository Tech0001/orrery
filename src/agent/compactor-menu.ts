/** The summary-model picker (pi's /compactor with no arguments, and the TUI): Sign in / API key / Local, then the provider, then the model, then the thinking level (spec §3). */

import { type ModelChoice, THINKING_LEVELS, type ThinkingLevel } from "./config.ts";
import { signIn } from "./summary-signin.ts";
import { pageOpener, summaryLine } from "./agent-commands.ts";
import type { MemoryAgent } from "./memory-agent.ts";
import { GROUP_TITLES, listModels, listSources, type ModelEntry, providerLabel, type SourceGroup, type SummarySources, usable } from "./summary-sources.ts";
import { type CompactorTarget, contextText, NotSwitched, priceText, switchSummaryModel } from "./summary-text.ts";

/** The part of pi's ctx.ui the menu uses. */
export interface MenuUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
	notify?(message: string, type?: "info" | "warning" | "error"): void;
}

/** Above this many models the menu asks for words to narrow the list first (OpenRouter lists hundreds). */
const LONG_LIST = 30;

/** The agent as /compactor's target: its current choice, its config model, and a live switch. */
export function agentTarget(agent: MemoryAgent): CompactorTarget {
	return {
		current: () => ({ choice: agent.compactorModel, source: agent.compactorSource }),
		configured: () => agent.config.compactor.model,
		apply: async (choice) => {
			agent.setCompactorModel(choice);
			return summaryLine(agent.compactorModel, agent.compactorSource);
		},
	};
}

/** "anthropic/claude-haiku-4.5  ·  200K  ·  $1.00 in / $5.00 out per M"; no price for sign-in and local models. */
function modelLine(model: ModelEntry): string {
	return [model.id, contextText(model.contextWindow), ...(model.price ? [priceText(model.price)] : [])].join("  ·  ");
}

export type Picked = { readonly choice: ModelChoice } | { readonly none: string };

/**
 * Sign in / API key / Local, then the provider, then the model (and, with askThinking, the thinking level). Returns
 * the pick, `none` with the reason nothing can be picked, `extra` when one of `options.extra` was chosen at the first
 * step, or undefined when cancelled. Tests nothing and switches nothing.
 */
export async function pickSummaryModel(
	ui: MenuUI,
	sources: SummarySources,
	options: { heading: string; thinking: ThinkingLevel; askThinking?: boolean; extra?: readonly string[]; signIn?: (name: string) => Promise<void> },
): Promise<Picked | { readonly extra: string } | undefined> {
	const entries = (await listSources(sources)).filter((e) => usable(e) || (e.group === "signin" && e.name === "openrouter"));
	const groups: SourceGroup[] = (["signin", "key", "local"] as const).filter((g) => entries.some((e) => e.group === g && usable(e)));
	if (!groups.includes("signin")) groups.push("signin");
	if (groups.length === 0) return { none: "No summary logins saved. In a shell: orrery login openai, or orrery login --key <openai|anthropic|openrouter>." };
	const extra = options.extra ?? [];
	const groupTitle = await ui.select(`${options.heading}\nSummaries from:`, [...groups.map((g) => GROUP_TITLES[g]), ...extra]);
	if (groupTitle !== undefined && extra.includes(groupTitle)) return { extra: groupTitle };
	const group: SourceGroup | undefined = groups.find((g) => GROUP_TITLES[g] === groupTitle);
	if (group === undefined) return undefined;
	const inGroup = entries.filter((e) => e.group === group);
	let entry = inGroup[0];
	if (inGroup.length > 1) {
		const name = await ui.select(`${GROUP_TITLES[group]}:`, inGroup.map((e) => providerLabel(e.provider)));
		const picked = inGroup.find((e) => providerLabel(e.provider) === name);
		if (picked === undefined) return undefined;
		entry = picked;
	}
	if (!usable(entry)) {
		await (options.signIn ?? ((name) => signInFromMenu(ui, sources, name)))(entry.name);
	}
	const label = providerLabel(entry.provider);
	let models = listModels(sources, entry.provider);
	if (models.length > LONG_LIST) {
		const words = await ui.input(`${label}: ${models.length} models. Words to narrow (e.g. haiku):`);
		if (words === undefined) return undefined;
		models = listModels(sources, entry.provider, words);
	}
	if (models.length === 0) return { none: `No ${label} model matches.` };
	const lines = models.map(modelLine);
	const line = await ui.select(`${label} model:`, lines);
	const model = models[lines.indexOf(line ?? "")];
	if (model === undefined) return undefined;
	let thinking = options.thinking;
	if (options.askThinking === true) {
		// The current level comes first, so Enter keeps it.
		const levels = [options.thinking, ...THINKING_LEVELS.filter((l) => l !== options.thinking)];
		const level = await ui.select(`Thinking (now ${options.thinking}):`, levels);
		if (level === undefined) return undefined;
		thinking = level as ThinkingLevel;
	}
	return { choice: { provider: entry.provider, modelId: model.id, thinking } };
}

/**
 * Walks the picker for `target`, the thinking level last as in the TUI, then tests and switches (switchSummaryModel);
 * returns the text to show.
 */
export async function compactorMenu(ui: MenuUI, sources: SummarySources, target: CompactorTarget): Promise<string> {
	const { choice: now, source } = target.current();
	const current = summaryLine(now, source);
	const picked = await pickSummaryModel(ui, sources, { heading: current, thinking: now.thinking, askThinking: true });
	if (picked === undefined || "extra" in picked) return current;
	if ("none" in picked) return `${current}\n${picked.none}`;
	try {
		return await switchSummaryModel(sources, target, picked.choice);
	} catch (error) {
		// The menu says why it did not switch rather than failing.
		if (error instanceof NotSwitched) return `${error.message}\n${current}`;
		throw error;
	}
}


/** pi/OMP and the TUI share the same callback/manual-code flow and cancellable prompt. */
export async function signInFromMenu(ui: MenuUI, sources: SummarySources, name: string): Promise<void> {
	let link = "";
	await signIn(sources, {
		notify: (event) => {
			if (event.type === "auth_url") {
				link = `Open this link and authorize Orrery:\n${event.url}\n`;
				if (process.env.ORRERY_NO_OPEN !== "1") pageOpener()?.open(event.url);
			} else if (event.type !== "device_code") ui.notify?.(event.message, "info");
		},
		prompt: async (prompt) => {
			const answer = await ui.input(`${link}${prompt.message}`, undefined, { signal: prompt.signal });
			if (answer === undefined) throw new Error("Sign-in cancelled.");
			return answer;
		},
	}, name);
}
