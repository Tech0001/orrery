import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { Page } from "../../src/tui/app.ts";
import type { LaneRow } from "../../src/lane/overview.ts";
import { lanesPage } from "../../src/tui/pages/lanes.ts";
import { makeTheme } from "../../src/tui/theme.ts";
import { fakeDeps, keys, makeApp, row, screen, settle } from "./support.ts";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";

describe("the restart marker", () => {
	const lanes = (runs: string | undefined, installed: string | undefined, running = "0.6.0") =>
		makeApp(fakeDeps({ installedVersion: () => installed, about: () => ({ version: "0.6.0", root: "/opt/orrery", running }) }, [row({ name: "Alpha", state: "open", openIn: "pi", ...(runs === undefined ? {} : { runsVersion: runs }) })]), [lanesPage]);

	it("marks a lane older than the installed current version, whatever this TUI runs", () => {
		expect(screen(lanes("0.6.0", "0.6.1"))).toMatch(/Alpha\s+pi\s+open · on 0\.6\.0, restart for 0\.6\.1/);
		// a TUI left running on 0.6.0 does not tell a lane on 0.6.1 to restart
		expect(screen(lanes("0.6.1", "0.6.1"))).not.toContain("restart for");
	});

	it("marks a lane on another local build of the same release, and one on a local build when the release is current", () => {
		// The State column holds 42 characters, so the second local build's name is cut short.
		expect(screen(lanes("0.6.0-aaa1111", "0.6.0-bbb2222"))).toMatch(/open · on 0\.6\.0-aaa1111, restart for 0\.6\./);
		expect(screen(lanes("0.6.1-aaa1111", "0.6.1"))).toMatch(/open · on 0\.6\.1-aaa1111, restart for 0\.6\.1/);
		expect(screen(lanes("0.6.0-bbb2222", "0.6.0-bbb2222"))).not.toContain("restart for");
	});

	it("marks nothing for a lane newer than current (after a rollback), a checkout, unknown, no version, or nothing installed", () => {
		for (const text of [screen(lanes("0.6.2", "0.6.1")), screen(lanes("0.6.2-aaa1111", "0.6.1-bbb2222")), screen(lanes("checkout", "0.6.1")), screen(lanes("unknown", "0.6.1")), screen(lanes(undefined, "0.6.1")), screen(lanes("0.6.0", undefined))]) {
			expect(text).not.toContain("restart for");
		}
	});
});

describe("instructions on the Lanes page", () => {
	it("the state cell says which lanes have none, which are over 32 KB, and which open ones have newer instructions", () => {
		const app = makeApp(fakeDeps({}, [row({ name: "Alpha", instructions: "none" }), row({ name: "Birch", instructions: "too large" }), row({ name: "Cedarn", state: "open", openIn: "pi", instructionsNewer: true }), row({ name: "Dunn" })]), [lanesPage]);
		const text = screen(app, 120);
		expect(text).toMatch(/Alpha\s+pi\s+closed · no instructions\s/);
		expect(text).toMatch(/Birch\s+pi\s+closed · instructions over 32 KB\s/);
		expect(text).toMatch(/Cedarn\s+pi\s+open · new instructions: restart\s/);
		expect(text).toMatch(/Dunn\s+pi\s+closed\s+10/);
		for (const width of [60, 81, 99, 100, 120]) expect(app.render(width).every((line) => line.length <= width)).toBe(true);
	});

	it("the lane's page names its instructions", () => {
		const page = (fields: Partial<LaneRow>) => {
			const app = makeApp(fakeDeps({}, [row({ name: "Alpha", ...fields })]), [lanesPage]);
			keys(app, ENTER);
			return screen(app, 120);
		};
		expect(page({})).toMatch(/Instructions {2,}instructions\.md *\n/);
		expect(page({ state: "open", openIn: "pi", instructionsNewer: true })).toContain("instructions.md (newer than the open session's: it uses them at its next start)");
		expect(page({ instructions: "none" })).toMatch(/Instructions\s+none yet/);
		expect(page({ instructions: "too large" })).toMatch(/Instructions\s+over 32 KB: only the first 32 KB reach the model/);
		expect(page({ instructions: "none" })).toMatch(/Alpha · pi · closed · no instructions/);
	});
});

