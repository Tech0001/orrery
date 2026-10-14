import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { guardToolCall, movedAgentDirCredentials } from "../../src/pi/guard.ts";
import type { HarnessConfig } from "../../src/lane/config.ts";
import { createOrrery } from "../../src/pi/index.ts";
import { fakeOmp, ompCleanup, track } from "../omp/world.ts";
import type { PiRun } from "./harness.ts";
import { cleanup, pi, scratchHome, summarySourcesFor, world } from "./world.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup() {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "orrery-guard-")));
	const workspace = join(dir, "ws");
	mkdirSync(join(workspace, "sub"), { recursive: true });
	mkdirSync(join(dir, "outside"));
	symlinkSync(join(dir, "outside"), join(workspace, "link"));
	// A scratch home, so no case stats the real one's credential files (~/.omp's among them).
	return { workspace, options: { workspace, allowedRoots: [], cwd: join(workspace, "sub"), home: join(dir, "home"), foreignViews: [] as string[] } };
}
const write = (path: string, options: Parameters<typeof guardToolCall>[2]) => guardToolCall("write", { path, content: "x" }, options);

describe("guardToolCall resolves paths the way pi's tools do", () => {
	it("blocks ~, @/abs, file:// and symlink escapes for write", () => {
		const { options } = setup();
		expect(write("~/x", options)).toMatch(/outside/);
		expect(write("@/etc/x", options)).toMatch(/outside/);
		expect(write("file:///etc/x", options)).toMatch(/outside/);
		expect(write("../link/x", options)).toMatch(/outside/);
		expect(write("../link/new/deeper.txt", options)).toMatch(/outside/);
	});

	it("allows @notes.md and relative paths from a cwd subfolder", () => {
		const { options } = setup();
		expect(write("@notes.md", options)).toBeUndefined();
		expect(write("a/b.ts", options)).toBeUndefined();
		expect(write("../top.ts", options)).toBeUndefined();
	});

	it("still checks sensitive files and bash commands", () => {
		const { options } = setup();
		expect(guardToolCall("read", { path: "~/.ssh/id_ed25519" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("bash", { command: "cat ~/.ssh/config" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("bash", { command: "ls" }, options)).toBeUndefined();
	});
});

describe("guardToolCall keeps credentials in the user's home out", () => {
	/** A fake home with pi's models.json, beside the workspace and another repo the lane may read. */
	function homeSetup() {
		const { workspace, options } = setup();
		const home = join(dir, "home");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		mkdirSync(join(home, ".ssh"));
		mkdirSync(join(dir, "repo"));
		writeFileSync(join(home, ".pi", "agent", "models.json"), "{}");
		return { workspace, home, options: { ...options, home } };
	}

	it("refuses OMP's credential stores in pi too", () => {
		const { options } = homeSetup();
		expect(guardToolCall("read", { path: "~/.omp/agent/agent.db" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("read", { path: "~/.omp/agent/models.yml" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("read", { path: "~/.omp/.env" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("read", { path: "~/.omp/agent/.env" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("read", { path: "~/.omp/agent/secrets.yml" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("grep", { pattern: "key", path: "~/.omp" }, options)).toMatch(/narrower folder/);
	});

	it("blocks pi's models.json and /proc/*/environ through the raw, the resolved and the real path", () => {
		const { workspace, home, options } = homeSetup();
		const read = (path: string, cwd = options.cwd) => guardToolCall("read", { path }, { ...options, cwd });
		expect(read("~/.pi/agent/models.json")).toMatch(/sensitive/);
		expect(read(join(home, ".pi/agent/models.json"))).toMatch(/sensitive/);
		expect(read("/proc/self/environ")).toMatch(/sensitive/);
		expect(read("/proc/1/environ")).toMatch(/sensitive/);
		expect(read("environ", "/proc/self")).toMatch(/sensitive/);
		expect(guardToolCall("bash", { command: "cat /proc/self/environ" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("bash", { command: "cat ~/.pi/agent/models.json" }, options)).toMatch(/sensitive/);
		// Only the real target names the file: a link in the workspace.
		symlinkSync(join(home, ".pi", "agent", "models.json"), join(workspace, "settings.json"));
		expect(read("../settings.json")).toMatch(/sensitive/);
		// Only pi's resolution names the file: ~/.pi is itself a link (dotfiles kept elsewhere), cwd is under it.
		const stow = join(dir, "dotfiles");
		mkdirSync(join(stow, "agent"), { recursive: true });
		writeFileSync(join(stow, "agent", "models.json"), "{}");
		const linkedHome = join(dir, "home2");
		mkdirSync(linkedHome);
		symlinkSync(stow, join(linkedHome, ".pi"));
		expect(read("models.json", join(linkedHome, ".pi", "agent"))).toMatch(/sensitive/);
	});

	it("checks grep, find and ls glob and pattern arguments", () => {
		const { options } = homeSetup();
		const repo = join(dir, "repo");
		expect(guardToolCall("grep", { pattern: "x", path: repo, glob: "**/.ssh/**" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("find", { pattern: "id_ed25519*", path: repo }, options)).toMatch(/sensitive/);
		expect(guardToolCall("grep", { pattern: "x", path: repo, glob: ".pi/agent/models.json" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("grep", { pattern: "TODO", path: repo, glob: "*.ts" }, options)).toBeUndefined();
	});

	it("lets grep search file contents for credential names (its pattern is text, not a file name), but not glob for them", () => {
		const { workspace, options } = homeSetup();
		expect(guardToolCall("grep", { pattern: "auth.json", path: workspace }, options)).toBeUndefined();
		expect(guardToolCall("grep", { pattern: "id_rsa|\\.ssh/", path: workspace }, options)).toBeUndefined();
		expect(guardToolCall("grep", { pattern: "auth.json", path: workspace, glob: "**/auth.json" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("find", { pattern: "auth.json", path: workspace }, options)).toMatch(/sensitive/);
	});

	it("blocks a search rooted at home or above it (it would recurse into ~/.ssh and ~/.pi), and says to narrow it", () => {
		const { workspace, home, options } = homeSetup();
		expect(guardToolCall("grep", { pattern: "apiKey", path: "~" }, options)).toMatch(/narrower folder/);
		expect(guardToolCall("grep", { pattern: "apiKey", path: home }, options)).toMatch(/narrower folder/);
		expect(guardToolCall("find", { pattern: "*.json", path: dir }, options)).toMatch(/narrower folder/);
		expect(guardToolCall("ls", { path: "/" }, options)).toMatch(/narrower folder/);
		expect(guardToolCall("grep", { pattern: "apiKey" }, { ...options, cwd: home })).toMatch(/narrower folder/);
		expect(guardToolCall("grep", { pattern: "apiKey", path: "~/.pi/agent" }, options)).toMatch(/narrower folder/);
		// A link to home is home.
		symlinkSync(home, join(workspace, "home-link"));
		expect(guardToolCall("grep", { pattern: "apiKey", path: "../home-link" }, options)).toMatch(/narrower folder/);
	});

	it("still allows reads and searches elsewhere: lanes read other repos", () => {
		const { workspace, options } = homeSetup();
		const repo = join(dir, "repo");
		expect(guardToolCall("grep", { pattern: "TODO", path: repo }, options)).toBeUndefined();
		expect(guardToolCall("find", { pattern: "*.ts", path: repo }, options)).toBeUndefined();
		expect(guardToolCall("ls", { path: repo }, options)).toBeUndefined();
		expect(guardToolCall("ls", {}, options)).toBeUndefined();
		expect(guardToolCall("grep", { pattern: "TODO" }, options)).toBeUndefined();
		expect(guardToolCall("read", { path: join(repo, "README.md") }, options)).toBeUndefined();
		expect(guardToolCall("read", { path: "/etc/os-release" }, options)).toBeUndefined();
		expect(guardToolCall("write", { path: join(workspace, "a.ts"), content: "x" }, options)).toBeUndefined();
	});
});

describe("guardToolCall against spellings that dodge the patterns", () => {
	function adversary() {
		const { workspace, options } = setup();
		const home = join(dir, "home");
		const stow = join(dir, "dotfiles-ssh"); // ~/.ssh kept elsewhere, linked in (as dotfile managers do)
		mkdirSync(stow);
		writeFileSync(join(stow, "config"), "Host x");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		symlinkSync(stow, join(home, ".ssh"));
		const data = join(dir, "orrery-data");
		mkdirSync(data);
		writeFileSync(join(data, "credentials.json"), "{}");
		return { workspace, home, data, options: { ...options, home, credentials: [join(data, "credentials.json")] } };
	}

	it("refuses a search at home or above however the path is written", () => {
		const { workspace, home, options } = adversary();
		const grep = (path: string, cwd = options.cwd) => guardToolCall("grep", { pattern: "key", path }, { ...options, cwd });
		for (const path of ["~", "~/", "~/..", "@~", `file://${home}`, `${home}/./`, `${home}/../home`, ".", ""]) {
			expect([path, grep(path, home)]).toEqual([path, expect.stringMatching(/narrower folder/)]);
		}
		// On a case-insensitive file system (macOS) another letter case is the same folder.
		expect(grep(home.toUpperCase())).toMatch(/narrower folder/);
		expect(grep(join(home, ".PI"))).toMatch(/narrower folder/);
		symlinkSync(dir, join(workspace, "up"));
		expect(grep("../up")).toMatch(/narrower folder/);
		expect(guardToolCall("find", { pattern: "*", path: "~/.." }, options)).toMatch(/narrower folder/);
		expect(guardToolCall("ls", { path: "/proc/self/root" }, options)).toMatch(/narrower folder/);
	});

	it("refuses a search whose root holds any credential location, whatever its glob (globs cannot be enumerated)", () => {
		const { home, data, options } = adversary();
		for (const glob of ["**/.ss[h]/*", "**/.s?h/**", "{.ssh,x}/*", "**/*", "*sh/*"]) {
			expect(guardToolCall("grep", { pattern: "x", path: home, glob }, options)).toMatch(/narrower folder|sensitive/);
		}
		expect(guardToolCall("grep", { pattern: "x", path: join(home, ".pi") }, options)).toMatch(/narrower folder/);
		expect(guardToolCall("grep", { pattern: "x", path: data }, options)).toMatch(/narrower folder/);
		expect(guardToolCall("grep", { pattern: "PATH", path: "/proc/self" }, options)).toMatch(/narrower folder/);
		expect(guardToolCall("grep", { pattern: "PATH", path: "/proc" }, options)).toMatch(/narrower folder/);
	});

	it("refuses credential files reached through a linked ~/.ssh, a configured credentials file, or another letter case", () => {
		const { workspace, home, data, options } = adversary();
		symlinkSync(join(home, ".ssh"), join(workspace, "keys"));
		expect(guardToolCall("read", { path: "../keys/config" }, options)).toMatch(/sensitive/);
		symlinkSync(join(data, "credentials.json"), join(workspace, "c.txt"));
		expect(guardToolCall("read", { path: "../c.txt" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("read", { path: "~/.SSH/id_rsa" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("read", { path: "~/.SSH/config" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("read", { path: join(home, ".PI/agent/AUTH.json") }, options)).toMatch(/sensitive/);
		expect(guardToolCall("read", { path: "/proc/self/task/1/environ" }, options)).toMatch(/sensitive/);
		// Still fine: a file beside the credentials, a repo, pi's settings.
		writeFileSync(join(data, "notes.txt"), "x");
		expect(guardToolCall("read", { path: join(data, "notes.txt") }, options)).toBeUndefined();
		expect(guardToolCall("read", { path: "~/.pi/agent/settings.json" }, options)).toBeUndefined();
		expect(guardToolCall("grep", { pattern: "TODO", path: join(dir, "outside"), glob: "**/*" }, options)).toBeUndefined();
	});
});

describe("movedAgentDirCredentials", () => {
	it("names pi's credential files in an agent dir moved by PI_CODING_AGENT_DIR", () => {
		dir = mkdtempSync(join(tmpdir(), "orrery-guard-"));
		expect(movedAgentDirCredentials({}, "/h")).toEqual([]);
		expect(movedAgentDirCredentials({ PI_CODING_AGENT_DIR: "~/pi-agent" }, "/h")).toEqual(["/h/pi-agent/models.json", "/h/pi-agent/auth.json"]);
		expect(movedAgentDirCredentials({ PI_CODING_AGENT_DIR: "/srv/pi" }, "/h")).toEqual(["/srv/pi/models.json", "/srv/pi/auth.json"]);
	});
});

describe("guardToolCall keeps Orrery's home out", () => {
	it("refuses the remote keys and other lanes' memory, and allows config.toml", () => {
		const { workspace, options } = setup();
		const data = join(dir, "home", ".orrery");
		mkdirSync(join(data, "lanes", "Birch"), { recursive: true });
		for (const file of ["remotes.json", "config.toml"]) writeFileSync(join(data, file), "");
		const guarded = { ...options, workspace, allowedRoots: [], orreryData: data };
		expect(guardToolCall("read", { path: join(data, "remotes.json") }, guarded)).toMatch(/sensitive/);
		expect(guardToolCall("grep", { pattern: "x", path: join(data, "lanes") }, guarded)).toMatch(/sensitive/);
		expect(guardToolCall("read", { path: join(data, "config.toml") }, guarded)).toBeUndefined();
	});
});

describe("pi: only the agent that owns a folder's memory view reads it", () => {
	afterEach(async () => {
		await ompCleanup();
		await cleanup();
	});

	/** The world's two lanes, Atlas and Birch, each set up the file way: a memory view in its folder. */
	function viewWorld() {
		const made = world();
		dir = made.root;
		const views = { atlasView: join(made.root, "agent-Atlas", ".orrery", "view.md"), birchView: join(made.root, "agent-Birch", ".orrery", "view.md") };
		for (const [name, path] of [
			["Atlas", views.atlasView],
			["Birch", views.birchView],
		]) {
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, `${name}'s view: secret`);
		}
		return { ...made, ...views };
	}

	/** One tool call in `run`, as the model makes it: its result's text. */
	async function call(run: PiRun, name: string, args: Parameters<typeof fauxToolCall>[1]): Promise<string> {
		run.setResponses([fauxAssistantMessage([fauxToolCall(name, args)]), fauxAssistantMessage("done")]);
		await run.session.prompt(`${name}, please`);
		const results = run.session.messages.filter((m: { role: string }) => m.role === "toolResult") as { content: { text?: string }[] }[];
		return results.at(-1)?.content.map((c) => c.text ?? "").join("") ?? "";
	}
	const refused = (text: string) => {
		expect(text).toMatch(/sensitive|memory view/);
		expect(text).not.toContain("secret");
	};
	const edit = (path: string) => ({ path, edits: [{ oldText: "secret", newText: "planted" }] });

	it("refuses Birch's view to Atlas in read, edit and write, by absolute and relative path and through a link; Atlas's own stays open", async () => {
		const { root, config, atlasView, birchView } = viewWorld();
		symlinkSync(birchView, join(root, "agent-Atlas", "notes.md"));
		const atlas = await pi(root, join(root, "agent-Atlas"), config);
		expect(atlas.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		for (const path of [birchView, "../agent-Birch/.orrery/view.md", "notes.md"]) {
			refused(await call(atlas, "read", { path }));
			refused(await call(atlas, "edit", edit(path)));
			refused(await call(atlas, "write", { path, content: "planted" }));
		}
		refused(await call(atlas, "bash", { command: `cat ${birchView}` }));
		expect(readFileSync(birchView, "utf8")).toBe("Birch's view: secret");
		expect(await call(atlas, "read", { path: ".orrery/view.md" })).toContain("Atlas's view: secret");
		expect(await call(atlas, "read", { path: atlasView })).toContain("Atlas's view: secret");
		// In shell text only by an absolute (or ~/) path: a shell's folder is not proof of where a relative one starts.
		expect(await call(atlas, "bash", { command: `cat ${atlasView}` })).toContain("Atlas's view: secret");
		refused(await call(atlas, "bash", { command: "cat .orrery/view.md" }));
	}, 20_000);

	it("lets Atlas, opened in Birch's folder, list its root with pi's ls and find, and refuses grep there (fix round 1)", async () => {
		const { root, config } = viewWorld();
		// pi's ls and find are not among pi's default tools, so pi's entry runs in a pi-shaped host here.
		const options = { config, summarySources: async (cfg: HarnessConfig) => summarySourcesFor(cfg), ...scratchHome(root), env: { ORRERY_AGENT: "Atlas" } };
		const host = track(fakeOmp(join(root, "agent-Birch"), [createOrrery(options)], { omp: false }));
		await host.emit("session_start");
		const tool = async (toolName: string, input: object) => (await host.emit("tool_call", { toolName, toolCallId: "t1", input }))[0];
		expect(await tool("ls", { path: "." })).toBeUndefined();
		expect(await tool("ls", {})).toBeUndefined();
		expect(await tool("find", { pattern: "*.md" })).toBeUndefined();
		expect(await tool("grep", { pattern: "secret" })).toEqual({ block: true, reason: expect.stringMatching(/memory view/) });
		expect(await tool("grep", { pattern: "secret", path: "." })).toEqual({ block: true, reason: expect.stringMatching(/memory view/) });
	});

	it("refuses shell text that names Orrery's config, to read or to change it (fix round 1)", async () => {
		const { root, config } = viewWorld();
		const atlas = await pi(root, join(root, "agent-Atlas"), config);
		for (const command of ["cat ~/.orrery/config.toml", "sed -i s/Atlas/Birch/ ~/.orrery/config.toml", "printf '[' >> ~/.orrery/config.toml"]) {
			refused(await call(atlas, "bash", { command }));
		}
	}, 20_000);

	it("refuses Birch's view to Atlas opened by ORRERY_AGENT in Birch's folder, and keeps Atlas's own open", async () => {
		const { root, config, atlasView } = viewWorld();
		const atlas = await pi(root, join(root, "agent-Birch"), config, undefined, { env: { ORRERY_AGENT: "Atlas" } });
		expect(atlas.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		refused(await call(atlas, "read", { path: ".orrery/view.md" }));
		refused(await call(atlas, "edit", edit(".orrery/view.md")));
		refused(await call(atlas, "bash", { command: "cat .orrery/view.md" }));
		expect(await call(atlas, "read", { path: atlasView })).toContain("Atlas's view: secret");
		expect(await call(atlas, "bash", { command: `cat ${atlasView}` })).toContain("Atlas's view: secret");
	}, 20_000);

	it("refuses every lane's view to a refused ORRERY_AGENT, the folder's own lane's too", async () => {
		const { root, config, birchView } = viewWorld();
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { env: { ORRERY_AGENT: "Nobody" } });
		expect(run.tool("zoom")).toBeUndefined();
		refused(await call(run, "read", { path: ".orrery/view.md" }));
		refused(await call(run, "bash", { command: "cat .orrery/view.md" }));
		refused(await call(run, "read", { path: birchView }));
	}, 20_000);
});
