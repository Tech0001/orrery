import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installFrom, removeVersion } from "../../src/install/install.ts";
import { checkTools, installSteps, ompExtensionFile, ompExtensionText, orreryRoot, runInstall, type ToolCheck } from "../../src/lane/tools.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { fakeModel, rpc } from "../pi/host-rpc.ts";
import { realRemoteTurn } from "../pi/remote-real-support.ts";
import { builtRelease, bunReady, changedSince, installRelease, removeBuiltRelease } from "../release/support.ts";

/**
 * OMP's whole environment for every run here: a scratch HOME and XDG folders inside it, nothing inherited but PATH.
 * OMP moves its data under $XDG_*_HOME/omp when that folder exists, so HOME alone would not keep it out of the
 * user's own state; no PI_* or OMP_* variable reaches it either.
 */
function isolated(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		TERM: "dumb",
		...extra,
	};
}

const scratch = mkdtempSync(join(tmpdir(), "orrery-real-omp-"));
afterAll(removeBuiltRelease);
afterAll(() => removeVersion(scratch)); // installed releases under it are read-only

/** The omp binary: ORRERY_TEST_OMP, or "omp" on PATH; null when there is none. Even --version runs in a scratch HOME. */
function findOmp(): string | null {
	const home = join(scratch, "version-home");
	mkdirSync(home, { recursive: true });
	const works = (path: string) => spawnSync(path, ["--version"], { env: isolated(home), timeout: 30_000 }).status === 0;
	const wanted = process.env.ORRERY_TEST_OMP ?? "omp";
	if (wanted.includes("/")) return works(wanted) ? wanted : null;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir !== "" && works(join(dir, wanted))) return join(dir, wanted);
	}
	return null;
}

const omp = findOmp();

describe.skipIf(omp === null)("Orrery inside a real OMP (isolated OMP home)", () => {
	it("checks out a remote lane, records a real turn, saves and closes", async () => {
		await realRemoteTurn(omp as string, "omp");
	}, 90_000);

	it("lets a delayed shutdown release go stale and retakes it on the same machine", async () => {
		await realRemoteTurn(omp as string, "omp", true);
	}, 60_000);

	it("loads from the install file, switches OMP's features off, records turns and sends only the view and this run", async () => {
		await loadCheck(mkdtempSync(join(scratch, "checkout-")), orreryRoot(), "checkout");
	}, 120_000);

	// An installed release folder is read-only and holds no dev packages; OMP supplies what extensions/omp.js leaves out.
	it.skipIf(!bunReady)("OMP loads Orrery through app/current", async () => {
		const base = mkdtempSync(join(scratch, "installed-"));
		try {
			const home = join(base, "home");
			const { version } = installFrom({ from: await builtRelease(), env: isolated(home) });
			expect(existsSync(join(home, ".orrery", "app", version, "node_modules"))).toBe(false);
			const current = join(home, ".orrery", "app", "current");
			// Written by hand until the wiring knows releases: OMP follows only a relative re-export (research section 3).
			await loadCheck(base, current, version, (file) => {
				writeFileSync(file, `export { default } from ${JSON.stringify(relative(dirname(file), join(current, "extensions", "omp.js")))};\n`);
			});
		} finally {
			removeVersion(base); // the installed version is read-only
		}
	}, 180_000);

	describe.skipIf(!bunReady)("from a release", () => {
		it("OMP loads extensions/omp.js from a read-only installed release, through a relative re-export, and writes nothing there", async () => {
			const base = mkdtempSync(join(scratch, "release-"));
			const installed = installRelease(await builtRelease(), join(base, "home"));
			try {
				// Written by hand until the wiring knows releases: OMP follows only a relative re-export (research §3).
				await loadCheck(base, installed.current, installed.version, (file) => {
					writeFileSync(file, `export { default } from ${JSON.stringify(relative(dirname(file), join(installed.current, "extensions", "omp.js")))};\n`);
				});
				expect(changedSince(installed.folder, installed.marker)).toEqual([]);
			} finally {
				installed.remove();
			}
		}, 120_000);
	});
});

/**
 * The load check, in `base`: Orrery installed into a scratch OMP home the way the Tools page installs it, against
 * `root` (a checkout, or an install's app/current), or by `writeExtension` when given, then a real OMP run in a lane.
 * Its status records `version`.
 */