describe("the App and the Lanes page", () => {
	it("draws the page tabs and one row per lane, with its tool, state, memory and summaries", () => {
		const app = makeApp(fakeDeps({}, [row({ name: "Alpha", tool: "claude-code", state: "working", openIn: "claude-code" }), row({ name: "Cedarn", summary: { state: "failing", waiting: 3, plain: "quota reached" } })]), [lanesPage]);
		const text = screen(app);
		expect(text).toContain("1 Lanes");
		expect(text).toMatch(/› Alpha\s+Claude\s+working\s+10\s+64\/128 KB\s+ok/);
		expect(text).toMatch(/Cedarn\s+pi\s+closed\s+10\s+64\/128 KB\s+failing: quota reached/);
		expect(text).toContain("5 min");
	});

	it("drops the summary model below 100 columns and the last message below 82, and fits every width", () => {
		const app = makeApp(fakeDeps(), [lanesPage]);
		expect(screen(app, 100)).toContain("Summary model");
		expect(screen(app, 100)).toContain("gpt-6.1-sol low");
		expect(screen(app, 100)).not.toContain("openai/gpt-6.1-sol");
		expect(screen(app, 99)).not.toContain("Summary model");
		expect(screen(app, 99)).toContain("Last msg");
		expect(screen(app, 81)).not.toContain("Last msg");
		for (const width of [60, 81, 99, 100, 120]) expect(app.render(width).every((line) => line.length <= width)).toBe(true);
	});

	it("drops a leading claude- from the model in the table only", () => {
		const claude = row({ name: "Alpha", summaryModel: { ref: "anthropic/claude-sonnet-5-5", thinking: "low", source: "config" } });
		const app = makeApp(fakeDeps({}, [claude]), [lanesPage]);
		expect(screen(app, 120)).toContain("sonnet-5-5 low");
		expect(screen(app, 120)).not.toContain("claude-sonnet");
		keys(app, ENTER);
		expect(screen(app, 120)).toContain("anthropic/claude-sonnet-5-5 low");
	});

	it("moves the selection, filters with /, and clears the filter with Esc", () => {
		const app = makeApp(fakeDeps(), [lanesPage]);
		keys(app, DOWN);
		expect(screen(app)).toMatch(/› Cedarn/);
		keys(app, "/", "a", "l");
		expect(screen(app)).toContain("Alpha");
		expect(screen(app)).not.toContain("Cedarn");
		keys(app, ESC);
		expect(screen(app)).toContain("Cedarn");
	});

	it("opens a lane's page with Enter and goes back with Esc", () => {
		const app = makeApp(fakeDeps({}, [row({ name: "Alpha", toolSet: false, reads: ["*"], summary: { state: "stopped", waiting: 4, plain: "unknown model x/y" } })]), [lanesPage]);
		keys(app, ENTER);
		const text = screen(app);
		expect(text).toContain("Folder");
		expect(text).toContain("/w/alpha");
		expect(text).toContain("stopped: unknown model x/y");
		expect(text).toContain("guessed");
		expect(text).toContain("all lanes");
		keys(app, ESC);
		expect(screen(app)).toContain("Summaries");
	});

	it("shows help on ?, closes it on any key, and quits on q", () => {
		const deps = fakeDeps();
		const app = makeApp(deps, [lanesPage]);
		keys(app, "?");
		expect(screen(app)).toContain("Keys");
		keys(app, "x");
		expect(screen(app)).not.toContain("Keys");
		keys(app, "q");
		expect(deps.quits).toBe(1);
	});

	it("reads letters and digits a terminal sends Kitty-encoded (CSI u): q quits, 2 and j work", () => {
		const deps = fakeDeps();
		const app = makeApp(deps, [lanesPage, { ...lanesPage, id: "logins", title: "Logins", render: () => ["the second page"] }]);
		keys(app, "\x1b[106u"); // j
		expect(screen(app)).toMatch(/› Cedarn/);
		keys(app, "\x1b[50u"); // 2
		expect(screen(app)).toContain("the second page");
		keys(app, "\x1b[113u"); // q
		expect(deps.quits).toBe(1);
	});

	it("draws a lane's folder and data folder without their control characters", () => {
		const app = makeApp(fakeDeps({}, [row({ name: "Alpha", workspace: "/w/a\x1b]0;evil\x07b", dataDir: "/d/\x1b[31mred" })]), [lanesPage]);
		keys(app, ENTER);
		const text = screen(app);
		expect(text).toContain("/w/a]0;evilb");
		expect(text).toContain("/d/[31mred");
		expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
	});

	it("asks for a bigger window below 60 × 12, and shows a broken config without crashing", () => {
		const small = makeApp(fakeDeps({ rows: () => 10 }), [lanesPage]);
		expect(small.render(80)).toEqual(["Orrery needs a window at least 60 columns wide and 12 rows tall."]);
		const broken = makeApp(fakeDeps({ loadConfig: () => { throw new Error("config is not valid TOML: line 3"); } }), [lanesPage]);
		const text = screen(broken);
		expect(text).toContain("config is not valid TOML: line 3");
		expect(text).toContain("/c/config.toml");
		// It offers nothing that edits: the bottom line is only the way out.
		expect(broken.render(120).at(-1)?.trim()).toBe("q quit");
	});

	it("colors failing rows red and closed rows dim when colors are on", () => {
		// The first row is selected (inverse); the failing one is the second.
		const app = makeApp(fakeDeps({ theme: makeTheme(true) }, [row({ name: "Alpha" }), row({ name: "Cedarn", state: "open", summary: { state: "failing", waiting: 0, plain: "x" } })]), [lanesPage]);
		expect(screen(app)).toContain("\x1b[31m");
	});

	it("colors catching-up rows yellow and waiting rows dim", () => {
		const app = makeApp(fakeDeps({ theme: makeTheme(true) }, [row({ name: "Alpha" }), row({ name: "Busy", state: "open", summary: { state: "catching up", waiting: 2 } }), row({ name: "Idle", summary: { state: "waiting", waiting: 3 } })]), [lanesPage]);
		const lines = app.render(120);
		expect(lines.find((l) => l.includes("Busy"))?.startsWith("\x1b[33m")).toBe(true);
		expect(lines.find((l) => l.includes("Idle"))?.startsWith("\x1b[2m")).toBe(true);
	});

	it("keeps the list's selection while a lane's page is open: the arrows do nothing there", () => {
		const app = makeApp(fakeDeps(), [lanesPage]);
		keys(app, DOWN, ENTER, DOWN, "\x1b[A", "j", "k", ESC);
		expect(screen(app)).toMatch(/› Cedarn/);
	});

	it("shows a lane whose usage cannot be read as unreadable, and keeps running", () => {
		const app = makeApp(fakeDeps({ usage: () => { throw new Error("database is locked"); } }), [lanesPage]);
		keys(app, ENTER);
		expect(screen(app)).toMatch(/Tokens, 7 days\s+unreadable: database is locked/);
		keys(app, ESC);
		expect(screen(app)).toContain("Summaries");
	});

	it("writes the lane page's token counts compactly, as the Usage page does", () => {
		const usage = [{ name: "Alpha", rows: [
			{ at: "2026-10-08T09:00:00.000Z", role: "agent" as const, model: "m", input: 1_000_000, cacheRead: 4_200_000, cacheWrite: 0, output: 41_800, ok: true },
			{ at: "2026-10-08T09:00:00.000Z", role: "compactor" as const, model: "m", input: 900, cacheRead: 100, cacheWrite: 0, output: 30, ok: true },
		] }];
		const app = makeApp(fakeDeps({ usage: () => usage }), [lanesPage]);
		keys(app, ENTER);
		expect(screen(app)).toMatch(/Tokens, 7 days\s+agent 5\.2M in \(81% cached\), 41\.8K out · summaries 1\.0K in \(10% cached\), 30 out/);
	});

	it("asks the usage of the one lane whose page opens", () => {
		const asked: (string | undefined)[] = [];
		const app = makeApp(fakeDeps({ usage: (_config, _days, only) => {
			asked.push(only);
			return [];
		} }), [lanesPage]);
		keys(app, DOWN, ENTER);
		expect(asked).toEqual(["Cedarn"]);
	});

	it("puts a page's error on the status line instead of stopping", () => {
		const broken: Page = { ...lanesPage, key: () => { throw new Error("the page broke"); } };
		const app = makeApp(fakeDeps(), [broken]);
		expect(() => keys(app, "x")).not.toThrow();
		const lines = app.render(120);
		expect(lines.at(-2)).toContain("the page broke");
		expect(lines.join("\n")).toContain("Alpha");
	});

	it("runs one action at a time and shows its error in plain words", async () => {
		const app = makeApp(fakeDeps(), [lanesPage]);
		app.run("Testing", async () => {
			throw new Error("boom\x07 happened");
		});
		await app.idle();
		await settle();
		expect(screen(app)).toContain("boom happened");
	});
});

