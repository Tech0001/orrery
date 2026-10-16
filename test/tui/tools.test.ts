import { homedir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { InstallStep, ToolCheck } from "../../src/agent/tools.ts";
import { toolsPage } from "../../src/tui/pages/tools.ts";
import { answer, fakeDeps, keys, makeApp, row, screen } from "./support.ts";

const ENTER = "\r";
const CHECKS: ToolCheck[] = [
	{ id: "pi", label: "pi", path: "/bin/pi", version: "1.1.0", wiring: "missing", detail: "no /h/.pi/agent/extensions/orrery.ts" },
	{ id: "claude-code", label: "Claude Code", path: "/bin/claude", version: "2.1.294 (Claude Code)", wiring: "installed", detail: "plugin 0.2.0" },
	{ id: "codex", label: "Codex", wiring: "memory", detail: "hooks are checked at the first launch" },
];

describe("the Tools page", () => {
	it("lists each tool, where it is, its version and Orrery's side, then Orrery itself", () => {
		const app = makeApp(fakeDeps({ tools: () => CHECKS }), [toolsPage]);
		const text = screen(app);
		expect(text).toMatch(/pi\s+\/bin\/pi\s+1\.1\.0\s+missing/);
		expect(text).toMatch(/Codex\s+not found\s+—\s+memory\s+hooks are check/);
		expect(text).toMatch(/Orrery\s+\/opt\/orrery\s+0\.1\.0/);
	});

	it("I shows what it will do, asks, installs, and shows the output", async () => {
		const ran: InstallStep[][] = [];
		const steps: InstallStep[] = [{ kind: "write", path: "/h/.pi/agent/extensions/orrery.ts", text: "x", describe: "write /h/.pi/agent/extensions/orrery.ts" }];
		const app = makeApp(fakeDeps({ tools: () => CHECKS, installSteps: () => steps, install: (s) => (ran.push([...s]), { ok: true, output: "wrote /h/.pi/agent/extensions/orrery.ts\n" }) }), [toolsPage]);
		keys(app, "I");
		await answer(app, "write /h/.pi/agent/extensions/orrery.ts", "y");
		await answer(app, "pi", ENTER);
		await app.idle();
		expect(ran).toEqual([steps]);
		expect(screen(app)).toContain("Done.");
	});

	it("I on an installed row does nothing and says so", async () => {
		let asked = 0;
		const steps: InstallStep[] = [{ kind: "run", cmd: "/bin/claude", args: ["plugin", "install", "orrery@orrery"], describe: "claude plugin install orrery@orrery" }];
		const app = makeApp(fakeDeps({ tools: () => CHECKS, installSteps: () => (asked++, steps), install: () => { throw new Error("must not install"); } }), [toolsPage]);
		keys(app, "\x1b[B", "I");
		await app.idle();
		expect(app.host.current).toBeUndefined();
		expect(asked).toBe(0);
		expect(screen(app)).toContain("Already installed: Claude Code, plugin 0.2.0.");
	});

	it("says when there is nothing it can do", async () => {
		const app = makeApp(fakeDeps({ tools: () => [{ ...CHECKS[0]!, wiring: "other", detail: "pi and OMP share one extensions folder" }], installSteps: () => [] }), [toolsPage]);
		keys(app, "I");
		await app.idle();
		expect(screen(app)).toContain("Nothing Orrery can do for pi: pi and OMP share one extensions folder.");
	});

	it("Codex needs nothing installed: I and Enter say its memory comes with each launch, and the last hook check", async () => {
		const app = makeApp(fakeDeps({ tools: () => CHECKS, installSteps: () => [], install: () => { throw new Error("must not install"); } }), [toolsPage]);
		keys(app, "\x1b[B", "\x1b[B", "I");
		await app.idle();
		expect(screen(app, 200)).toContain("Nothing to install for Codex: Orrery's hooks and memory tools come with each launch (hooks are checked at the first launch).");
		keys(app, ENTER);
		await answer(app, "Codex");
		expect(screen(app)).toContain("Orrery: memory");
		expect(screen(app)).toContain("Nothing to install: Orrery's hooks and memory tools come with each launch.");
	});

	it("I on the Orrery row says how Orrery updates: orrery update for a release, commit then npm run install-local from a checkout", async () => {
		for (const [running, said] of [
			["0.6.1", "Orrery updates with orrery update."],
			[undefined, "Orrery updates with orrery update."],
			["checkout", "This Orrery runs from a checkout: commit a change, then npm run install-local."],
		] as const) {
			const app = makeApp(fakeDeps({ tools: () => CHECKS, about: () => ({ version: "0.6.1", root: "/opt/orrery", ...(running === undefined ? {} : { running }) }) }), [toolsPage]);
			keys(app, "\x1b[B", "\x1b[B", "\x1b[B", "I");
			await app.idle();
			expect(app.host.current).toBeUndefined();
			expect(screen(app)).toContain(said);
		}
	});

	it("Enter on the Orrery row shows its version, folder, config file and memory folder in full", async () => {
		const config = "/very/long/path/to/some/where/deep/in/a/home/folder/.config/orrery/config.toml";
		const app = makeApp(fakeDeps({ tools: () => CHECKS, configPath: config }), [toolsPage]);
		keys(app, "\x1b[B", "\x1b[B", "\x1b[B", ENTER);
		await app.idle();
		const text = screen(app);
		expect(text).toContain("Version: 0.1.0");
		expect(text).toContain("Runs from: /opt/orrery");
		expect(text).toContain(`Config file: ${config}`);
		expect(text).toContain("Memory folder: /d");
	});

	it("draws a tool's path and details without control characters, in the table and in its dialog", async () => {
		const odd: ToolCheck[] = [{ id: "pi", label: "pi", path: "/bin/\x1b[31mpi", version: "1.1.0", wiring: "missing", detail: "no /h/\x1b]0;x\x07orrery.ts" }, CHECKS[1], CHECKS[2]];
		const app = makeApp(fakeDeps({ tools: () => odd, about: () => ({ version: "0.1.0", root: "/opt/\x1b[2Jorrery" }) }), [toolsPage]);
		expect(screen(app)).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
		keys(app, ENTER);
		await app.idle();
		const dialog = app.host.current as unknown as { render(w: number, h: number, t: unknown): string[] };
		const text = dialog.render(100, 20, app.deps.theme).join("\n");
		expect(text).toContain("Found: /bin/[31mpi");
		expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
	});

	it("strips control characters from install output, line by line", async () => {
		const steps: InstallStep[] = [{ kind: "write", path: "/x", text: "x", describe: "write /x" }];
		const app = makeApp(fakeDeps({ tools: () => CHECKS, installSteps: () => steps, install: () => ({ ok: true, output: "line one\x1b[31m red\nline two\n" }) }), [toolsPage]);
		keys(app, "I");
		await answer(app, "write /x", "y");
		const out = app.host.current as unknown as { render(w: number, h: number, t: unknown): string[] };
		expect(out.render(80, 10, app.deps.theme).join("\n")).not.toContain("\x1b");
		await answer(app, "pi", ENTER);
	});

	it("shows the newest backup across agents on the Orrery row, and where backups are in its dialog", async () => {
		const agents = [row({ name: "Alpha", lastBackup: "2026-10-06" }), row({ name: "Cedarn", lastBackup: "2026-10-08" }), row({ name: "Gamma" })];
		const app = makeApp(fakeDeps({ tools: () => CHECKS }, agents), [toolsPage]);
		expect(screen(app)).toMatch(/Orrery\s+\/opt\/orrery\s+0\.1\.0\s+—\s+last backup 2026-10-08/);
		keys(app, "\x1b[B", "\x1b[B", "\x1b[B", ENTER);
		await app.idle();
		expect(screen(app)).toContain("Last backup: 2026-10-08 in /d/backups");
		const none = makeApp(fakeDeps({ tools: () => CHECKS }, [row({ name: "Alpha" })]), [toolsPage]);
		expect(screen(none)).toMatch(/Orrery\s+\/opt\/orrery\s+0\.1\.0\s+—\s+no backup yet/);
		keys(none, "\x1b[B", "\x1b[B", "\x1b[B", ENTER);
		await none.idle();
		expect(screen(none)).toContain("Last backup: never (run orrery backup)");
	});
});


it("renders while Ori is pending and shows its facts and manual install instructions after it resolves", async () => {
	const ori: ToolCheck = { id: "ori", label: "Ori", path: "/bin/ori", wiring: "none", detail: "sign-in unknown", signin: "unknown" };
	let finish!: (row: ToolCheck) => void;
	const pending = new Promise<ToolCheck>((done) => { finish = done; });
	const app = makeApp(fakeDeps({ tools: () => [ori], ori: () => pending, installSteps: () => [] }), [toolsPage]);
	expect(screen(app)).toContain("Ori");
	expect(screen(app)).not.toContain("0.15.7");
	finish({ ...ori, version: "0.15.7" });
	await Promise.resolve();
	expect(screen(app)).toContain("0.15.7");
	keys(app, ENTER);
	expect(screen(app)).toContain("Sign-in: unknown");
	expect(screen(app)).toContain("curl -fsSL https://openrouter.ai/labs/ori/install.sh | bash");
	expect(screen(app)).toContain("ori login");
});


it("does not color an unknown Ori sign-in as an error", () => {
	const red = vi.fn((text: string) => text);
	const deps = fakeDeps({ tools: () => [{ id: "ori", label: "Ori", path: "/bin/ori", wiring: "none", signin: "unknown", detail: "Sign-in not probed" }] });
	const app = makeApp({ ...deps, theme: { ...deps.theme, red } }, [toolsPage]);
	keys(app, "\x1b[B");
	expect(screen(app)).toContain("unknown");
	expect(red).not.toHaveBeenCalled();
});


it("uses ~ and middle ellipses in Found and Detail, with bare version numbers", () => {
	const home = homedir();
	const checks: ToolCheck[] = [
		{ id: "pi", label: "pi", path: `${home}/.local/share/mise/installs/deeply/nested/pi-wrapper-packages/pi/1.1.0/bin/pi`, version: "1.1.0", wiring: "installed", detail: `${home}/.pi/agent/extensions/orrery.ts` },
		{ id: "claude-code", label: "Claude Code", path: `${home}/.local/bin/claude`, version: "2.1.296 (Claude Code)", wiring: "installed", detail: `points at ${home}/code/very-long-project-directory/claude-plugin` },
		{ id: "codex", label: "Codex", path: `${home}/.local/bin/codex`, version: "codex-cli 0.162.1", wiring: "memory", detail: "hooks checked with Codex 0.162.1" },
		{ id: "omp", label: "OMP", path: `${home}/.local/share/mise/installs/oh-my-pi/18.10.2/omp`, version: "omp/18.10.2", wiring: "installed", detail: `${home}/.omp/agent/extensions/orrery.ts` },
	];
	const snapshot = JSON.stringify(checks);
	const app = makeApp(fakeDeps({ tools: () => checks, about: () => ({ root: `${home}/code/orrery`, version: "0.1.0" }) }), [toolsPage]);
	const wide = toolsPage.render(app, 160, 10).join("\n");
	expect(wide).toContain("~/.local/bin/claude");
	expect(wide).toContain("~/code/orrery");
	expect(wide).not.toContain(home);
	expect(wide).not.toContain("(Claude Code)");
	expect(wide).not.toContain("codex-cli");
	expect(wide).not.toContain("omp/18.10.2");
	for (const [label, version] of [["pi", "1.1.0"], ["Claude Code", "2.1.296"], ["Codex", "0.162.1"], ["OMP", "18.10.2"]]) expect(wide.split("\n").find((line) => line.includes(label))).toContain(version);
	for (const width of [80, 100, 120]) {
		const lines = toolsPage.render(app, width, 10);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		const pi = lines.find((line) => /[ ›] pi\s/.test(line))!;
		expect(pi).toMatch(/~.*….*bin\/pi/);
		if (width === 120) expect(pi).toMatch(/~\/\.pi.*….*orrery\.ts/);
	}
	expect(JSON.stringify(checks)).toBe(snapshot);
});


it("shows Wrangler's version and has no install action", async () => {
	const wrangler: ToolCheck = { id: "wrangler", label: "wrangler", path: "/opt/orrery/worker/node_modules/.bin/wrangler", version: "4.45.0", wiring: "none", detail: "Cloudflare Worker tools; setup in docs/remote.md" };
	const app = makeApp(fakeDeps({ tools: () => [wrangler], installSteps: () => [], install: () => { throw new Error("must not install Wrangler"); } }), [toolsPage]);
	expect(screen(app)).toMatch(/wrangler.*4\.45\.0/);
	keys(app, "I");
	await app.idle();
	expect(app.host.current).toBeUndefined();
	expect(screen(app)).toContain("Nothing Orrery can do for wrangler");
});
