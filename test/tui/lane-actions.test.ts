import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../src/lane/config.ts";
import { saveKey } from "../../src/lane/logins.ts";
import { summarySources } from "../../src/lane/summary-sources.ts";
import type { CompactorTarget } from "../../src/lane/summary-text.ts";
import type { ToolCheck } from "../../src/lane/tools.ts";
import { lanesPage } from "../../src/tui/pages/lanes.ts";
import { tempDir } from "../lane/support.ts";
import { answer, fakeDeps, keys, makeApp, row, screen, settle, typed } from "./support.ts";

const ENTER = "\r";
const dirs: string[] = [];
beforeEach(() => {
	for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) vi.stubEnv(name, "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tool = (id: ToolCheck["id"], fields: Partial<ToolCheck> = {}): ToolCheck => ({ id, label: { pi: "pi", "claude-code": "Claude Code", codex: "Codex", omp: "OMP", ori: "Ori", wrangler: "wrangler" }[id], path: `/bin/${id}`, version: "1", wiring: id === "codex" ? "none" : "installed", detail: "", ...fields });

/** Summary sources with an Anthropic key saved, in a temp folder (offline: listing models makes no call). */
async function anthropicSources() {
	const dir = tempDir("orrery-tui-src-");
	dirs.push(dir);
	const sources = summarySources(parseConfig(`data_dir = ${JSON.stringify(dir)}\n`, dir));
	await saveKey(sources, "anthropic", "sk-ant-test");
	return sources;
}

describe("L launch", () => {
	it("says Codex records nothing, launches, and reports the way back", async () => {
		const deps = fakeDeps({ tools: () => [tool("pi"), tool("claude-code"), tool("codex")] }, [row({ name: "Alpha", tool: "codex", workspace: "/" })]);
		const app = makeApp(deps, [lanesPage]);
		keys(app, "L");
		await answer(app, "Codex", ENTER);
		await app.idle();
		expect(deps.launched).toEqual(["Alpha"]);
		expect(screen(app)).toContain("Back from Codex (Alpha).");
	});

	it("asks before a second session on an open lane; no cancels", async () => {
		const deps = fakeDeps({ tools: () => [tool("pi"), tool("claude-code"), tool("codex")] }, [row({ name: "Alpha", workspace: "/", state: "open", openIn: "pi" })]);
		const app = makeApp(deps, [lanesPage]);
		keys(app, "l");
		await answer(app, "already open in pi", "n");
		await app.idle();
		expect(deps.launched).toEqual([]);
		expect(screen(app)).toContain("Not launched.");
	});

	it("reports a tool that exits with an error, and one that is not on PATH", async () => {
		const deps = fakeDeps({ tools: () => [tool("pi"), tool("claude-code"), tool("codex")], launch: async () => ({ code: 2, signal: null }) }, [row({ name: "Alpha", workspace: "/" })]);
		const app = makeApp(deps, [lanesPage]);
		keys(app, "L");
		await app.idle();
		expect(screen(app)).toContain("pi exited with code 2.");
		const none = makeApp(fakeDeps({ tools: () => [tool("pi", { path: undefined }), tool("claude-code"), tool("codex")] }, [row({ name: "Alpha", workspace: "/" })]), [lanesPage]);
		keys(none, "L");
		await none.idle();
		expect(screen(none)).toContain("pi is not on PATH");
	});
});

describe("M summary model", () => {
	it("walks the picker, test-calls, and applies through the lane's target", async () => {
		const sources = await anthropicSources();
		const applied: unknown[] = [];
		const target: CompactorTarget = {
			current: () => ({ choice: { provider: "openai", modelId: "gpt-6.1-sol", thinking: "low" }, source: "config" }),
			configured: () => ({ provider: "openai", modelId: "gpt-6.1-sol", thinking: "low" }),
			apply: async (choice) => {
				applied.push(choice);
				return "summaries: anthropic/claude-haiku-4-5 (off) · set in chat";
			},
		};
		const tested: unknown[] = [];
		let report: ((message: string) => void) | undefined;
		const deps = fakeDeps({ sources: async () => sources, target: (_config, _lane, onReport) => { report = onReport; return target; }, testChoice: async (_s, choice) => (tested.push(choice), { ok: true as const }) });
		const app = makeApp(deps, [lanesPage]);
		keys(app, "M");
		await answer(app, "Summaries from:", ENTER);
		await answer(app, "Anthropic model:", ...typed("haiku-4-5"), ENTER);
		await answer(app, "Thinking", ...typed("off"), ENTER);
		await app.idle();
		expect(tested).toEqual([{ provider: "anthropic", modelId: "claude-haiku-4-5", thinking: "off" }]);
		expect(applied).toEqual([{ provider: "anthropic", modelId: "claude-haiku-4-5", thinking: "off" }]);
		expect(screen(app)).toContain("summaries: anthropic/claude-haiku-4-5 (off) · set in chat");
		expect(report).toBeDefined();
		report?.("Test: unsaved local turns were kept aside");
		expect(screen(app)).toContain("unsaved local turns were kept aside");
	});

	it("keeps the old model when the test call fails, and offers the way back to the config's model", async () => {
		const sources = await anthropicSources();
		const applied: unknown[] = [];
		const target: CompactorTarget = {
			current: () => ({ choice: { provider: "anthropic", modelId: "claude-opus-5", thinking: "low" }, source: "chat" }),
			configured: () => ({ provider: "openai", modelId: "gpt-6.1-sol", thinking: "low" }),
			apply: async (choice) => (applied.push(choice), "applied"),
		};
		const deps = fakeDeps({ sources: async () => sources, target: () => target, testChoice: async () => ({ ok: false as const, reason: "the Anthropic key was refused" }) });
		const app = makeApp(deps, [lanesPage]);
		keys(app, "M");
		await answer(app, "Summaries from:", ...typed("back"), ENTER);
		await app.idle();
		expect(applied).toEqual([]);
		expect(screen(app)).toContain("Not switched: the Anthropic key was refused. Still on anthropic/claude-opus-5.");
	});
});

describe("E edit", () => {
	it("changes summary jobs and the tool in the config, keeping the rest", async () => {
		const deps = fakeDeps();
		const app = makeApp(deps, [lanesPage]);
		keys(app, "E");
		await answer(app, "change which setting", ...typed("jobs"), ENTER);
		await answer(app, "Summary jobs", "\x15", ...typed("8"), ENTER);
		await app.idle();
		expect(deps.edits.at(-1)).toContain('[lanes.Alpha]\nworkspace = "/w/alpha"\ncompactor_model = "openai/gpt-6.1-sol"\ncompactor_jobs = 8\n');
		expect(screen(app)).toContain("Saved. It applies when Alpha next opens.");
		keys(app, "E");
		await answer(app, "change which setting", ...typed("tool"), ENTER);
		await answer(app, "Tool:", ...typed("codex"), ENTER);
		await app.idle();
		expect(deps.edits.at(-1)).toContain('tool = "codex"');
	});

	it("changes where Claude Code compacts, refusing under 100 thousand", async () => {
		const deps = fakeDeps();
		const app = makeApp(deps, [lanesPage]);
		keys(app, "E");
		await answer(app, "change which setting", ...typed("Claude Code compacts at: 200K tokens"), ENTER);
		await answer(app, "Compact Claude Code", "\x15", ...typed("150"), ENTER);
		await app.idle();
		expect(deps.edits.at(-1)).toContain("compact_at = 150000");
		const refused = fakeDeps();
		const second = makeApp(refused, [lanesPage]);
		keys(second, "E");
		await answer(second, "change which setting", ...typed("Claude Code compacts at: 200K tokens"), ENTER);
		await answer(second, "Compact Claude Code", "\x15", ...typed("50"), ENTER);
		await second.idle();
		expect(screen(second)).toContain("Enter a whole number of thousands, at least 100.");
		expect(refused.edits).toEqual([]);
	});

	it("clears the folder with an empty value; a lane without one shows none, in its page and in E", async () => {
		const deps = fakeDeps();
		const app = makeApp(deps, [lanesPage]);
		keys(app, "E");
		await answer(app, "change which setting", ...typed("Folder"), ENTER);
		await answer(app, "Folder (an absolute path; empty: none", "\x15", ENTER);
		await app.idle();
		expect(deps.edits.at(-1)).toContain('[lanes.Alpha]\ncompactor_model = "openai/gpt-6.1-sol"\n[lanes.Cedarn]');
		expect(screen(app)).toContain("Saved. Alpha launches with it next time.");
		const bare = makeApp(fakeDeps({}, [row({ name: "Alpha", workspace: undefined })]), [lanesPage]);
		keys(bare, ENTER);
		expect(screen(bare, 120)).toContain("none (it opens wherever it is opened)");
		keys(bare, "\x1b", "E");
		await answer(bare, "change which setting", ...typed("Folder: none"), ENTER);
		await answer(bare, "Folder (an absolute path; empty: none", ...typed("/w/new"), ENTER);
		await bare.idle();
		expect(screen(bare)).toContain("Saved. Alpha launches with it next time.");
	});

	it("refuses a number that is not one, and a config it cannot write", async () => {
		const deps = fakeDeps();
		const app = makeApp(deps, [lanesPage]);
		keys(app, "E");
		await answer(app, "change which setting", ...typed("view"), ENTER);
		await answer(app, "View size", "\x15", ...typed("lots"), ENTER);
		await app.idle();
		expect(screen(app)).toContain("Enter a whole number of KB.");
		expect(deps.edits).toEqual([]);
		const locked = makeApp(fakeDeps({ configWritable: () => false }), [lanesPage]);
		keys(locked, "E");
		expect(screen(locked)).toContain("can't be written");
	});
});

describe("N new lane", () => {
	it("asks name, folder, tool and summary model, writes the lane, then offers the wiring", async () => {
		const sources = await anthropicSources();
		const fixes: string[] = [];
		const deps = fakeDeps({
			sources: async () => sources,
			tools: () => [tool("pi", { wiring: "missing" }), tool("claude-code"), tool("codex")],
			applyFix: (fix) => (fixes.push(fix), "fixed"),
		});
		deps.overview = (config) => [...config.lanes.values()].map((lane) => row({ name: lane.name, workspace: lane.workspace, tool: lane.tool ?? "pi" }));
		const app = makeApp(deps, [lanesPage]);
		keys(app, "N");
		await answer(app, "New lane's name", ...typed("Gamma"), ENTER);
		await answer(app, "Its folder", "\x15", ...typed("/tmp/orrery-no-such-folder-gamma"), ENTER);
		await answer(app, "Its tool", ENTER);
		await answer(app, "Summaries from:", ENTER);
		await answer(app, "Anthropic model:", ...typed("haiku-4-5"), ENTER);
		await answer(app, "Thinking", ...typed("low"), ENTER);
		await answer(app, "does not exist", "n");
		await answer(app, "pi extension is not installed", "y");
		await answer(app, "Done", ENTER);
		await app.idle();
		expect(deps.edits.at(-1)).toContain('[lanes.Gamma]\nworkspace = "/tmp/orrery-no-such-folder-gamma"\ntool = "pi"\nmodel = "anthropic/claude-haiku-4-5"\ncompactor_model = "anthropic/claude-haiku-4-5"\ncompactor_thinking = "low"\n');
		expect(fixes).toEqual(["install-pi"]);
		expect(screen(app)).toContain("Added Gamma. Press L to launch it.");
	});

	it("refuses a name that exists in another case, writing nothing", async () => {
		const sources = await anthropicSources();
		const deps = fakeDeps({ sources: async () => sources, tools: () => [tool("pi"), tool("claude-code"), tool("codex")] });
		const app = makeApp(deps, [lanesPage]);
		keys(app, "N");
		await answer(app, "New lane's name", ...typed("alpha"), ENTER);
		await app.idle();
		expect(screen(app)).toContain("A lane named alpha already exists.");
		expect(deps.edits).toEqual([]);
	});
});

describe("B browse", () => {
	it("writes the memory page and says where", async () => {
		const app = makeApp(fakeDeps(), [lanesPage]);
		keys(app, "B");
		await app.idle();
		await settle();
		expect(screen(app)).toContain("Wrote /d/lanes/Alpha/memory.html (no display here: open it yourself).");
	});
});

describe("failing wiring", () => {
	const boom = () => {
		throw new Error("$ claude plugin install orrery@orrery\nboom\nexit 1\n");
	};

	it("L: shows the full failure and does not launch", async () => {
		const deps = fakeDeps({ tools: () => [tool("pi", { wiring: "missing" }), tool("claude-code"), tool("codex")], applyFix: boom }, [row({ name: "Alpha", workspace: "/" })]);
		const app = makeApp(deps, [lanesPage]);
		keys(app, "L");
		await answer(app, "extension is not installed", "y");
		await settle();
		expect(app.host.current?.title).toBe("Failed");
		expect((app.host.current as unknown as { text: string }).text).toContain("exit 1");
		await answer(app, "Failed", ENTER);
		await app.idle();
		expect(deps.launched).toEqual([]);
		expect(screen(app)).toContain("Not launched.");
	});

	it("N: the lane is still added and the status says so", async () => {
		const sources = await anthropicSources();
		const deps = fakeDeps({ sources: async () => sources, tools: () => [tool("pi", { wiring: "missing" }), tool("claude-code"), tool("codex")], applyFix: boom });
		deps.overview = (config) => [...config.lanes.values()].map((lane) => row({ name: lane.name, workspace: lane.workspace, tool: lane.tool ?? "pi" }));
		const app = makeApp(deps, [lanesPage]);
		keys(app, "N");
		await answer(app, "New lane's name", ...typed("Gamma"), ENTER);
		await answer(app, "Its folder", "\x15", ...typed("/tmp"), ENTER);
		await answer(app, "Its tool", ENTER);
		await answer(app, "Summaries from:", ENTER);
		await answer(app, "Anthropic model:", ...typed("haiku-4-5"), ENTER);
		await answer(app, "Thinking", ...typed("low"), ENTER);
		await answer(app, "extension is not installed", "y");
		await settle();
		expect((app.host.current as unknown as { text: string }).text).toContain("exit 1");
		await answer(app, "Failed", ENTER);
		await app.idle();
		expect(screen(app)).toContain("Added Gamma");
	});
});

describe("N folder", () => {
	it("refuses a relative folder before asking anything else", async () => {
		const deps = fakeDeps({ tools: () => [tool("pi")] });
		const app = makeApp(deps, [lanesPage]);
		keys(app, "N");
		await answer(app, "New lane's name", ...typed("Gamma"), ENTER);
		await answer(app, "Its folder", "\x15", ...typed("projects/x"), ENTER);
		await app.idle();
		expect(screen(app)).toContain("The folder must be an absolute path.");
		expect(deps.edits).toEqual([]);
	});
});

describe("A archive", () => {
	/** Fake deps whose rows follow the config, so an archived lane leaves the list. */
	const following = (fields: Partial<ReturnType<typeof row>> = {}, overrides: Parameters<typeof fakeDeps>[0] = {}) => {
		const deps = fakeDeps(overrides);
		deps.overview = (config) => [...config.lanes.values()].map((lane) => row({ name: lane.name, workspace: lane.workspace, dataDir: lane.dir, ...(lane.name === "Alpha" ? fields : {}) }));
		return deps;
	};

	it("asks, then takes the lane out of the config and keeps its settings as comments", async () => {
		const deps = following();
		const app = makeApp(deps, [lanesPage]);
		keys(app, "A");
		await answer(app, "Archive Alpha?");
		const title = app.host.current?.title ?? "";
		expect(title.replaceAll("\n", " ")).toBe("Archive Alpha? It leaves the config; its memory stays in /d/lanes/Alpha. Its settings are kept as comments at the end of config.toml.");
		expect(title.split("\n").every((line) => line.length <= 56)).toBe(true);
		await answer(app, "Archive Alpha?", "y");
		await app.idle();
		expect(deps.edits).toHaveLength(1);
		expect(deps.edits[0]).not.toMatch(/^\[lanes\.Alpha\]/m);
		expect(deps.edits[0]).toMatch(/^# \[lanes\.Alpha\]$/m);
		expect(deps.edits[0]).toContain("Its memory is still in /d/lanes/Alpha.");
		const text = screen(app);
		expect(text).toContain("Archived Alpha.");
		expect(text).not.toMatch(/[› ] Alpha\s/);
	});

	it("does nothing when the answer is no", async () => {
		const deps = following();
		const app = makeApp(deps, [lanesPage]);
		keys(app, "a");
		await answer(app, "Archive Alpha?", "n");
		await app.idle();
		expect(deps.edits).toEqual([]);
		expect(screen(app)).toMatch(/› Alpha/);
	});

	it("archives the lane whose page is open, and closes the page", async () => {
		const deps = following();
		const app = makeApp(deps, [lanesPage]);
		keys(app, "\x1b[B", ENTER, "A");
		await answer(app, "Archive Cedarn?", "y");
		await app.idle();
		expect(deps.edits[0]).toMatch(/^# \[lanes\.Cedarn\]$/m);
		expect(screen(app)).toContain("Archived Cedarn.");
		expect(screen(app)).toMatch(/Lane\s+Tool/);
	});

	it("refuses an open, working or finishing lane, naming its tool", async () => {
		for (const [fields, tool] of [
			[{ state: "open", openIn: "pi" }, "pi"],
			[{ state: "working", openIn: "claude-code", tool: "claude-code" }, "Claude Code"],
			[{ state: "finishing", openIn: "claude-code", tool: "claude-code" }, "Claude Code"],
		] as const) {
			const deps = following(fields);
			const app = makeApp(deps, [lanesPage]);
			keys(app, "A");
			await app.idle();
			expect(app.host.current).toBeUndefined();
			expect(screen(app)).toContain(`Alpha is open in ${tool}; close it first.`);
			expect(deps.edits).toEqual([]);
		}
	});

	it("checks again after the yes: a lane opened while the question was up is refused", async () => {
		let open = false;
		const deps = fakeDeps();
		deps.overview = (config) => [...config.lanes.values()].map((lane) => row({ name: lane.name, dataDir: lane.dir, ...(open && lane.name === "Alpha" ? { state: "open" as const, openIn: "pi" as const } : {}) }));
		const app = makeApp(deps, [lanesPage]);
		keys(app, "A");
		await answer(app, "Archive Alpha?");
		open = true;
		await answer(app, "Archive Alpha?", "y");
		await app.idle();
		expect(deps.edits).toEqual([]);
		expect(screen(app)).toContain("Alpha is open in pi; close it first.");
	});

	it("refuses when the config can't be written, as E and N do", async () => {
		const deps = following({}, { configWritable: () => false });
		const app = makeApp(deps, [lanesPage]);
		keys(app, "A");
		await app.idle();
		expect(app.host.current).toBeUndefined();
		expect(screen(app)).toContain("The config can't be written here (/c/config.toml); edit it by hand.");
	});

	it("shows the config's refusal (a lane that another reads) and changes nothing", async () => {
		let text = 'data_dir = "/d"\n[lanes.Alpha]\nworkspace = "/w/alpha"\ncompactor_model = "a/b"\n[lanes.Cedarn]\nreads = ["Alpha"]\nworkspace = "/w/cedarn"\ncompactor_model = "a/b"\n';
		const edits: string[] = [];
		const deps = following({}, { editConfig: (edit) => {
			text = edit(text, "/d");
			edits.push(text);
			return parseConfig(text, "/d");
		} });
		const app = makeApp(deps, [lanesPage]);
		keys(app, "A");
		await answer(app, "Archive Alpha?", "y");
		await app.idle();
		expect(edits).toEqual([]);
		expect(screen(app)).toContain("Cedarn reads it; take it out of Cedarn's reads first.");
	});
});

describe("the cursor across refreshes", () => {
	const tools = () => [tool("pi"), tool("claude-code"), tool("codex")];
	const at = (time: string) => `2026-10-08T${time}:00.000Z`;
	/** A config with lanes A, B, C and Z, so L finds whichever lane the cursor is on. */
	const loadConfig = () => parseConfig(`data_dir = "/d"\n${["A", "B", "C", "Z"].map((n) => `[lanes.${n}]\nworkspace = "/"\ncompactor_model = "a/b"\n`).join("")}`, "/d");

	it("stays on the chosen lane when a refresh re-sorts the list by last message, so L launches that lane", async () => {
		let lanes = [row({ name: "A", workspace: "/", lastMessageAt: at("11:55") }), row({ name: "B", workspace: "/", lastMessageAt: at("11:50") }), row({ name: "C", workspace: "/", lastMessageAt: at("11:40") })];
		const deps = fakeDeps({ tools, loadConfig });
		deps.overview = () => lanes;
		const app = makeApp(deps, [lanesPage]);
		keys(app, "s", "s", "\x1b[B");
		expect(screen(app)).toMatch(/› B/);
		lanes = lanes.map((r) => (r.name === "C" ? { ...r, lastMessageAt: at("11:59") } : r));
		app.refresh();
		expect(screen(app)).toMatch(/› B/);
		keys(app, "L");
		await app.idle();
		expect(deps.launched).toEqual(["B"]);
	});

	it("stays on the chosen lane when a refresh re-sorts the needs-attention order", async () => {
		let lanes = [row({ name: "A", workspace: "/", lastMessageAt: at("11:55") }), row({ name: "B", workspace: "/", summary: { state: "waiting", waiting: 1 } }), row({ name: "C", workspace: "/", lastMessageAt: at("11:40") })];
		const deps = fakeDeps({ tools, loadConfig });
		deps.overview = () => lanes;
		const app = makeApp(deps, [lanesPage]);
		keys(app, "s", "s", "s");
		expect(screen(app)).toMatch(/› A/);
		lanes = lanes.map((r) => (r.name === "C" ? { ...r, summary: { state: "failing", waiting: 0, plain: "quota" } } : r));
		app.refresh();
		expect(screen(app)).toMatch(/› A/);
		keys(app, "L");
		await app.idle();
		expect(deps.launched).toEqual(["A"]);
	});

	it("moves to the nearest row when the chosen lane is gone, and follows it from there", async () => {
		let lanes = [row({ name: "A", workspace: "/" }), row({ name: "B", workspace: "/" }), row({ name: "C", workspace: "/" })];
		const deps = fakeDeps({ tools, loadConfig });
		deps.overview = () => lanes;
		const app = makeApp(deps, [lanesPage]);
		keys(app, "\x1b[B", "\x1b[B");
		lanes = lanes.filter((r) => r.name !== "C");
		app.refresh();
		expect(screen(app)).toMatch(/› B/);
		lanes = [...lanes, row({ name: "Z", workspace: "/" })];
		app.refresh();
		expect(screen(app)).toMatch(/› B/);
		keys(app, "L");
		await app.idle();
		expect(deps.launched).toEqual(["B"]);
	});
});

it("E sets the launcher and sets or clears its model", async () => {
	const deps = fakeDeps();
	const app = makeApp(deps, [lanesPage]);
	keys(app, "E");
	await answer(app, "change which setting?", ...typed("Launcher"), ENTER);
	await answer(app, "Launcher:", ...typed("Ori"), ENTER);
	await app.idle();
	expect(deps.edits.at(-1)).toContain('launcher = "ori"');
	keys(app, "E");
	await answer(app, "change which setting?", ...typed("Ori model"), ENTER);
	await answer(app, "Ori model", ...typed("vendor/model"), ENTER);
	await app.idle();
	expect(deps.edits.at(-1)).toContain('ori_model = "vendor/model"');
	keys(app, "E");
	await answer(app, "change which setting?", ...typed("Ori model"), ENTER);
	await answer(app, "Ori model", ENTER);
	await app.idle();
	expect(deps.edits.at(-1)).not.toContain("ori_model");
});

it.each(["No", "Yes"])("N asks about Ori only when found, defaulting to No (%s)", async (choice) => {
	const sources = await anthropicSources();
	const deps = fakeDeps({ sources: async () => sources, tools: () => [tool("pi"), tool("ori")] });
	const app = makeApp(deps, [lanesPage]);
	keys(app, "N");
	await answer(app, "New lane", ...typed("Atlas"), ENTER);
	await answer(app, "Its folder", ENTER);
	await answer(app, "Its tool", ENTER);
	await answer(app, "Launch through Ori?", ...(choice === "Yes" ? typed("Yes") : []), ENTER);
	await answer(app, "Summaries from:", ENTER);
	await answer(app, "Anthropic model:", ...typed("haiku-4-5"), ENTER);
	await answer(app, "Thinking", ...typed("off"), ENTER);
	await app.idle();
	expect(parseConfig(deps.edits.at(-1)!, "/d").lanes.get("Atlas")?.launcher).toBe(choice === "Yes" ? "ori" : "direct");
});
