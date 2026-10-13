import { describe, expect, it } from "vitest";
import { checkToolCall } from "../../src/lane/guard.ts";

const options = { workspace: "/home/alex/Documents/GitHub/agent-Atlas", allowedRoots: ["/home/alex/Documents/GitHub"] };
const call = (name: string, args: Record<string, unknown>) => checkToolCall({ name, arguments: args }, options);

describe("checkToolCall", () => {
	it("allows normal work inside the workspace and allowed roots", () => {
		expect(call("write", { path: "src/a.ts", content: "x" })).toBeUndefined();
		expect(call("edit", { path: "/home/alex/Documents/GitHub/sample-service/README.md", edits: [] })).toBeUndefined();
		expect(call("read", { path: "/etc/os-release" })).toBeUndefined();
		expect(call("bash", { command: "cargo test --workspace" })).toBeUndefined();
	});

	it("blocks writes outside the roots, including escapes", () => {
		expect(call("write", { path: "/etc/passwd", content: "x" })).toMatch(/outside/);
		expect(call("edit", { path: "../../../../.bashrc", edits: [] })).toMatch(/outside/);
		expect(call("write", { path: "/home/alex/Documents/GitHubX/a", content: "x" })).toMatch(/outside/);
	});

	it("blocks anything touching ssh keys or credential files", () => {
		expect(call("read", { path: "/home/alex/.ssh/id_ed25519" })).toMatch(/sensitive/);
		expect(call("bash", { command: "cat ~/.ssh/config" })).toMatch(/sensitive/);
		expect(call("bash", { command: "cp /var/lib/orrery/credentials.json /tmp" })).toMatch(/sensitive/);
		expect(call("read", { path: "/home/alex/.pi/agent/auth.json" })).toMatch(/sensitive/);
	});
});

import { mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach as after, beforeEach as before } from "vitest";
import { checkResolvedPath, guardExtension } from "../../src/lane/guard.ts";
import { guardOmpToolCall, guardToolCall } from "../../src/lane/guard-paths.ts";
import { sensitive } from "../../src/lane/guard-rules.ts";
import { ctx, fauxModels, tempDir } from "./support.ts";

describe("checkResolvedPath (pi's own path resolution, symlinks followed)", () => {
	let root: string;
	let ws: string;
	let outside: string;
	let home: string;
	const savedHome = process.env.HOME;
	before(() => {
		root = tempDir("orrery-guard-");
		ws = join(root, "ws");
		outside = join(root, "outside");
		home = join(root, "home");
		for (const d of [ws, outside, join(home, ".ssh")]) mkdirSync(d, { recursive: true });
		writeFileSync(join(home, ".ssh", "id_test"), "key");
		process.env.HOME = home;
	});
	after(() => {
		process.env.HOME = savedHome;
		rmSync(root, { recursive: true, force: true });
	});
	const opts = () => ({ workspace: ws, allowedRoots: [ws] });

	it("blocks writes the tool would resolve outside the roots via ~, @ or file://", async () => {
		const env = new NodeExecutionEnv({ cwd: ws });
		expect(await checkResolvedPath(env, "~/notes.txt", "write", opts(), ctx)).toMatch(/outside/);
		expect(await checkResolvedPath(env, `@${join(outside, "x")}`, "write", opts(), ctx)).toMatch(/outside/);
		expect(await checkResolvedPath(env, `file://${join(outside, "x")}`, "write", opts(), ctx)).toMatch(/outside/);
		expect(await checkResolvedPath(env, "src/new.ts", "write", opts(), ctx)).toBeUndefined();
	});

	it("follows symlinks out of the workspace and into key directories", async () => {
		const env = new NodeExecutionEnv({ cwd: ws });
		symlinkSync(outside, join(ws, "escape"));
		symlinkSync(join(home, ".ssh"), join(ws, "keys"));
		expect(await checkResolvedPath(env, "escape/x.txt", "write", opts(), ctx)).toMatch(/outside/);
		expect(await checkResolvedPath(env, "keys/id_test", "read", opts(), ctx)).toMatch(/sensitive/);
	});

	it("checks the variant path pi's read tool would actually open", async () => {
		const env = new NodeExecutionEnv({ cwd: ws });
		symlinkSync(join(home, ".ssh"), join(ws, "keys\u2019"));
		expect(await checkResolvedPath(env, "keys'/id_test", "read", opts(), ctx)).toMatch(/sensitive/);
	});

	it("is applied by the guard extension to pi's write tool", async () => {
		const { agent, models } = fauxModels();
		agent.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "~/pwned.txt", content: "x" }, { id: "w" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(guardExtension(opts()));
		const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => new NodeExecutionEnv({ cwd: ws }) }, ctx);
		const conv = await harness.root(ctx, { agent: { model: { provider: "faux-agent", modelId: "faux-1" } } });
		await (await conv.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
		expect(existsSync(join(home, "pwned.txt"))).toBe(false);
		await harness.close(ctx);
	});
});