describe("the header's update notice", () => {
	const NOTICE = "Orrery 0.6.1 is available: orrery update";
	const withNotice = async (theme = fakeDeps().theme) => {
		const app = makeApp(fakeDeps({ updateNotice: async () => NOTICE, theme }), [lanesPage]);
		await settle();
		return app;
	};

	it("ends the first line after the version, dim", async () => {
		expect((await withNotice()).render(120)[0]).toMatch(/ Orrery v0\.1\.0  Orrery 0\.6\.1 is available: orrery update *$/);
		expect((await withNotice(makeTheme(true))).render(120)[0]).toContain(`\x1b[2m${NOTICE}\x1b[22m`);
	});

	it("is left out rather than cutting the version at 70 columns, and is absent without one", async () => {
		const app = await withNotice();
		const line = app.render(70)[0];
		expect(line).toContain("v0.1.0");
		expect(line).not.toContain("available");
		expect(visibleWidth(line)).toBeLessThanOrEqual(70);
		expect(makeApp(fakeDeps(), [lanesPage]).render(120)[0]).not.toContain("available");
	});

	it("survives a notice check that throws", async () => {
		const app = makeApp(fakeDeps({ updateNotice: async () => { throw new Error("offline"); } }), [lanesPage]);
		await settle();
		expect(app.render(120)[0]).toContain("v0.1.0");
	});
});

