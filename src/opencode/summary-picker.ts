/**
 * The server side of OpenCode's summary-model picker (src/opencode/summary-menu.ts): what can be picked, Orrery's
 * sources and OpenCode's models, and the test-then-switch every surface uses (summary-text.ts switchSummaryModel), an
 * OpenCode model tested with the same one small call through OpenCode.
 */

import type { Message } from "@earendil-works/pi-ai";
import { agentTarget } from "../agent/compactor-menu.ts";
import { type ModelChoice, parseModelChoice, THINKING_LEVELS } from "../agent/config.ts";
import type { MemoryAgent } from "../agent/memory-agent.ts";
import { FREE_REASON, isOpenCodeChoice, OPENCODE_SOURCE } from "../agent/opencode-source.ts";
import { entryFor, GROUP_TITLES, listModels, listSources, loginHint, providerLabel, type SourceGroup, type SummarySources, type TestResult, testChoice, usable } from "../agent/summary-sources.ts";
import { contextText, NotSwitched, priceText, switchSummaryModel } from "../agent/summary-text.ts";
import { summaryLine } from "../agent/agent-commands.ts";
import type { MenuData, MenuGroup, MenuModel, SwitchResult } from "./summary-menu.ts";
import type { OpenCodeModel, OpenCodeSummaries } from "./summaries.ts";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const firstLine = (error: unknown) => (errorText(error).split("\n")[0] as string).trim().replace(/\.+$/, "");

/** A model's line in the picker: id, context, price (when there is one). */
const title = (id: string, contextWindow: number, price?: { readonly input: number; readonly output: number }) =>
	[id, ...(contextWindow > 0 ? [contextText(contextWindow)] : []), ...(price === undefined ? [] : [priceText(price)])].join("  ·  ");

/** The thinking levels an OpenCode model takes: off (its default), then the variants that are Orrery's levels. */
function openCodeLevels(model: OpenCodeModel): string[] {
	return ["off", ...THINKING_LEVELS.filter((level) => level !== "off" && model.variants.includes(level))];
}

/** Orrery's models for `provider`, as the picker lists them. */
export function orreryModels(sources: SummarySources, provider: string, current: ModelChoice): MenuModel[] {
	return listModels(sources, provider).map((model) => ({
		provider,
		modelId: model.id,
		title: title(model.id, model.contextWindow, model.price),
		thinking: [...THINKING_LEVELS],
		current: current.provider === provider && current.modelId === model.id,
	}));
}

/** What the picker offers for `memory`: Orrery's sources (from `sources`), then OpenCode's models. */
export async function menuData(memory: MemoryAgent | undefined, sources: SummarySources | undefined, opencode: OpenCodeSummaries): Promise<MenuData> {
	if (memory === undefined || sources === undefined) return { line: "", thinking: "off", groups: [], problem: "Orrery: this agent's memory is not open for writing in this OpenCode, so its summary model can't be changed here." };
	const current = memory.compactorModel;
	const entries = await listSources(sources);
	const currentGroup: string | undefined = isOpenCodeChoice(current) ? "opencode" : entryFor(sources.config, current.provider)?.group;
	const groups: MenuGroup[] = [];
	for (const group of ["signin", "key", "local"] as const satisfies readonly SourceGroup[]) {
		const inGroup = entries.filter((entry) => entry.group === group);
		if (inGroup.length === 0) continue;
		groups.push({
			key: group,
			title: GROUP_TITLES[group],
			current: currentGroup === group,
			providers: inGroup.map((entry) => ({
				key: entry.provider,
				title: providerLabel(entry.provider),
				current: entry.provider === current.provider,
				...(usable(entry) ? {} : { unavailable: entry.note ?? `${entry.state}; in a shell: ${loginHint(sources.config, entry.provider)}` }),
			})),
		});
	}
	const models = await opencode.refresh();
	const byProvider = new Map<string, OpenCodeModel[]>();
	for (const model of models) byProvider.set(model.providerID, [...(byProvider.get(model.providerID) ?? []), model]);
	if (byProvider.size > 0) {
		groups.push({
			key: OPENCODE_SOURCE,
			title: "OpenCode",
			current: currentGroup === OPENCODE_SOURCE,
			providers: [...byProvider].map(([providerID, list]) => ({
				key: providerID,
				title: `OpenCode · ${providerID}`,
				current: isOpenCodeChoice(current) && current.modelId.startsWith(`${providerID}/`),
				models: list.map((model) => ({
					provider: OPENCODE_SOURCE,
					modelId: `${model.providerID}/${model.id}`,
					title: `${title(model.id, model.contextWindow, model.price)}${model.free ? "  ·  free tier, unavailable" : ""}`,
					...(model.free ? { unavailable: FREE_REASON } : {}),
					thinking: openCodeLevels(model),
					current: isOpenCodeChoice(current) && current.modelId === `${model.providerID}/${model.id}`,
				})),
			})),
		});
	}
	const configured = memory.config.compactor.model;
	return {
		line: summaryLine(current, memory.compactorSource),
		thinking: current.thinking,
		groups,
		...(memory.compactorSource === "chat" ? { configured: `${configured.provider}/${configured.modelId}` } : {}),
	};
}

/** The test before a switch to an OpenCode model: one small call through OpenCode, as testChoice makes for Orrery's. */
export async function testOpenCode(opencode: OpenCodeSummaries, choice: ModelChoice, timeoutMs = 60_000): Promise<TestResult> {
	const name = `${choice.provider}/${choice.modelId}`;
	const why = opencode.unavailable(choice.modelId);
	if (why !== undefined) return { ok: false, reason: why };
	const signal = AbortSignal.timeout(timeoutMs);
	const turn = { role: "user", content: [{ type: "text", text: "Reply with OK." }], timestamp: Date.now() } as Message;
	try {
		const text = await opencode.complete(choice.modelId, "Reply with one word.", [turn], { signal, ...(choice.thinking === "off" ? {} : { reasoning: choice.thinking }) });
		return text.trim() ? { ok: true } : { ok: false, reason: `${name} answered with nothing` };
	} catch (error) {
		return { ok: false, reason: signal.aborted ? `${name} did not answer within ${timeoutMs / 1000} s` : firstLine(error) };
	}
}

/** A pick from the picker, tested and switched to (or back to the config's model): what to show. */
export async function switchTo(memory: MemoryAgent | undefined, sources: SummarySources | undefined, opencode: OpenCodeSummaries, input: unknown): Promise<SwitchResult> {
	if (memory === undefined || sources === undefined) return { ok: false, text: "Orrery: this agent's memory is not open for writing in this OpenCode, so its summary model can't be changed here." };
	const asked = (input ?? {}) as { provider?: unknown; modelId?: unknown; thinking?: unknown; reset?: unknown };
	let choice: ModelChoice | undefined;
	try {
		if (asked.reset !== true) {
			if (typeof asked.provider !== "string" || typeof asked.modelId !== "string" || typeof asked.thinking !== "string") throw new Error("the pick names no model");
			choice = parseModelChoice(`${asked.provider}/${asked.modelId}`, asked.thinking);
		}
	} catch (error) {
		return { ok: false, text: `Not switched: ${firstLine(error)}.` };
	}
	const test = (from: SummarySources, picked: ModelChoice) => (isOpenCodeChoice(picked) ? testOpenCode(opencode, picked) : testChoice(from, picked));
	try {
		return { ok: true, text: await switchSummaryModel(sources, agentTarget(memory), choice, test) };
	} catch (error) {
		if (error instanceof NotSwitched) return { ok: false, text: error.message };
		return { ok: false, text: `Not switched: ${firstLine(error)}.` };
	}
}
