import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, describe, expect, it } from "vitest";
import { writeSetupMarker } from "../../src/claude/view-file.ts";
import { type HarnessConfig, type LaneConfig, parseConfig } from "../../src/lane/config.ts";
import { checkResolvedPath } from "../../src/lane/guard.ts";
import { guardOmpToolCall, guardToolCall, laneViews } from "../../src/lane/guard-paths.ts";
import { checkToolCall } from "../../src/lane/guard-rules.ts";
import { ctx, tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const view = (workspace: string) => join(workspace, ".orrery", "view.md");

/**
 * Two lanes, Atlas and Birch, each with its memory view in its folder under projects/ (as Claude Code's file mode keeps
 * it), and a scratch home beside them. `folders` writes a lane's workspace as another spelling (a link to its folder).
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

const bash = (command: string, options: Parameters<typeof guardToolCall>[2]) => guardToolCall("bash", { command }, options);

describe("laneViews", () => {
	it("names every other lane's view file as another's, and the session's own; a refused pick owns none", () => {
		const t = lanes();
		expect(laneViews(t.config, lane(t.config, "Atlas"))).toEqual({ foreignViews: [view(t.birch)], fileModeViews: [], ownView: view(t.atlas) });
		expect(laneViews(t.config)).toEqual({ foreignViews: [view(t.atlas), view(t.birch)], fileModeViews: [] });
	});

	it("names a view as its workspace is written and where it really is", () => {
		const outside = realpathSync(tempDir("orrery-views-link-"));
		dirs.push(outside);
		const t = lanes({ Birch: join(outside, "birch-link") });
		expect(laneViews(t.config, lane(t.config, "Atlas")).foreignViews).toEqual([view(join(outside, "birch-link")), view(t.birch)]);
	});

	it("counts the views of lanes set up the file way, by their setup marker, before the file is written", () => {
		const t = lanes();
		rmSync(view(t.birch));
		writeSetupMarker(lane(t.config, "Birch").dir, t.birch, "CLAUDE.local.md");
		expect(laneViews(t.config, lane(t.config, "Atlas")).fileModeViews).toEqual([view(t.birch)]);
		writeSetupMarker(lane(t.config, "Birch").dir, t.birch, "mod");
		expect(laneViews(t.config, lane(t.config, "Atlas")).fileModeViews).toEqual([]);
	});

	it("gives a session no own view when its folder is another lane's too, in any letter case: that lane's view is another's", () => {
		const t = lanes();
		const config = (birchFolder: string) =>
			parseConfig(
				`data_dir = ${JSON.stringify(join(t.root, "data"))}\n${[
					["Atlas", t.atlas],
					["Birch", birchFolder],
				]
					.map(([name, folder]) => `[lanes.${name}]\nworkspace = ${JSON.stringify(folder)}\nmodel = "faux-agent/faux-1"\ncompactor_model = "faux-compactor/faux-1"\n`)
					.join("")}`,
				t.root,
			);
		const shared = config(t.atlas);
		expect(laneViews(shared, lane(shared, "Atlas"))).toEqual({ foreignViews: [view(t.atlas)], fileModeViews: [] });
		const cased = config(t.atlas.toUpperCase());
		expect(laneViews(cased, lane(cased, "Atlas")).ownView).toBeUndefined();
	});

	it("leaves out lanes with no folder", () => {
		const t = lanes();
		const toml = `data_dir = ${JSON.stringify(join(t.root, "data"))}\n[lanes.Atlas]\nworkspace = ${JSON.stringify(t.atlas)}\nmodel = "faux-agent/faux-1"\ncompactor_model = "faux-compactor/faux-1"\n[lanes.Roam]\nmodel = "faux-agent/faux-1"\ncompactor_model = "faux-compactor/faux-1"\n`;
		const config = parseConfig(toml, t.root);
		expect(laneViews(config, lane(config, "Roam"))).toEqual({ foreignViews: [view(t.atlas)], fileModeViews: [] });
	});
});

describe("the view name rule in commands: only the session's own view, by an absolute or ~/ path", () => {
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
		// Atlas's own view by a relative path: a shell may keep a folder of its own (OMP's does), so the host's cwd is no proof
		() => "cat .orrery/view.md",
		() => "cat ./.orrery/view.md",
		() => "grep -n memory .orrery/view.md",
		(t: Lanes) => `cat "${view(t.atlas)}"`,
		(t: Lanes) => `cat ${t.atlas}/src/../.orrery/view.md`,
	])("refuses Atlas the command %s", (command) => {
		const t = lanes();
		expect(bash(command(t), asAtlas(t))).toMatch(/sensitive/);
	});

	it.each([
		(t: Lanes) => `cat ${view(t.atlas)}`,
		(t: Lanes) => `grep -n memory ${view(t.atlas)}`,
		(t: Lanes) => `head -5 ${view(t.atlas)} | wc -l`,
		(t: Lanes) => `wc -c < ${view(t.atlas)}`,
		(t: Lanes) => `(cat ${view(t.atlas)})`,
		(t: Lanes) => `cd ${t.birch} && cat ${view(t.atlas)}`,
	])("allows Atlas the command %s on its own view", (command) => {
		const t = lanes();
		expect(bash(command(t), asAtlas(t))).toBeUndefined();
	});

	it("reads an absolute word the same from any folder, and opens no ~/ spelling (fix round 3)", () => {
		const t = lanes();
		expect(bash(`cat ${view(t.atlas)}`, asAtlas(t, t.birch))).toBeUndefined();
		expect(bash(`cat ${view(t.birch)}`, asAtlas(t, t.birch))).toMatch(/sensitive/);
		// The shell's ~ follows its HOME, which a command may change; the guard's home is no proof of where ~ leads.
		const homeIsRoot = { ...asAtlas(t), home: t.root };
		expect(bash("cat ~/projects/agent-Atlas/.orrery/view.md", homeIsRoot)).toMatch(/sensitive/);
		const leak = `export HOME=${t.root}/x; mkdir -p ~/projects; ln -sfn ${t.birch} ~/projects/agent-Atlas; cat ~/projects/agent-Atlas/.orrery/view.md`;
		expect(bash(leak, homeIsRoot)).toMatch(/sensitive/);
		expect(bash("cat $HOME/projects/agent-Atlas/.orrery/view.md", homeIsRoot)).toMatch(/sensitive/);
	});

	it("refuses every view file to a refused pick, the folder's own lane's too", () => {
		const t = lanes();
		expect(bash(`cat ${view(t.atlas)}`, refusedIn(t, t.atlas))).toMatch(/sensitive/);
		expect(bash(`cat ${view(t.birch)}`, refusedIn(t, t.atlas))).toMatch(/sensitive/);
	});

	it("judges a very long command quickly", () => {
		const t = lanes();
		const options = asAtlas(t);
		const units = [`${view(t.atlas)} `, ".orrery/view.md ", "x/.orrery/view.md ", ".orrery/view.md;", "a/", "a", ",.orrery/view.md", "~/.orrery/view.md ", "cd "];
		// As the guard's own timing test does: a 4x step must cost under 10x (linear is about 4x), best of three each size.
		const time = (unit: string, times: number) => {
			const command = `cat ${unit.repeat(times)}${view(t.atlas)}`;
			const started = performance.now();
			bash(command, options);
			return performance.now() - started;
		};
		for (const unit of units) {
			time(unit, 500); // warm up
			let small = Number.POSITIVE_INFINITY;
			let large = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				small = Math.min(small, time(unit, 2_000));
				large = Math.min(large, time(unit, 8_000));
			}
			expect(large / Math.max(small, 20), `${JSON.stringify(unit)}: ${small.toFixed(0)} ms -> ${large.toFixed(0)} ms`).toBeLessThan(10);
			expect(large, `${JSON.stringify(unit)} backstop`).toBeLessThan(5_000);
		}
	});

	it("checks a file tool's path by where it resolves: a relative path to the own view is open there", () => {
		const t = lanes();
		expect(checkToolCall({ name: "read", arguments: { path: view(t.birch) } }, asAtlas(t))).toMatch(/sensitive/);
		expect(checkToolCall({ name: "read", arguments: { path: "../agent-Birch/.orrery/view.md" } }, asAtlas(t))).toMatch(/sensitive/);
		expect(checkToolCall({ name: "read", arguments: { path: ".orrery/view.md" } }, asAtlas(t))).toBeUndefined();
		expect(checkToolCall({ name: "read", arguments: { path: ".orrery/view.md" } }, refusedIn(t, t.atlas))).toMatch(/sensitive/);
	});
});

describe("Orrery's config: file tools may read it, nothing may change it, and shell text may not name it", () => {
	/** An agent opened in its home, so the work area holds Orrery's home and its config. */
	function inHome() {
		const t = lanes();
		const data = join(t.home, ".orrery");
		mkdirSync(data);
		writeFileSync(join(data, "config.toml"), "");
		return { ...t, data, options: { ...asAtlas(t, t.home), workspace: t.home, orreryData: data } };
	}

	it("refuses shell text that names it, to read or to change it", () => {
		const { options } = inHome();
		for (const command of ["cat ~/.orrery/config.toml", "sed -i s/Atlas/Birch/ ~/.orrery/config.toml", "printf '[' >> ~/.orrery/config.toml", "cd ~/.orrery && cat config.toml"]) {
			expect([command, bash(command, options)]).toEqual([command, expect.stringMatching(/sensitive/)]);
		}
	});

	it("lets file tools read it and refuses their writes, though the work area holds it", () => {
		const { data, options } = inHome();
		expect(guardToolCall("read", { path: join(data, "config.toml") }, options)).toBeUndefined();
		expect(guardToolCall("read", { path: "~/.orrery/config.toml" }, options)).toBeUndefined();
		for (const tool of ["write", "edit"]) {
			expect(guardToolCall(tool, { path: "~/.orrery/config.toml", content: "x" }, options)).toMatch(/Orrery's config/);
			expect(guardToolCall(tool, { path: join(data, "config.toml"), content: "x" }, options)).toMatch(/Orrery's config/);
			expect(guardOmpToolCall(tool, { path: join(data, "config.toml"), input: "x", content: "x" }, options)).toMatch(/Orrery's config/);
		}
		// A custom data folder: its config.toml is refused by where it is.
		const store = join(options.workspace, "store");
		mkdirSync(store);
		writeFileSync(join(store, "config.toml"), "");
		expect(guardToolCall("write", { path: join(store, "config.toml"), content: "x" }, { ...options, orreryData: store })).toMatch(/Orrery's config/);
		expect(guardToolCall("write", { path: join(options.workspace, "notes.md"), content: "x" }, options)).toBeUndefined();
	});

	it("refuses its writes in the durable harness too", async () => {
		const { data, options } = inHome();
		const env = new NodeExecutionEnv({ cwd: options.workspace });
		expect(await checkResolvedPath(env, join(data, "config.toml"), "write", options, ctx)).toMatch(/Orrery's config/);
		expect(await checkResolvedPath(env, join(data, "config.toml"), "read", options, ctx)).toBeUndefined();
	});
});

describe("Orrery's installed program: file tools may read it, nothing may change it, and shell text may not name it (fix round 3)", () => {
	/** An agent opened in its home, so the work area holds Orrery's home and its installed program (app/current). */
	function inHome() {
		const t = lanes();
		const data = join(t.home, ".orrery");
		const app = join(data, "app");
		mkdirSync(join(app, "0.6.0", "src"), { recursive: true });
		symlinkSync("0.6.0", join(app, "current"));
		writeFileSync(join(app, "0.6.0", "src", "main.ts"), "");
		return { ...t, data, app, main: join(app, "current", "src", "main.ts"), options: { ...asAtlas(t, t.home), workspace: t.home, orreryData: data } };
	}

	it("refuses shell text that names it", () => {
		const { app, options } = inHome();
		for (const command of [
			"ln -sfn /tmp/x ~/.orrery/app/current",
			"chmod -R u+w ~/.orrery/app",
			"rm -rf ~/.orrery/app/current",
			"ls ~/.orrery/app",
			"ls ~/.orrery/app/current/src",
			`cat ${app}/current/src/main.ts`,
			"cd ~/.orrery/app && ls",
			"cp /tmp/x /somewhere/.orrery/app/current/bin/orrery",
		]) {
			expect([command, bash(command, options)]).toEqual([command, expect.stringMatching(/sensitive/)]);
		}
	});

	it("lets file tools read it and refuses their writes and edits by any spelling or link, though the work area holds it", () => {
		const { home, app, main, options } = inHome();
		symlinkSync(join(app, "0.6.0"), join(home, "prog"));
		expect(guardToolCall("read", { path: main }, options)).toBeUndefined();
		expect(guardToolCall("read", { path: "~/.orrery/app/current/src/main.ts" }, options)).toBeUndefined();
		expect(guardToolCall("read", { path: "prog/src/main.ts" }, options)).toBeUndefined();
		expect(guardToolCall("grep", { pattern: "x", path: join(app, "current") }, options)).toBeUndefined();
		const paths = [main, "~/.orrery/app/current/src/main.ts", join(app, "0.7.0", "new.ts"), join(app, "current"), "prog/src/main.ts", join(home, ".Orrery", "APP", "x.ts")];
		for (const tool of ["write", "edit"]) {
			for (const path of paths) expect([tool, path, guardToolCall(tool, { path, content: "x" }, options)]).toEqual([tool, path, expect.stringMatching(/Orrery's installed program/)]);
			expect(guardOmpToolCall(tool, { path: main, input: "x", content: "x" }, options)).toMatch(/Orrery's installed program/);
		}
		// A custom data folder: its app/ is refused by where it is.
		const store = join(home, "store");
		mkdirSync(join(store, "app"), { recursive: true });
		expect(guardToolCall("write", { path: join(store, "app", "x.ts"), content: "x" }, { ...options, orreryData: store })).toMatch(/Orrery's installed program/);
		expect(guardToolCall("write", { path: join(home, "notes.md"), content: "x" }, options)).toBeUndefined();
	});

	it("refuses its writes in the durable harness too", async () => {
		const { main, options } = inHome();
		const env = new NodeExecutionEnv({ cwd: options.workspace });
		expect(await checkResolvedPath(env, main, "write", options, ctx)).toMatch(/Orrery's installed program/);
		expect(await checkResolvedPath(env, main, "read", options, ctx)).toBeUndefined();
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
		expect(bash(`cat ${view(t.atlas)}`, options)).toBeUndefined();
		expect(bash(`cat ${view(join(outside, "atlas-link"))}`, options)).toBeUndefined();
		expect(bash(`cat ${view(t.birch)}`, options)).toMatch(/sensitive/);
		expect(guardToolCall("read", { path: view(join(outside, "birch-link")) }, options)).toMatch(/sensitive|memory view/);
		expect(guardToolCall("read", { path: view(t.birch) }, options)).toMatch(/sensitive|memory view/);
	});

	it("refuses a content search whose root holds Birch's view, and lets a listing of it through", () => {
		const t = lanes();
		const options = asAtlas(t);
		for (const path of [t.birch, t.projects, view(t.birch), "../agent-Birch"]) {
			expect([path, guardToolCall("grep", { pattern: "x", path }, options)]).toEqual([path, expect.stringMatching(/memory view|sensitive/)]);
		}
		expect(guardToolCall("grep", { pattern: "x" }, asAtlas(t, t.birch))).toMatch(/memory view/);
		// ls and find (fd) list names only.
		for (const tool of ["ls", "find"]) {
			expect([tool, guardToolCall(tool, { pattern: "*.md", path: t.birch }, options)]).toEqual([tool, undefined]);
			expect([tool, guardToolCall(tool, {}, asAtlas(t, t.birch))]).toEqual([tool, undefined]);
			expect([tool, guardToolCall(tool, { path: view(t.birch) }, options)]).toEqual([tool, expect.stringMatching(/memory view|sensitive/)]);
		}
		expect(guardToolCall("grep", { pattern: "x", path: t.atlas }, options)).toBeUndefined();
		expect(guardToolCall("grep", { pattern: "x" }, options)).toBeUndefined();
		expect(guardToolCall("grep", { pattern: "x", path: join(t.birch, "src") }, options)).toBeUndefined();
		expect(guardToolCall("grep", { pattern: "x", path: t.atlas, glob: "**/.orrery/view.md" }, options)).toMatch(/sensitive/);
	});

	it("lets a content search through a folder with no view file yet, unless its lane is set up the file way", () => {
		const t = lanes();
		rmSync(view(t.birch));
		expect(guardToolCall("grep", { pattern: "x", path: t.birch }, asAtlas(t))).toBeUndefined();
		writeSetupMarker(lane(t.config, "Birch").dir, t.birch, "CLAUDE.md");
		expect(guardToolCall("grep", { pattern: "x", path: t.birch }, asAtlas(t))).toMatch(/memory view/);
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
