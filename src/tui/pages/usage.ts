/**
 * Page 3, Usage (spec §3.3): tokens per lane per day, agent and summaries, with the share read from cache, and what
 * summaries on API keys cost at the catalog's price.
 */

import { dollarText, type ModelPrice, type SummaryCost, totalCost, usageCost } from "../../lane/overview.ts";
import type { UsageRow } from "../../memory/index.ts";
import type { App, Page } from "../app.ts";
import { type Column, compactCount, fit, renderTable } from "../table.ts";

export const USAGE_SPANS = [1, 7, 14, 30, 90] as const;

const COLUMNS: readonly Column[] = [
	{ title: "Lane", width: 12 },
	{ title: "Day", width: 10 },
	{ title: "Agent in", width: 8, align: "right" },
	{ title: "cache-read", width: 10, align: "right", drop: 3 },
	{ title: "share", width: 6, align: "right", drop: 1 },
	{ title: "out", width: 8, align: "right", drop: 6 },
	{ title: "Summaries in", width: 12, align: "right" },
	{ title: "cache-read", width: 10, align: "right", drop: 4 },
	{ title: "share", width: 6, align: "right", drop: 2 },
	{ title: "out", width: 8, align: "right", grow: true, drop: 7 },
	// Summaries' cost: it stays at 100 columns (after the shares and cache reads go), not at 60.
	{ title: "Cost", width: 8, align: "right", drop: 5 },
];

/** One lane's day: its token cells and its summaries' rows; `row` adds the Cost cell, made when the prices change. */
interface Group {
	readonly cells: readonly string[];
	readonly summaries: readonly UsageRow[];
	row: readonly string[];
	/** `row` in lower case, for the filter. */
	text: string;
}

interface State {
	span: number;
	groups: Group[];
	/** When `groups` were read (ms), or undefined before the first read. */
	at?: number;
	/** The catalog's prices: asked for once, when the page first reads usage; each model is looked up once. */
	pricing?: "loading" | "failed" | { readonly price: (provider: string, modelId: string) => ModelPrice | undefined };
	/** The line under the title: the span's API-key total. */
	costLine: string;
	/** The rows the last filter left, until the rows or the filter change. */
	shown?: { readonly filter: string; readonly rows: readonly (readonly string[])[] };
}
const states = new WeakMap<App, State>();
const state = (app: App): State => {
	let s = states.get(app);
	if (s === undefined) {
		s = { span: 1, groups: [], costLine: "" };
		states.set(app, s);
	}
	return s;
};

/** Input counts what was sent: fresh input, cache reads and cache writes. */
function totals(rows: readonly UsageRow[]): [string, string, string, string] {
	if (rows.length === 0) return ["—", "—", "—", "—"];
	const input = rows.reduce((s, r) => s + r.input + r.cacheRead + r.cacheWrite, 0);
	const cached = rows.reduce((s, r) => s + r.cacheRead, 0);
	const out = rows.reduce((s, r) => s + r.output, 0);
	return [compactCount(input), compactCount(cached), input === 0 ? "0%" : `${Math.round((100 * cached) / input)}%`, compactCount(out)];
}

const REREAD_MS = 30_000;

/** Opens the summary sources once, for the catalog's prices; the costs are made again and drawn when they arrive. */
function loadPrices(app: App, s: State): void {
	const config = app.config;
	if (s.pricing !== undefined || config === undefined) return;
	s.pricing = "loading";
	Promise.resolve()
		.then(() => app.deps.sources(config))
		.then(
			(sources) => {
				// One catalog lookup per model, however many rows and redraws there are.
				const known = new Map<string, ModelPrice | undefined>();
				const price = (provider: string, modelId: string) => {
					const ref = `${provider}/${modelId}`;
					if (!known.has(ref)) {
						let cost: ModelPrice | undefined;
						try {
							cost = sources.models.getModel(provider, modelId)?.cost;
						} catch {
							cost = undefined;
						}
						known.set(ref, cost);
					}
					return known.get(ref);
				};
				s.pricing = { price };
			},
			() => {
				s.pricing = "failed";
			},
		)
		.finally(() => {
			reprice(app, s);
			app.deps.requestRender();
		});
}

