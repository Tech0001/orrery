import { describe, expect, it } from "vitest";
import type { AgentUsage } from "../../src/agent/overview.ts";
import { compactCount } from "../../src/tui/table.ts";
import { usagePage } from "../../src/tui/pages/usage.ts";
import { CONFIG, fakeDeps, keys, makeApp, row, screen, settle } from "./support.ts";

const USAGE: AgentUsage[] = [
	{
		name: "Alpha",
		rows: [
			{ at: "2026-10-08T09:00:00.000Z", role: "agent", model: "m", input: 100, cacheRead: 300, cacheWrite: 0, output: 20, ok: true },
			{ at: "2026-10-08T10:00:00.000Z", role: "compactor", model: "m", input: 50, cacheRead: 50, cacheWrite: 0, output: 5, ok: true },
		],
	},
	{ name: "Cedarn", rows: [{ at: "2026-10-07T09:00:00.000Z", role: "compactor", model: "m", input: 10, cacheRead: 0, cacheWrite: 0, output: 1, ok: true }] },
];

describe("compactCount", () => {
	it("shortens big counts with K, M and B", () => {
		const cases: [number, string][] = [[0, "0"], [351, "351"], [999, "999"], [1000, "1.0K"], [16000, "16.0K"], [391343, "391.3K"], [999999, "1.0M"], [4777703, "4.8M"], [177778662, "177.8M"], [1.2e9, "1.2B"]];
		for (const [n, text] of cases) expect(compactCount(n)).toBe(text);
	});
});

describe("the Usage page", () => {
	it("shows tokens per agent per day, its chat and its summaries, with the cached share", () => {
		const app = makeApp(fakeDeps({ usage: () => USAGE }, [row({ name: "Alpha" }), row({ name: "Cedarn", tool: "claude-code" })]), [usagePage]);
		const text = screen(app);
		expect(text).toContain("last 7 days");
		// The agent's own model's tokens are "Chat in", so they are not read as the Agent column's.
		expect(text).toMatch(/Agent\s+Day\s+Chat in\s+cache-read\s+share\s+out\s+Summaries in\s+cache-read\s+share\s+out/);
		expect(text).toMatch(/Alpha\s+2026-10-08\s+400\s+300\s+75%\s+20\s+100\s+50\s+50%\s+5/);
		expect(text).toMatch(/Cedarn\s+2026-10-07\s+—\s+—\s+—\s+—\s+10\s+0\s+0%\s+1/);
	});

	it("prints big counts compactly and fits at 60, 100 and 120 columns", () => {
		const usage: AgentUsage[] = [{ name: "Alpha", rows: [{ at: "2026-10-08T09:00:00.000Z", role: "agent", model: "m", input: 100_000_000, cacheRead: 77_778_662, cacheWrite: 0, output: 391_343, ok: true }] }];
		const app = makeApp(fakeDeps({ usage: () => usage }), [usagePage]);
		expect(screen(app, 120)).toMatch(/Alpha\s+2026-10-08\s+177\.8M\s+77\.8M\s+44%\s+391\.3K/);
		expect(screen(app, 120)).not.toContain("177778662");
		for (const width of [60, 100, 120]) expect(app.render(width).every((line) => line.length <= width)).toBe(true);
	});

	it("+ and - change the span", () => {
		const spans: number[] = [];
		const app = makeApp(fakeDeps({ usage: (_c: unknown, days: number) => (spans.push(days), []) }), [usagePage]);
		keys(app, "+");
		keys(app, "-", "-");
		expect(spans).toEqual([7, 14, 7, 1]);
		expect(screen(app)).toContain("last 1 day");
	});

	it("counts cache writes in input and shows the cache-read count", () => {
		const usage: AgentUsage[] = [{ name: "Alpha", rows: [{ at: "2026-10-08T09:00:00.000Z", role: "agent", model: "m", input: 100, cacheRead: 200, cacheWrite: 700, output: 5, ok: true }] }];
		const app = makeApp(fakeDeps({ usage: () => usage }), [usagePage]);
		expect(screen(app)).toMatch(/Alpha\s+2026-10-08\s+1\.0K\s+200\s+20%\s+5/);
	});

	it("tells an empty span from a filter that matches nothing", () => {
		const app = makeApp(fakeDeps({ usage: () => USAGE }), [usagePage]);
		keys(app, "/", "z", "z");
		expect(screen(app)).toContain("Nothing matches the filter.");
		const empty = makeApp(fakeDeps({ usage: () => [] }), [usagePage]);
		expect(screen(empty)).toContain("No usage recorded in this span.");
	});

	it("reads usage again only when shown, on + or -, or after 30 seconds", () => {
		let reads = 0;
		let now = 1_000_000;
		const app = makeApp(fakeDeps({ usage: () => (reads++, []), now: () => now }), [usagePage]);
		app.refresh();
		app.refresh();
		expect(reads).toBe(1);
		now += 31_000;
		app.refresh();
		expect(reads).toBe(2);
		keys(app, "+");
		expect(reads).toBe(3);
	});
});

