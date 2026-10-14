import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resetCapabilitiesCache, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOGO, LOGO_HEIGHT, LOGO_WIDTH, orreryLogo } from "../../src/tui/art.ts";
import { InputModal } from "../../src/tui/dialogs.ts";
import { agentsPage } from "../../src/tui/pages/agents.ts";
import { makeTheme, PLAIN } from "../../src/tui/theme.ts";
import { fakeDeps, keys, makeApp, screen } from "./support.ts";

const BRAILLE = /[⠁-⣿]/;
/** Only braille and spaces: no block shapes, no other characters. */
const DOTS_ONLY = /^[⠀-⣿ ]*$/;
const ESC = /\x1b/;
const PLAIN_LOGO = orreryLogo(PLAIN);
const ROOT = resolve(import.meta.dirname, "..", "..");

/** An App with no agents, so the Agents page shows its empty screen. */
const emptyApp = (rows = 30, theme = PLAIN) => makeApp(fakeDeps({ rows: () => rows, theme }, []), [agentsPage]);
/** An App with two agents and all four pages' tabs. */
const fourPages = (rows: number, theme = PLAIN, about?: () => { version: string; root: string }) =>
	makeApp(fakeDeps({ rows: () => rows, theme, ...(about === undefined ? {} : { about }) }), [
		agentsPage,
		{ ...agentsPage, id: "logins", title: "Logins" },
		{ ...agentsPage, id: "usage", title: "Usage" },
		{ ...agentsPage, id: "tools", title: "Tools" },
	]);
const hex = (color: string) => `\x1b[38;2;${[1, 3, 5].map((k) => Number.parseInt(color.slice(k, k + 2), 16)).join(";")}m`;
const colorsOf = (lines: typeof LOGO) => new Set(lines.flatMap((line) => line.map((s) => s.color)).filter((c) => c !== undefined));

beforeEach(() => setCapabilities({ images: null, trueColor: true, hyperlinks: false }));
afterEach(() => resetCapabilitiesCache());

describe("the small logo", () => {
	it("is a small braille orrery: 5 or 6 rows, 14 to 20 columns, every line exactly LOGO_WIDTH cells", () => {
		expect(LOGO_HEIGHT).toBeGreaterThanOrEqual(5);
		expect(LOGO_HEIGHT).toBeLessThanOrEqual(6);
		expect(LOGO_WIDTH).toBeGreaterThanOrEqual(14);
		expect(LOGO_WIDTH).toBeLessThanOrEqual(20);
		expect(LOGO).toHaveLength(LOGO_HEIGHT);
		for (const line of LOGO) expect(line.reduce((n, s) => n + visibleWidth(s.text), 0)).toBe(LOGO_WIDTH);
	});

	it("is plain braille, with no escape codes and no block shapes, under PLAIN", () => {
		expect(PLAIN_LOGO).toHaveLength(LOGO_HEIGHT);
		for (const line of PLAIN_LOGO) {
			expect(line).toMatch(DOTS_ONLY);
			expect(visibleWidth(line)).toBe(LOGO_WIDTH);
		}
		expect(PLAIN_LOGO.join("")).toMatch(BRAILLE);
	});

	it("has the drawing's colours: the orbits' gold, the sun's orange and at least two planets'; the same dots underneath", () => {
		const colors = colorsOf(LOGO);
		expect(colors).toContain("#b08d52");
		expect(colors).toContain("#e98a66");
		const planets = [...colors].filter((c) => !["#b08d52", "#d4ae66", "#d97757", "#e98a66"].includes(c));
		expect(planets.length).toBeGreaterThanOrEqual(2);
		const svg = readFileSync(join(ROOT, "assets", "orrery.svg"), "utf8");
		for (const c of planets) expect(svg).toContain(`fill="${c}"`);
		const colored = orreryLogo(makeTheme(true));
		expect(colored.join("")).toContain(hex("#e98a66"));
		expect(colored.join("")).toContain(hex("#b08d52"));
		expect(colored.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual(PLAIN_LOGO);
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const indexed = orreryLogo(makeTheme(true)).join("");
		expect(indexed).toContain("\x1b[38;5;");
		expect(indexed).not.toContain("\x1b[38;2;");
	});

	it("is the only artwork: art.ts and its generator hold no big drawing, and the PNG is gone; the SVG stays for the README", async () => {
		expect(Object.keys(await import("../../src/tui/art.ts")).sort()).toEqual(["LOGO", "LOGO_HEIGHT", "LOGO_WIDTH", "orreryLogo"]);
		expect(existsSync(join(ROOT, "src", "tui", "brand.ts"))).toBe(false);
		expect(readFileSync(join(ROOT, "scripts", "orrery-art.ts"), "utf8")).not.toMatch(/\bART\b|ART_WIDTH|orreryArt/);
		const png = ["orrery", "png"].join(".");
		expect(existsSync(join(ROOT, "assets", png))).toBe(false);
		expect(existsSync(join(ROOT, "assets", "orrery.svg"))).toBe(true);
		const found: string[] = [];
		const walk = (path: string) => {
			// Links are not the repository's files (a local docs/superpowers link to private notes, say).
			if (lstatSync(path).isSymbolicLink()) return;
			if (statSync(path).isDirectory()) {
				for (const name of readdirSync(path)) walk(join(path, name));
			} else if (readFileSync(path, "utf8").includes(png)) found.push(path);
		};
		for (const dir of ["src", "scripts", "test", "docs", "claude-plugin", "deploy"]) if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));
		for (const file of ["README.md", "package.json"]) walk(join(ROOT, file));
		expect(found).toEqual([]);
	});
});

