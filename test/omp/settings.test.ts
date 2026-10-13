import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importsView, VIEW_IMPORT } from "../../src/claude/view-file.ts";
import { applyLaneSettings, applyWith, importsClaudeView, type OmpInternals, type OmpSetting, VIEW_IMPORT as OMP_VIEW_IMPORT } from "../../src/omp/settings.ts";
import { createOrrery, type LaneSettingsResult } from "../../src/pi/index.ts";
import { cleanup, scratchHome, summarySourcesFor, world } from "../pi/world.ts";
import { fakeOmp, ompCleanup, ompOrrery, track } from "./world.ts";

afterEach(async () => {
	await ompCleanup();
	await cleanup();
});

/** OMP's live session settings, a layer of runtime overrides over the configured values (`values` is what OMP reads). */
class FakeSettings {
	readonly overrides: Record<string, unknown> = {};
	readonly base: Record<string, unknown>;
	constructor(base: Record<string, unknown>) {
		this.base = base;
	}
	get values(): Record<string, unknown> {
		return { ...this.base, ...this.overrides };
	}
}

/** OMP's settings internals as its config registry hands them out: override(scope, undefined) removes an override (registry.ts:722-727). */
function fakeInternals(start: Record<string, unknown>, options: { isolated?: boolean; missing?: string; failsToClear?: string; failsToSet?: string } = {}) {
	const live = new FakeSettings({ ...start });
	const setting = (id: string): OmpSetting => ({
		get: (settings) => (settings as FakeSettings).values[id],
		override: (settings, value) => {
			const layer = (settings as FakeSettings).overrides;
			if (value !== undefined && id === options.failsToSet) throw new Error(`cannot set ${id}`);
			if (value !== undefined) layer[id] = value;
			else if (id === options.failsToClear) throw new Error(`cannot clear ${id}`);
			else delete layer[id];
		},
	});
	const internals: OmpInternals = {
		create: () => (options.isolated ? new FakeSettings({ ...start }) : live),
		lookup: (id) => (id === options.missing ? undefined : setting(id)),
	};
	return { internals, live };
}

/** A result with its restore, which these tests call separately. */
const applied = { applied: true, restore: expect.any(Function) };
const notApplied = (why: unknown) => ({ applied: false, why, restore: expect.any(Function) });

/** What claude-setup leaves in a Claude Code lane's CLAUDE.md (file mode). */
const CLAUDE_CODE_LANE = "Lane rules.\n\n@AGENTS.md\n@.orrery/view.md\n";

/** A lane folder (a world's agent-Atlas), with `claudeMd` as its CLAUDE.md when given. */
function laneFolder(claudeMd?: string): string {
	const lane = join(world().root, "agent-Atlas");
	if (claudeMd !== undefined) writeFileSync(join(lane, "CLAUDE.md"), claudeMd);
	return lane;
}

describe("applyWith (OMP's internals present)", () => {
	it("in a Claude Code lane turns off compaction and OMP's memory, adds the project CLAUDE.md to the user's disabled list, and stops titles", () => {
		const lane = laneFolder(CLAUDE_CODE_LANE);
		const { internals, live } = fakeInternals({ "compaction.enabled": true, "memory.backend": "local", disabledExtensions: ["skill:mine"] });
		const env: NodeJS.ProcessEnv = {};
		expect(applyWith(internals, lane, lane, env)).toEqual(applied);
		expect(live.values).toEqual({ "compaction.enabled": false, "memory.backend": "off", disabledExtensions: ["skill:mine", "context-file:project:CLAUDE.md"] });
		expect(env.PI_NO_TITLE).toBe("1");
		expect(applyWith(internals, lane, lane, env)).toEqual(applied);
		expect(live.values.disabledExtensions).toEqual(["skill:mine", "context-file:project:CLAUDE.md"]);
	});

	it("leaves the disabled list untouched when the lane has no CLAUDE.md, or one that does not import the view, and still applies the rest", () => {
		for (const claudeMd of [undefined, "Lane rules.\n@AGENTS.md\n", "See @.orrery/view.md for the memory.\n"]) {
			const lane = laneFolder(claudeMd);
			const { internals, live } = fakeInternals({ "compaction.enabled": true, "memory.backend": "local", disabledExtensions: ["skill:mine"] });
			const env: NodeJS.ProcessEnv = {};
			expect(applyWith(internals, lane, lane, env)).toEqual(applied);
			expect(live.values).toEqual({ "compaction.enabled": false, "memory.backend": "off", disabledExtensions: ["skill:mine"] });
			expect(env.PI_NO_TITLE).toBe("1");
		}
	});

	it("needs OMP's disabledExtensions setting only where the lane's CLAUDE.md imports the view", () => {
		const plain = fakeInternals({ "compaction.enabled": true, "memory.backend": "local" }, { missing: "disabledExtensions" });
		expect(applyWith(plain.internals, "/lane", laneFolder(), {})).toEqual(applied);
		const claude = fakeInternals({ "compaction.enabled": true, "memory.backend": "local" }, { missing: "disabledExtensions" });
		expect(applyWith(claude.internals, "/lane", laneFolder(CLAUDE_CODE_LANE), {})).toEqual(notApplied("OMP has no setting disabledExtensions"));
		expect(claude.live.values["compaction.enabled"]).toBe(true);
	});

	it("says not applied when OMP hands out a fresh settings object each time (no live session settings)", () => {
		const { internals } = fakeInternals({ "compaction.enabled": true, "memory.backend": "off", disabledExtensions: [] }, { isolated: true });
		expect(applyWith(internals, "/lane", "/lane", {})).toEqual(notApplied("no live session settings"));
	});

	it("names the setting OMP no longer has, and changes nothing", () => {
		const { internals, live } = fakeInternals({ "compaction.enabled": true, "memory.backend": "local", disabledExtensions: [] }, { missing: "memory.backend" });
		expect(applyWith(internals, "/lane", "/lane", {})).toEqual(notApplied("OMP has no setting memory.backend"));
		expect(live.values["compaction.enabled"]).toBe(true);
	});
});

