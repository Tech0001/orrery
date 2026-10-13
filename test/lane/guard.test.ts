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
		expect(guardToolCall("grep", { pattern: "x", path: data }, base)).toMatch(/would search credential files/);
		expect(guardToolCall("find", { pattern: "*.json", path: join(data, "lanes") }, base)).toMatch(/sensitive/);
	});

	it("refuses OMP's searches, reads and edits of it", () => {
		const { data, base } = setup();
		expect(guardOmpToolCall("grep", { pattern: "x", path: data }, base)).toMatch(/would search credential files/);
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
	])("refuses the command %s", (command) => {
		expect(checkToolCall({ name: "bash", arguments: { command } }, options)).toMatch(/sensitive/);
	});

	it.each(["cat .orrery/view.md", "ls ~/.orrery/app/current/src", "cat ~/.orrery/config.toml", "ls ~/.local/share/orrery/app/current"])("allows %s", (command) => {
		expect(checkToolCall({ name: "bash", arguments: { command } }, options)).toBeUndefined();
	});
});