describe("sensitive patterns", () => {
	it("cover common credential stores", () => {
		const o = { workspace: "/w", allowedRoots: ["/w"] };
		for (const p of ["/home/alex/.gnupg/private-keys-v1.d/a", "/home/alex/.kube/config", "/home/alex/.docker/config.json", "/home/alex/.config/gh/hosts.yml", "/home/alex/.git-credentials"]) {
			expect(checkToolCall({ name: "read", arguments: { path: p } }, o)).toMatch(/sensitive/);
		}
	});

	it("resolves relative paths against pi's cwd, not the workspace root", () => {
		const sub = { ...options, cwd: "/home/alex/Documents/GitHub/agent-Atlas/sub/deeper" };
		const at = (path: string) => checkToolCall({ name: "write", arguments: { path, content: "x" } }, sub);
		expect(at("a.ts")).toBeUndefined();
		expect(at("../../x")).toBeUndefined();
		expect(at("../../../../../../x")).toMatch(/outside/);
		const narrow = { workspace: "/w/lane", allowedRoots: [], cwd: "/w/lane/sub" };
		expect(checkToolCall({ name: "write", arguments: { path: "../x" } }, narrow)).toBeUndefined();
		expect(checkToolCall({ name: "write", arguments: { path: "../../x" } }, narrow)).toMatch(/\/w\/x is outside/);
	});
});

