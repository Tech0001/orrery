/**
 * The summary-model picker in OpenCode (spec 2026-10-16-opencode-design, "Summaries through OpenCode"): OpenCode's TUI
 * runs `/compactor` (its TUI entry, plugin/tui.tsx), and the agent's memory is in OpenCode's server (src/opencode/
 * plugin.ts), so the two talk through a plugin RPC of OpenCode's (`ctx.rpc.register` on the server,
 * `client.rpc(definition)` in the TUI). The server says what can be picked: Orrery's own sources (Sign in, API key,
 * Local) and OpenCode's models, the current one first, OpenCode's free tier listed but not offered (with the reason);
 * the TUI asks, step by step, in OpenCode's dialogs, and the thinking level last, as pi's /compactor does; the server
 * tests the pick with one small call, then switches. This file is both sides' shared part, Node built-ins only: the TUI
 * entry packs it (plugin/tui-feed.ts).
 */

/** The RPC, as OpenCode takes a plugin's (a portable definition: JSON Schemas, no events). */
export const SUMMARY_RPC = {
	id: "orrery.summaries",
	methods: {
		menu: { input: { type: "object" }, output: { type: "object" } },
		models: { input: { type: "object" }, output: { type: "object" } },
		switch: { input: { type: "object" }, output: { type: "object" } },
	},
	events: {},
} as const;

/** A model as the picker shows it. */
export interface MenuModel {
	readonly provider: string;
	readonly modelId: string;
	/** "fake-model  ·  200K  ·  $3.00 in / $15.00 out per M". */
	readonly title: string;
	/** Why it can't be picked, when it can't (OpenCode's free tier). */
	readonly unavailable?: string;
	/** The thinking levels it takes, Orrery's names ("off" first). */
	readonly thinking: readonly string[];
	readonly current: boolean;
}

/** A provider in a group: Orrery's (its models asked for when picked) or OpenCode's (its models given). */
export interface MenuProvider {
	/** Orrery's registry id, or OpenCode's provider id for an OpenCode model. */
	readonly key: string;
	readonly title: string;
	readonly current: boolean;
	/** Why it can't be used now (no login saved), when it can't. */
	readonly unavailable?: string;
	/** OpenCode's providers carry their models; Orrery's are asked for (`models`). */
	readonly models?: readonly MenuModel[];
}

export interface MenuGroup {
	/** "signin", "key", "local" or "opencode". */
	readonly key: string;
	readonly title: string;
	readonly current: boolean;
	readonly providers: readonly MenuProvider[];
}

/** What the picker offers. */
export interface MenuData {
	/** The summary line now ("summaries: provider/id (thinking) · from config"). */
	readonly line: string;
	readonly thinking: string;
	readonly groups: readonly MenuGroup[];
	/** The config's model, for "back to the config's" (undefined: already on it). */
	readonly configured?: string;
	/** Why no picker can be shown (the memory is not open here), when it can't. */
	readonly problem?: string;
}

/** The server's answer to a switch. */
export interface SwitchResult {
	readonly ok: boolean;
	readonly text: string;
}

/** The RPC's methods, as the TUI calls them. */
export interface SummaryRpc {
	menu(): Promise<MenuData>;
	models(input: { provider: string }): Promise<{ readonly models: readonly MenuModel[] }>;
	switch(input: { provider: string; modelId: string; thinking: string } | { reset: true }): Promise<SwitchResult>;
}

/** The dialogs the picker uses (OpenCode's TUI ui.dialog.select). */
export interface MenuDialogs {
	select<V>(options: { readonly title: string; readonly options: readonly { title: string; value: V; description?: string }[]; readonly current?: V }): Promise<V | undefined>;
}

/**
 * An option that can't be picked, as OpenCode's dialog can show it: never `disabled`, which its dialog drops with its
 * description (dialog-select.tsx), but "unavailable" in its title and the reason as its description. Picking one says why.
 */
const unavailableOption = <V>(title: string, value: V, reason: string | undefined) =>
	reason === undefined ? { title, value } : { title: title.includes("unavailable") ? title : `${title}  ·  unavailable`, value, description: reason };

/**
 * /compactor and "Orrery: summary model" in the command palette, as OpenCode's TUI keymap takes a plugin's commands
 * (`context.keymap.layer`). The layer's mode is "global": without one it is OpenCode's "base" mode, which neither slash
 * completion nor the palette reads.
 */
export function summaryCommandLayer(run: () => void) {
	return {
		mode: "global" as const,
		commands: [
			{
				id: "orrery.compactor",
				title: "Orrery: summary model",
				description: "Choose the model that makes this agent's summaries",
				group: "Orrery",
				palette: true,
				slash: { name: "compactor" },
				run,
			},
		],
	};
}

/** `items`, the current one first. */
const currentFirst = <T extends { readonly current: boolean }>(items: readonly T[]): T[] => [...items.filter((item) => item.current), ...items.filter((item) => !item.current)];

const RESET = "\u0000reset";

/**
 * Walks the picker: group (and "back to the config's"), provider, model, thinking level, then asks the server to test
 * and switch. Returns what to show (a toast), or undefined when cancelled.
 */
export async function pickSummaryModel(dialogs: MenuDialogs, rpc: SummaryRpc): Promise<SwitchResult | undefined> {
	const data = await rpc.menu();
	if (data.problem !== undefined) return { ok: false, text: data.problem };
	const groups = currentFirst(data.groups);
	const groupKey = await dialogs.select<string>({
		title: `${data.line}\nSummaries from:`,
		options: [
			...groups.map((group) => ({ title: group.title, value: group.key })),
			...(data.configured === undefined ? [] : [{ title: `Back to the config's (${data.configured})`, value: RESET }]),
		],
		current: groups[0]?.key,
	});
	if (groupKey === undefined) return undefined;
	if (groupKey === RESET) return rpc.switch({ reset: true });
	const group = groups.find((each) => each.key === groupKey);
	if (group === undefined) return undefined;
	const providers = currentFirst(group.providers);
	let provider: MenuProvider | undefined = providers[0];
	if (providers.length > 1) {
		const key = await dialogs.select<string>({
			title: `${group.title}:`,
			options: providers.map((each) => unavailableOption(each.title, each.key, each.unavailable)),
			current: provider?.key,
		});
		provider = providers.find((each) => each.key === key);
	}
	if (provider === undefined) return undefined;
	if (provider.unavailable !== undefined) return { ok: false, text: `${provider.title}: ${provider.unavailable}.` };
	const models = currentFirst(provider.models ?? (await rpc.models({ provider: provider.key })).models);
	if (models.length === 0) return { ok: false, text: `${provider.title} has no models to pick.` };
	const index = await dialogs.select<number>({
		title: `${provider.title} model:`,
		options: models.map((model, at) => unavailableOption(model.title, at, model.unavailable)),
		current: models.findIndex((model) => model.unavailable === undefined),
	});
	const model = index === undefined ? undefined : models[index];
	if (model === undefined) return undefined;
	if (model.unavailable !== undefined) return { ok: false, text: `${model.title}: ${model.unavailable}.` };
	// The current level first, so Enter keeps it (as pi's /compactor).
	const now = model.thinking.includes(data.thinking) ? data.thinking : (model.thinking[0] ?? "off");
	const levels = [now, ...model.thinking.filter((level) => level !== now)];
	const thinking = await dialogs.select<string>({ title: `Thinking (now ${data.thinking}):`, options: levels.map((level) => ({ title: level, value: level })), current: now });
	if (thinking === undefined) return undefined;
	return rpc.switch({ provider: model.provider, modelId: model.modelId, thinking });
}
