/**
 * The "OpenCode model" summary source (spec 2026-10-16-opencode-design, "Summaries through OpenCode", and the user's
 * decision (b)): an agent's summaries made by a model OpenCode has, through Orrery's plugin, while the agent is open in
 * OpenCode (src/opencode/summaries.ts). Its refs fit Orrery's `provider/id` ones: the provider is "opencode", and the
 * model id is OpenCode's own ref, `<OpenCode provider>/<model>` (so `opencode/anthropic/claude-sonnet-4-5`, and a model
 * of OpenCode's own Zen gateway `opencode/opencode/<model>`). Opened anywhere else (pi, OMP, Claude Code, Codex,
 * `orrery compact`), such an agent's summaries wait, and say how to switch. Paid and own-key models only: OpenCode's
 * free tier is never offered. Data and words only: no OpenCode module here, so every tool can load it.
 */

import type { ModelChoice } from "./config.ts";
import type { Host } from "./view-text.ts";

/** The summary source's provider in Orrery's refs. */
export const OPENCODE_SOURCE = "opencode";

/** Whether a summary-model choice is an OpenCode model. */
export const isOpenCodeChoice = (choice: Pick<ModelChoice, "provider">): boolean => choice.provider === OPENCODE_SOURCE;

/** Why OpenCode's free models are never a summary source (the user's decision (b); OpenCode refuses them outside a chat). */
export const FREE_REASON = "OpenCode's free tier only works inside OpenCode chats; background summaries aren't allowed";

/** A model as OpenCode lists it (its model list's fields Orrery reads). */
export interface OpenCodeModelInfo {
	readonly providerID: string;
	/** The model's id in its provider. */
	readonly id: string;
	readonly cost?: readonly { readonly input?: number; readonly output?: number }[];
}

/**
 * Whether a model is OpenCode's free tier: a model of OpenCode's own gateway (the `opencode` provider, and its other
 * plans such as `opencode-go`) that charges nothing for input, by OpenCode 2.0.30's own rule (it keeps exactly these on
 * without a login: core/src/plugin/provider/opencode.ts, `!model.cost.some((cost) => cost.input > 0)`), or one whose id
 * ends in "-free". Big Pickle is free and has no "-free" in its id, so the price is the marker; the name is a second one.
 */
export function openCodeFree(model: OpenCodeModelInfo): boolean {
	const gateway = model.providerID === "opencode" || model.providerID.startsWith("opencode-");
	if (!gateway) return false;
	const charges = (model.cost ?? []).some((cost) => typeof cost.input === "number" && cost.input > 0);
	return !charges || /-free$/i.test(model.id);
}

/** An OpenCode model's ref in Orrery: `opencode/<provider>/<model>`. */
export const openCodeRef = (model: Pick<OpenCodeModelInfo, "providerID" | "id">): string => `${OPENCODE_SOURCE}/${model.providerID}/${model.id}`;

/** OpenCode's own provider and model of an OpenCode choice's model id (`<provider>/<model>`), or undefined when it has no provider. */
export function openCodeModelOf(modelId: string): { readonly providerID: string; readonly id: string } | undefined {
	const slash = modelId.indexOf("/");
	if (slash <= 0 || slash === modelId.length - 1) return undefined;
	return { providerID: modelId.slice(0, slash), id: modelId.slice(slash + 1) };
}

/**
 * The OpenCode variant a thinking level asks for: OpenCode names a model's reasoning settings by effort (none,
 * minimal, low, medium, high, xhigh, max: core/src/models-dev/variant.ts), as Orrery's levels are; "off" is "none".
 * Undefined (the model's default) when the model has no such variant.
 */
export function openCodeVariant(thinking: ModelChoice["thinking"], variants: readonly string[]): string | undefined {
	const wanted = thinking === "off" ? "none" : thinking;
	return variants.includes(wanted) ? wanted : undefined;
}

/** How a person switches an agent's summary model in `host`, for notices. */
export function compactorCommandIn(host: Host, agent: string): string {
	switch (host) {
		case "claude-code":
		case "claude-mod":
			return "/orrery:compactor";
		case "codex":
			return `orrery compactor ${agent}`;
		default:
			// pi's, OMP's and OpenCode's own /compactor.
			return "/compactor";
	}
}

/** Why an agent's summaries wait outside OpenCode (short: the status line and /memory show it). */
export const waitingForOpenCode = (agent: string, ref: string): string => `${ref} is an OpenCode model: summaries wait until ${agent} is open in OpenCode`;

/** What the person is told when an agent whose summaries use an OpenCode model opens elsewhere. */
export function openCodeElsewhere(agent: string, ref: string, host: Host): string {
	return `Orrery: ${agent}'s summaries use an OpenCode model (${ref}), which works only while ${agent} is open in OpenCode; they wait until then. To summarize here, choose another summary model with ${compactorCommandIn(host, agent)}.`;
}

/** Why a switch to an OpenCode model is refused outside OpenCode (testChoice): a clause, no closing period. */
export const OPENCODE_ONLY_INSIDE = "OpenCode models are chosen inside OpenCode, where they run: open the agent in OpenCode and use /compactor there";