describe("the header's warning", () => {
	const failing = (name: string, state: "failing" | "stopped" = "failing") => row({ name, summary: { state, waiting: 0, plain: "quota reached" } });
	const pages = (lanes: ReturnType<typeof row>[], rows = 30, theme = fakeDeps().theme) =>
		makeApp(fakeDeps({ rows: () => rows, theme }, lanes), [
			lanesPage,
			{ ...lanesPage, id: "logins", title: "Logins", render: () => ["the second page"] },
			{ ...lanesPage, id: "usage", title: "Usage" },
			{ ...lanesPage, id: "tools", title: "Tools" },
		]);

	it("says nothing when no lane needs attention", () => {
		const app = pages([row({ name: "Alpha" }), row({ name: "Cedarn", summary: { state: "catching up", waiting: 3 } })]);
		expect(app.render(120)[0]).not.toContain("⚠");
		expect(app.render(120)[0]).toMatch(/Orrery v0\.1\.0 *$/);
	});

	it("names one lane after Orrery's version, with its state's word: failing, stopped or unreadable", () => {
		expect(pages([row({ name: "Alpha" }), failing("Cedarn")]).render(120)[0]).toMatch(/ Orrery v0\.1\.0  ⚠ Cedarn summaries failing *$/);
		expect(pages([failing("Cedarn", "stopped")]).render(120)[0]).toContain("⚠ Cedarn summaries stopped");
		const unreadable = row({ name: "Cedarn", unreadable: "disk I/O error", summary: { state: "stopped", waiting: 0, plain: "memory unreadable: disk I/O error" } });
		expect(pages([unreadable]).render(120)[0]).toContain("⚠ Cedarn summaries unreadable");
	});

	it("counts several lanes and names as many as fit, on every page", () => {
		const lanes = [failing("Alpha"), row({ name: "Okay" }), failing("Cedarn", "stopped"), failing("Gamma")];
		const app = pages(lanes);
		expect(app.render(120)[0]).toContain("⚠ 3 lanes need attention (Alpha, Cedarn, Gamma)");
		keys(app, "2");
		expect(screen(app)).toContain("the second page");
		expect(app.render(120)[0]).toContain("⚠ 3 lanes need attention (Alpha, Cedarn, Gamma)");
		expect(app.render(80)[0]).toMatch(/ Orrery v0\.1\.0  ⚠ 3 lanes need attention \(Alpha, Cedarn, …\) *$/);
		const many = pages(["Andromeda", "Betelgeuse", "Cassiopeia", "Hazeloladus", "Eridanus"].map((n) => failing(n)));
		const line = many.render(90)[0];
		expect(line).toContain("⚠ 5 lanes need attention (Andromeda, Betelgeuse, …)");
		expect(visibleWidth(line)).toBeLessThanOrEqual(90);
		// Too narrow for any name: the count alone.
		expect(many.render(64)[0]).toMatch(/ Orrery v0\.1\.0  ⚠ 5 lanes need attention *$/);
	});

	it("is red when colours are on", () => {
		const app = pages([failing("Cedarn")], 30, makeTheme(true));
		expect(app.render(120)[0]).toContain("\x1b[31m⚠ Cedarn summaries failing\x1b[39m");
	});

	it("follows the tabs in the one-line header when there is room, else it is left out", () => {
		const one = pages([failing("Cedarn")], 16);
		expect(one.render(120)[0]).toMatch(/^ Orrery {4}1 Lanes {3}2 Logins {3}3 Usage {3}4 Tools {2}⚠ Cedarn summaries failing *$/);
		expect(one.render(60)[0]).not.toContain("⚠");
		expect(one.render(60)[0]).toMatch(/^ Orrery {4}1 Lanes {3}2 Logins/);
	});

	it("never makes a line wider than the window, at 60 and 120 columns", () => {
		const lanes = ["Andromeda", "Betelgeuse", "Cassiopeia", "Hazeloladus", "Eridanus"].map((n) => failing(n));
		for (const theme of [fakeDeps().theme, makeTheme(true)]) {
			for (const rows of [12, 16, 30]) {
				for (const width of [60, 61, 120]) {
					for (const list of [lanes, lanes.slice(0, 1), [failing("A".repeat(32))]]) {
						for (const line of pages(list, rows, theme).render(width)) expect(visibleWidth(line), `${width}×${rows}`).toBeLessThanOrEqual(width);
					}
				}
			}
		}
	});
});