describe("Orrery's own home", () => {
	const setup = () => {
		const home = tempDir("guard-home-");
		const data = join(home, ".orrery");
		for (const dir of ["lanes/Atlas", "lanes/Birch", "backups/2026-10-13", "builds", "ssh", "app/0.6.0-abc1234/src"]) mkdirSync(join(data, dir), { recursive: true });
		symlinkSync("0.6.0-abc1234", join(data, "app", "current"));
		for (const file of ["config.toml", "remotes.json", "device-id", "credentials.json", "backup.env", "lanes/Birch/memory.sqlite", "ssh/known_hosts"]) writeFileSync(join(data, file), "");
		// The old paths, left as links by move-home.
		mkdirSync(join(home, ".local", "share"), { recursive: true });
		symlinkSync(data, join(home, ".local", "share", "orrery"));
		const workspace = join(home, "ws");
		mkdirSync(workspace);
		return { home, data, base: { workspace, allowedRoots: [] as string[], cwd: workspace, home, orreryData: data } };
	};
	const read = (path: string, base: ReturnType<typeof setup>["base"]) => guardToolCall("read", { path }, base);

	it.each(["remotes.json", "device-id", "ssh/known_hosts", "lanes/Birch/memory.sqlite", "backups/2026-10-13", "builds", "backup.env"])("refuses %s", (rel) => {
		const { data, base } = setup();
		expect(read(join(data, rel), base)).toMatch(/sensitive/);
	});

	it("refuses the same files reached through the old-path link", () => {
		const { home, base } = setup();
		expect(read(join(home, ".local", "share", "orrery", "remotes.json"), base)).toMatch(/sensitive/);
	});

	it("allows the installed program and the config", () => {
		const { data, base } = setup();
		expect(read(join(data, "app", "current", "src"), base)).toBeUndefined();
		expect(read(join(data, "config.toml"), base)).toBeUndefined();
	});

	it("refuses a search rooted at the home, which would read the lanes", () => {
		const { data, base } = setup();
		// The folder name is refused on sight now; a search of a custom data_dir still gets the search message (see the extension test).
		expect(guardToolCall("grep", { pattern: "x", path: data }, base)).toMatch(/sensitive file|would search credential files/);
		expect(guardToolCall("find", { pattern: "*.json", path: join(data, "lanes") }, base)).toMatch(/sensitive/);
	});

	it("refuses OMP's searches, reads and edits of it", () => {
		const { data, base } = setup();
		expect(guardOmpToolCall("grep", { pattern: "x", path: data }, base)).toMatch(/sensitive file|would search credential files/);
		expect(guardOmpToolCall("read", { path: join(data, "remotes.json") }, base)).toMatch(/sensitive/);
		expect(guardOmpToolCall("edit", { path: join(data, "lanes", "Birch", "memory.sqlite"), input: "x" }, base)).toMatch(/sensitive/);
		expect(guardOmpToolCall("read", { path: join(data, "app", "current", "src") }, base)).toBeUndefined();
	});

	it("refuses a .. spelling and another letter case", () => {
		const { data, base } = setup();
		expect(read(join(data, "app", "..", "remotes.json"), base)).toMatch(/sensitive/);
		expect(read(join(data, "REMOTES.json"), base)).toMatch(/sensitive/);
	});

	it.each([
		"cat ~/.orrery/remotes.json",
		"cat $HOME/.orrery/lanes/Birch/memory.sqlite",
		"sqlite3 /somewhere/.orrery/lanes/Birch/memory.sqlite .dump",
		"tar czf x.tgz ~/.orrery/backups",
		"cat ~/.local/share/orrery/remotes.json",
		"cat ~/.config/orrery/backup.env",
		"ls ~/.orrery/ssh/",
		'ls "$HOME/.orrery/builds"',
		// the old config folder is a link to the whole home after move-home
		"cat ~/.config/orrery/remotes.json",
		"sqlite3 ~/.config/orrery/lanes/Birch/memory.sqlite .dump",
		"ls ~/.config/orrery/ssh/",
		"ls ~/.config/orrery",
		// the bare home, in every spelling of home
		"grep -r sk- ~/.orrery",
		"tar czf x.tgz ~/.orrery",
		"cp -r ~/.orrery /tmp/x",
		"cd ~/.orrery && cat remotes.json",
		"cp -r $HOME/.orrery /tmp/x",
		"cp -r ${HOME}/.orrery /tmp/x",
		'cp -r "$HOME"/.orrery /tmp/x',
		'cp -r "$HOME/.orrery" /tmp/x',
		"cp -r /home/someone/.orrery /tmp/x",
		"cp -r /Users/Someone/.Orrery /tmp/x",
		"cp -r /root/.orrery /tmp/x",
		"ls ~/.local/share/orrery",
		"ls ~/.local/share/orrery/lanes",
		// spellings that reach the same files
		"cat ~/.orrery/app/../remotes.json",
		"ls ~/.orrery/app/../lanes",
		"cat ~/.local/share/orrery/app/../remotes.json",
		"cat /somewhere/.orrery/app/../remotes.json",
		"cat ~/.orrery/./remotes.json",
		"cat ~/.orrery//remotes.json",
		"cat ~/.orrery/*.json",
		'cat ~/.orrery/"remotes.json"',
		"cat /somewhere/.orrery/./remotes.json",
		"cat /somewhere/.orrery//lanes/Birch/memory.sqlite",
		'cat /somewhere/.orrery/"remotes.json"',
		"ls ~/.orrery/lanes|head",
		"ls ~/.orrery/lanes;echo",
		"(ls ~/.orrery/lanes)",
		"ls ~/.orrery/lanes&",
		"ls ~/.orrery/app/$X",
		// separators and quotes before .orrery
		"tar czf x ~//.orrery",
		"tar czf x ~/./.orrery",
		"tar czf x $HOME//.orrery",
		"tar czf x /home/alex//.orrery",
		"tar czf x /home//alex/.orrery",
		"tar czf x ~/'.orrery'",
		'tar czf x ~/".orrery"',
		"tar czf x ~/x/../.orrery",
		// and in the old folders
		"cat ~/.config//orrery/remotes.json",
		"cat ~/.config/./orrery/remotes.json",
		'cat ~/.config/"orrery"/remotes.json',
		"cat ~/.local//share/orrery/remotes.json",
		"cat ~/.local/share/./orrery/remotes.json",
		"cat /home/alex/.config/orrery/remotes.json",
		// more spellings of home
		"tar czf x ~alex/.orrery",
		"tar czf x ${HOME%/}/.orrery",
		"tar czf x ${HOME:-/root}/.orrery",
		"tar czf x /var/home/alex/.orrery",
		// backslashes and quotes inside the name
		"tar czf x ~/.orr\\ery",
		"tar czf x ~/.orr''ery",
		'tar czf x ~/".orr"ery',
		"cat ~/.config/orr\\ery/remotes.json",
		// expansions in front of the folder
		"tar czf x $(echo ~)/.orrery",
		"tar czf x `echo ~`/.orrery",
		"tar czf x $d/.orrery",
		"tar czf x $PWD/.orrery",
		// brace groups
		"ls ~/{.orrery,x}/lanes",
		"tar czf x ~/{.orrery,y}",
		"tar czf x {~,/x}/.orrery",
		"tar czf x ~/.{orrery,x}",
		// other home roots, and the old folders anywhere
		"cat ~/../alex/.config/orrery/backup.env",
		"tar -C/home/alex/.local/share/orrery x",
		"cat /data/alex/.config/orrery/remotes.json",
		"cat /mnt/home/alex/.orrery/lanes/x",
		'tar -C"/home/alex"/.orrery x',
		"cat ~/${x}.orrery/*",
		"cat ~/``.orrery/*",
		// backslash-newline, $'..', empty substitutions
		"tar czf x ~/.orr\\\nery",
		"cat ~/.s\\\nsh/config",
		"cat ~/.pi/agent/au\\\nth.json",
		"cat $'.orrery'/remotes.json",
		'cat $".orrery"/remotes.json',
		"tar czf x ~/.orr$()ery",
		"tar czf x ~/../alex/.orrery",
		// brace groups that split a name
		"tar czf x ~/{.,}orrery",
		"tar czf x ~/.orrer{y,}",
		"tar czf x ~/.{orr,x}ery",
		"ls ~/{x,.orrery,y}/lanes",
		// .. nested deeper than any fixed cap
		`cat ~/${"a/".repeat(12)}${"../".repeat(12)}.orrery/remotes.json`,
		// the XDG folders
		"cat $XDG_CONFIG_HOME/orrery/backup.env",
		"cat ${XDG_DATA_HOME}/orrery/remotes.json",
		"cat ${XDG_DATA_HOME:-~/.local/share}/orrery/remotes.json",
		// a project-local .config/orrery is refused too (accepted cost of judging the name, not the home)
		"cat ~/projects/x/.config/orrery/settings.json",
		"ls .orrery",
	])("refuses the command %s", (command) => {
		expect(checkToolCall({ name: "bash", arguments: { command } }, options)).toMatch(/sensitive/);
	});

	it.each([
		"cat ~/.ssh/id_ed25519",
		"cat ~/.aws/credentials",
		"cat /proc/self/environ",
		"cat ~/.omp/agent/agent.db",
		"cat ~/.omp/agent/models.yml",
		"cat ~/.omp/profiles/work/agent/agent.db",
		"cat ~/.local/share/omp/agent.db",
		"cat ~/.omp/.env",
		"cat ~/.omp/secrets.yml",
		"cat ~/.pi/agent/models.json",
		"cat ~/.pi/agent/auth.json",
		"cat ~/data/credentials.json",
		"cat ~/.netrc",
		"cat ~/.git-credentials",
		"cat ~/.gnupg/pubring.kbx",
		"cat ~/.kube/config",
		"cat ~/.docker/config.json",
		"cat ~/.config/gh/hosts.yml",
		"cat ~/.pgpass",
		"cat '~/.ssh'; ls",
		'cat "$HOME/.SSH/config"',
		"cat ~/.ssh//id_rsa",
		"cat ~/.s\\\nsh/config",
	])("keeps refusing the credential command %s", (command) => {
		expect(checkToolCall({ name: "bash", arguments: { command } }, options)).toMatch(/sensitive/);
	});

	it("judges a very long command quickly", () => {
		for (const unit of ["a/", "/", "./", "~/", "$", "{", "'", "x/../", "${", "{a,", "\\\n", "$()", "`", ".orrery/", "{a,b}"]) {
			const command = `cat ${unit.repeat(100_000)}`;
			const started = performance.now();
			checkToolCall({ name: "bash", arguments: { command } }, options);
			expect(performance.now() - started).toBeLessThan(1000);
		}
	});

	it.each([
		"cat .orrery/view.md",
		"ls ~/.orrery/app/current/src",
		"ls ~/.orrery/app",
		"ls ~/.orrery/app/",
		"cat ~/.orrery/config.toml",
		"cat ~/.config/orrery/config.toml",
		"ls ~/.local/share/orrery/app/current",
		"ls ~/.local/share/orrery/app",
		'cat "$HOME/.orrery/config.toml"',
		"cat ~/.orrery-notes.txt",
		"git status",
		"ls ~/Documents",
		"cat ~/.bashrc",
		"cat ~/code/orrery/src/x.ts",
		"cd ~/Documents/GitHub/orrery",
		"jq '{orrery: .x}' a.json",
		`curl -d '{"name":"orrery"}' x`,
		`node -e 'const {orreryData} = require("./x")'`,
		"git -C ~/Documents/GitHub/orrery status",
		"awk '{print $1}' f | grep orrery",
		"git commit -m 'a {b} change\n\nOrrery now guards the home'",
		"cat ~/.orrery.bak",
	])("allows %s", (command) => {
		expect(checkToolCall({ name: "bash", arguments: { command } }, options)).toBeUndefined();
	});

	it("allows text that merely says orrery, and a path with brackets before the lane's view", () => {
		expect(sensitive("+import { a, orreryHome } from './a';")).toBe(false);
		const { home, base } = setup();
		const dir = join(home, "proj (copy)", ".orrery");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "view.md"), "");
		expect(read(join(dir, "view.md"), base)).toBeUndefined();
	});

	it("does not trust a planted link named app or config.toml", () => {
		const { home, base: orrery } = setup();
		// A custom data_dir, so only the path rule (not the name patterns) can refuse.
		const data = join(home, "store");
		mkdirSync(join(data, "lanes", "Birch"), { recursive: true });
		mkdirSync(join(data, "app"));
		for (const file of ["remotes.json", "config.toml", "lanes/Birch/memory.sqlite"]) writeFileSync(join(data, file), "");
		const base = { ...orrery, orreryData: data };
		rmSync(join(data, "app"), { recursive: true });
		symlinkSync(".", join(data, "app"));
		expect(read(join(data, "app", "remotes.json"), base)).toMatch(/sensitive/);
		expect(read(join(data, "app", "lanes", "Birch", "memory.sqlite"), base)).toMatch(/sensitive/);
		rmSync(join(data, "config.toml"));
		symlinkSync("remotes.json", join(data, "config.toml"));
		expect(read(join(data, "config.toml"), base)).toMatch(/sensitive/);
	});

	it("refuses through the durable harness's own check too", async () => {
		const { home } = setup();
		const data = join(home, "store"); // a custom data_dir, so only the path rule can refuse
		mkdirSync(join(data, "lanes", "Birch"), { recursive: true });
		mkdirSync(join(data, "app", "v1", "src"), { recursive: true });
		symlinkSync("v1", join(data, "app", "current"));
		for (const file of ["remotes.json", "config.toml", "lanes/Birch/memory.sqlite"]) writeFileSync(join(data, file), "");
		// A login file outside the data folder, with a name no pattern knows: only the credentials list can refuse it.
		const logins = join(home, "elsewhere", "logins.store");
		mkdirSync(join(home, "elsewhere"));
		writeFileSync(logins, "");
		const env = new NodeExecutionEnv({ cwd: home });
		const guard = { workspace: join(home, "ws"), allowedRoots: [], orreryData: data, credentials: [logins] };
		expect(await checkResolvedPath(env, join(data, "remotes.json"), "read", guard, ctx)).toMatch(/sensitive/);
		expect(await checkResolvedPath(env, logins, "read", guard, ctx)).toMatch(/sensitive/);
		expect(await checkResolvedPath(env, logins, "read", { ...guard, credentials: [] }, ctx)).toBeUndefined();
		expect(await checkResolvedPath(env, join(data, "app", "..", "lanes", "Birch", "memory.sqlite"), "read", guard, ctx)).toMatch(/sensitive/);
		expect(await checkResolvedPath(env, join(data, "app", "current", "src"), "read", guard, ctx)).toBeUndefined();
		expect(await checkResolvedPath(env, join(data, "config.toml"), "read", guard, ctx)).toBeUndefined();
	});
});
