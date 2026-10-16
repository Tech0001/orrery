import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.ts";
import { ConfigError, type HarnessConfig, parseConfig } from "../../src/agent/config.ts";
import { checkResolvedPath } from "../../src/agent/guard.ts";
import { guardOmpToolCall, guardToolCall } from "../../src/agent/guard-paths.ts";
import { checkToolCall } from "../../src/agent/guard-rules.ts";
import { claudeGuard } from "../../src/claude/guard.ts";
import { runHook } from "../../src/claude/hooks.ts";
import { createOrrery } from "../../src/pi/index.ts";
import { fakeOmp, ompCleanup, ompOrrery, track } from "../omp/world.ts";
import { scratchHome, summarySourcesFor } from "../pi/world.ts";
import { agentConfigToml, contextLines, ctx, fauxModels, tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(async () => {
	await ompCleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROTECTED = /protected by \[guard\] protect in Orrery's config/;
const SENSITIVE = /sensitive/;

/**
 * An agent, Atlas, in projects/agent-Atlas, a scratch home beside it, and a key folder outside both. The config's
 * [guard] protect names a folder under home (~/finance), a file by its absolute path (keys/prod.pem), a file name
 * (secrets.yml) and a folder name (vault). Atlas's folder holds .env files, protected names and links to protected files.
 */
function protectWorld() {
	const root = realpathSync(tempDir("orrery-protect-"));
	dirs.push(root);
	const home = join(root, "home");
	const atlas = join(root, "projects", "agent-Atlas");
	const keys = join(root, "keys");
	for (const folder of [join(home, "finance"), join(home, "finance-old"), keys, join(atlas, "src"), join(atlas, "vault"), join(root, "data")]) mkdirSync(folder, { recursive: true });
	writeFileSync(join(home, "finance", "q3.csv"), "q3");
	writeFileSync(join(home, "finance-old", "x.csv"), "old");
	writeFileSync(join(home, "financial.txt"), "x");
	writeFileSync(join(keys, "prod.pem"), "key");
	writeFileSync(join(keys, "dev.pem"), "key");
	for (const file of ["secrets.yml", "secrets.yml.bak", "my-secrets.yml", "vault/token.txt", "src/a.ts", ".gitignore", ".env", ".env.local", ".env.example", ".envrc", "prod.env"]) {
		writeFileSync(join(atlas, file), "x");
	}
	symlinkSync(join(home, "finance", "q3.csv"), join(atlas, "link.csv"));
	symlinkSync(join(home, "finance"), join(atlas, "fin"));
	symlinkSync(join(keys, "prod.pem"), join(atlas, "key-link"));
	symlinkSync(join(atlas, "secrets.yml"), join(atlas, "notes.yml"));
	symlinkSync(join(atlas, ".env"), join(atlas, "settings.txt"));
	const protect = ["~/finance", join(keys, "prod.pem"), "secrets.yml", "vault"];
	const toml = `data_dir = ${JSON.stringify(join(root, "data"))}

[guard]
protect = ${JSON.stringify(protect)}

[agents.Atlas]
folder = ${JSON.stringify(atlas)}
model = "faux-agent/faux-1"
compactor_model = "faux-compactor/faux-1"
compactor_thinking = "off"
`;
	const config = parseConfig(toml, root);
	/** pi's guard for Atlas, as the extension builds it from the config. */
	const options = { folder: atlas, allowedRoots: [join(root, "projects")], cwd: atlas, home, foreignViews: [] as string[], protect };
	return { root, home, atlas, keys, protect, config, options };
}

type World = ReturnType<typeof protectWorld>;
const pi = (t: World, tool: string, input: Record<string, unknown>) => guardToolCall(tool, input, t.options);
const read = (t: World, path: string) => pi(t, "read", { path });
const bash = (t: World, command: string) => pi(t, "bash", { command });

describe("[guard] protect in Orrery's config", () => {
	const agent = `[agents.A]\nfolder = "/w/a"\ncompactor_model = "openai/gpt-6.1-sol"\n`;
	const parse = (protect: string) => parseConfig(`[guard]\nprotect = ${protect}\n${agent}`, "/x");

	it("reads path and name entries as written, and none when absent", () => {
		expect(parse('["~/finance", "/srv/keys/prod.pem", "secrets.yml", "/srv/data/"]').guard.protect).toEqual(["~/finance", "/srv/keys/prod.pem", "secrets.yml", "/srv/data/"]);
		expect(parseConfig(agent, "/x").guard.protect).toEqual([]);
		expect(parseConfig(`[guard]\n${agent}`, "/x").guard.protect).toEqual([]);
	});

	it.each([
		['"secrets.yml"', /guard\.protect must be an array of strings/],
		['["a", 1]', /guard\.protect must be an array of strings/],
		['[""]', /empty/],
		['["  "]', /empty/],
		['[" secrets.yml"]', /space/],
		['["foo/bar"]', /must start with \/ or ~\//],
		['["./x"]', /must start with \/ or ~\//],
		['["~alex/x"]', /must start with \/ or ~\//],
		['["~"]', /everything/],
		['["/"]', /everything/],
		['["~/"]', /everything/],
		['["//"]', /everything/],
		['["~/."]', /everything/],
		['["."]', /not a name/],
		['[".."]', /not a name/],
		['["~/../x"]', /\.\./],
		['["/srv/../etc"]', /\.\./],
		['["*.pem"]', /glob/],
		['["key?.pem"]', /glob/],
		['["[ab].pem"]', /glob/],
		['["{a,b}.pem"]', /glob/],
		['["~/keys/*"]', /glob/],
		['["a\\nb"]', /control/],
	])("refuses protect = %s", (protect, problem) => {
		expect(() => parse(protect)).toThrow(ConfigError);
		expect(() => parse(protect)).toThrow(problem);
	});

	it("refuses a [guard] that is not a table", () => {
		expect(() => parseConfig(`guard = 1\n${agent}`, "/x")).toThrow(/guard must be a table/);
	});
});

describe("[guard] protect: file tools", () => {
	it("refuses a path entry, a file or a folder and anything in it, as written, from ~, in any letter case and through links", () => {
		const t = protectWorld();
		expect(read(t, "~/finance/q3.csv")).toBe("~/finance/q3.csv is protected by [guard] protect in Orrery's config.");
		for (const path of [
			"~/finance",
			join(t.home, "finance", "q3.csv"),
			join(t.home, "FINANCE", "q3.csv"),
			"~/Finance/Q3.csv",
			join(t.keys, "prod.pem"),
			join(t.root, "KEYS", "prod.PEM"),
			"link.csv",
			"fin/q3.csv",
			"key-link",
		]) {
			expect([path, read(t, path)]).toEqual([path, expect.stringMatching(PROTECTED)]);
		}
		expect(pi(t, "write", { path: "~/finance/new.csv", content: "x" })).toMatch(PROTECTED);
		expect(pi(t, "edit", { path: "key-link", edits: [] })).toMatch(PROTECTED);
	});

	it("leaves what only begins like a path entry, or sits beside it", () => {
		const t = protectWorld();
		for (const path of ["~/finance-old/x.csv", "~/financial.txt", join(t.keys, "dev.pem"), "src/a.ts"]) expect([path, read(t, path)]).toEqual([path, undefined]);
	});

	it("refuses a name entry as a file or a folder name in any folder, and through a link", () => {
		const t = protectWorld();
		for (const path of ["secrets.yml", "src/../secrets.yml", join(t.root, "elsewhere", "secrets.yml"), "SECRETS.YML", "notes.yml", "vault/token.txt", "vault", "src/vault/x.ts"]) {
			expect([path, read(t, path)]).toEqual([path, expect.stringMatching(PROTECTED)]);
		}
		expect(pi(t, "write", { path: "vault/new.txt", content: "x" })).toMatch(PROTECTED);
		for (const path of ["secrets.yml.bak", "my-secrets.yml", "vaults/x.txt", "src/a.ts"]) expect([path, read(t, path)]).toEqual([path, undefined]);
	});
});

describe("[guard] protect: shell text", () => {
	it("refuses a command that names a path entry by any spelling the guard knows, and says which entry", () => {
		const t = protectWorld();
		expect(bash(t, "cat ~/finance/q3.csv")).toBe("This command touches ~/finance, protected by [guard] protect in Orrery's config.");
		for (const command of [
			"tar czf x.tgz ~/finance",
			"cat $HOME/finance/q3.csv",
			'cat "${HOME}/finance/q3.csv"',
			`cat ${join(t.home, "finance", "q3.csv")}`,
			"cat ~/FINANCE/q3.csv",
			"cat ~/finance*",
			"ls ~/finance;echo",
			"cat ~/fin''ance/q3.csv",
			"cat ~/{finance,x}/q3.csv",
			"cat ~/./finance/q3.csv",
			`cat ${join(t.keys, "prod.pem")}`,
			`cp ${join(t.keys, "prod.pem")} /tmp/x`,
		]) {
			expect([command, bash(t, command)]).toEqual([command, expect.stringMatching(PROTECTED)]);
		}
	});

	it("refuses a command that names a name entry as a path segment", () => {
		const t = protectWorld();
		expect(bash(t, "cat secrets.yml")).toBe("This command touches secrets.yml, protected by [guard] protect in Orrery's config.");
		for (const command of ["cat config/secrets.yml", 'cat "secrets.yml"', "cp x secrets.yml", "cat <secrets.yml", "app --file=secrets.yml", "cat Secrets.YML", "ls vault", "cat vault/token.txt", "tar czf x ./vault", "cat secrets.yml|head", "cat secrets.yml*"]) {
			expect([command, bash(t, command)]).toEqual([command, expect.stringMatching(PROTECTED)]);
		}
	});

	it("allows commands that only resemble an entry", () => {
		const t = protectWorld();
		for (const command of [
			"cat ~/finance-old/x.csv",
			"ls ~/financial.txt",
			`cat ${join(t.keys, "dev.pem")}`,
			"cat secrets.yml.bak",
			"cat my-secrets.yml",
			"cat mysecrets.yml",
			"ls vaults",
			"echo vaulted",
			"git status",
		]) {
			expect([command, bash(t, command)]).toEqual([command, undefined]);
		}
	});
});

describe("[guard] protect: searches", () => {
	it("refuses a search whose root holds a path entry, naming the entry, and says to search a narrower folder", () => {
		const t = protectWorld();
		const entry = join(t.keys, "prod.pem");
		for (const tool of ["grep", "find", "ls"]) {
			expect(pi(t, tool, { pattern: "x", path: t.keys })).toBe(`${tool} on ${t.keys} would search ${entry}, protected by [guard] protect in Orrery's config; search a narrower folder.`);
		}
		expect(pi(t, "grep", { pattern: "x", path: "~/finance" })).toMatch(PROTECTED);
	});

	it("does not check a name entry against a search's root, but refuses a glob or file-name pattern that names it", () => {
		const t = protectWorld();
		expect(pi(t, "grep", { pattern: "token", path: "." })).toBeUndefined();
		expect(pi(t, "grep", { pattern: "token" })).toBeUndefined();
		expect(pi(t, "grep", { pattern: "x", path: ".", glob: "**/secrets.yml" })).toBe(`grep glob "**/secrets.yml" names secrets.yml, protected by [guard] protect in Orrery's config.`);
		expect(pi(t, "find", { pattern: "secrets.yml", path: "." })).toMatch(PROTECTED);
		expect(pi(t, "find", { pattern: "vault/**", path: "." })).toMatch(PROTECTED);
		expect(pi(t, "grep", { pattern: "secrets.yml", path: "src" })).toBeUndefined();
		expect(pi(t, "grep", { pattern: "x", path: ".", glob: "*.ts" })).toBeUndefined();
	});
});

describe(".env built in", () => {
	/** No [guard] protect at all: .env is protected anyway. */
	const plain = (t: World) => ({ ...t.options, protect: [] as string[] });

	it("refuses .env and .env.<anything> to file tools, as a sensitive file", () => {
		const t = protectWorld();
		for (const path of [".env", ".env.local", ".env.production", join(t.root, "x", ".env"), ".ENV", "settings.txt"]) {
			expect([path, guardToolCall("read", { path }, plain(t))]).toEqual([path, expect.stringMatching(SENSITIVE)]);
		}
		expect(guardToolCall("read", { path: ".env" }, plain(t))).toBe(".env is a sensitive file (keys, credentials or Orrery's private data).");
		expect(guardToolCall("write", { path: ".env", content: "KEY=x" }, plain(t))).toMatch(SENSITIVE);
		expect(guardToolCall("edit", { path: ".env.local", edits: [] }, plain(t))).toMatch(SENSITIVE);
	});

	it("leaves the shared examples, .envrc and files that only end in .env", () => {
		const t = protectWorld();
		for (const path of [".env.example", ".env.sample", ".env.template", ".envrc", "prod.env", ".gitignore"]) expect([path, guardToolCall("read", { path }, plain(t))]).toEqual([path, undefined]);
	});

	it.each([
		"cat .env",
		"cat .env.local",
		"cat /x/.env",
		"node --env-file=.env app.js",
		"source .env",
		"docker run --env-file .env img",
		"cat .env*",
		"set -a; . ./.env",
		"cp .env.example .env",
		"cat .ENV.Local",
		"cat {.env,x}",
		'grep KEY ".env"',
	])("refuses the command %s", (command) => {
		const t = protectWorld();
		expect(guardToolCall("bash", { command }, plain(t))).toBe("This command touches sensitive files (keys, credentials or Orrery's private data).");
	});

	it.each([
		"cat .env.example",
		"cp .env.example .env.sample",
		"cat .env.template",
		"cat .envrc",
		"cat prod.env",
		"node -e 'console.log(process.env.HOME)'",
		"node -e 'console.log(import.meta.env.MODE)'",
		"printenv HOME",
		"env | sort",
		"direnv allow",
		"echo $ENV",
		"python -c 'import os; print(os.environ)'",
	])("allows the command %s", (command) => {
		const t = protectWorld();
		expect(guardToolCall("bash", { command }, plain(t))).toBeUndefined();
	});

	it("refuses a glob or file-name pattern that names one", () => {
		const t = protectWorld();
		expect(guardToolCall("grep", { pattern: "KEY", path: ".", glob: ".env*" }, plain(t))).toMatch(SENSITIVE);
		expect(guardToolCall("find", { pattern: "**/.env", path: "." }, plain(t))).toMatch(SENSITIVE);
		expect(guardToolCall("find", { pattern: "**/.env.example", path: "." }, plain(t))).toBeUndefined();
		expect(guardToolCall("grep", { pattern: ".env", path: "src" }, plain(t))).toBeUndefined();
	});
});

describe("[guard] protect and .env in OMP", () => {
	const omp = (t: World, tool: string, input: Record<string, unknown>) => guardOmpToolCall(tool, input, t.options);

	it("lets an edit's text name .env or a name entry, and refuses an edit that targets one", () => {
		const t = protectWorld();
		expect(omp(t, "edit", { input: "[.gitignore#1a2b]\nPUT 1\n+.env\n+.env.local\n+secrets.yml\n", paths: [".gitignore"], path: ".gitignore" })).toBeUndefined();
		expect(omp(t, "edit", { input: '[src/a.ts#1a2b]\nPUT 1\n+dotenv.config({ path: ".env" });\n', path: "src/a.ts" })).toBeUndefined();
		expect(omp(t, "edit", { input: "[.env#1a2b]\nPUT 1\n+KEY=x\n" })).toMatch(SENSITIVE);
		expect(omp(t, "edit", { input: "PUT 1\n+KEY=x\n", path: ".env" })).toMatch(SENSITIVE);
		expect(omp(t, "edit", { input: "[src/a.ts#1a2b]\nMV .env.local\n", path: "src/a.ts" })).toMatch(SENSITIVE);
		expect(omp(t, "edit", { input: "*** Begin Patch\n*** Update File: secrets.yml\n@@\n-a\n+b\n*** End Patch\n" })).toMatch(PROTECTED);
		expect(omp(t, "edit", { input: "[vault/token.txt#1a2b]\nPUT 1\n+x\n" })).toMatch(PROTECTED);
	});

	it("keeps the whole-text check for path entries: an edit whose text names one is refused, its content included", () => {
		const t = protectWorld();
		expect(omp(t, "edit", { input: "[src/a.ts#1a2b]\nPUT 1\n+see ~/finance/q3.csv\n", path: "src/a.ts" })).toBe(
			"This edit touches ~/finance, protected by [guard] protect in Orrery's config.",
		);
		expect(omp(t, "edit", { input: "[src/a.ts#1a2b]\nPUT 1\n+see ~/finance-old/x.csv\n", path: "src/a.ts" })).toBeUndefined();
	});

	it("judges eval like bash, and reads, searches and ast_edit like pi's tools", () => {
		const t = protectWorld();
		expect(omp(t, "eval", { language: "py", code: "open('.env').read()" })).toMatch(SENSITIVE);
		expect(omp(t, "eval", { language: "py", code: "open('secrets.yml').read()" })).toMatch(PROTECTED);
		expect(omp(t, "eval", { language: "js", code: "console.log(process.env.HOME)" })).toBeUndefined();
		expect(omp(t, "read", { path: "secrets.yml:1-5" })).toMatch(PROTECTED);
		expect(omp(t, "read", { path: "src/a.ts .env" })).toMatch(SENSITIVE);
		expect(omp(t, "grep", { pattern: "x", path: t.keys })).toMatch(/would search .*prod\.pem, protected by \[guard\] protect .*narrower folder/);
		expect(omp(t, "grep", { pattern: "x", path: "." })).toBeUndefined();
		expect(omp(t, "glob", { path: "**/secrets.yml" })).toMatch(PROTECTED);
		expect(omp(t, "grep", { pattern: "KEY", path: "src/**/.env*" })).toMatch(SENSITIVE);
		expect(omp(t, "ast_edit", { ops: [{ pat: "a", out: "b" }], paths: ["vault/**/*.ts"] })).toMatch(PROTECTED);
	});
});

describe("[guard] protect and .env in Claude Code", () => {
	it("refuses them through Claude Code's tools", () => {
		const t = protectWorld();
		const claude = (tool: string, input: Record<string, unknown>) => claudeGuard(tool, input, t.options);
		expect(claude("Read", { file_path: ".env" })).toMatch(SENSITIVE);
		expect(claude("Read", { file_path: "secrets.yml" })).toMatch(PROTECTED);
		expect(claude("Read", { file_path: join(t.atlas, "link.csv") })).toMatch(PROTECTED);
		expect(claude("Bash", { command: "cat ~/finance/q3.csv" })).toMatch(PROTECTED);
		expect(claude("Bash", { command: "cat .env.local" })).toMatch(SENSITIVE);
		expect(claude("Grep", { pattern: "x", path: t.keys })).toMatch(/narrower folder/);
		expect(claude("Glob", { pattern: "**/secrets.yml" })).toMatch(PROTECTED);
		expect(claude("Glob", { pattern: "**/.env.example" })).toBeUndefined();
		expect(claude("Grep", { pattern: ".env" })).toBeUndefined();
		expect(claude("Edit", { file_path: ".gitignore", old_string: "node_modules", new_string: "node_modules\n.env" })).toBeUndefined();
	});

	it("takes the entries from the config in the PreToolUse hook", async () => {
		const t = protectWorld();
		const c = { config: t.config, env: { CLAUDE_PROJECT_DIR: t.atlas }, claudePid: 1, startHolder: () => {}, home: t.home };
		const call = async (tool_name: string, tool_input: object) =>
			JSON.parse((await runHook("pre-tool-use", JSON.stringify({ session_id: "s1", cwd: t.atlas, tool_name, tool_input }), c)) || "{}").hookSpecificOutput?.permissionDecisionReason;
		expect(await call("Read", { file_path: join(t.atlas, "secrets.yml") })).toBe(`Orrery guard: ${join(t.atlas, "secrets.yml")} is protected by [guard] protect in Orrery's config.`);
		expect(await call("Bash", { command: "cat ~/finance/q3.csv" })).toMatch(PROTECTED);
		expect(await call("Read", { file_path: join(t.atlas, ".env") })).toMatch(SENSITIVE);
		expect(await call("Read", { file_path: join(t.atlas, "src", "a.ts") })).toBeUndefined();
	});
});

describe("[guard] protect in pi's and OMP's sessions", () => {
	it("takes the entries from the config in pi", async () => {
		const t = protectWorld();
		const options = { config: t.config, summarySources: async (cfg: HarnessConfig) => summarySourcesFor(cfg), ...scratchHome(t.root) };
		const host = track(fakeOmp(t.atlas, [createOrrery(options)], { omp: false }));
		await host.emit("session_start");
		const tool = async (toolName: string, input: object) => (await host.emit("tool_call", { toolName, toolCallId: "t1", input }))[0];
		expect(await tool("read", { path: "secrets.yml" })).toEqual({ block: true, reason: "secrets.yml is protected by [guard] protect in Orrery's config." });
		expect(await tool("bash", { command: "cat ~/finance/q3.csv" })).toEqual({ block: true, reason: expect.stringMatching(PROTECTED) });
		expect(await tool("read", { path: ".env" })).toEqual({ block: true, reason: expect.stringMatching(SENSITIVE) });
		expect(await tool("read", { path: "src/a.ts" })).toBeUndefined();
	});

	it("takes the entries from the config in OMP", async () => {
		const t = protectWorld();
		const host = await ompOrrery(t.atlas, t.config);
		const tool = async (toolName: string, input: object) => (await host.emit("tool_call", { toolName, toolCallId: "t1", input }))[0];
		expect(await tool("read", { path: "vault/token.txt" })).toEqual({ block: true, reason: expect.stringMatching(PROTECTED) });
		expect(await tool("edit", { input: "[.gitignore#1a2b]\nPUT 1\n+.env\n", path: ".gitignore" })).toBeUndefined();
		expect(await tool("edit", { input: "[.env#1a2b]\nPUT 1\n+KEY=x\n" })).toEqual({ block: true, reason: expect.stringMatching(SENSITIVE) });
	});
});

describe("[guard] protect and .env in orrery run", () => {
	it("refuses them in the durable guard's pre-check, a ~/ entry by its spellings", () => {
		const t = protectWorld();
		// The durable guard reads "~" as the OS's home; nothing here looks at the file system.
		const options = { folder: t.atlas, allowedRoots: [t.atlas], cwd: t.atlas, foreignViews: [] as string[], protect: t.protect };
		const call = (name: string, args: Record<string, unknown>) => checkToolCall({ name, arguments: args }, options);
		expect(call("bash", { command: "cat secrets.yml" })).toMatch(PROTECTED);
		expect(call("bash", { command: "cat ~/finance/q3.csv" })).toMatch(PROTECTED);
		expect(call("bash", { command: "cat .env" })).toMatch(SENSITIVE);
		expect(call("read", { path: "vault/x" })).toMatch(PROTECTED);
		expect(call("read", { path: "~/finance/q3.csv" })).toMatch(PROTECTED);
		expect(call("read", { path: ".env.local" })).toMatch(SENSITIVE);
		expect(call("read", { path: ".env.example" })).toBeUndefined();
	});

	it("refuses them in the durable guard's resolved check, links followed", async () => {
		const t = protectWorld();
		// Absolute entries: "~" would be the OS's home, which a test leaves alone.
		const protect = [join(t.home, "finance"), join(t.keys, "prod.pem"), "secrets.yml", "vault"];
		const options = { folder: t.atlas, allowedRoots: [t.atlas], cwd: t.atlas, foreignViews: [] as string[], protect };
		const env = new NodeExecutionEnv({ cwd: t.atlas });
		expect(await checkResolvedPath(env, "link.csv", "read", options, ctx)).toMatch(PROTECTED);
		expect(await checkResolvedPath(env, "key-link", "read", options, ctx)).toMatch(PROTECTED);
		expect(await checkResolvedPath(env, "notes.yml", "read", options, ctx)).toMatch(PROTECTED);
		expect(await checkResolvedPath(env, "settings.txt", "read", options, ctx)).toMatch(SENSITIVE);
		expect(await checkResolvedPath(env, "src/a.ts", "read", options, ctx)).toBeUndefined();
	});

	it("takes the entries from the config", async () => {
		const dir = realpathSync(tempDir("orrery-protect-run-"));
		dirs.push(dir);
		const folder = join(dir, "ws");
		mkdirSync(folder);
		writeFileSync(join(folder, "secrets.yml"), "token: x");
		const config = parseConfig(agentConfigToml({ dataDir: join(dir, "data"), folder, extra: '[guard]\nprotect = ["secrets.yml"]\n' }), dir);
		const { chat, models } = fauxModels();
		const results: string[] = [];
		chat.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "secrets.yml" }, { id: "r" }), { stopReason: "toolUse" }),
			(context) => {
				results.push(contextLines(context).at(-1) ?? "");
				return fauxAssistantMessage("done");
			},
		]);
		const agent = await Agent.open({ config, agent: "Test", models, context: ctx });
		try {
			await (await agent.submit("read it", "r1"))?.submission.wait(ctx);
			expect(results[0]).toMatch(PROTECTED);
			expect(results[0]).not.toContain("token: x");
		} finally {
			await agent.close();
		}
	});
});

describe("[guard] protect: speed", () => {
	it("judges a very long command in time that grows linearly, entries and the .env rule included", () => {
		const t = protectWorld();
		const units = [".env.=", "=.env", "/.env", "{.env,", ".env.x=y", "~/finance", "~/fin", "secrets.yml=", "=secrets.y", "$HOME/fin", "{a,b}/vault=", "vault."];
		// As the guard's own speed test: a 4x step must cost under 10x (linear is about 4x, quadratic about 16x).
		const time = (unit: string, times: number) => {
			const command = `cat ${unit.repeat(times)}`;
			const started = performance.now();
			guardToolCall("bash", { command }, t.options);
			return performance.now() - started;
		};
		for (const unit of units) {
			time(unit, 1000); // warm up
			let small = Number.POSITIVE_INFINITY;
			let large = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				small = Math.min(small, time(unit, 25_000));
				large = Math.min(large, time(unit, 100_000));
			}
			expect(large / Math.max(small, 20), `${JSON.stringify(unit)}: ${small.toFixed(0)} ms -> ${large.toFixed(0)} ms`).toBeLessThan(10);
			expect(large, `${JSON.stringify(unit)} backstop`).toBeLessThan(10_000);
		}
	});
});