describe("no big drawing on any screen", () => {
	/** Every line below the header (the logo's rows and the blank line after them): no braille there. */
	const body = (lines: string[]) => (lines[0].startsWith(` ${PLAIN_LOGO[0]}`) ? lines.slice(LOGO_HEIGHT + 1) : lines.slice(1));

	/** The screens that once had the drawing: the empty Agents page, help, the first-run welcome and a setup step. */
	const screens = (rows: number) => {
		const empty = emptyApp(rows);
		const help = emptyApp(rows);
		keys(help, "?");
		const welcome = emptyApp(rows);
		welcome.setup = true;
		const step = emptyApp(rows);
		step.setup = true;
		void step.host.open(new InputModal("Where should memory live?", "~/.orrery"));
		return { empty, help, welcome, step };
	};

	it("shows each screen's text and no braille under the header, with the header's logo when the window is tall enough", () => {
		const text = { empty: "No agents yet. Press N to add one.", help: "1-4 or ← →", welcome: "Welcome to Orrery.", step: "Where should memory live?" };
		for (const [width, rows] of [
			[120, 40],
			[120, 30],
			[80, 18],
		]) {
			for (const [name, app] of Object.entries(screens(rows))) {
				const lines = app.render(width);
				expect(lines[0].startsWith(` ${PLAIN_LOGO[0]}`), `${name} ${width}×${rows}`).toBe(true);
				expect(body(lines).join("\n"), `${name} ${width}×${rows}`).not.toMatch(BRAILLE);
				expect(lines.join("\n")).toContain(text[name as keyof typeof text]);
				app.host.closeAll();
			}
		}
		for (const [name, app] of Object.entries(screens(12))) {
			const lines = app.render(60);
			expect(lines).toHaveLength(12);
			expect(lines.join("\n"), name).not.toMatch(BRAILLE);
			expect(lines.join("\n")).toContain(text[name as keyof typeof text]);
			app.host.closeAll();
		}
	});

	it("puts the empty Agents line, help's keys and the welcome at the top of the body", () => {
		const { empty, help, welcome } = screens(30);
		expect(empty.render(120)[LOGO_HEIGHT + 1].trim()).toBe("No agents yet. Press N to add one.");
		expect(help.render(120)[LOGO_HEIGHT + 1].trim()).toBe("Keys");
		expect(welcome.render(120)[LOGO_HEIGHT + 1].trim()).toBe("Welcome to Orrery.");
	});

	it("not on the Agents page when there are agents (only the header's logo)", () => {
		const lines = makeApp(fakeDeps({ rows: () => 30 }), [agentsPage]).render(120);
		expect(lines.slice(LOGO_HEIGHT).join("\n")).not.toMatch(BRAILLE);
	});
});