describe("restore (the session left the lane's folder: OMP's /resume of another folder's session, /move)", () => {
	it("removes exactly the overrides Orrery set and gives PI_NO_TITLE back as it was", () => {
		const lane = laneFolder(CLAUDE_CODE_LANE);
		const start = { "compaction.enabled": true, "memory.backend": "local", disabledExtensions: ["skill:mine"] };
		const { internals, live } = fakeInternals(start);
		const env: NodeJS.ProcessEnv = {};
		const result = applyWith(internals, lane, lane, env);
		expect(live.overrides).toEqual({ "compaction.enabled": false, "memory.backend": "off", disabledExtensions: ["skill:mine", "context-file:project:CLAUDE.md"] });
		result.restore?.();
		expect(live.overrides).toEqual({});
		expect(live.values).toEqual(start);
		expect(env).toEqual({});
		// The user's own PI_NO_TITLE, and a list that already held the CLAUDE.md id (no override there), stay theirs.
		const own = fakeInternals({ ...start, disabledExtensions: ["context-file:project:CLAUDE.md"] });
		const userEnv: NodeJS.ProcessEnv = { PI_NO_TITLE: "0" };
		applyWith(own.internals, lane, lane, userEnv).restore?.();
		expect(own.live.overrides).toEqual({});
		expect(userEnv).toEqual({ PI_NO_TITLE: "0" });
	});

	it("when nothing was overridden, gives back only PI_NO_TITLE", () => {
		const { internals, live } = fakeInternals({ "compaction.enabled": true, "memory.backend": "local" }, { missing: "memory.backend" });
		const env: NodeJS.ProcessEnv = {};
		applyWith(internals, "/lane", laneFolder(), env).restore?.();
		expect(env).toEqual({});
		expect(live.overrides).toEqual({});
	});

	it("tries every override before it reports the first that would not clear", () => {
		const { internals, live } = fakeInternals({ "compaction.enabled": true, "memory.backend": "local" }, { failsToClear: "compaction.enabled" });
		const env: NodeJS.ProcessEnv = {};
		const result = applyWith(internals, "/lane", laneFolder(), env);
		expect(() => result.restore?.()).toThrow("cannot clear compaction.enabled");
		expect(live.overrides).toEqual({ "compaction.enabled": false });
		expect(env).toEqual({});
	});

	it("takes back what was set before an override OMP refused", async () => {
		const { internals, live } = fakeInternals({ "compaction.enabled": true, "memory.backend": "local" }, { failsToSet: "memory.backend" });
		const env: NodeJS.ProcessEnv = {};
		const lane = laneFolder();
		const result = await applyLaneSettings({ cwd: lane }, lane, env, async () => internals);
		expect(result).toEqual(notApplied("cannot set memory.backend"));
		expect(live.overrides).toEqual({ "compaction.enabled": false });
		result.restore?.();
		expect(live.overrides).toEqual({});
		expect(env).toEqual({});
	});

	it("applyLaneSettings gives PI_NO_TITLE back as it was before its own first set, internals or not", async () => {
		const env: NodeJS.ProcessEnv = {};
		(await applyLaneSettings({ cwd: "/lane" }, "/lane", env)).restore?.();
		expect(env).toEqual({});
		const { internals, live } = fakeInternals({ "compaction.enabled": true, "memory.backend": "local" });
		const lane = laneFolder();
		(await applyLaneSettings({ cwd: lane }, lane, env, async () => internals)).restore?.();
		expect(env).toEqual({});
		expect(live.overrides).toEqual({});
	});
});

