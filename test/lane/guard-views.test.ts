import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, describe, expect, it } from "vitest";
import { type HarnessConfig, type LaneConfig, parseConfig } from "../../src/lane/config.ts";
import { checkResolvedPath } from "../../src/lane/guard.ts";
import { guardToolCall, laneViews } from "../../src/lane/guard-paths.ts";
import { checkToolCall } from "../../src/lane/guard-rules.ts";
import { ctx, tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const view = (workspace: string) => join(workspace, ".orrery", "view.md");

/**
 * Two lanes set up Claude Code's file way, Atlas and Birch, each with its memory view in its folder under projects/, and
 * a scratch home beside them. `folders` writes a lane's workspace as another spelling (a link to its folder, say).
 */
function lanes(folders: Partial<Record<"Atlas" | "Birch", string>> = {}) {
	const root = realpathSync(tempDir("orrery-views-"));
	dirs.push(root);
	const home = join(root, "home");
	const projects = join(root, "projects");
	mkdirSync(home);
	let toml = `data_dir = ${JSON.stringify(join(root, "data"))}\n`;
	for (const name of ["Atlas", "Birch"] as const) {
		const folder = join(projects, `agent-${name}`);
		mkdirSync(join(folder, ".orrery"), { recursive: true });
		mkdirSync(join(folder, "src"));
		writeFileSync(view(folder), `${name}'s memory`);
		toml += `[lanes.${name}]\nworkspace = ${JSON.stringify(folders[name] ?? folder)}\nmodel = "faux-agent/faux-1"\ncompactor_model = "faux-compactor/faux-1"\ncompactor_thinking = "off"\n`;
	}
	for (const [name, written] of Object.entries(folders)) symlinkSync(join(projects, `agent-${name}`), written);
	const config = parseConfig(toml, root);
	return { root, home, projects, config, atlas: join(projects, "agent-Atlas"), birch: join(projects, "agent-Birch") };
}

type Lanes = ReturnType<typeof lanes>;
const lane = (config: HarnessConfig, name: string) => config.lanes.get(name) as LaneConfig;

/** The guard of a session picked as Atlas, working in `cwd` (its folder by default). */
const asAtlas = (t: Lanes, cwd = t.atlas) => ({ workspace: t.atlas, allowedRoots: [] as string[], cwd, home: t.home, ...laneViews(t.config, lane(t.config, "Atlas")) });
/** The guard of a session whose ORRERY_AGENT was refused, in `cwd`: no lane, so every lane's view is another's. */
const refusedIn = (t: Lanes, cwd: string) => ({ workspace: cwd, allowedRoots: [] as string[], cwd, home: t.home, ...laneViews(t.config) });

const bash = (command: string, options: Parameters<typeof checkToolCall>[1]) => checkToolCall({ name: "bash", arguments: { command } }, options);

describe("laneViews", () => {
	it("names every other lane's view file as another's, and the session's own; a refused pick owns none", () => {
		const t = lanes();
		expect(laneViews(t.config, lane(t.config, "Atlas"))).toEqual({ foreignViews: [view(t.birch)], ownView: view(t.atlas) });
		expect(laneViews(t.config)).toEqual({ foreignViews: [view(t.atlas), view(t.birch)] });
	});

	it("names a view as its workspace is written and where it really is", () => {
		const outside = realpathSync(tempDir("orrery-views-link-"));
		dirs.push(outside);
		const t = lanes({ Birch: join(outside, "birch-link") });
		expect(laneViews(t.config, lane(t.config, "Atlas")).foreignViews).toEqual([view(join(outside, "birch-link")), view(t.birch)]);
	});

	it("gives a session no own view when its folder is another lane's too: that lane's view is another's", () => {
		const t = lanes();
		const toml = `data_dir = ${JSON.stringify(join(t.root, "data"))}\n${["Atlas", "Birch"].map((name) => `[lanes.${name}]\nworkspace = ${JSON.stringify(t.atlas)}\nmodel = "faux-agent/faux-1"\ncompactor_model = "faux-compactor/faux-1"\n`).join("")}`;
		const shared = parseConfig(toml, t.root);
		expect(laneViews(shared, lane(shared, "Atlas"))).toEqual({ foreignViews: [view(t.atlas)] });
	});

	it("leaves out lanes with no folder", () => {
		const t = lanes();
		const toml = `data_dir = ${JSON.stringify(join(t.root, "data"))}\n[lanes.Atlas]\nworkspace = ${JSON.stringify(t.atlas)}\nmodel = "faux-agent/faux-1"\ncompactor_model = "faux-compactor/faux-1"\n[lanes.Roam]\nmodel = "faux-agent/faux-1"\ncompactor_model = "faux-compactor/faux-1"\n`;
		const config = parseConfig(toml, t.root);
		expect(laneViews(config, lane(config, "Roam"))).toEqual({ foreignViews: [view(t.atlas)] });
	});
});

describe("the view name rule in commands: only the session's own view is open", () => {
	it.each([
		(t: Lanes) => `cat ${view(t.birch)}`,
		() => "cat ../agent-Birch/.orrery/view.md",
		(t: Lanes) => `grep -r secret ${view(t.birch)}`,
		(t: Lanes) => `cp ${view(t.birch)} /tmp/x`,
		(t: Lanes) => `echo planted > ${view(t.birch)}`,
		(t: Lanes) => `cat "${t.birch}"/.orrery/view.md`,
		(t: Lanes) => `cat '${view(t.birch)}'`,
		(t: Lanes) => `cd ${t.birch} && cat .orrery/view.md`,
		(t: Lanes) => `pushd ${t.birch}; cat ./.orrery/view.md`,
		() => "cat $PWD/../agent-Birch/.orrery/view.md",
		() => "cat ~/../projects/agent-Birch/.orrery/view.md",
		() => "cat */.orrery/view.md",
		() => "cat {.,x}/.orrery/view.md",
		() => "cat src/../.orrery/view.md",
		() => "cat x\\ .orrery/view.md",
		() => "cat --file=.orrery/view.md",
	])("refuses Atlas the command %s", (command) => {
		const t = lanes();
		expect(bash(command(t), asAtlas(t))).toMatch(/sensitive/);
	});

	it.each([
		() => "cat .orrery/view.md",
		() => "cat ./.orrery/view.md",
		(t: Lanes) => `cat ${view(t.atlas)}`,
		() => "grep -n memory .orrery/view.md",
		() => "head -5 .orrery/view.md | wc -l",
		() => "wc -c < .orrery/view.md",
		() => "(cat .orrery/view.md)",
		() => "echo note >> .orrery/view.md; ls",
	])("allows Atlas the command %s on its own view", (command) => {
		const t = lanes();
		expect(bash(command(t), asAtlas(t))).toBeUndefined();
	});

	it("reads a word from the folder the command runs in, and ~/ from the home", () => {
		const t = lanes();
		expect(bash("cat .orrery/view.md", asAtlas(t, t.birch))).toMatch(/sensitive/);
		expect(bash(`cat ${view(t.atlas)}`, asAtlas(t, t.birch))).toBeUndefined();
		expect(bash("cat ../.orrery/view.md", asAtlas(t, join(t.atlas, "src")))).toMatch(/sensitive/);
		const homeIsProjects = { ...asAtlas(t), home: t.projects };
		expect(bash("cat ~/agent-Atlas/.orrery/view.md", homeIsProjects)).toBeUndefined();
		expect(bash("cat ~/agent-Birch/.orrery/view.md", homeIsProjects)).toMatch(/sensitive/);
	});

	it("refuses every view file to a refused pick, the folder's own lane's too", () => {
		const t = lanes();
		expect(bash("cat .orrery/view.md", refusedIn(t, t.atlas))).toMatch(/sensitive/);
		expect(bash(`cat ${view(t.atlas)}`, refusedIn(t, t.atlas))).toMatch(/sensitive/);
		expect(bash(`cat ${view(t.birch)}`, refusedIn(t, t.atlas))).toMatch(/sensitive/);
	});

	it("judges a very long command quickly with lane views given", () => {
		const t = lanes();
		const options = asAtlas(t);
		const units = [".orrery/view.md ", "x/.orrery/view.md ", ".orrery/view.md;", "a/", "a", ",.orrery/view.md", "~/.orrery/view.md ", "cd "];
		// As the guard's own timing test does: a 4x step must cost under 10x (linear is about 4x), best of three each size.
		const time = (unit: string, times: number) => {
			const command = `cat ${unit.repeat(times)}.orrery/view.md`;
			const started = performance.now();
			bash(command, options);
			return performance.now() - started;
		};
		for (const unit of units) {
			time(unit, 500); // warm up
			let small = Number.POSITIVE_INFINITY;
			let large = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				small = Math.min(small, time(unit, 4_000));
				large = Math.min(large, time(unit, 16_000));
			}
			expect(large / Math.max(small, 20), `${JSON.stringify(unit)}: ${small.toFixed(0)} ms -> ${large.toFixed(0)} ms`).toBeLessThan(10);
			expect(large, `${JSON.stringify(unit)} backstop`).toBeLessThan(5_000);
		}
	});

	it("checks a path argument's view by name too", () => {
		const t = lanes();
		expect(checkToolCall({ name: "read", arguments: { path: view(t.birch) } }, asAtlas(t))).toMatch(/sensitive/);
		expect(checkToolCall({ name: "read", arguments: { path: "../agent-Birch/.orrery/view.md" } }, asAtlas(t))).toMatch(/sensitive/);
		expect(checkToolCall({ name: "read", arguments: { path: ".orrery/view.md" } }, asAtlas(t))).toBeUndefined();
		expect(checkToolCall({ name: "read", arguments: { path: ".orrery/view.md" } }, refusedIn(t, t.atlas))).toMatch(/sensitive/);
	});
});