describe("the header", () => {
	it("at 120×40: the logo top-left, Orrery and the version beside its first line, the tabs beside its second, the body below", () => {
		const lines = fourPages(40).render(120);
		expect(lines).toHaveLength(40);
		for (let i = 0; i < LOGO_HEIGHT; i++) expect(lines[i].startsWith(` ${PLAIN_LOGO[i]}  `)).toBe(true);
		const at = 1 + LOGO_WIDTH + 2;
		expect(lines[0].slice(at)).toMatch(/^ Orrery v0\.1\.0 *$/);
		expect(lines[1].slice(at)).toMatch(/^ 1 Agents {3}2 Logins {3}3 Usage {3}4 Tools *$/);
		// The name sits over the first tab's number.
		expect(lines[0].indexOf("Orrery")).toBe(lines[1].indexOf("1 Agents"));
		for (let i = 2; i < LOGO_HEIGHT; i++) expect(lines[i].slice(at).trim()).toBe("");
		expect(lines[LOGO_HEIGHT].trim()).toBe("");
		expect(lines[LOGO_HEIGHT + 1]).toMatch(/^ {2}Agent\s+Tool/);
		expect(lines.slice(LOGO_HEIGHT + 1).join("\n")).not.toMatch(BRAILLE);
	});

	it("with colours: the logo coloured, Orrery bold, the version dim, the current tab highlighted", () => {
		const lines = fourPages(40, makeTheme(true)).render(120);
		const head = lines.slice(0, LOGO_HEIGHT).join("\n");
		expect(head).toContain(hex("#e98a66"));
		expect(head).toContain(hex("#b08d52"));
		expect(lines[0]).toContain("\x1b[1mOrrery\x1b[22m");
		expect(lines[0]).toContain("\x1b[2mv0.1.0\x1b[22m");
		expect(lines[1]).toContain("\x1b[7m 1 Agents \x1b[27m");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
	});

	it("shows the version Orrery reports, and just the name when it cannot be read", () => {
		expect(fourPages(40, PLAIN, () => ({ version: "2.3.4", root: "/opt/orrery" })).render(120)[0]).toContain(" Orrery v2.3.4");
		const unreadable = fourPages(40, PLAIN, () => {
			throw new Error("no package.json");
		}).render(120);
		expect(unreadable[0].slice(1 + LOGO_WIDTH + 2)).toMatch(/^ Orrery *$/);
	});

	it("falls back to one line (Orrery and the tabs, no logo) at 120×16 and at 60×12", () => {
		for (const [width, height] of [
			[120, 16],
			[60, 12],
		]) {
			const lines = fourPages(height).render(width);
			expect(lines).toHaveLength(height);
			expect(lines[0]).toMatch(/^ Orrery {4}1 Agents {3}2 Logins {3}3 Usage {3}4 Tools/);
			expect(lines[0]).not.toContain("v0.1.0");
			expect(lines.join("\n")).not.toMatch(BRAILLE);
			expect(lines[1]).toMatch(/^ {2}Agent\s+Tool/);
		}
		const color = fourPages(16, makeTheme(true)).render(120);
		expect(color[0]).toContain("\x1b[1m Orrery \x1b[22m");
		expect(color[0]).not.toContain("✺");
	});

	it("never draws a line wider than the window, and keeps all four tabs, at 60, 80 and 120 columns", () => {
		for (const theme of [PLAIN, makeTheme(true)]) {
			for (const width of [60, 80, 120]) {
				for (const height of [12, 16, 18, 40]) {
					const lines = fourPages(height, theme).render(width);
					expect(lines).toHaveLength(height);
					for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					expect(lines.slice(0, LOGO_HEIGHT).join("\n")).toContain(" 4 Tools ");
				}
			}
		}
		// The logo and the tabs need 61 columns: at 60 the header is one line, at 80 it has the logo from 18 rows.
		expect(fourPages(40).render(60)[0]).toMatch(/^ Orrery {4}1 Agents/);
		expect(fourPages(40).render(80)[0].startsWith(` ${PLAIN_LOGO[0]}`)).toBe(true);
		expect(fourPages(18).render(80)[0].startsWith(` ${PLAIN_LOGO[0]}`)).toBe(true);
		expect(fourPages(17).render(80)[0]).toMatch(/^ Orrery {4}1 Agents/);
	});

	it("has no escape codes under PLAIN, on any page or screen", () => {
		const app = fourPages(40);
		expect(app.render(120).join("\n")).not.toMatch(ESC);
		keys(app, "?");
		expect(app.render(120).join("\n")).not.toMatch(ESC);
		const empty = emptyApp(40);
		expect(empty.render(120).join("\n")).not.toMatch(ESC);
		empty.setup = true;
		expect(empty.render(120).join("\n")).not.toMatch(ESC);
	});
});