async function loadCheck(base: string, root: string, version: string, writeExtension?: (file: string) => void): Promise<void> {
	const model = await fakeModel("pong");
	const home = join(base, "home");
	const lane = join(base, "lane");
	const data = join(base, "data", "lanes", "Probe");
	// A Claude Code lane's import line: OMP would put the stale view in its prompt unless Orrery disables CLAUDE.md.
	mkdirSync(join(lane, ".orrery"), { recursive: true });
	writeFileSync(join(lane, "CLAUDE.md"), "Lane rules.\n\n@.orrery/view.md\n");
	writeFileSync(join(lane, ".orrery", "view.md"), "STALE-VIEW-MARKER-77\n");
	const env = isolated(home, { ORRERY_CONFIG: join(base, "config.toml") });
	const agentDir = join(home, ".omp", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.yml"),
		[
			"providers:",
			"  local:",
			`    baseUrl: ${model.baseUrl}`,
			"    apiKey: none",
			"    api: openai-completions",
			"    models:",
			"      - id: m",
			"        name: m",
			"        reasoning: false",
			"        input: [text]",
			"        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
			"        contextWindow: 128000",
			"        maxTokens: 4096",
			"        compat:",
			"          supportsStore: false",
			"          supportsDeveloperRole: false",
			"          maxTokensField: max_tokens",
			"",
		].join("\n"),
	);
	writeFileSync(join(agentDir, "config.yml"), "modelRoles:\n  default: local/m\nsetupVersion: 2\n");
	const file = ompExtensionFile(env);
	expect(file).toBe(join(agentDir, "extensions", "orrery.ts"));
	if (writeExtension !== undefined) {
		mkdirSync(dirname(file), { recursive: true });
		writeExtension(file);
	} else {
		// Installed the way the Tools page installs (src/lane/tools.ts), into the scratch agent folder: env's HOME is
		// scratch. Runner: no tool's --version or `claude plugin list` runs here; only OMP's wiring matters.
		const quiet = () => ({ status: 1, stdout: "", stderr: "" });
		const ompCheck = (): ToolCheck => checkTools({ root, env, run: quiet }).find((check) => check.id === "omp") as ToolCheck;
		expect(ompCheck().wiring).toBe("missing");
		const steps = installSteps(ompCheck(), root, env);
		expect(steps.map((step) => (step.kind === "write" ? step.path : step.kind))).toEqual([file]);
		expect(runInstall(steps, quiet)).toMatchObject({ ok: true });
		expect(readFileSync(file, "utf8")).toBe(ompExtensionText(root, file));
		expect(ompCheck().wiring).toBe("installed");
	}
	writeFileSync(
		join(base, "config.toml"),
		[
			`data_dir = ${JSON.stringify(join(base, "data"))}`,
			`credentials = ${JSON.stringify(join(base, "credentials.json"))}`,
			"[[providers]]",
			'id = "local"',
			`base_url = ${JSON.stringify(model.baseUrl)}`,
			"[[providers.models]]",
			'id = "m"',
			'name = "m"',
			"context_window = 128000",
			"max_tokens = 4096",
			"reasoning = false",
			"[lanes.Probe]",
			`workspace = ${JSON.stringify(lane)}`,
			'tool = "omp"',
			'compactor_model = "local/m"',
			'compactor_thinking = "off"',
			"",
		].join("\n"),
	);
	const child = spawn(omp as string, ["--mode", "rpc"], { cwd: lane, env });
	const exited = new Promise<void>((done) => child.on("exit", () => done()));
	const { frames, send, waitFor } = rpc(child);
	try {
		await waitFor((f) => f.type === "ready");
		await waitFor((f) => f.method === "setStatus" && f.statusKey === "orrery" && f.statusText === "Orrery · Probe · 0 msgs");
		const state = (await send({ type: "get_state" })).data as { autoCompactionEnabled: boolean; systemPrompt: string[]; dumpTools: { name: string }[] };
		expect(state.autoCompactionEnabled).toBe(false);
		expect(state.systemPrompt.join("\n")).not.toContain("STALE-VIEW-MARKER-77");
		const tools = state.dumpTools.map((tool) => tool.name);
		expect(tools).toEqual(expect.arrayContaining(["zoom", "date", "memory_search"]));
		expect(tools).not.toContain("search");
		// Orrery's own summary registry inside OMP (models.ts's fallback): /compactor reset makes one test call through it.
		await send({ type: "prompt", message: "/compactor reset" });
		await waitFor((f) => f.method === "notify" && f.message === "summaries: local/m (off) · from config");
		const first = await send({ type: "prompt", message: "The codename is Cedar." });
		await waitFor((f) => f.type === "prompt_result" && f.id === first.id);
		const second = await send({ type: "prompt", message: "What is the codename?" });
		await waitFor((f) => f.type === "prompt_result" && f.id === second.id);
		const turn2 = model.calls.find((call) => call.system.includes("# Memory") && call.users.some((u) => u.includes("What is the codename?")));
		expect(turn2?.system).toContain("The codename is Cedar.");
		expect(turn2?.system).toContain("zoom, date and memory_search are the Orrery memory tools");
		expect(turn2?.users).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(data, "status.json"), "utf8"))).toMatchObject({ lane: "Probe", model: "omp", open: true, version });
		expect(frames.filter((f) => f.method === "notify" && String(f.message).includes("OMP settings not applied"))).toEqual([]);
	} finally {
		child.stdin.end();
		const stop = setTimeout(() => child.kill("SIGTERM"), 10_000);
		await exited;
		clearTimeout(stop);
		model.close();
	}
	const store = MemoryStore.openReadOnly(join(data, "memory.sqlite"));
	const rows = store.root.map((m) => `${m.kind}: ${m.text}`);
	store.close();
	expect(rows).toEqual(["user: The codename is Cedar.", "talk: pong", "user: What is the codename?", "talk: pong"]);
	expect(JSON.parse(readFileSync(join(data, "status.json"), "utf8")).open).toBe(false);
}