describe("the path judge: another lane's view is refused wherever the path lands", () => {
	it.each(["read", "write", "edit"])("refuses %s of Birch's view by absolute and relative path and through links", (tool) => {
		const t = lanes();
		symlinkSync(view(t.birch), join(t.atlas, "notes.md"));
		symlinkSync(t.birch, join(t.atlas, "birch"));
		symlinkSync(join(t.birch, ".orrery"), join(t.atlas, "dot"));
		const options = asAtlas(t);
		for (const path of [view(t.birch), "../agent-Birch/.orrery/view.md", "notes.md", "birch/.orrery/view.md", "dot/view.md", "~/../projects/agent-Birch/.orrery/view.md"]) {
			expect([path, guardToolCall(tool, { path, content: "x", edits: [] }, options)]).toEqual([path, expect.stringMatching(/sensitive|memory view/)]);
		}
	});

	it.each(["read", "write", "edit"])("allows %s of Atlas's own view, relative and absolute", (tool) => {
		const t = lanes();
		for (const path of [".orrery/view.md", view(t.atlas), "./.orrery/view.md"]) {
			expect([path, guardToolCall(tool, { path, content: "x", edits: [] }, asAtlas(t))]).toEqual([path, undefined]);
		}
	});

	it("opens Atlas's own view however its folder is written, and refuses Birch's however Birch's is", () => {
		const outside = realpathSync(tempDir("orrery-views-link-"));
		dirs.push(outside);
		const t = lanes({ Atlas: join(outside, "atlas-link"), Birch: join(outside, "birch-link") });
		const options = { ...asAtlas(t), workspace: join(outside, "atlas-link") };
		expect(guardToolCall("read", { path: view(join(outside, "atlas-link")) }, options)).toBeUndefined();
		expect(guardToolCall("read", { path: view(t.atlas) }, options)).toBeUndefined();
		// Through guardToolCall, as pi, OMP and Claude Code judge a command: it knows where the own view really is.
		expect(guardToolCall("bash", { command: `cat ${view(t.atlas)}` }, options)).toBeUndefined();
		expect(guardToolCall("bash", { command: `cat ${view(join(outside, "atlas-link"))}` }, options)).toBeUndefined();
		expect(guardToolCall("bash", { command: `cat ${view(t.birch)}` }, options)).toMatch(/sensitive/);
		expect(guardToolCall("read", { path: view(join(outside, "birch-link")) }, options)).toMatch(/sensitive|memory view/);
		expect(guardToolCall("read", { path: view(t.birch) }, options)).toMatch(/sensitive|memory view/);
	});

	it("refuses a search whose root holds Birch's view, and allows Atlas's own folder and Birch's subfolders", () => {
		const t = lanes();
		const options = asAtlas(t);
		for (const [tool, path] of [
			["grep", t.birch],
			["find", t.birch],
			["ls", t.birch],
			["grep", t.projects],
			["grep", view(t.birch)],
			["grep", "../agent-Birch"],
		] as const) {
			expect([tool, path, guardToolCall(tool, { pattern: "x", path }, options)]).toEqual([tool, path, expect.stringMatching(/memory view|sensitive/)]);
		}
		expect(guardToolCall("grep", { pattern: "x" }, asAtlas(t, t.birch))).toMatch(/memory view/);
		expect(guardToolCall("grep", { pattern: "x", path: t.atlas }, options)).toBeUndefined();
		expect(guardToolCall("grep", { pattern: "x" }, options)).toBeUndefined();
		expect(guardToolCall("find", { pattern: "*.ts", path: join(t.birch, "src") }, options)).toBeUndefined();
		expect(guardToolCall("grep", { pattern: "x", path: t.atlas, glob: "**/.orrery/view.md" }, options)).toMatch(/sensitive/);
	});

	it("lets a search through a folder that holds no view file (yet): another lane's view is refused once it is there", () => {
		const t = lanes();
		rmSync(view(t.birch));
		expect(guardToolCall("grep", { pattern: "x", path: t.birch }, asAtlas(t))).toBeUndefined();
		expect(guardToolCall("read", { path: view(t.birch) }, asAtlas(t))).toMatch(/sensitive|memory view/);
		expect(guardToolCall("write", { path: view(t.birch), content: "planted" }, { ...asAtlas(t), allowedRoots: [t.birch] })).toMatch(/sensitive|memory view/);
	});

	it("refuses every view to a refused pick, its folder's lane's own too", () => {
		const t = lanes();
		const options = refusedIn(t, t.atlas);
		expect(guardToolCall("read", { path: ".orrery/view.md" }, options)).toMatch(/sensitive|memory view/);
		expect(guardToolCall("read", { path: view(t.birch) }, options)).toMatch(/sensitive|memory view/);
		expect(guardToolCall("grep", { pattern: "x" }, options)).toMatch(/memory view/);
	});

	it("keeps today's rules where no lane views are given", () => {
		const t = lanes();
		const plain = { workspace: t.atlas, allowedRoots: [] as string[], cwd: t.atlas, home: t.home };
		expect(guardToolCall("read", { path: view(t.birch) }, plain)).toBeUndefined();
		expect(guardToolCall("grep", { pattern: "x", path: t.birch }, plain)).toBeUndefined();
	});
});

describe("the durable harness's own check (checkResolvedPath)", () => {
	it("refuses Birch's view by absolute and relative path and through a link, and opens Atlas's", async () => {
		const t = lanes();
		symlinkSync(view(t.birch), join(t.atlas, "notes.md"));
		const env = new NodeExecutionEnv({ cwd: t.atlas });
		const options = asAtlas(t);
		for (const mode of ["read", "write"] as const) {
			for (const path of [view(t.birch), "../agent-Birch/.orrery/view.md", "notes.md"]) {
				expect([mode, path, await checkResolvedPath(env, path, mode, options, ctx)]).toEqual([mode, path, expect.stringMatching(/sensitive|memory view/)]);
			}
			expect(await checkResolvedPath(env, ".orrery/view.md", mode, options, ctx)).toBeUndefined();
			expect(await checkResolvedPath(env, view(t.atlas), mode, options, ctx)).toBeUndefined();
		}
		expect(await checkResolvedPath(env, ".orrery/view.md", "read", refusedIn(t, t.atlas), ctx)).toMatch(/sensitive|memory view/);
	});
});