describe("the Usage page's summary cost", () => {
	/** $ per million tokens, as pi-ai's catalog has them. */
	const HAIKU = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
	const summaries = (at: string, model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ at, role: "compactor" as const, model, input, cacheRead, cacheWrite, output, ok: true });
	const usage: AgentUsage[] = [
		{
			name: "Alpha",
			rows: [
				summaries("2026-10-08T09:00:00.000Z", "anthropic/claude-haiku-4-5", 100_000, 10_000, 50_000, 10_000),
				summaries("2026-10-07T09:00:00.000Z", "openai/gpt-6.1-sol", 9_000, 900),
				{ at: "2026-10-06T09:00:00.000Z", role: "agent", model: "m", input: 100, cacheRead: 0, cacheWrite: 0, output: 1, ok: true },
			],
		},
		{
			name: "Cedarn",
			rows: [
				summaries("2026-10-08T09:00:00.000Z", "bonsai/qwen-9b", 5_000, 500),
				summaries("2026-10-07T09:00:00.000Z", "openrouter/acme/mystery-1", 5_000, 500),
				summaries("2026-10-06T09:00:00.000Z", "anthropic/claude-haiku-4-5", 100, 10),
			],
		},
	];
	const asked: string[] = [];
	const sources = async () =>
		({
			models: {
				getModel: (provider: string, id: string) => {
					asked.push(`${provider}/${id}`);
					return provider === "anthropic" && id === "claude-haiku-4-5" ? { cost: HAIKU } : undefined;
				},
			},
		}) as never;
	const config = { ...CONFIG, providers: [{ id: "bonsai", baseUrl: "http://127.0.0.1:8000/v1", models: [] }] };
	const app = async (overrides: Parameters<typeof fakeDeps>[0] = {}) => {
		const made = makeApp(fakeDeps({ usage: () => usage, sources, loadConfig: () => config, ...overrides }), [usagePage]);
		await settle();
		return made;
	};

	it("prices API-key summaries from the catalog: $ with two decimals, <$0.01, plan, — and ?", async () => {
		const text = screen(await app());
		expect(text).toMatch(/Alpha\s+2026-10-08\s+—\s+—\s+—\s+—\s+160\.0K\s+50\.0K\s+31%\s+10\.0K\s+\$0\.17/);
		expect(text).toMatch(/Alpha\s+2026-10-07\s+—(\s+—){3}\s+9\.0K\s+0\s+0%\s+900\s+plan/);
		expect(text).toMatch(/Alpha\s+2026-10-06\s+100\s+0\s+0%\s+1(\s+—){5}\s*$/m);
		expect(text).toMatch(/Cedarn\s+2026-10-08(\s+—){4}\s+5\.0K\s+0\s+0%\s+500\s+—/);
		expect(text).toMatch(/Cedarn\s+2026-10-07(\s+—){4}\s+5\.0K\s+0\s+0%\s+500\s+\?/);
		expect(text).toMatch(/Cedarn\s+2026-10-06(\s+—){4}\s+100\s+0\s+0%\s+10\s+<\$0\.01/);
		expect(asked).toContain("openrouter/acme/mystery-1");
	});

	it("shows the span's API-key total under the title", async () => {
		const text = screen(await app());
		expect(text).toContain("Summaries on API keys: $0.17 over 7 days · sign-in use is part of your plan");
	});

	it("asks for the summary sources once, and draws the costs once they arrive", async () => {
		let calls = 0;
		let release: () => void = () => {};
		const slow = () => {
			calls++;
			return new Promise<never>((resolve) => {
				release = () => resolve(sources() as never);
			});
		};
		const made = makeApp(fakeDeps({ usage: () => usage, sources: slow, loadConfig: () => config }), [usagePage]);
		await settle();
		expect(screen(made)).not.toContain("$0.17");
		expect(screen(made)).toMatch(/Alpha\s+2026-10-07\s+—(\s+—){3}\s+9\.0K\s+0\s+0%\s+900\s+plan/);
		release();
		await settle();
		expect(screen(made)).toContain("$0.17");
		made.refresh();
		keys(made, "+");
		await settle();
		expect(calls).toBe(1);
	});

	it("shows ? for API-key rows when the summary sources cannot be opened", async () => {
		const text = screen(await app({ sources: async () => { throw new Error("credentials unreadable"); } }));
		expect(text).toMatch(/Alpha\s+2026-10-08\s+—\s+—\s+—\s+—\s+160\.0K\s+50\.0K\s+31%\s+10\.0K\s+\?/);
		expect(text).toMatch(/plan/);
	});

	it("prices each model once, not on every frame", async () => {
		const calls = new Map<string, number>();
		const counting = async () =>
			({
				models: {
					getModel: (provider: string, id: string) => {
						calls.set(`${provider}/${id}`, (calls.get(`${provider}/${id}`) ?? 0) + 1);
						return provider === "anthropic" && id === "claude-haiku-4-5" ? { cost: HAIKU } : undefined;
					},
				},
			}) as never;
		const made = await app({ sources: counting });
		for (let i = 0; i < 5; i++) {
			screen(made);
			keys(made, "\x1b[B");
		}
		keys(made, "+");
		made.refresh();
		await settle();
		screen(made, 100);
		expect(screen(made)).toContain("$0.17");
		expect([...calls.keys()].sort()).toEqual(["anthropic/claude-haiku-4-5", "openrouter/acme/mystery-1"]);
		expect(Math.max(...calls.values())).toBe(1);
	});

	it("keeps every line within the width at 60, 100 and 120 columns; Cost stays at 100, not at 60", async () => {
		const made = await app();
		for (const width of [60, 100, 120]) expect(made.render(width).every((line) => line.length <= width)).toBe(true);
		expect(screen(made, 120)).toMatch(/out\s+Cost/);
		expect(screen(made, 100)).toMatch(/Alpha\s+2026-10-08\s+—\s+—\s+160\.0K\s+50\.0K\s+10\.0K\s+\$0\.17/);
		expect(screen(made, 60)).not.toMatch(/\bCost\b/);
	});
});
