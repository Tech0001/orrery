import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanEnv, cliCommand } from "../claude/support.ts";
import { localIso } from "../../src/memory/index.ts";
import { tempDir } from "../agent/support.ts";
import { fifos, readableOnce, standInTool, stopWriters } from "./read-once.ts";

const dirs: string[] = [];
afterEach(() => {
	stopWriters();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const orrery = (args: string[], env: Record<string, string>, cwd?: string) => {
	const c = cliCommand(args);
	return spawnSync(c.cmd, c.args, { env: cleanEnv(env), encoding: "utf8", ...(cwd ? { cwd } : {}) });
};

describe("orrery agent", () => {
	it("adds an agent to a new config, then sets its keys", () => {
		const dir = tempDir("orrery-agent-cli-");
		dirs.push(dir);
		const config = join(dir, "config.toml");
		const add = orrery(["agent", "add", "Gamma", "--folder", "ws", "--tool", "claude-code", "--summary", "openai/gpt-6.1-sol"], { ORRERY_CONFIG: config }, dir);
		expect(add.stderr).toBe("");
		expect(add.stdout).toBe(`Added agent Gamma: ${join(realpathSync(dir), "ws")}, Claude Code, summaries openai/gpt-6.1-sol (low).\n`);
		const set = orrery(["agent", "set", "Gamma", "--view-kb", "96"], { ORRERY_CONFIG: config });
		expect(set.stdout).toBe("Set agents.Gamma.view_bytes = 96000. It applies when Gamma next opens.\n");
		expect(readFileSync(config, "utf8")).toContain("view_bytes = 96000");
		expect(readFileSync(config, "utf8")).toContain('model = "openai/gpt-6.1-sol"\ncompactor_model = "openai/gpt-6.1-sol"');
	});

	it("sets compact_at with --compact-at", () => {
		const dir = tempDir("orrery-agent-cli-");
		dirs.push(dir);
		const config = join(dir, "config.toml");
		writeFileSync(config, `[agents.A]\nfolder = "/w"\ncompactor_model = "a/b"\n`);
		const out = orrery(["agent", "set", "A", "--compact-at", "150000"], { ORRERY_CONFIG: config });
		expect(out.stderr).toBe("");
		expect(out.stdout).toBe("Set agents.A.compact_at = 150000. It applies when A next opens.\n");
		expect(readFileSync(config, "utf8")).toContain("compact_at = 150000");
	});

	it("finds the agent to set whatever the case of its name", () => {
		const dir = tempDir("orrery-agent-cli-");
		dirs.push(dir);
		const config = join(dir, "config.toml");
		writeFileSync(config, `[agents.Gamma]\nfolder = "/w"\ncompactor_model = "a/b"\n`);
		const out = orrery(["agent", "set", "gamma", "--jobs", "2"], { ORRERY_CONFIG: config });
		expect(out.stderr).toBe("");
		expect(out.stdout).toBe("Set agents.Gamma.compactor_jobs = 2. It applies when Gamma next opens.\n");
		expect(readFileSync(config, "utf8")).toBe(`[agents.Gamma]\nfolder = "/w"\ncompactor_model = "a/b"\ncompactor_jobs = 2\n`);
	});

	it.skipIf(!fifos)("in a coding tool's session add, set and archive read the config once, in the gate, and write the file it read", async () => {
		const dir = tempDir("orrery-agent-cli-");
		dirs.push(dir);
		const config = join(dir, "config.toml");
		const tool = standInTool(dir);
		/**
		 * `args` run on `text` under a coding tool (there the config is written only as the gate read it), at a
		 * config that can be read once: a second read would wait for a writer that never comes.
		 */
		const run = async (args: string[], text: string) => {
			rmSync(config, { force: true });
			readableOnce(config, text);
			const c = cliCommand(args);
			const child = spawn(tool, [c.cmd, ...c.args], { env: cleanEnv({ ORRERY_CONFIG: config }), cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
			child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
			const stop = setTimeout(() => child.kill(), 15_000);
			const [code] = (await once(child, "close")) as [number | null];
			clearTimeout(stop);
			expect(statSync(config).isFile(), args.join(" ")).toBe(true);
			expect(readFileSync(`${config}.bak`, "utf8"), args.join(" ")).toBe(text);
			return { code, stdout, stderr, text: readFileSync(config, "utf8") };
		};
		const start = `data_dir = ${JSON.stringify(join(dir, "data"))}\n[agents.Alpha]\nfolder = "/w/a"\ncompactor_model = "a/b"\n[agents.Beta]\nfolder = "/w/b"\ncompactor_model = "a/b"\n`;
		const added = await run(["agent", "add", "Gamma", "--folder", "ws", "--tool", "claude-code", "--summary", "openai/gpt-6.1-sol", "--reads", "Alpha"], start);
		expect({ code: added.code, stderr: added.stderr }).toEqual({ code: 0, stderr: "" });
		expect(added.text).toContain("[agents.Gamma]");
		const set = await run(["agent", "set", "gamma", "--view-kb", "96"], added.text);
		expect(set).toMatchObject({ code: 0, stderr: "", stdout: "Set agents.Gamma.view_bytes = 96000. It applies when Gamma next opens.\n" });
		const archived = await run(["agent", "archive", "Beta"], set.text);
		expect(archived).toMatchObject({ code: 0, stderr: "", stdout: "Archived Beta.\n" });
		expect(archived.text).toContain("# [agents.Beta]");
	}, 60_000);

	it("refuses an unknown option value with the reason and leaves the config alone", () => {
		const dir = tempDir("orrery-agent-cli-");
		dirs.push(dir);
		const config = join(dir, "config.toml");
		writeFileSync(config, `[agents.A]\nfolder = "/w"\ncompactor_model = "a/b"\n`);
		const out = orrery(["agent", "set", "A", "--tool", "vim"], { ORRERY_CONFIG: config });
		expect(out.status).toBe(1);
		expect(out.stderr).toContain("agents.A.tool must be one of pi, claude-code, codex");
		expect(readFileSync(config, "utf8")).toBe(`[agents.A]\nfolder = "/w"\ncompactor_model = "a/b"\n`);
	});
});

describe("orrery agent archive", () => {
	function agents(extra = "") {
		const dir = tempDir("orrery-agent-archive-");
		dirs.push(dir);
		const config = join(dir, "config.toml");
		const data = join(dir, "data");
		writeFileSync(config, `data_dir = ${JSON.stringify(data)}\n\n[agents.Alpha]\nfolder = "/w/a"\ncompactor_model = "a/b"\n\n[agents.Beta]\nfolder = "/w/b"\ncompactor_model = "a/b"\n${extra}`);
		const memory = join(data, "agents", "Alpha");
		mkdirSync(memory, { recursive: true });
		writeFileSync(join(memory, "memory.sqlite"), "not touched");
		return { config, data, memory };
	}

	it("takes the agent out of the config, keeps it as comments, and leaves its memory folder alone", () => {
		const { config, data, memory } = agents();
		const out = orrery(["agent", "archive", "alpha"], { ORRERY_CONFIG: config });
		expect(out.stderr).toBe("");
		expect(out.status).toBe(0);
		expect(out.stdout).toBe("Archived Alpha.\n");
		const text = readFileSync(config, "utf8");
		expect(text).toMatch(new RegExp(`^# Archived \\d{4}-\\d{2}-\\d{2} \\(orrery agent archive Alpha\\)\\. Its memory is still in ${join(data, "agents", "Alpha").replaceAll("/", "\\/")}\\. Uncomment to bring it back:$`, "m"));
		expect(text).toContain('# [agents.Alpha]\n# folder = "/w/a"\n# compactor_model = "a/b"\n');
		expect(text).not.toMatch(/^\[agents\.Alpha\]/m);
		expect(readFileSync(join(memory, "memory.sqlite"), "utf8")).toBe("not touched");
		const status = orrery(["status", "--json"], { ORRERY_CONFIG: config });
		expect(JSON.parse(status.stdout).agents.map((l: { name: string }) => l.name)).toEqual(["Beta"]);
	});

	it("refuses an agent another agent reads, and an open agent, changing nothing", () => {
		const read = agents('reads = ["Alpha"]\n');
		const before = readFileSync(read.config, "utf8");
		const refused = orrery(["agent", "archive", "Alpha"], { ORRERY_CONFIG: read.config });
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain("Beta reads it; take it out of Beta's reads first.");
		expect(readFileSync(read.config, "utf8")).toBe(before);

		const open = agents();
		const status = { agent: "Alpha", pid: process.pid, open: true, busy: false, model: "pi", thinking: "off", compactor: { stopped: false, failing: 0, model: "a/b", thinking: "low", source: "config" }, trouble: null, lastError: null, updatedAt: localIso() };
		writeFileSync(join(open.memory, "status.json"), JSON.stringify(status));
		const busy = orrery(["agent", "archive", "Alpha"], { ORRERY_CONFIG: open.config });
		expect(busy.status).toBe(1);
		expect(busy.stderr).toContain("Alpha is open in pi; close it first.");
		expect(readFileSync(open.config, "utf8")).not.toContain("# [agents.Alpha]");
	});

	it("refuses a config it can't write, and an unknown agent", () => {
		const { config } = agents();
		const unknown = orrery(["agent", "archive", "Gamma"], { ORRERY_CONFIG: config });
		expect(unknown.status).toBe(1);
		expect(unknown.stderr).toContain("No agent named Gamma");
		chmodSync(config, 0o444);
		const locked = orrery(["agent", "archive", "Alpha"], { ORRERY_CONFIG: config });
		chmodSync(config, 0o644);
		expect(locked.status).toBe(1);
		expect(locked.stderr).toContain(`The config can't be written here (${config}); edit it by hand.`);
		expect(readFileSync(config, "utf8")).not.toContain("# [agents.Alpha]");
	});

	it("is in the usage text", () => {
		expect(orrery(["help"], {}).stdout).toContain("agent archive <Name>");
	});
});

describe("orrery tools", () => {
	/** No config at the named path, an empty HOME, and a PATH with only the given fake tools. */
	function bare(scripts: Record<string, string> = {}) {
		const dir = tempDir("orrery-tools-cli-");
		dirs.push(dir);
		const bin = join(dir, "bin");
		const home = join(dir, "home");
		mkdirSync(bin);
		mkdirSync(home);
		for (const [name, body] of Object.entries(scripts)) {
			writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
			chmodSync(join(bin, name), 0o755);
		}
		return { dir, home, env: { ORRERY_CONFIG: join(dir, "no-such", "config.toml"), HOME: home, PATH: bin, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") } };
	}

	it("works before any config exists (the docs send new users here first)", () => {
		const { env } = bare();
		const out = orrery(["tools", "--json"], env);
		expect(out.stderr).toBe("");
		expect(out.status).toBe(0);
		// Wrangler's row appears only where worker/ has its own dependencies installed, which a fresh clone does not.
		const wrangler = existsSync(fileURLToPath(new URL("../../worker/node_modules/.bin/wrangler", import.meta.url))) ? ["wrangler"] : [];
		expect(JSON.parse(out.stdout).tools.map((t: { id: string }) => t.id)).toEqual(["pi", "claude-code", "codex", "omp", "opencode", "ori", ...wrangler]);
	});

	it("keeps full paths, details and version strings in CLI text and JSON", () => {
		const { env, home } = bare({ pi: 'echo "1.1.0"', claude: 'if [ "$1" = "--version" ]; then echo "2.1.296 (Claude Code)"; else echo "[]"; fi', codex: 'echo "codex-cli 0.162.1"', omp: 'echo "omp/18.10.2"', opencode: 'echo "opencode v2.0.30"' });
		const text = orrery(["tools"], env);
		expect(text.status).toBe(0);
		for (const version of ["2.1.296 (Claude Code)", "codex-cli 0.162.1", "omp/18.10.2", "opencode v2.0.30"]) expect(text.stdout).toContain(version);
		// OpenCode's side comes with each launch, as Codex's does; the Tools line says what the last check found.
		expect(text.stdout).toMatch(/^OpenCode +opencode v2\.0\.30 +memory +plugin is checked at the first launch$/m);
		expect(text.stdout).toContain(`${home}/.pi/agent/extensions/orrery.ts`);
		const result = orrery(["tools", "--json"], env);
		expect(result.status).toBe(0);
		const tools = JSON.parse(result.stdout).tools;
		expect(tools.find((tool: { id: string }) => tool.id === "claude-code")).toMatchObject({ version: "2.1.296 (Claude Code)", path: `${env.PATH}/claude` });
		expect(tools.find((tool: { id: string }) => tool.id === "pi").detail).toContain(`${home}/.pi/agent/extensions/orrery.ts`);
		expect(result.stdout).not.toContain("…");
	});

	it("installs OMP's relative entry with --yes", () => {
		const { env: shared, home } = bare({ omp: "echo omp/18.8.7" });
		const { PI_CODING_AGENT_DIR: _pi, ...env } = shared; // pi's dir would be OMP's too
		expect(orrery(["tools", "install", "omp", "--yes"], env).status).toBe(0);
		// A checkout re-exports its source entry; the built binary runs from a release folder, which has the packed one.
		const entry = process.env.ORRERY_TEST_BIN ? /^export \{ default \} from "\.\.\/.*extensions\/omp\.js";\n$/ : /^export \{ default \} from "\.\.\/.*src\/omp\/index\.ts";\n$/;
		expect(readFileSync(join(home, ".omp", "agent", "extensions", "orrery.ts"), "utf8")).toMatch(entry);
	});

	it("without a terminal and without --yes, says why nothing was installed", () => {
		const { env, home } = bare({ pi: "echo 1.1.0" });
		const out = orrery(["tools", "install", "pi"], env);
		expect(out.status).toBe(1);
		expect(out.stdout).toContain(`will write ${join(home, ".pi", "agent", "extensions", "orrery.ts")} (a re-export of `);
		expect(out.stdout).toContain("Not installed: no terminal to confirm; rerun with --yes.\n");
		expect(existsSync(join(home, ".pi", "agent", "extensions", "orrery.ts"))).toBe(false);
	});

	it("installs with --yes, then says it is already installed", () => {
		const { env, home } = bare({ pi: "echo 1.1.0" });
		expect(orrery(["tools", "install", "pi", "--yes"], env).status).toBe(0);
		expect(existsSync(join(home, ".pi", "agent", "extensions", "orrery.ts"))).toBe(true);
		const again = orrery(["tools", "install", "pi"], env);
		expect(again.status).toBe(0);
		expect(again.stdout).toBe(`Already installed: pi, ${join(home, ".pi", "agent", "extensions", "orrery.ts")}.\n`);
	});
});

describe("orrery agent --reads", () => {
	const base = `[agents.Atlas]\nfolder = "/w/a"\ncompactor_model = "a/b"\n[agents.Birch]\nfolder = "/w/b"\ncompactor_model = "a/b"\n[agents.Cedar]\nfolder = "/w/c"\ncompactor_model = "a/b"\n`;

	it("sets the agents one reads, then clears them", () => {
		const dir = tempDir("orrery-agent-cli-");
		dirs.push(dir);
		const config = join(dir, "config.toml");
		writeFileSync(config, base);
		const set = orrery(["agent", "set", "Atlas", "--reads", "birch,Cedar"], { ORRERY_CONFIG: config });
		expect(set.stderr).toBe("");
		expect(set.stdout).toBe("Set agents.Atlas.reads = Birch, Cedar. It applies when Atlas next opens.\n");
		expect(readFileSync(config, "utf8")).toContain('reads = ["Birch", "Cedar"]');
		const none = orrery(["agent", "set", "Atlas", "--reads", "none"], { ORRERY_CONFIG: config });
		expect(none.stdout).toBe("Set agents.Atlas.reads = none. It applies when Atlas next opens.\n");
		expect(readFileSync(config, "utf8")).toBe(base);
	});

	it("refuses unknown names and itself, leaving the config alone", () => {
		const dir = tempDir("orrery-agent-cli-");
		dirs.push(dir);
		const config = join(dir, "config.toml");
		writeFileSync(config, base);
		const unknown = orrery(["agent", "set", "Atlas", "--reads", "Nope"], { ORRERY_CONFIG: config });
		expect(unknown.status).not.toBe(0);
		expect(unknown.stderr).toContain("Known agents: Atlas, Birch, Cedar");
		const self = orrery(["agent", "set", "Atlas", "--reads", "Atlas"], { ORRERY_CONFIG: config });
		expect(self.stderr).toContain("an agent always reads itself");
		expect(readFileSync(config, "utf8")).toBe(base);
	});

	it("agent add --reads all writes [\"*\"]", () => {
		const dir = tempDir("orrery-agent-cli-");
		dirs.push(dir);
		const config = join(dir, "config.toml");
		writeFileSync(config, base);
		const add = orrery(["agent", "add", "Dune", "--folder", "/w/d", "--tool", "pi", "--summary", "a/b", "--reads", "all"], { ORRERY_CONFIG: config });
		expect(add.stderr).toBe("");
		expect(readFileSync(config, "utf8")).toContain('reads = ["*"]');
		const fresh = join(dir, "new", "config.toml");
		const second = orrery(["agent", "add", "Eve", "--folder", "/w/e", "--tool", "pi", "--summary", "a/b", "--reads", "none"], { ORRERY_CONFIG: fresh });
		expect(second.stderr).toBe("");
		expect(readFileSync(fresh, "utf8")).not.toContain("reads =");
	});
});

it("agent set --reads with no config file says there is no such agent, not ENOENT", () => {
	const dir = tempDir("orrery-agent-cli-");
	dirs.push(dir);
	const out = orrery(["agent", "set", "Atlas", "--reads", "all"], { ORRERY_CONFIG: join(dir, "none.toml") });
	expect(out.status).not.toBe(0);
	expect(out.stderr).toContain("No agent named Atlas");
	expect(out.stderr).not.toContain("ENOENT");
});