describe("a lane's last backup", () => {
	const page = (fields: Partial<ReturnType<typeof row>>, theme = fakeDeps().theme) => {
		const app = makeApp(fakeDeps({ theme }, [row({ name: "Alpha", ...fields })]), [lanesPage]);
		keys(app, ENTER);
		return app.render(120);
	};

	it("shows the day and the backup's folder on the lane's page", () => {
		expect(page({ lastBackup: "2026-10-08" }).join("\n")).toMatch(/Last backup\s+2026-10-08 {2}\(\/d\/backups\/2026-10-08\/Alpha\)/);
	});

	it("says never, with the command, when there is none; a lane without memory has nothing to back up", () => {
		expect(page({}).join("\n")).toMatch(/Last backup\s+never — run orrery backup/);
		expect(page({ hasMemory: false }).join("\n")).toMatch(/Last backup\s+never \(no memory yet\)/);
	});

	it("is yellow when older than 2 days, or never made for a lane with memory", () => {
		const color = makeTheme(true);
		const line = (lines: string[]) => lines.find((l) => l.includes("Last backup")) ?? "";
		expect(line(page({ lastBackup: "2026-10-06" }, color)).startsWith("\x1b[33m")).toBe(false);
		expect(line(page({ lastBackup: "2026-10-05" }, color)).startsWith("\x1b[33m")).toBe(true);
		expect(line(page({}, color)).startsWith("\x1b[33m")).toBe(true);
		expect(line(page({ hasMemory: false }, color)).startsWith("\x1b[33m")).toBe(false);
	});
});