describe("importsClaudeView", () => {
	it("reads the lane's CLAUDE.md as Claude Code's own check (importsView) does", () => {
		expect(OMP_VIEW_IMPORT).toBe(VIEW_IMPORT);
		const linked = laneFolder();
		writeFileSync(join(linked, "rules.md"), CLAUDE_CODE_LANE);
		symlinkSync("rules.md", join(linked, "CLAUDE.md"));
		const localOnly = laneFolder();
		writeFileSync(join(localOnly, "CLAUDE.local.md"), CLAUDE_CODE_LANE);
		const folder = laneFolder();
		mkdirSync(join(folder, "CLAUDE.md"));
		const cases: [string, boolean][] = [
			[laneFolder(), false],
			[laneFolder(CLAUDE_CODE_LANE), true],
			[laneFolder("Lane rules.\n  @.orrery/view.md  \n"), true],
			[laneFolder("@.orrery/view.md"), true],
			[laneFolder("See @.orrery/view.md for the memory.\n"), false],
			[laneFolder(`${"x".repeat(256 * 1024)}\n@.orrery/view.md\n`), false],
			[linked, false],
			[localOnly, false],
			[folder, false],
		];
		for (const [lane, expected] of cases) {
			expect(importsClaudeView(lane)).toBe(expected);
			expect(importsView(join(lane, "CLAUDE.md"))).toBe(expected);
		}
	});
});

describe("applyLaneSettings", () => {
	it("says why when OMP's internals do not load (as under Node), and still stops titles", async () => {
		const env: NodeJS.ProcessEnv = {};
		expect(await applyLaneSettings({ cwd: "/lane" }, "/lane", env)).toEqual(notApplied(expect.stringMatching(/^OMP internals did not load: /)));
		expect(env.PI_NO_TITLE).toBe("1");
	});

	it("turns a throw inside OMP's settings into not applied", async () => {
		const internals: OmpInternals = {
			create: () => {
				throw new Error("settings exploded");
			},
			lookup: () => undefined,
		};
		expect(await applyLaneSettings({ cwd: "/lane" }, "/lane", {}, async () => internals)).toEqual(notApplied("settings exploded"));
	});
});