function compute(app: App): void {
	const s = state(app);
	if (app.config === undefined) return;
	loadPrices(app, s);
	s.at = app.deps.now();
	const days = USAGE_SPANS[s.span];
	s.groups = [];
	for (const lane of app.deps.usage(app.config, days)) {
		const byDay = new Map<string, UsageRow[]>();
		for (const r of lane.rows) byDay.set(r.at.slice(0, 10), [...(byDay.get(r.at.slice(0, 10)) ?? []), r]);
		for (const day of [...byDay.keys()].sort().reverse()) {
			const rows = byDay.get(day) ?? [];
			const summaries = rows.filter((r) => r.role === "compactor");
			const cells = [lane.name, day, ...totals(rows.filter((r) => r.role === "agent")), ...totals(summaries)];
			s.groups.push({ cells, summaries, row: cells, text: "" });
		}
	}
	reprice(app, s);
}

/** The Cost cell: "$0.11", "<$0.01", "plan", "—" (a local server, or no summaries), "?" (no price), "…" (prices coming). */
function costCell(costs: readonly SummaryCost[], loading: boolean): string {
	const total = totalCost(costs);
	if (total === undefined || total.kind === "local") return "—";
	if (total.kind === "plan") return "plan";
	if (total.kind === "unknown") return loading ? "…" : "?";
	return dollarText(total.dollars);
}

/**
 * Prices every summaries row (API-key rows are unknown until the prices arrive, or when they can't be had) and makes
 * each row's Cost cell and the total line. Runs when usage is read and when the prices arrive, never while drawing.
 */
function reprice(app: App, s: State): void {
	const config = app.config;
	const days = USAGE_SPANS[s.span];
	const span = `over ${days} ${days === 1 ? "day" : "days"}`;
	const loading = s.pricing === "loading" || s.pricing === undefined;
	const price = typeof s.pricing === "object" ? s.pricing.price : () => undefined;
	let dollars = 0;
	let unknown = false;
	for (const group of s.groups) {
		const costs = config === undefined ? [] : group.summaries.map((row) => usageCost(row, config, price));
		for (const cost of costs) {
			if (cost.kind === "api") dollars += cost.dollars;
			else if (cost.kind === "unknown") unknown = true;
		}
		group.row = [...group.cells, costCell(costs, loading)];
		group.text = group.row.join(" ").toLowerCase();
	}
	s.costLine = loading
		? `Summaries on API keys: … ${span}`
		: `Summaries on API keys: ${dollarText(dollars)} ${span} · sign-in use is part of your plan${unknown ? " · ? = no price known" : ""}`;
	s.shown = undefined;
}

/** The rows the filter leaves (kept until the rows or the filter change). */
function visible(app: App): readonly (readonly string[])[] {
	const s = state(app);
	const filter = app.filterText();
	if (s.shown?.filter !== filter) {
		const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
		s.shown = { filter, rows: s.groups.filter((g) => words.every((w) => g.text.includes(w))).map((g) => g.row) };
	}
	return s.shown.rows;
}

export const usagePage: Page = {
	id: "usage",
	title: "Usage",
	hints: "+ more days · - fewer days",
	// Reading usage opens every lane's database: on showing the page and on + / -, else at most every 30 s.
	show: compute,
	refresh: (app) => {
		const s = state(app);
		if (s.at === undefined || app.deps.now() - s.at >= REREAD_MS) compute(app);
	},
	count: (app) => visible(app).length,
	render(app, width, height) {
		const s = state(app);
		const days = USAGE_SPANS[s.span];
		const rows = visible(app);
		const title = fit(`Tokens, last ${days} ${days === 1 ? "day" : "days"} (Claude Code keeps its own agent tokens: —)`, width);
		if (rows.length === 0) return [title, "", fit(s.groups.length === 0 ? "No usage recorded in this span." : "Nothing matches the filter.", width)];
		return [title, fit(s.costLine, width), ...renderTable(COLUMNS, rows, width, { selected: app.sel(), height: height - 2, theme: app.deps.theme })];
	},
	key(app, data) {
		const s = state(app);
		if (data === "+") s.span = Math.min(USAGE_SPANS.length - 1, s.span + 1);
		else if (data === "-") s.span = Math.max(0, s.span - 1);
		else return false;
		compute(app);
		return true;
	},
};