describe("sorting the Lanes list with s", () => {
	const at = (time: string) => `2026-10-08T${time}:00.000Z`;
	const lanes = [
		row({ name: "Alpha", lastMessageAt: at("11:55") }),
		row({ name: "Zed", lastMessageAt: at("10:00"), summary: { state: "failing", waiting: 0, plain: "quota reached" } }),
		row({ name: "Mid", state: "open", lastMessageAt: at("11:59"), summary: { state: "catching up", waiting: 2 } }),
		row({ name: "Bravo", lastMessageAt: undefined }),
		row({ name: "echo", lastMessageAt: at("09:00"), summary: { state: "waiting", waiting: 1 } }),
		row({ name: "Kappa", lastMessageAt: at("11:00"), unreadable: "disk I/O error", summary: { state: "stopped", waiting: 0, plain: "memory unreadable" } }),
	];
	const names = lanes.map((r) => r.name);
	/** The lanes in the order the table draws them. */
	const drawn = (app: ReturnType<typeof makeApp>) => {
		const lines = app.render(120);
		const where = (name: string) => lines.findIndex((line) => new RegExp(`^[› ] ${name}\\s`).test(line));
		return names.filter((n) => where(n) !== -1).sort((a, b) => where(a) - where(b));
	};
	const hint = (app: ReturnType<typeof makeApp>) => app.render(120).at(-1) ?? "";

	it("cycles config order, name, last message and needs-attention-first, and back", () => {
		const app = makeApp(fakeDeps({}, lanes), [lanesPage]);
		expect(drawn(app)).toEqual(["Alpha", "Zed", "Mid", "Bravo", "echo", "Kappa"]);
		expect(hint(app)).toContain("s sort: config");
		keys(app, "s");
		expect(drawn(app)).toEqual(["Alpha", "Bravo", "echo", "Kappa", "Mid", "Zed"]);
		expect(hint(app)).toContain("s sort: name");
		keys(app, "s");
		expect(drawn(app)).toEqual(["Mid", "Alpha", "Kappa", "Zed", "echo", "Bravo"]);
		expect(hint(app)).toContain("s sort: last msg");
		keys(app, "s");
		expect(drawn(app)).toEqual(["Kappa", "Zed", "Mid", "echo", "Alpha", "Bravo"]);
		expect(hint(app)).toContain("s sort: attention");
		keys(app, "s");
		expect(drawn(app)).toEqual(names);
		expect(hint(app)).toContain("s sort: config");
	});

	it("keeps the selection on the same lane, and the order across refreshes", () => {
		const app = makeApp(fakeDeps({}, lanes), [lanesPage]);
		keys(app, DOWN, DOWN);
		expect(screen(app)).toMatch(/› Mid/);
		keys(app, "s");
		expect(screen(app)).toMatch(/› Mid/);
		keys(app, "s");
		expect(screen(app)).toMatch(/› Mid/);
		app.refresh();
		expect(drawn(app)[0]).toBe("Mid");
		keys(app, ENTER);
		expect(screen(app)).toContain("Mid · pi · open");
	});

	it("sorts what the filter leaves", () => {
		const app = makeApp(fakeDeps({}, lanes), [lanesPage]);
		keys(app, "s", "s", "/", "a", ENTER);
		expect(drawn(app)).toEqual(["Alpha", "Kappa", "Bravo"]);
		keys(app, DOWN);
		expect(screen(app)).toMatch(/› Kappa/);
		keys(app, "s");
		expect(drawn(app)).toEqual(["Kappa", "Alpha", "Bravo"]);
		expect(screen(app)).toMatch(/› Kappa/);
	});

	it("fits its hint and every line in the window", () => {
		const app = makeApp(fakeDeps({}, lanes), [lanesPage]);
		keys(app, "s", "s", "s");
		for (const width of [60, 100, 120]) for (const line of app.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(app.render(120).at(-1)?.trimEnd().endsWith("q quit")).toBe(true);
	});
});

describe("the help screen", () => {
	it("lists the Lanes page's A archive and s sort", () => {
		const app = makeApp(fakeDeps(), [lanesPage]);
		keys(app, "?");
		const text = screen(app);
		expect(text).toContain("A archive");
		expect(text).toMatch(/s sort \(config, name, last message, needs attention\)/);
		for (const width of [60, 120]) for (const line of app.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});

it("shows Ori in the tool column at 80 and 100 columns, and the model on the lane page", () => {
	const app = makeApp(fakeDeps({}, [row({ name: "Atlas", launcher: "ori", oriModel: "vendor/model" })]), [lanesPage]);
	for (const width of [80, 100]) {
		expect(screen(app, width)).toContain("pi · Ori");
		expect(app.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	}
	expect(screen(app, 100)).toContain("Summary model");
	keys(app, ENTER);
	expect(screen(app)).toMatch(/Launcher\s+Ori \(model vendor\/model\)/);
});