describe("lane settings at OMP's session start", () => {
	it("are applied before the tools register, with no notice and a plain footer", async () => {
		const { root, config } = world();
		let toolsThen = -1;
		const omp = track(
			fakeOmp(join(root, "agent-Atlas"), [
				createOrrery({
					config,
					host: "omp",
					...scratchHome(root),
					summarySources: async (cfg) => summarySourcesFor(cfg),
					laneSettings: async () => {
						toolsThen = omp.tools.size;
						return { applied: true };
					},
				}),
			]),
		);
		await omp.emit("session_start");
		expect(toolsThen).toBe(0);
		expect(omp.tools.size).toBe(3);
		expect(omp.notices).toEqual([]);
		expect(omp.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
	});

	it("when not applied (or thrown), memory still works, one notice says why, and the footer says so", async () => {
		const { root, config } = world();
		const failed = async (): Promise<LaneSettingsResult> => ({ applied: false, why: "OMP has no setting memory.backend" });
		const omp = await ompOrrery(join(root, "agent-Atlas"), config, { laneSettings: failed });
		expect(omp.tools.has("zoom")).toBe(true);
		expect(omp.status("orrery")).toBe("Orrery · Atlas · 0 msgs · OMP settings not applied");
		expect(omp.notices).toEqual([
			{ message: "Orrery: OMP settings not applied (OMP has no setting memory.backend): OMP's own compaction, memory and project CLAUDE.md may still apply in Atlas. Orrery's memory works as usual.", type: "warning" },
		]);
		const thrown = await ompOrrery(join(root, "agent-Birch"), config, { laneSettings: () => Promise.reject(new Error("boom")) });
		expect(thrown.notices.map((n) => n.message)).toEqual(["Orrery: OMP settings not applied (boom): OMP's own compaction, memory and project CLAUDE.md may still apply in Birch. Orrery's memory works as usual."]);
	});

	it("with OMP's internals: a lane without the view import keeps the disabled list, a Claude Code lane's goes on it (read from the lane folder, started in a subfolder), no notice either way", async () => {
		const { root, config } = world();
		const atlas = fakeInternals({ "compaction.enabled": true, "memory.backend": "local", disabledExtensions: [] });
		const plain = await ompOrrery(join(root, "agent-Atlas"), config, { laneSettings: (ctx, workspace) => applyLaneSettings(ctx, workspace, {}, async () => atlas.internals) });
		expect(atlas.live.values).toEqual({ "compaction.enabled": false, "memory.backend": "off", disabledExtensions: [] });
		expect(plain.notices).toEqual([]);
		expect(plain.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		writeFileSync(join(root, "agent-Birch", "CLAUDE.md"), CLAUDE_CODE_LANE);
		mkdirSync(join(root, "agent-Birch", "src"));
		const birch = fakeInternals({ "compaction.enabled": true, "memory.backend": "local", disabledExtensions: [] });
		const claude = await ompOrrery(join(root, "agent-Birch", "src"), config, { laneSettings: (ctx, workspace) => applyLaneSettings(ctx, workspace, {}, async () => birch.internals) });
		expect(birch.live.values).toEqual({ "compaction.enabled": false, "memory.backend": "off", disabledExtensions: ["context-file:project:CLAUDE.md"] });
		expect(claude.notices).toEqual([]);
	});

	it("are not touched outside a lane, in a subagent, or when the lane is held elsewhere", async () => {
		const { root, config } = world();
		let calls = 0;
		const laneSettings = async (): Promise<LaneSettingsResult> => {
			calls++;
			return { applied: true };
		};
		await ompOrrery(join(root, "plain"), config, { laneSettings });
		expect(calls).toBe(0);
		await ompOrrery(join(root, "agent-Atlas"), config, { laneSettings });
		expect(calls).toBe(1);
		await ompOrrery(join(root, "agent-Atlas"), config, { laneSettings, agent: "sub" });
		await ompOrrery(join(root, "agent-Atlas"), config, { laneSettings });
		expect(calls).toBe(1);
	});

	it("are taken back when the session moves out of the lane's folder (OMP keeps overrides across its cwd change), and switched again in the next lane", async () => {
		const { root, config } = world();
		writeFileSync(join(root, "agent-Atlas", "CLAUDE.md"), CLAUDE_CODE_LANE);
		const start = { "compaction.enabled": true, "memory.backend": "local", disabledExtensions: ["skill:mine"] };
		const { internals, live } = fakeInternals(start);
		const env: NodeJS.ProcessEnv = {};
		const omp = await ompOrrery(join(root, "agent-Atlas"), config, { laneSettings: (ctx, workspace) => applyLaneSettings(ctx, workspace, env, async () => internals) });
		expect(live.overrides).toEqual({ "compaction.enabled": false, "memory.backend": "off", disabledExtensions: ["skill:mine", "context-file:project:CLAUDE.md"] });
		expect(env).toEqual({ PI_NO_TITLE: "1" });
		omp.cwd = join(root, "plain");
		omp.session = { id: "elsewhere", entries: [] };
		await omp.emit("session_switch", { reason: "resume" });
		expect(live.overrides).toEqual({});
		expect(env).toEqual({});
		omp.cwd = join(root, "agent-Birch");
		omp.session = { id: "birch", entries: [] };
		await omp.emit("session_switch", { reason: "resume" });
		expect(live.overrides).toEqual({ "compaction.enabled": false, "memory.backend": "off" });
		expect(env).toEqual({ PI_NO_TITLE: "1" });
	});

	it("that would not be taken back: one notice, and the move goes on", async () => {
		const { root, config } = world();
		const { internals } = fakeInternals({ "compaction.enabled": true, "memory.backend": "local" }, { failsToClear: "memory.backend" });
		const omp = await ompOrrery(join(root, "agent-Atlas"), config, { laneSettings: (ctx, workspace) => applyLaneSettings(ctx, workspace, {}, async () => internals) });
		omp.cwd = join(root, "plain");
		await omp.emit("session_switch", { reason: "resume" });
		expect(omp.notices).toEqual([
			{ message: "Orrery: taking back OMP's settings for Atlas failed (cannot clear memory.backend): OMP's own compaction and memory may stay off in this session.", type: "warning" },
			{ message: "Orrery: this session moved from Atlas to another folder; Atlas's memory is closed.", type: "info" },
		]);
	});
});
