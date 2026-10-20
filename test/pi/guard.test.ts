import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { guardOmpToolCall, guardToolCall, movedAgentDirCredentials } from "../../src/pi/guard.ts";
import { type HarnessConfig, parseConfig } from "../../src/agent/config.ts";
import { ompExtensionFile, piExtensionFile } from "../../src/agent/tools.ts";
import { createOrrery } from "../../src/pi/index.ts";
import { fakeOmp, ompCleanup, ompOrrery, track } from "../omp/world.ts";
import type { PiRun } from "./harness.ts";
import { cleanup, isolatedHome, pi, scratchHome, summarySourcesFor, world } from "./world.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup() {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "orrery-guard-")));
	const folder = join(dir, "ws");
	mkdirSync(join(folder, "sub"), { recursive: true });
	mkdirSync(join(dir, "outside"));
	symlinkSync(join(dir, "outside"), join(folder, "link"));
	// A scratch home, so no case stats the real one's credential files (~/.omp's among them).
	return { folder, options: { folder, allowedRoots: [], cwd: join(folder, "sub"), home: join(dir, "home"), foreignViews: [] as string[] } };
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
	/** A fake home with pi's models.json, beside the folder and another repo the agent may read. */
	function homeSetup() {
		const { folder, options } = setup();
		const home = join(dir, "home");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		mkdirSync(join(home, ".ssh"));
		mkdirSync(join(dir, "repo"));
		writeFileSync(join(home, ".pi", "agent", "models.json"), "{}");
		return { folder, home, options: { ...options, home } };
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
		const { folder, home, options } = homeSetup();
		const read = (path: string, cwd = options.cwd) => guardToolCall("read", { path }, { ...options, cwd });
		expect(read("~/.pi/agent/models.json")).toMatch(/sensitive/);
		expect(read(join(home, ".pi/agent/models.json"))).toMatch(/sensitive/);
		expect(read("/proc/self/environ")).toMatch(/sensitive/);
		expect(read("/proc/1/environ")).toMatch(/sensitive/);
		expect(read("environ", "/proc/self")).toMatch(/sensitive/);
		expect(guardToolCall("bash", { command: "cat /proc/self/environ" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("bash", { command: "cat ~/.pi/agent/models.json" }, options)).toMatch(/sensitive/);
		// Only the real target names the file: a link in the folder.
		symlinkSync(join(home, ".pi", "agent", "models.json"), join(folder, "settings.json"));
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
		const { folder, options } = homeSetup();
		expect(guardToolCall("grep", { pattern: "auth.json", path: folder }, options)).toBeUndefined();
		expect(guardToolCall("grep", { pattern: "id_rsa|\\.ssh/", path: folder }, options)).toBeUndefined();
		expect(guardToolCall("grep", { pattern: "auth.json", path: folder, glob: "**/auth.json" }, options)).toMatch(/sensitive/);
		expect(guardToolCall("find", { pattern: "auth.json", path: folder }, options)).toMatch(/sensitive/);
	});

	it("blocks a search rooted at home or above it (it would recurse into ~/.ssh and ~/.pi), and says to narrow it", () => {
		const { folder, home, options } = homeSetup();
		expect(guardToolCall("grep", { pattern: "apiKey", path: "~" }, options)).toMatch(/narrower folder/);
		expect(guardToolCall("grep", { pattern: "apiKey", path: home }, options)).toMatch(/narrower folder/);
		expect(guardToolCall("find", { pattern: "*.json", path: dir }, options)).toMatch(/narrower folder/);
		expect(guardToolCall("ls", { path: "/" }, options)).toMatch(/narrower folder/);
		expect(guardToolCall("grep", { pattern: "apiKey" }, { ...options, cwd: home })).toMatch(/narrower folder/);
		expect(guardToolCall("grep", { pattern: "apiKey", path: "~/.pi/agent" }, options)).toMatch(/narrower folder/);
		// A link to home is home.
		symlinkSync(home, join(folder, "home-link"));
		expect(guardToolCall("grep", { pattern: "apiKey", path: "../home-link" }, options)).toMatch(/narrower folder/);
	});

	it("still allows reads and searches elsewhere: agents read other repos", () => {
		const { folder, options } = homeSetup();
		const repo = join(dir, "repo");
		expect(guardToolCall("grep", { pattern: "TODO", path: repo }, options)).toBeUndefined();
		expect(guardToolCall("find", { pattern: "*.ts", path: repo }, options)).toBeUndefined();
		expect(guardToolCall("ls", { path: repo }, options)).toBeUndefined();
		expect(guardToolCall("ls", {}, options)).toBeUndefined();
		expect(guardToolCall("grep", { pattern: "TODO" }, options)).toBeUndefined();
		expect(guardToolCall("read", { path: join(repo, "README.md") }, options)).toBeUndefined();
		expect(guardToolCall("read", { path: "/etc/os-release" }, options)).toBeUndefined();
		expect(guardToolCall("write", { path: join(folder, "a.ts"), content: "x" }, options)).toBeUndefined();
	});
});

describe("guardToolCall against spellings that dodge the patterns", () => {
	function adversary() {
		const { folder, options } = setup();
		const home = join(dir, "home");
		const stow = join(dir, "dotfiles-ssh"); // ~/.ssh kept elsewhere, linked in (as dotfile managers do)
		mkdirSync(stow);
		writeFileSync(join(stow, "config"), "Host x");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		symlinkSync(stow, join(home, ".ssh"));
		const data = join(dir, "orrery-data");
		mkdirSync(data);
		writeFileSync(join(data, "credentials.json"), "{}");
		return { folder, home, data, options: { ...options, home, credentials: [join(data, "credentials.json")] } };
	}

	it("refuses a search at home or above however the path is written", () => {
		const { folder, home, options } = adversary();
		const grep = (path: string, cwd = options.cwd) => guardToolCall("grep", { pattern: "key", path }, { ...options, cwd });
		for (const path of ["~", "~/", "~/..", "@~", `file://${home}`, `${home}/./`, `${home}/../home`, ".", ""]) {
			expect([path, grep(path, home)]).toEqual([path, expect.stringMatching(/narrower folder/)]);
		}
		// On a case-insensitive file system (macOS) another letter case is the same folder.
		expect(grep(home.toUpperCase())).toMatch(/narrower folder/);
		expect(grep(join(home, ".PI"))).toMatch(/narrower folder/);
		symlinkSync(dir, join(folder, "up"));
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
		const { folder, home, data, options } = adversary();
		symlinkSync(join(home, ".ssh"), join(folder, "keys"));
		expect(guardToolCall("read", { path: "../keys/config" }, options)).toMatch(/sensitive/);
		symlinkSync(join(data, "credentials.json"), join(folder, "c.txt"));
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
	it("refuses the remote keys and other agents' memory, and allows config.toml", () => {
		const { folder, options } = setup();
		const data = join(dir, "home", ".orrery");
		mkdirSync(join(data, "agents", "Birch"), { recursive: true });
		for (const file of ["remotes.json", "config.toml"]) writeFileSync(join(data, file), "");
		const guarded = { ...options, folder, allowedRoots: [], orreryData: data };
		expect(guardToolCall("read", { path: join(data, "remotes.json") }, guarded)).toMatch(/sensitive/);
		expect(guardToolCall("grep", { pattern: "x", path: join(data, "agents") }, guarded)).toMatch(/sensitive/);
		expect(guardToolCall("read", { path: join(data, "config.toml") }, guarded)).toBeUndefined();
	});
});

describe("pi: only the agent that owns a folder's memory view reads it", () => {
	afterEach(async () => {
		await ompCleanup();
		await cleanup();
	});
	// These sessions run pi's real bash: a command the guard lets through runs, under a scratch HOME.
	isolatedHome();

	/** The world's two agents, Atlas and Birch, each set up the file way: a memory view in its folder. */
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

	/** Runs `run` with ORRERY_CONFIG set to `file`, as the session's process would have it, and puts it back after. */
	async function withConfig(file: string, run: () => Promise<void>): Promise<void> {
		const saved = process.env.ORRERY_CONFIG;
		process.env.ORRERY_CONFIG = file;
		try {
			await run();
		} finally {
			if (saved === undefined) delete process.env.ORRERY_CONFIG;
			else process.env.ORRERY_CONFIG = saved;
		}
	}

	it("keeps the default guard on in a session that starts while Orrery's config cannot be read (fix round 2)", async () => {
		const { root } = viewWorld();
		// A key in the scratch home: the guard refuses it by name, and nothing real is read if it does not.
		const key = join(root, "home", ".ssh", "id_test");
		mkdirSync(join(key, ".."), { recursive: true });
		writeFileSync(key, "fake key: secret");
		const broken = join(root, "broken.toml");
		writeFileSync(broken, "agents = [");
		const escape = `${root}-escape.txt`;
		try {
			await withConfig(broken, async () => {
				const run = await pi(root, join(root, "plain"), undefined);
				expect(run.tool("zoom")).toBeUndefined();
				expect(run.notices).toEqual([{ type: "warning", message: expect.stringMatching(/; running without memory$/) }]);
				refused(await call(run, "read", { path: key }));
				expect(await call(run, "write", { path: escape, content: "x" })).toMatch(/outside this agent's folder/);
				expect(existsSync(escape)).toBe(false);
				refused(await call(run, "bash", { command: `printf '[' >> ${broken}` }));
				// The session's own folder is its work area.
				await call(run, "write", { path: join(root, "plain", "notes.md"), content: "x" });
				expect(readFileSync(join(root, "plain", "notes.md"), "utf8")).toBe("x");
			});
		} finally {
			rmSync(escape, { force: true });
		}
	}, 20_000);

	it("keeps the config file in use read-only and named in no command, wherever ORRERY_CONFIG puts it (fix round 2)", async () => {
		const { root, configPath } = viewWorld();
		const before = readFileSync(configPath, "utf8");
		await withConfig(configPath, async () => {
			const atlas = await pi(root, join(root, "agent-Atlas"), undefined);
			expect(atlas.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
			for (const command of [`printf '[' >> ${configPath}`, `sed -i s/Atlas/Birch/ ${configPath}`, `cat "${configPath}"`]) refused(await call(atlas, "bash", { command }));
			// Its folder is in Atlas's allowed roots (the folder's parent): only the config rule refuses these.
			expect(await call(atlas, "write", { path: configPath, content: "[" })).toMatch(/Orrery's config/);
			expect(await call(atlas, "edit", { path: configPath, edits: [{ oldText: "Atlas", newText: "Birch" }] })).toMatch(/Orrery's config/);
			expect(await call(atlas, "read", { path: configPath })).toContain("[agents.Atlas]");
		});
		expect(readFileSync(configPath, "utf8")).toBe(before);
	}, 20_000);

	/**
	 * An Orrery home in the world's scratch home (the guard's), with a config and an installed program. pi's bash runs a
	 * command the guard lets through for real: these tests name only scratch paths, never "~" (the harness refuses that),
	 * so a run against code that does not refuse them changes nothing outside the test's folders.
	 */
	function scratchOrrery(root: string) {
		const home = join(root, "home", ".orrery");
		mkdirSync(join(home, "app", "0.6.0", "src"), { recursive: true });
		symlinkSync("0.6.0", join(home, "app", "current"));
		writeFileSync(join(home, "config.toml"), "# config\n");
		writeFileSync(join(home, "app", "0.6.0", "src", "main.ts"), "// program\n");
		return { home, config: join(home, "config.toml"), app: join(home, "app") };
	}

	it("refuses shell text that names Orrery's config, to read or to change it (fix round 1)", async () => {
		const { root, config } = viewWorld();
		const orrery = scratchOrrery(root);
		const atlas = await pi(root, join(root, "agent-Atlas"), config);
		for (const command of [`cat ${orrery.config}`, `sed -i s/config/x/ ${orrery.config}`, `printf '[' >> ${orrery.config}`]) {
			refused(await call(atlas, "bash", { command }));
		}
		expect(readFileSync(orrery.config, "utf8")).toBe("# config\n");
	}, 20_000);

	it("refuses shell text that names Orrery's installed program, and keeps it read-only to file tools (fix round 3)", async () => {
		const { root, config } = viewWorld();
		const orrery = scratchOrrery(root);
		const atlas = await pi(root, join(root, "agent-Atlas"), config);
		const current = join(orrery.app, "current");
		for (const command of [`ln -sfn /tmp/x ${current}`, `chmod -R u+w ${orrery.app}`, `rm -rf ${current}`, `ls ${current}/src`]) {
			refused(await call(atlas, "bash", { command }));
		}
		// Atlas's allowed roots (the folder's parent) hold the scratch home: only the program rule refuses these.
		const main = join(current, "src", "main.ts");
		expect(await call(atlas, "write", { path: main, content: "planted" })).toMatch(/Orrery's installed program/);
		expect(await call(atlas, "edit", { path: main, edits: [{ oldText: "program", newText: "planted" }] })).toMatch(/Orrery's installed program/);
		expect(await call(atlas, "write", { path: join(orrery.app, "0.7.0", "x.ts"), content: "planted" })).toMatch(/Orrery's installed program/);
		expect(await call(atlas, "read", { path: main })).toContain("// program");
		expect(readFileSync(main, "utf8")).toBe("// program\n");
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

	it("refuses every agent's view to a refused ORRERY_AGENT, the folder's own agent's too", async () => {
		const { root, config, birchView } = viewWorld();
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { env: { ORRERY_AGENT: "Nobody" } });
		expect(run.tool("zoom")).toBeUndefined();
		refused(await call(run, "read", { path: ".orrery/view.md" }));
		refused(await call(run, "bash", { command: "cat .orrery/view.md" }));
		refused(await call(run, "read", { path: birchView }));
	}, 20_000);
});

describe("pi and OMP in a folder that is no agent's: Orrery's own rules only (spec 2026-10-19-no-agent-sessions §3)", () => {
	afterEach(async () => {
		await ompCleanup();
		await cleanup();
	});
	// pi's real bash runs a command the guard lets through, under a scratch HOME: these name no real path.
	isolatedHome();

	async function call(run: PiRun, name: string, args: Parameters<typeof fauxToolCall>[1]): Promise<string> {
		run.setResponses([fauxAssistantMessage([fauxToolCall(name, args)]), fauxAssistantMessage("done")]);
		await run.session.prompt(`${name}, please`);
		const results = run.session.messages.filter((m: { role: string }) => m.role === "toolResult") as { content: { text?: string }[] }[];
		return results.at(-1)?.content.map((c) => c.text ?? "").join("") ?? "";
	}

	/** The world, with memory in Atlas's data folder, a .env file in the plain folder and a key in the guard's home. */
	function plainWorld() {
		const made = world();
		dir = made.root;
		const plain = join(made.root, "plain");
		const memory = join(made.root, "data", "agents", "Atlas", "notes.md");
		const key = join(made.root, "home", ".ssh", "id_test");
		for (const [file, text] of [
			[memory, "Atlas's memory: hidden-value"],
			[join(plain, ".env"), "KEY=plain-value"],
			[key, "fake key: plain-value"],
		]) {
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, text);
		}
		return { ...made, plain, memory, key };
	}

	/** A tool call in a fake host: the guard's answer. */
	const answer = (host: ReturnType<typeof fakeOmp>) => async (toolName: string, input: object) => (await host.emit("tool_call", { toolName, toolCallId: "t1", input }))[0];
	const blocked = { block: true, reason: expect.any(String) };

	it("a plain OMP folder takes ordinary brace and extended globs in its searches and ast_edit, and refuses a group that reaches out", async () => {
		const { root, config, plain } = plainWorld();
		for (const file of ["src/a.ts", "src/b.tsx", "src/gen/d.ts", "lib/c.ts"]) {
			mkdirSync(join(plain, file, ".."), { recursive: true });
			writeFileSync(join(plain, file), "export const a = 1;\n");
		}
		const tool = answer(await ompOrrery(plain, config));
		const edit = (paths: string[]) => ({ ops: [{ pat: "a", out: "b" }], paths });
		for (const path of ["src/**/*.{ts,tsx}", "*.{ts,tsx}", "{src,lib}", "{src,lib}/**/*.ts", "src/**/@(a|b).ts", "@src/**/*.{ts,tsx}", '"src/**/*.{ts,tsx}"']) {
			for (const toolName of ["grep", "glob", "find"]) expect([toolName, path, await tool(toolName, { pattern: "x", path })]).toEqual([toolName, path, undefined]);
			expect(["ast_edit", path, await tool("ast_edit", edit([path]))]).toEqual(["ast_edit", path, undefined]);
		}
		// A negation only narrows what the other paths reach.
		expect(await tool("ast_edit", edit(["src/**/*.ts", "!src/gen/**"]))).toBeUndefined();
		// A group that holds "/", "..", "~" or "$", or is unbalanced, and ".." after a wildcard: refused.
		// And a group whose expansion moves the base: {,}~/… is ~/…, {,}/abs/… is absolute, .{.,}/… is ../….
		const moving = ["{,}~/x/**", "{,}/abs/**", ".{.,}/x/**", "{,}~/.orr*/agents/**", ".{.,}/.o*/app/**", "src/.{.,}/x/*.ts"];
		// Read as OMP reads a path, its "@", ":" and quotes gone, before the groups are put in place.
		const prefixed = ["@{,~}/x/**", ":{,/abs}/x/**", '"@{,~}/x/**"', "@{,}~/x/**", ":{,}/abs/x/**", '"@{,}~/x/**"', "@{,}/abs/**", "{,file:}//x/**"];
		for (const path of ["{src,~/.orrery}/**", "{src,../..}/*.ts", "{src,$HOME}/*.ts", "src/{a,b", "@(src|../x)/**", "src/*/../../..", "!{src,~/.orrery}/**", ...moving, ...prefixed]) {
			const searches = path.startsWith("!") ? [] : ["grep", "glob"];
			for (const toolName of searches) expect([toolName, path, await tool(toolName, { pattern: "x", path })]).toEqual([toolName, path, blocked]);
			expect(["ast_edit", path, await tool("ast_edit", edit([path]))]).toEqual(["ast_edit", path, blocked]);
		}
		// Orrery's home in a group's alternatives is read as a name, as before.
		expect(await tool("grep", { pattern: "x", path: `${root}/{data,plain}` })).toEqual(blocked);
	});

	it("an agent's OMP session keeps refusing brace globs, negations and extended globs, as before", async () => {
		const { root, config } = plainWorld();
		const tool = answer(await ompOrrery(join(root, "agent-Atlas"), config));
		expect(await tool("grep", { pattern: "x", path: "src/**/*.{ts,tsx}" })).toEqual({ block: true, reason: expect.stringMatching(/brace or parent patterns/) });
		expect(await tool("ast_edit", { ops: [{ pat: "a", out: "b" }], paths: ["src/**/*.ts", "!src/gen/**"] })).toEqual({ block: true, reason: expect.stringMatching(/can't tell which files/) });
	});

	it("a plain OMP session whose folder holds or is inside Orrery's files has its language server's edits refused", async () => {
		const { root, config, plain } = plainWorld();
		const host = await ompOrrery(root, config);
		const tool = answer(host);
		const rename = { action: "rename", file: "a.ts", line: 1, symbol: "a", new_name: "b" };
		// The folder holds Orrery's data folder.
		expect(await tool("lsp", rename)).toEqual({ block: true, reason: expect.stringMatching(/language server.*Orrery's files/) });
		expect(await tool("lsp", { action: "code_actions", file: "a.ts", apply: true, query: "fix" })).toEqual(blocked);
		expect(await tool("lsp", { action: "hover", file: "a.ts", line: 1 })).toBeUndefined();
		// Inside it.
		host.cwd = join(root, "data", "agents");
		expect(await tool("lsp", rename)).toEqual(blocked);
		// A project beside it.
		host.cwd = plain;
		expect(await tool("lsp", rename)).toBeUndefined();
	});

	it("a plain OMP session's language server edits are judged by the file they name, and where it really is", () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "orrery-lsp-")));
		const home = join(dir, "home");
		const data = join(home, ".orrery");
		const program = join(data, "app", "current", "src", "main.ts");
		const project = join(dir, "project");
		mkdirSync(join(program, ".."), { recursive: true });
		mkdirSync(project);
		writeFileSync(program, "export const a = 1;\n");
		writeFileSync(join(project, "a.ts"), "export const a = 1;\n");
		symlinkSync(join(data, "app", "current", "src"), join(project, "linked-app"));
		const options = { orreryOnly: true, folder: project, allowedRoots: [] as string[], cwd: project, home, foreignViews: [] as string[], orreryData: data, credentials: [join(data, "credentials.json")], configFile: join(data, "config.toml"), orreryHome: data };
		const lsp = (input: Record<string, unknown>) => guardOmpToolCall("lsp", input, options);
		for (const file of [program, "~/.orrery/app/current/src/main.ts", "linked-app/main.ts"]) {
			for (const input of [{ action: "rename", file, line: 1, symbol: "a", new_name: "b" }, { action: "code_actions", file, apply: true, query: "fix" }]) {
				expect([input, lsp(input)]).toEqual([input, expect.stringMatching(/installed program|Orrery's files/)]);
			}
			// Reading actions name the file to read it: they pass, as before.
			expect(lsp({ action: "hover", file, line: 1 })).toBeUndefined();
		}
		expect(lsp({ action: "rename", file: "a.ts", line: 1, symbol: "a", new_name: "b" })).toBeUndefined();
		expect(lsp({ action: "code_actions", file: join(project, "a.ts"), apply: true, query: "fix" })).toBeUndefined();
	});

	it("a plain pi or OMP session writes nothing where agents' sessions load code from: the extensions folders, Claude Code's plugin copy", () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "orrery-entries-")));
		const home = join(dir, "home");
		const data = join(home, ".orrery");
		const project = join(dir, "project");
		mkdirSync(project, { recursive: true });
		const env = { ...process.env, HOME: home };
		const options = { orreryOnly: true, folder: project, allowedRoots: [] as string[], cwd: project, home, foreignViews: [] as string[], orreryData: data, credentials: [join(data, "credentials.json")], configFile: join(data, "config.toml"), orreryHome: data };
		const piFolder = dirname(piExtensionFile(env));
		const entries = [piExtensionFile(env), ompExtensionFile(env), join(piFolder, "mine.ts"), join(home, ".claude", "plugins", "cache", "orrery", "orrery", "0.9.1", "hooks", "hooks.json")];
		for (const file of entries) {
			expect([file, guardToolCall("write", { path: file, content: "export {}" }, options)]).toEqual([file, expect.stringMatching(/where your agents' sessions load code from/)]);
			expect([file, guardToolCall("edit", { path: file, edits: [{ oldText: "a", newText: "b" }] }, options)]).toEqual([file, expect.stringMatching(/load code from/)]);
			expect([file, guardOmpToolCall("write", { path: file, content: "export {}" }, options)]).toEqual([file, expect.stringMatching(/load code from/)]);
			expect([file, guardToolCall("read", { path: file }, options)]).toEqual([file, undefined]);
		}
		// Shell text into the folder, a redirect or a copy: refused.
		expect(guardToolCall("bash", { command: `cp evil.ts ${piFolder}/` }, options)).toMatch(/sensitive/);
		expect(guardOmpToolCall("bash", { command: `printf x > ${piFolder.replace(home, "~")}/z.ts` }, options)).toMatch(/sensitive/);
		// pi's own settings and the user's shell profile: theirs.
		expect(guardToolCall("write", { path: join(dirname(piFolder), "settings.json"), content: "{}" }, options)).toBeUndefined();
		expect(guardToolCall("bash", { command: "echo 'export X=1' >> ~/.profile" }, options)).toBeUndefined();
	});

	it("a plain pi folder takes ordinary brace and extended globs", async () => {
		const { root, config, plain } = plainWorld();
		const host = track(fakeOmp(plain, [createOrrery({ config, summarySources: async (cfg: HarnessConfig) => summarySourcesFor(cfg), ...scratchHome(root) })], { omp: false }));
		await host.emit("session_start");
		const tool = answer(host);
		expect(await tool("grep", { pattern: "x", glob: "*.{ts,tsx}" })).toBeUndefined();
		expect(await tool("find", { pattern: "src/**/*.{ts,tsx}" })).toBeUndefined();
		expect(await tool("find", { pattern: "{src,lib}/**/@(a|b).ts" })).toBeUndefined();
		expect(await tool("bash", { command: "ls src/**/*.{ts,tsx} {src,lib}/*.md" })).toBeUndefined();
		expect(await tool("grep", { pattern: "x", glob: "**/{.orrery,x}/*" })).toEqual(blocked);
	});

	it("a plain pi folder gets it", async () => {
		const { root, config, plain, memory, key } = plainWorld();
		const run = await pi(root, plain, config);
		expect(run.tool("zoom")).toBeUndefined();
		expect(run.notices).toEqual([]);
		// Orrery's memory and settings, its commands that change them, and the session records it checks prompts against.
		const read = await call(run, "read", { path: memory });
		expect(read).toMatch(/sensitive/);
		expect(read).not.toContain("hidden-value");
		const planted = join(root, "data", "planted.txt");
		expect(await call(run, "write", { path: planted, content: "planted" })).toMatch(/sensitive/);
		expect(existsSync(planted)).toBe(false);
		expect(await call(run, "write", { path: join(root, "data", "config.toml"), content: "planted" })).toMatch(/Orrery's config/);
		expect(await call(run, "bash", { command: "echo orrery restore Atlas" })).toMatch(/can't run from a session that is no agent's/);
		expect(await call(run, "bash", { command: "echo scratch/.claude/projects" })).toMatch(/session records/);
		// Everything else, as in plain pi: .env files, keys under home, writes outside the folder.
		expect(await call(run, "read", { path: ".env" })).toContain("KEY=plain-value");
		expect(await call(run, "bash", { command: "cat .env" })).toContain("KEY=plain-value");
		expect(await call(run, "read", { path: key })).toContain("fake key");
		const elsewhere = join(root, "agent-Birch", "from-plain.txt");
		await call(run, "write", { path: elsewhere, content: "written" });
		expect(readFileSync(elsewhere, "utf8")).toBe("written");
	}, 20_000);

	it("a plain OMP folder gets it too, its language server's edits pass, and a move into an agent's folder gets that agent's guard", async () => {
		const { root, config, plain, memory } = plainWorld();
		const host = await ompOrrery(plain, config);
		const tool = async (toolName: string, input: object) => (await host.emit("tool_call", { toolName, toolCallId: "t1", input }))[0];
		const refused = (reason: RegExp) => ({ block: true, reason: expect.stringMatching(reason) });
		expect(host.notices).toEqual([]);
		expect(await tool("read", { path: memory })).toEqual(refused(/sensitive/));
		expect(await tool("eval", { language: "sh", code: "echo orrery restore Atlas" })).toEqual(refused(/no agent's/));
		expect(await tool("edit", { path: join(root, "data", "config.toml"), edits: [{ oldText: "x", newText: "y" }] })).toEqual(refused(/Orrery's config/));
		const escape = `${root}-escape.txt`;
		for (const input of [{ path: escape, content: "x" }, { path: ".env", content: "x" }]) expect(await tool("write", input)).toBeUndefined();
		expect(await tool("read", { path: ".env" })).toBeUndefined();
		// A symbol rename names no file: in a session that is no agent's, the language server edits the project it has open.
		expect(await tool("lsp", { action: "rename", file: "a.ts", line: 1, symbol: "a", new_name: "b" })).toBeUndefined();
		expect(await tool("lsp", { action: "rename_file", file: "a.ts", new_name: join(root, "data", "a.ts") })).toEqual(refused(/sensitive/));
		// Moved into Atlas's folder (OMP's /move): Atlas's guard from the next message on.
		host.cwd = join(root, "agent-Atlas");
		await host.emit("before_agent_start", { systemPrompt: [] });
		expect(await tool("write", { path: escape, content: "x" })).toEqual(refused(/outside this agent's folder/));
		expect(await tool("lsp", { action: "rename", file: "a.ts", line: 1, symbol: "a", new_name: "b" })).toEqual(refused(/language server/));
		// And back out: Orrery's own rules again.
		host.cwd = plain;
		await host.emit("before_agent_start", { systemPrompt: [] });
		expect(await tool("write", { path: escape, content: "x" })).toBeUndefined();
		expect(await tool("read", { path: memory })).toEqual(refused(/sensitive/));
	});

	/** The plain world with a memory view in each agent's folder (Claude Code's file mode keeps it there). */
	function viewsWorld() {
		const made = plainWorld();
		const view = (name: string) => join(made.root, `agent-${name}`, ".orrery", "view.md");
		for (const name of ["Atlas", "Birch"]) {
			mkdirSync(join(view(name), ".."), { recursive: true });
			writeFileSync(view(name), `${name}'s view: hidden-value`);
		}
		return { ...made, atlasView: view("Atlas"), birchView: view("Birch") };
	}

	it("a plain pi folder reads no agent's memory view, and the rest of the agents' folders as before", async () => {
		const { root, config, plain, atlasView, birchView } = viewsWorld();
		symlinkSync(birchView, join(plain, "notes.md"));
		const run = await pi(root, plain, config);
		for (const [name, args] of [
			["read", { path: atlasView }],
			["read", { path: "notes.md" }],
			["edit", { path: birchView, edits: [{ oldText: "hidden-value", newText: "planted" }] }],
			["bash", { command: `cat ${atlasView}` }],
		] as [string, Parameters<typeof fauxToolCall>[1]][]) {
			const text = await call(run, name, args);
			expect([name, args, text]).toEqual([name, args, expect.stringMatching(/sensitive|memory view/)]);
			expect(text).not.toContain("hidden-value");
		}
		expect(readFileSync(birchView, "utf8")).toBe("Birch's view: hidden-value");
		expect(await call(run, "read", { path: join(root, "agent-Atlas", "AGENTS.md") })).toContain("You are Atlas.");
	}, 20_000);

	it("a plain OMP folder searches no folder that holds an agent's view, and lists it", async () => {
		const { root, config, plain } = viewsWorld();
		const host = await ompOrrery(plain, config);
		const tool = async (toolName: string, input: object) => (await host.emit("tool_call", { toolName, toolCallId: "t1", input }))[0];
		const atlas = join(root, "agent-Atlas");
		for (const toolName of ["grep", "ast_grep"]) {
			expect([toolName, await tool(toolName, { pattern: "hidden", path: atlas })]).toEqual([toolName, { block: true, reason: expect.stringMatching(/memory view/) }]);
		}
		expect(await tool("glob", { pattern: "**/*.md", path: atlas })).toBeUndefined();
		expect(await tool("read", { path: join(atlas, "AGENTS.md") })).toBeUndefined();
		expect(await tool("grep", { pattern: "x", path: plain })).toBeUndefined();
	});
});

describe("pi: [guard] protect and .env files", () => {
	afterEach(async () => {
		await ompCleanup();
		await cleanup();
	});
	// pi's real bash runs a command the guard lets through, under a scratch HOME.
	isolatedHome();

	async function call(run: PiRun, name: string, args: Parameters<typeof fauxToolCall>[1]): Promise<string> {
		run.setResponses([fauxAssistantMessage([fauxToolCall(name, args)]), fauxAssistantMessage("done")]);
		await run.session.prompt(`${name}, please`);
		const results = run.session.messages.filter((m: { role: string }) => m.role === "toolResult") as { content: { text?: string }[] }[];
		return results.at(-1)?.content.map((c) => c.text ?? "").join("") ?? "";
	}

	it("refuses a protected name, a protected path and .env to pi's tools and bash, and lets .env.example through", async () => {
		const made = world();
		dir = made.root;
		const atlas = join(made.root, "agent-Atlas");
		const kept = join(made.root, "kept");
		mkdirSync(kept);
		writeFileSync(join(kept, "a.txt"), "hidden-value");
		writeFileSync(join(atlas, "secrets.yml"), "token: hidden-value");
		writeFileSync(join(atlas, ".env"), "KEY=hidden-value");
		writeFileSync(join(atlas, ".env.example"), "KEY=");
		const config = parseConfig(`${readFileSync(made.configPath, "utf8")}\n[guard]\nprotect = ["secrets.yml", ${JSON.stringify(kept)}]\n`, made.root);
		const atlasRun = await pi(made.root, atlas, config);
		expect(atlasRun.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		const calls: [string, Parameters<typeof fauxToolCall>[1]][] = [
			["read", { path: "secrets.yml" }],
			["read", { path: join(kept, "a.txt") }],
			["bash", { command: "cat secrets.yml" }],
			["bash", { command: `cat ${kept}/a.txt` }],
		];
		for (const [name, args] of calls) {
			const text = await call(atlasRun, name, args);
			expect([name, args, text]).toEqual([name, args, expect.stringMatching(/protected by \[guard\] protect in Orrery's config/)]);
			expect(text).not.toContain("hidden-value");
		}
		for (const [name, args] of [
			["read", { path: ".env" }],
			["bash", { command: "cat .env" }],
			["edit", { path: ".env", edits: [{ oldText: "hidden-value", newText: "planted" }] }],
			["write", { path: ".env", content: "planted" }],
		] as [string, Parameters<typeof fauxToolCall>[1]][]) {
			const text = await call(atlasRun, name, args);
			expect([name, args, text]).toEqual([name, args, expect.stringMatching(/sensitive file/)]);
			expect(text).not.toContain("hidden-value");
		}
		expect(readFileSync(join(atlas, ".env"), "utf8")).toBe("KEY=hidden-value");
		expect(await call(atlasRun, "read", { path: ".env.example" })).toContain("KEY=");
	}, 20_000);
});
