#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * orrery: run and inspect agents. Each command loads its modules when it runs. The short-lived processes Claude Code
 * starts several times a turn (claude-hook) must not load pi-durable and every model provider first. Every command but
 * the hooks first passes the gate (src/cli/gate.ts): inside an agent's session only a few run, as that agent.
 */

import { dirname, join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import type { ReaderTool } from "../agent/memory-tools.ts";
import type { Inside } from "../agent/sessions.ts";
import type { Gated } from "./gate.ts";
import { type AgentConfig, type ConfigFile, defaultConfigPath, findAgent, type HarnessConfig, loadConfig } from "../agent/config.ts";
import { armCodexGuard, CODEX_GUARD_DEADLINE_MS, isCodexGuard, isGrokGuard } from "../codex/guard-exit.ts";
import { exitWhenFlushed } from "./exit.ts";
import { allHelp, commandHelp, isCommand, shortHelp, UsageError } from "./help.ts";

function required(value: string | undefined, what: string): string {
	if (!value) throw new UsageError(`Missing ${what}.`);
	return value;
}

/** Asks a yes/no question on the terminal; no without a terminal. `hint` shows the answers ("y/N": no unless y). */
async function askYes(question: string, hint = "y/n"): Promise<boolean> {
	if (process.stdin.isTTY !== true) return false;
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await rl.question(`${question} (${hint}) `)).trim());
	} finally {
		rl.close();
	}
}

/**
 * Asks a question on the terminal whose last line names its answers and the one Enter gives ("[Y/n]", `defaultYes`, or
 * "[y/N]"): y or yes is yes, an empty answer the default, anything else no. No without a terminal.
 */
async function askWithDefault(question: string, defaultYes: boolean): Promise<boolean> {
	if (process.stdin.isTTY !== true) return false;
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`${question} `)).trim();
		return answer === "" ? defaultYes : /^y(es)?$/i.test(answer);
	} finally {
		rl.close();
	}
}

/** `orrery tools [--json]`, `orrery tools install <pi|claude-code|omp> [--yes]`. It needs no config, so a new user can run it first. */
async function toolsCommand(positionals: string[], values: { json?: boolean; yes?: boolean }): Promise<number> {
	const [{ checkTools, probeOri, installSteps, wiringRoot, runInstall, rowDetail }, { settingsDataDir }] = await Promise.all([import("../agent/tools.ts"), import("../grok/settings-keys.ts")]);
	const install = positionals[1] === "install";
	// The list says whether Grok's settings are as approved (the record of the config Orrery runs with); installing doesn't look.
	const tools = checkTools(install ? {} : { grokSettings: settingsDataDir(process.env) });
	if (install) {
		const id = required(positionals[2], "pi, claude-code or omp");
		const check = tools.find((t) => t.id === id);
		if (check === undefined || (id !== "pi" && id !== "claude-code" && id !== "omp")) throw new Error("tools install takes pi, claude-code or omp.");
		if (check.wiring === "installed") {
			process.stdout.write(`Already installed: ${check.label}, ${check.detail}.\n`);
			return 0;
		}
		const steps = installSteps(check, wiringRoot().root);
		if (steps.length === 0) {
			process.stdout.write(`Nothing to do: ${check.detail}.\n`);
			return 0;
		}
		for (const step of steps) process.stdout.write(`will ${step.describe}\n`);
		if (values.yes !== true) {
			if (process.stdin.isTTY !== true) {
				process.stdout.write("Not installed: no terminal to confirm; rerun with --yes.\n");
				return 1;
			}
			if (!(await askYes("Go ahead?"))) return 1;
		}
		const result = runInstall(steps);
		process.stdout.write(result.output);
		return result.ok ? 0 : 1;
	}
	const ori = await probeOri();
	tools.splice(tools.findIndex((t) => t.id === "ori"), 1, ori);
	if (values.json === true) {
		process.stdout.write(`${JSON.stringify({ tools }, null, 2)}\n`);
		return 0;
	}
	for (const t of tools) process.stdout.write(`${t.label.padEnd(12)} ${(t.version ?? (t.path === undefined ? "not found" : "?")).padEnd(24)} ${t.wiring.padEnd(17)} ${rowDetail(t)}\n`);
	return 0;
}

const say = (line: string) => process.stdout.write(`${line}\n`);

/**
 * `orrery setup [--yes]`: wires the orrery command, pi, OMP, Claude Code and the backup service to app/current. 1 when
 * something is left. `config`: the config the gate read and judged, which the [guard] example goes to.
 */
async function setupCommand(values: { yes?: boolean }, config: ConfigFile): Promise<number> {
	const [{ existsSync }, { orreryHome }, { wireReport, leftWarning }, { terminalConfirm }] = await Promise.all([import("node:fs"), import("../agent/home.ts"), import("../install/wire.ts"), import("../install/ask.ts")]);
	if (!existsSync(join(orreryHome(process.env), "app", "current"))) throw new Error("Orrery is not installed yet: see the install line in the README");
	// Each line is printed as it happens: Ctrl-C at a later question stops the process, and what was done is shown.
	const { left, unchecked } = await wireReport(process.env, { confirm: terminalConfirm({ yes: values.yes === true, say }), onLine: say, config });
	if (left.length > 0 || unchecked.length > 0) {
		for (const line of leftWarning(left, unchecked)) say(line);
		return 1;
	}
	return 0;
}

/** What install --from over another version, and --rollback, say last once agents are set up (a config is there). */
const RESTART_SESSIONS = "Restart open agent sessions now: sessions left open across the update aren't recorded until they restart.";

/**
 * `orrery install --from DIR | --rollback | --list [--yes]`: install a release folder or switch back a version, each
 * followed by setup; or list the installed copies in the home's app folder.
 */
async function installCommand(values: { from?: string; rollback?: boolean; list?: boolean; yes?: boolean }, config: ConfigFile): Promise<number> {
	const { installFrom, listVersions, rollback, versionLines } = await import("../install/install.ts");
	if (values.from !== undefined) {
		if (values.rollback === true || values.list === true) throw new Error("install takes one of --from DIR, --rollback or --list.");
		const dataDir = config.config?.dataDir;
		const { version, previous, removed } = installFrom({ from: values.from, env: process.env, log: say, ...(dataDir === undefined ? {} : { dataDir }) });
		say(`Installed ${version}.`);
		if (removed.length > 0) say(`Removed older versions: ${removed.join(", ")}.`);
		const status = await setupCommand(values, config);
		const [{ existsSync }, { homedir }, { defaultConfigPath }, { pathAdvice }] = await Promise.all([import("node:fs"), import("node:os"), import("../agent/config.ts"), import("../install/ask.ts")]);
		// Said even when setup left something (a tool not connected): the install itself is done.
		if (!existsSync(defaultConfigPath(process.env))) {
			const onPath = pathAdvice(process.env, join(process.env.HOME || homedir(), ".local", "bin")) === undefined;
			say(onPath ? "Run orrery to add your first agent." : "Run ~/.local/bin/orrery (or open a new terminal after adding it to PATH) to add your first agent.");
		} else if (previous !== undefined && previous !== version) {
			// An update (orrery update hands over to the new release's install --from, so the new version says this): a
			// session open across it may not be recorded until it restarts (a Claude Code or Codex started before it).
			say(RESTART_SESSIONS);
		}
		return status;
	}
	if (values.list === true) {
		process.stdout.write(`${versionLines(listVersions(process.env)).join("\n")}\n`);
		return 0;
	}
	if (values.rollback === true) {
		const { from, to } = rollback(process.env, config.config?.dataDir);
		say(`Switched back from ${from} to ${to}.`);
		const status = await setupCommand(values, config);
		// A session open across it runs the older version's hooks against the newer recorder (or the other way round),
		// which drops what it can't confirm, and pi and OMP keep the version they loaded: all until they restart.
		const [{ existsSync }, { defaultConfigPath }] = await Promise.all([import("node:fs"), import("../agent/config.ts")]);
		if (existsSync(defaultConfigPath(process.env))) say(RESTART_SESSIONS);
		return status;
	}
	throw new Error("install takes --from DIR, --rollback or --list.");
}

/** `orrery update`: the newest release (or --version V), downloaded, checked and installed by that release's own installer. */
async function updateCommand(values: { check?: boolean; version?: string; yes?: boolean }): Promise<number> {
	const { latestVersion, downloadRelease, installedVersion, newer, releasesBase } = await import("../install/update.ts");
	const { versionNumber, compiled } = await import("../agent/running.ts");
	const { agentVersions } = await import("../install/install.ts");
	const running = versionNumber();
	if (values.check === true && values.version !== undefined) throw new Error("--check looks for the latest release; drop --version.");
	const target = values.version?.replace(/^v/, "") ?? (await latestVersion(process.env));
	if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(target)) throw new Error(`--version takes a release such as 0.6.1 (got ${values.version})`);
	if (!newer(target, "0.5.99")) throw new Error("no release before 0.6.0 exists");
	if (values.check === true) {
		process.stdout.write(newer(target, running) ? `Orrery ${target} is available (this is ${running}). Run orrery update.\n` : `Orrery ${running} is up to date.\n`);
		return 0;
	}
	if (values.version === undefined && !newer(target, running)) {
		process.stdout.write(`Orrery ${running} is up to date.\n`);
		return 0;
	}
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { constants, tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { spawnSync } = await import("node:child_process");
	const work = mkdtempSync(join(tmpdir(), "orrery-update-"));
	// A signal while updating: stop the download, remove the work folder, and exit the way the shell expects.
	const control = new AbortController();
	const names = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	const handlers = names.map((name) => {
		const handler = () => {
			control.abort();
			rmSync(work, { recursive: true, force: true });
			process.exit(128 + constants.signals[name]);
		};
		process.on(name, handler);
		return handler;
	});
	const tty = process.stdout.isTTY === true;
	let shown = false;
	let status = 0;
	try {
		process.stdout.write(`Downloading Orrery ${target}...\n`);
		const folder = await downloadRelease(process.env, target, join(work, "release"), {
			signal: control.signal,
			onProgress: tty
				? (bytes, total) => {
						shown = true;
						const mb = (n: number) => (n / 1e6).toFixed(1);
						process.stdout.write(`\r  ${mb(bytes)} MB${total === undefined ? "" : ` / ${mb(total)} MB (${Math.floor((bytes / total) * 100)}%)`}   `);
					}
				: undefined,
		});
		if (shown) {
			process.stdout.write("\n");
			shown = false;
		}
		const r = spawnSync(join(folder, "bin", "orrery"), ["install", "--from", folder, ...(values.yes === true ? ["--yes"] : [])], { stdio: "inherit" });
		if (r.error) {
			// The archive unpacked, but its program cannot run there: a temp folder mounted noexec does that.
			const code = (r.error as { code?: unknown }).code;
			if (code === "EACCES" || code === "EPERM") throw new Error(`could not run the downloaded Orrery: ${tmpdir()} may be mounted noexec; set TMPDIR to a folder that allows running programs and try again`);
			throw new Error(`could not run the installer of ${target}: ${r.error.message}`);
		}
		if (r.signal) return 128 + (constants.signals[r.signal] ?? 0);
		status = r.status ?? 1;
	} finally {
		if (shown) process.stdout.write("\n");
		for (const [i, name] of names.entries()) process.off(name, handlers[i] as () => void);
		rmSync(work, { recursive: true, force: true });
	}
	// install --from also exits non-zero when only its setup left something (a question declined, no terminal), after
	// app/current was switched: what app/current names says whether the update happened.
	if (status !== 0 && installedVersion(process.env) !== target) {
		process.stderr.write(`The install of ${target} failed; Orrery stays on ${running}.\n`);
		return status;
	}
	process.stdout.write(`Updated ${running} → ${target}. Release notes: ${releasesBase(process.env)}/tag/v${target}\n`);
	// An older release's installer knows nothing of Grok, and that release answers Grok's hooks with an error, which blocks
	// every prompt: its Grok wiring goes (as a rollback's setup removes it, src/install/wire.ts).
	const { grokSupported } = await import("../grok/install.ts");
	if (!grokSupported(installedVersion(process.env))) {
		const [{ unwireGrok }, { orreryHome }] = await Promise.all([import("../install/uninstall.ts"), import("../agent/home.ts")]);
		const unwired = unwireGrok(process.env, join(orreryHome(process.env), "app"));
		if (unwired.changed || !unwired.ok) for (const line of unwired.lines) process.stdout.write(`${line}\n`);
		if (!unwired.ok) status = status === 0 ? 1 : status;
	}
	const live = [...agentVersions(process.env).versions].filter(([v]) => v !== target);
	if (live.length > 0) process.stdout.write(`These agents keep their version until they restart: ${live.map(([v, agents]) => `${agents.join(", ")} (${v})`).join("; ")}\n`);
	if (!compiled) process.stdout.write("This Orrery runs from a checkout; the installed copy was updated, the checkout was not.\n");
	if (status !== 0) process.stdout.write("Setup left something unfinished; run `orrery setup` to finish it.\n");
	return status;
}

/** `orrery uninstall [--purge]`: 1 when something of Orrery's was left, agents are open, or the purge was not confirmed. */
async function uninstallCommand(values: { purge?: boolean }): Promise<number> {
	const [{ uninstall }, { askTyped }, { orreryHome }] = await Promise.all([import("../install/uninstall.ts"), import("../install/ask.ts"), import("../agent/home.ts")]);
	const home = orreryHome(process.env);
	const { lines, ok } = await uninstall({
		env: process.env,
		purge: values.purge === true,
		confirmPurge: () => askTyped(`This deletes every agent's memory, logins and backups in ${home}.`, "delete"),
	});
	for (const line of lines) say(line);
	return ok ? 0 : 1;
}

/**
 * An agent name as given, or "." for this session's agent (Claude Code's commands use it). Inside an agent's session
 * that is the session's agent, as its record says (src/cli/gate.ts), whatever ORRERY_AGENT, CLAUDE_PID or the folder
 * say. Elsewhere: the one ORRERY_AGENT names, as the hooks pick it (src/claude/pick.ts), else the one whose folder holds
 * the project folder. In Claude Code (CLAUDE_PID, which it sets for the commands it runs, checked against this
 * process's place in the tree as a hook's is: claudeHookPid) that is the decision recorded for its process; a command
 * runs within a session, so it never decides. Elsewhere it is picked here, never claiming a token: a tool an agent
 * started with the same variables falls back to its folder.
 */
async function agentArg(config: HarnessConfig, name: string, inside: Inside | undefined): Promise<string> {
	if (name !== ".") return name;
	if (inside?.agent !== undefined) return inside.agent;
	const { claudeHookPid, claudePick, claudeRefusedNotice, claudeSession } = await import("../claude/pick.ts");
	const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	// An inherited CLAUDE_PID (one that names no Claude Code above this command) is no session's: the folder decides.
	const claudePid = process.env.CLAUDE_PID?.trim() ? claudeHookPid(config, process.env) : undefined;
	const pick =
		claudePid !== undefined
			? claudeSession(config, { env: process.env, cwd: dir, pid: claudePid, decide: false })
			: claudePick(config, { env: process.env, cwd: dir, owner: process.ppid, takeover: false });
	if (pick.kind === "agent") return pick.agent.name;
	if (pick.kind === "none") throw new Error(`${dir} is in no agent's folder.`);
	throw new Error(claudeRefusedNotice(pick));
}

/**
 * `orrery agent add <Name> --folder DIR --tool T --summary provider/id [--thinking L]`, `orrery agent set <Name> --tool T |
 * --folder DIR | --view-kb N | --summary-kb N | --jobs N | --compact-at TOKENS | --reads all|none|A,B` (`add` takes --reads too), `orrery agent archive <Name>`.
 * The config is the one the gate read and judged (`file`: --config, else $ORRERY_CONFIG, else the default config when it
 * exists, else where a new one goes), never read again; an edit is written to that file only while it is unchanged.
 */
async function agentCommand(args: string[], values: Record<string, string | boolean | string[] | undefined>, file: ConfigFile): Promise<number> {
	const [{ addAgent, archiveAgent, configWritable, editConfigOnce, parseReads, readOnlyConfigText, setAgentKey }, { configAbsent, configOf, parseConfig }, { homedir }, { archiveRefusal, agentOverview, TOOL_LABELS }] = await Promise.all([
		import("../agent/config-edit.ts"),
		import("../agent/config.ts"),
		import("node:os"),
		import("../agent/overview.ts"),
	]);
	const [action, name] = args;
	const path = file.path;
	if (["push", "pull", "takeover", "local"].includes(action)) {
		const { agentRemoteCommand } = await import("./remote.ts");
		process.stdout.write(await agentRemoteCommand(file, args, { to: values.to as string | undefined, from: values.from as string | undefined, folder: values.folder as string | undefined, yes: values.yes === true, "delete-remote": values["delete-remote"] === true }, { confirm: askYes }));
		return 0;
	}
	/** The config as read; a config not there yet is an empty one (add makes it), and one that can't be read is its error. */
	const known = () => (configAbsent(file) ? parseConfig("", dirname(path)) : configOf(file));
	const fullPath = (value: string) => resolvePath(value === "~" || value.startsWith("~/") ? `${homedir()}${value.slice(1)}` : value);
	const kb = (flag: string) => {
		const n = Number(values[flag]);
		if (!Number.isInteger(n) || n < 1) throw new Error(`--${flag} must be a whole number of KB`);
		return n * 1000;
	};
	if (action === "add") {
		const agent = required(name, "agent name");
		const summary = required(values.summary as string | undefined, "--summary provider/id");
		const thinking = (values.thinking as string | undefined) ?? "low";
		const tool = required(values.tool as string | undefined, "--tool pi|omp|claude-code|codex|opencode|grok");
		const folder = fullPath(required(values.folder as string | undefined, "--folder DIR"));
		const reads = values.reads === undefined ? undefined : parseReads(values.reads as string, known(), agent);
		editConfigOnce(file, (text, dir) => addAgent(text, dir, { name: agent, folder, tool: tool as never, compactorModel: summary, compactorThinking: thinking as never, ...(reads === undefined ? {} : { reads }) }));
		process.stdout.write(`Added agent ${agent}: ${folder}, ${(TOOL_LABELS as Record<string, string>)[tool] ?? tool}, summaries ${summary} (${thinking}).\n`);
		return 0;
	}
	if (action === "set") {
		// The name as the config spells it (`orrery agent set rowan` finds Rowan), as every other command does.
		const agent = configAbsent(file) ? required(name, "agent name") : findAgent(configOf(file), required(name, "agent name")).name;
		const changes: [Parameters<typeof setAgentKey>[3], Parameters<typeof setAgentKey>[4]][] = [];
		if (args.length > 2) {
			const key = args[2];
			if (args.length !== 4 || (key !== "launcher" && key !== "ori_model")) throw new Error("Use agent set <Name> launcher direct|ori or ori_model <id> (empty value clears).");
			changes.push([key, args[3]]);
		}
		if (values.launcher !== undefined) changes.push(["launcher", values.launcher as string]);
		if (values["ori-model"] !== undefined) changes.push(["ori_model", values["ori-model"] as string]);
		if (values.tool !== undefined) changes.push(["tool", values.tool as string]);
		if (values.folder !== undefined) changes.push(["folder", fullPath(values.folder as string)]);
		if (values["view-kb"] !== undefined) changes.push(["view_bytes", kb("view-kb")]);
		if (values["summary-kb"] !== undefined) changes.push(["compactor_context_bytes", kb("summary-kb")]);
		if (values.jobs !== undefined) changes.push(["compactor_jobs", Number(values.jobs)]);
		if (values["compact-at"] !== undefined) changes.push(["compact_at", Number(values["compact-at"])]);
		if (values.reads !== undefined) changes.push(["reads", parseReads(values.reads as string, known(), agent)]);
		if (changes.length === 0) throw new UsageError("agent set needs one of --launcher, --ori-model, --tool, --folder, --view-kb, --summary-kb, --jobs, --compact-at, --reads.");
		editConfigOnce(file, (text, dir) => changes.reduce((acc, [key, value]) => setAgentKey(acc, dir, agent, key, value), text));
		for (const [key, value] of changes) process.stdout.write(`Set agents.${agent}.${key} = ${typeof value === "string" || typeof value === "number" ? value : value.length === 0 ? "none" : value.includes("*") ? "all" : value.join(", ")}. It applies when ${agent} next opens.\n`);
		return 0;
	}
	if (action === "archive") {
		// The same refusals as the TUI's A: the agent must be closed and the config writable.
		const config = configOf(file);
		const agent = findAgent(config, required(name, "agent name")).name;
		const row = agentOverview(config).find((r) => r.name === agent);
		const refusal = row === undefined ? undefined : archiveRefusal(row);
		if (refusal !== undefined) throw new Error(refusal);
		if (!configWritable(path)) throw new Error(readOnlyConfigText(path));
		const { localIso } = await import("../memory/index.ts");
		editConfigOnce(file, (text, dir) => archiveAgent(text, dir, agent, localIso(new Date()).slice(0, 10)));
		process.stdout.write(`Archived ${agent}.\n`);
		return 0;
	}
	throw new UsageError("agent needs add, set, archive, push, pull, takeover or local.");
}

/** The command line's options; parseArgs reads them, and main's command finder skips a string option's value. */
const OPTIONS = {
	config: { type: "string" },
	"api-key": { type: "boolean" },
	key: { type: "string" },
	"from-pi": { type: "boolean" },
	days: { type: "string" },
	keep: { type: "string" },
	from: { type: "string" },
	to: { type: "string" },
	"delete-remote": { type: "boolean" },
	"dry-run": { type: "boolean" },
	commit: { type: "string" },
	claude: { type: "string" },
	"claude-file": { type: "string", multiple: true },
	codex: { type: "string" },
	"codex-file": { type: "string", multiple: true },
	notes: { type: "string", multiple: true },
	"paste-threshold": { type: "string" },
	"no-split": { type: "boolean" },
	out: { type: "string" },
	progress: { type: "string" },
	session: { type: "string" },
	cwd: { type: "string" },
	"wait-ms": { type: "string" },
	"spool-only": { type: "boolean" },
	agent: { type: "string" },
	"agent-token": { type: "string" },
	"claude-pid": { type: "string" },
	"host-pid": { type: "string" },
	nonce: { type: "string" },
	since: { type: "string" },
	open: { type: "boolean" },
	mod: { type: "boolean" },
	manual: { type: "boolean" },
	"no-browser": { type: "boolean" },
	prefix: { type: "string" },
	folder: { type: "string" },
	tool: { type: "string" },
	launcher: { type: "string" },
	"ori-model": { type: "string" },
	summary: { type: "string" },
	thinking: { type: "string" },
	"view-kb": { type: "string" },
	"summary-kb": { type: "string" },
	jobs: { type: "string" },
	"compact-at": { type: "string" },
	reads: { type: "string" },
	server: { type: "string" },
	cloudflare: { type: "string" },
	"token-file": { type: "string" },
	"code-file": { type: "string" },
	new: { type: "boolean" },
	json: { type: "boolean" },
	yes: { type: "boolean" },
	rollback: { type: "boolean" },
	list: { type: "boolean" },
	purge: { type: "boolean" },
	check: { type: "boolean" },
	help: { type: "boolean", short: "h" },
	version: { type: "boolean", short: "v" },
} as const;

/** "--config", "--tool", …: the options whose next token is their value, not the command. */
const VALUED = new Set(Object.entries(OPTIONS).flatMap(([name, option]) => (option.type === "string" ? [`--${name}`] : [])));

/**
 * A release binary registers the OAuth flows compiled into it (the ChatGPT sign-in among them): pi-ai otherwise imports
 * them by a file path that exists only in node_modules. OMP's entry registers the flows packed into extensions/omp.js
 * (src/omp/index.ts); pi brings its own.
 */
async function registerReleaseOAuthFlows(): Promise<void> {
	const { compiled } = await import("../agent/running.ts");
	if (compiled) (await import("@earendil-works/pi-ai/bun-oauth")).registerBunOAuthFlows();
}

async function main(rawArgv: string[]): Promise<number> {
	// --version is the version flag everywhere but `update`, where it names a release: take its value out first.
	// The command is the first token that is neither an option nor a string option's value (--config X, --tool T, …).
	let updateVersion: string | undefined;
	let argv = rawArgv;
	let first: string | undefined;
	for (let i = 0; i < rawArgv.length; i++) {
		const a = rawArgv[i] as string;
		if (VALUED.has(a)) i++;
		else if (!a.startsWith("-")) {
			first = a;
			break;
		}
	}
	// `orrery agent <Name> … -- <tool arguments>`: everything after `--` goes to the tool untouched.
	let toolArgs: string[] = [];
	if (first === "agent") {
		const dash = argv.indexOf("--");
		if (dash !== -1) {
			toolArgs = argv.slice(dash + 1);
			argv = argv.slice(0, dash);
		}
	}
	if (first === "update") {
		argv = [];
		let seen = false;
		for (let i = 0; i < rawArgv.length; i++) {
			const a = rawArgv[i] as string;
			if (a === "-v") throw new Error("use --version <release> with update.");
			if (!seen && a === "update") {
				seen = true;
				argv.push(a);
			} else if (a === "--version") {
				updateVersion = rawArgv[++i];
				if (updateVersion === undefined) throw new Error("--version takes a release such as 0.6.1");
			} else if (a.startsWith("--version=")) updateVersion = a.slice("--version=".length);
			else argv.push(a);
		}
	}
	const { positionals, values } = parseCommandLine(argv);
	const [command, arg] = positionals;
	// Help runs nothing else: `orrery help [<command>|all]`, or --help with any command.
	if (values.help === true || command === "help") return helpCommand(command === "help" ? arg : command);
	if (values.version === true || command === "version") {
		const { versionLine } = await import("../agent/running.ts");
		process.stdout.write(versionLine());
		return 0;
	}
	if (command !== undefined && !isCommand(command)) return unknownCommand(command);
	try {
		return await dispatch(positionals, values, updateVersion, toolArgs);
	} catch (error) {
		// A command used the wrong way: its own help follows the message.
		const help = error instanceof UsageError ? commandHelp(command) : undefined;
		if (help !== undefined) throw new Error(`${(error as Error).message}\n\n${help.trimEnd()}`);
		throw error;
	}
}

/** The command line as parseArgs reads it. */
const parseCommandLine = (args: string[]) => parseArgs({ args, allowPositionals: true, options: OPTIONS });

/** The version the help pages name; none when this copy cannot tell (a binary copied out of its release). */
async function helpVersion(): Promise<string | undefined> {
	const { versionNumber } = await import("../agent/running.ts");
	try {
		return versionNumber();
	} catch {
		return undefined;
	}
}

/** `orrery help`, `orrery help all`, `orrery help <command>`; an unknown command gets the short page, on stderr. */
async function helpCommand(topic: string | undefined): Promise<number> {
	if (topic === undefined || topic === "help") process.stdout.write(shortHelp(await helpVersion()));
	else if (topic === "all") process.stdout.write(allHelp(await helpVersion()));
	else {
		const page = commandHelp(topic);
		if (page === undefined) return unknownCommand(topic);
		process.stdout.write(page);
	}
	return 0;
}

async function unknownCommand(command: string): Promise<number> {
	process.stderr.write(`Unknown command ${command}.\n\n${shortHelp(await helpVersion())}`);
	return 2;
}

/**
 * The file the gate read the config from, as it read it (src/cli/gate.ts Gated.configFile): what a command that reads or
 * writes the config by path runs with, never read again. The gate gives it to every command that runs outside every
 * session; inside one, none of those runs.
 */
function judgedFile(gated: Gated): ConfigFile {
	if (gated.configFile === undefined) throw gated.configError ?? new Error("orrery could not read its config.");
	return gated.configFile;
}

/** Runs the command: everything but help and the version. */
async function dispatch(positionals: string[], values: ReturnType<typeof parseCommandLine>["values"], updateVersion: string | undefined, toolArgs: string[]): Promise<number> {
	const [command, arg] = positionals;
	// Claude Code's, Codex's and Grok's hooks run several times a turn and never sign in or call a model; their own
	// per-process decision governs them, so they skip the gate's look at the process tree.
	if (command === "claude-hook") return claudeHook(arg, values.config);
	if (command === "codex-hook") return codexHook(arg, values.config);
	if (command === "grok-hook") return grokHook(arg, values.config);
	// Grok's status row runs several times a second during a turn, and decides and writes nothing: as a hook event, the
	// claim its Grok already holds names its agent.
	if (command === "grok-status") return grokStatusCommand(values.config);
	// The Claude Code plugin's memory server, started by Grok (its Claude Code compatibility): it serves nothing, and
	// decides nothing for Grok's process, so Orrery's own server for Grok (--tool grok) is the only one there.
	if (command === "mcp" && (values.tool === undefined || values.tool === "claude-code") && (await import("../grok/host.ts")).hostIsGrok()) {
		const { runMcp } = await import("../claude/mcp.ts");
		await runMcp(process.stdin, process.stdout, []);
		return 0;
	}
	// Orrery's own server for Grok, started by Grok's shared leader (leader mode), which starts every session's with its
	// first client's environment: one session's agent can't be told from another's, so it serves nothing and decides
	// nothing (src/grok/host.ts grokHostRefusal). Nor does one a shell with no parent of its own started: no Grok did
	// (grokPid). Its client logs stderr.
	if (command === "mcp" && values.tool === "grok") {
		const { grokHostNotice, grokHostRefusal, grokPid, NO_GROK } = await import("../grok/host.ts");
		const pid = grokPid();
		const refused = pid === undefined ? NO_GROK : grokHostRefusal(pid);
		if (refused !== undefined) {
			process.stderr.write(`${grokHostNotice(refused)}\n`);
			const { runMcp } = await import("../claude/mcp.ts");
			await runMcp(process.stdin, process.stdout, []);
			return 0;
		}
	}
	const { GateRefusal, gateCommand, noAgentText, readableBy } = await import("./gate.ts");
	let gated: Gated;
	try {
		gated = gateCommand(command, positionals, values, process.env);
	} catch (error) {
		// The mod reads one JSON line, never stderr (claudeModCommand).
		if (command === "claude-mod" && error instanceof GateRefusal) return modReply({ error: modError(error) });
		throw error;
	}
	const inside = gated.inside;
	// A coding tool's session that is no agent's: status and usage show no agent, and say why; nothing else is read.
	if (gated.tool !== undefined) {
		process.stdout.write(noAgentText(command === "usage" ? "usage" : "status", gated.tool, values.json === true));
		return 0;
	}
	await registerReleaseOAuthFlows();
	const judged = () => judgedFile(gated);
	if (command === undefined && process.stdin.isTTY === true && process.stdout.isTTY === true) {
		const { runTui } = await import("../tui/run.ts");
		const file = judged();
		// The TUI reads its config again every 2 s: each read after a change is the gate's, judged again, for that file.
		const judge = () => judgedFile(gateCommand(undefined, [], { ...values, config: file.path }, process.env));
		return runTui(values.config, { config: { file, judge } });
	}
	if (command === undefined) {
		process.stdout.write(shortHelp(await helpVersion()));
		return 0;
	}
	if (command === "claude-mod") return claudeModCommand(arg, values, gated);
	if (command === "mcp") return mcpServer(values.config, values.tool, gated);
	if (command === "remote") {
		const { remoteCommand } = await import("./remote.ts");
		process.stdout.write(await remoteCommand(judged(), positionals.slice(1), { json: values.json === true, yes: values.yes === true, server: values.server, cloudflare: values.cloudflare, "token-file": values["token-file"], "code-file": values["code-file"], new: values.new === true }));
		return 0;
	}
	if (command === "tools") return toolsCommand(positionals, values);
	if (command === "install") return installCommand(values, judged());
	if (command === "setup") return setupCommand(values, judged());
	if (command === "update") return updateCommand({ check: values.check, version: updateVersion, yes: values.yes });
	if (command === "uninstall") return uninstallCommand(values);
	if (command === "agent") {
		// The config and remote subcommands. No agent may take one of their names (RESERVED_NAMES, src/agent/config.ts).
		const sub = positionals[1];
		if (sub !== undefined && ["add", "set", "archive", "push", "pull", "takeover", "local"].includes(sub)) return agentCommand(positionals.slice(1), values, judged());
		const [{ editAgentCommand, openAgentCommand }, { agentRemoteCommand }] = await Promise.all([import("./agent.ts"), import("./remote.ts")]);
		// A question only a person answers (starting Codex without Orrery's memory and guard) needs a terminal; --yes is no answer to it.
		const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
		const io = {
			say,
			confirm: (question: string) => (values.yes === true ? Promise.resolve(true) : askYes(question)),
			...(terminal ? { askPerson: (question: string) => askYes(question, "y/N"), askSettings: (question: string, defaultYes: boolean) => askWithDefault(question, defaultYes) } : {}),
		};
		if (positionals[1] === "edit") {
			if (positionals.length > 3) throw new Error(`orrery agent edit takes one agent name (got ${positionals.slice(2).join(" ")}).`);
			return editAgentCommand(judged(), required(positionals[2], "agent name"), io);
		}
		if (positionals.length > 2) {
			const name = positionals[1] as string;
			throw new Error(`orrery agent takes one agent name; ${positionals.slice(2).join(" ")} would be dropped. The tool's arguments go after --: orrery agent ${name} -- ${positionals.slice(2).join(" ")}`);
		}
		const file = judged();
		return openAgentCommand(values.config, required(positionals[1], "agent name"), { tool: values.tool, args: toolArgs, cwd: process.cwd() }, io, {
			takeover: (name) => agentRemoteCommand(file, ["takeover", name], { yes: true }),
			config: file,
		});
	}
	// The config the gate read and judged (src/cli/gate.ts Gated.config), never read again: a file may change between.
	if (gated.config === undefined) throw gated.configError ?? new Error("orrery could not read its config.");
	const config = gated.config;
	// Inside an agent's session status and usage list only what that agent may read.
	const readable = inside?.agent === undefined ? {} : { readable: readableBy(config, inside.agent) };
	switch (command) {
		case "status": {
			const { statusCommand } = await import("./commands.ts");
			process.stdout.write(statusCommand(config, arg === undefined ? undefined : await agentArg(config, arg, inside), { json: values.json === true, ...readable }));
			return 0;
		}
		case "usage": {
			const { usageCommand } = await import("./commands.ts");
			const days = Number(values.days ?? "7");
			if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a whole number of days, at least 1");
			process.stdout.write(usageCommand(config, arg === undefined ? undefined : await agentArg(config, arg, inside), days, { json: values.json === true, ...readable }));
			return 0;
		}
		case "login": {
			const [{ loginCommand }, { configureHttp }] = await Promise.all([import("./logins.ts"), import("../agent/http.ts")]);
			configureHttp();
			const key = values.key ?? (values["api-key"] ? required(arg, "provider") : undefined);
			const request = key !== undefined ? { key, fromPi: values["from-pi"] ?? false } : { signin: required(arg, "provider"), manual: values.manual === true || values["no-browser"] === true };
			process.stdout.write(await loginCommand(config, request));
			return 0;
		}
		case "logins": {
			const { loginsCommand } = await import("./logins.ts");
			process.stdout.write(await loginsCommand(config, { json: values.json === true }));
			return 0;
		}
		case "logout": {
			const { logoutCommand } = await import("./logins.ts");
			process.stdout.write(await logoutCommand(config, values.key !== undefined ? { key: values.key } : { signin: required(arg, "provider") }));
			return 0;
		}
		case "trust-host": {
			const { trustHostCommand } = await import("./commands.ts");
			await trustHostCommand(config, required(arg, "host"));
			return 0;
		}
		case "grok-settings": {
			// Grok's settings for the folder it runs in, against the record in the config's data folder; only a person at a
			// terminal is asked (--yes approves without asking).
			const { grokSettingsCommand } = await import("./grok-settings.ts");
			const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
			return grokSettingsCommand(config.dataDir, { yes: values.yes === true, cwd: process.cwd(), env: process.env }, { say, ...(terminal ? { ask: (question: string, defaultYes: boolean) => askWithDefault(question, defaultYes) } : {}) });
		}
		case "compact": {
			const [{ compactCommand }, { configureHttp }] = await Promise.all([import("./commands.ts"), import("../agent/http.ts")]);
			configureHttp();
			await compactCommand(config, required(arg, "agent"), undefined, values.progress === undefined ? {} : { progress: values.progress });
			return 0;
		}
		case "import": {
			const [{ importCommitCommand, importDryRunCommand }, { configureHttp }] = await Promise.all([import("./commands.ts"), import("../agent/http.ts")]);
			const agent = required(arg, "agent");
			if (values.commit !== undefined) {
				process.stdout.write(importCommitCommand(config, agent, values.commit));
				return 0;
			}
			if (values["dry-run"] !== true) throw new UsageError("import needs --dry-run or --commit FILE.");
			const threshold = Number(values["paste-threshold"] ?? "1200");
			if (!Number.isInteger(threshold) || threshold < 0) throw new Error("--paste-threshold must be a whole number of bytes");
			configureHttp();
			process.stdout.write(
				await importDryRunCommand(config, agent, {
					claude: values.claude,
					claudeFiles: values["claude-file"] ?? [],
					codex: values.codex,
					codexFiles: values["codex-file"] ?? [],
					notes: values.notes ?? [],
					pasteThreshold: threshold,
					split: values["no-split"] !== true,
					out: values.out,
				}),
			);
			return 0;
		}
		case "backup": {
			const { backupAgents } = await import("../agent/backup.ts");
			const keep = Number(values.keep ?? "14");
			if (!Number.isInteger(keep) || keep < 1) throw new Error("--keep must be a whole number of days, at least 1");
			const report = backupAgents(config, { keep });
			for (const agent of report.agents) {
				const what = agent.files.includes("memory.sqlite") ? `${agent.messages} messages, ${agent.nodes} summaries` : "instructions only (no memory yet)";
				process.stdout.write(`${agent.name}: ${what} -> ${report.dir}/${agent.name}\n`);
			}
			if (report.agents.length === 0) process.stdout.write(`No agent has memory or instructions yet; wrote ${report.dir}\n`);
			if (report.pruned.length > 0) process.stdout.write(`Removed old backups: ${report.pruned.join(", ")}\n`);
			// A warning leaves the backup good (exit 0): the nightly script still copies it.
			for (const warning of report.warnings) process.stderr.write(`Warning: ${warning}\n`);
			return 0;
		}
		case "restore": {
			const { restoreAgent } = await import("../agent/backup.ts");
			const agent = required(arg, "agent");
			if (values.from === undefined) throw new UsageError("restore needs --from DATE (YYYY-MM-DD) or --from DIR.");
			const report = restoreAgent(config, agent, { from: values.from });
			if (report.memory) process.stdout.write(`Restored ${report.agent} from ${report.from}: ${report.messages} messages, ${report.nodes} summaries (${report.files.join(", ")})\n`);
			else process.stdout.write(`The backup at ${report.from} holds instructions only; ${report.agent}'s memory is left as it is\n`);
			if (report.instructions === "restored") process.stdout.write(`${report.agent} had no instructions; put back the backup's instructions.md\n`);
			if (report.instructions === "kept") {
				process.stdout.write(`Kept ${report.agent}'s own instructions.md; the backup's copy is ${join(report.from, "instructions.md")}\n`);
			}
			if (report.instructions === "none in effect") {
				process.stdout.write(`Left ${report.agent}'s instructions.md as it is (not a regular file; none in effect); the backup's copy is ${join(report.from, "instructions.md")}\n`);
			}
			// The memory's restore stands (exit 0); what went wrong with instructions.md is said, naming the file.
			for (const warning of report.warnings) process.stderr.write(`Warning: ${warning}\n`);
			return 0;
		}
		case "browse": {
			const { browseCommand } = await import("./commands.ts");
			const agent = findAgent(config, await agentArg(config, required(arg, "agent"), inside));
			// --open writes where pi's /browse does (the agent's data folder), not into the folder Claude Code runs in.
			const path = browseCommand(config, agent.name, values.out ?? (values.open === true ? join(agent.dir, "memory.html") : undefined));
			if (values.open !== true) {
				process.stdout.write(`Wrote ${path}\n`);
				return 0;
			}
			const { pageOpener } = await import("../agent/agent-commands.ts");
			// ORRERY_NO_OPEN=1 (tests) never opens a page, even with a display.
			const opener = process.env.ORRERY_NO_OPEN === "1" ? undefined : pageOpener();
			opener?.open(path);
			process.stdout.write(`Wrote ${path}${opener === undefined ? " (no display here: open it yourself)" : ` and opened it with ${opener.command}`}\n`);
			return 0;
		}
		case "compactor": {
			const [{ compactorCliCommand }, { configureHttp }] = await Promise.all([import("./commands.ts"), import("../agent/http.ts")]);
			configureHttp(); // a switch makes a test call to the model
			// Inside an agent's session it starts no sign-in: it chooses among the user's existing logins, keys and endpoints.
			const options = { ...(values.prefix === undefined ? {} : { prefix: values.prefix }), ...(inside === undefined ? {} : { interactive: false }) };
			process.stdout.write(await compactorCliCommand(config, await agentArg(config, required(arg, "agent"), inside), positionals.slice(2), options));
			return 0;
		}
		case "run": {
			const [{ BACKGROUND_CONTEXT }, { configureHttp }, { Agent }, { runHarness }, { SignalStop, stopOnSignals }] = await Promise.all([
				import("@earendil-works/chord/context"),
				import("../agent/http.ts"),
				import("../agent/agent.ts"),
				import("./run.ts"),
				import("./signals.ts"),
			]);
			configureHttp();
			const fatal = new AbortController();
			const agent = await Agent.open({
				config,
				agent: required(arg, "agent"),
				onFatal: (reason) => {
					process.stderr.write(`\nFATAL: ${reason}\n`);
					fatal.abort();
				},
			});
			// systemctl stop (SIGTERM) and tmux kill-server (SIGHUP) close the agent like a fatal stop, but exit 0.
			const releaseSignals = stopOnSignals(fatal);
			let code: number;
			try {
				code = await runHarness(
					agent,
					{ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true, stop: fatal.signal },
					BACKGROUND_CONTEXT,
				);
			} finally {
				// Closed even when the terminal failed: its lock, its status and its session record go with it.
				try {
					await agent.close();
				} finally {
					releaseSignals();
				}
			}
			return fatal.signal.reason instanceof SignalStop ? 0 : code;
		}
		case "holder": {
			// The host's process: --claude-pid, Claude Code's (as always); or --host-pid, with --tool codex for Codex's, or
			// --tool grok for Grok's.
			if (values["claude-pid"] !== undefined && values["host-pid"] !== undefined) throw new UsageError("holder takes --claude-pid or --host-pid, not both.");
			const host = values.tool ?? "claude-code";
			if (host !== "claude-code" && host !== "codex" && host !== "grok") throw new UsageError(`holder: --tool takes claude-code, codex or grok (not ${host}).`);
			if (host !== "claude-code" && values["host-pid"] === undefined) throw new UsageError(`holder --tool ${host} needs --host-pid PID.`);
			const hostPid = Number(values["host-pid"] ?? values["claude-pid"]);
			if (!Number.isInteger(hostPid) || hostPid < 1) throw new UsageError("holder needs --claude-pid PID (or --host-pid PID).");
			const since = values.since === undefined ? undefined : Number(values.since);
			if (since !== undefined && !(Number.isInteger(since) && since >= 0)) throw new UsageError("holder: --since must be a time in ms since the epoch.");
			const { runHolder } = await import("../claude/holder.ts");
			return runHolder(config, required(arg, "agent"), {
				session: required(values.session, "--session"),
				claudePid: hostPid,
				nonce: values.nonce ?? "",
				...(since === undefined ? {} : { since }),
				...(host === "claude-code" ? {} : { host }),
			});
		}
		case "claude-setup": {
			const setup = await import("../claude/setup.ts");
			const agent = findAgent(config, await agentArg(config, required(arg, "agent"), inside));
			process.stdout.write(values.mod === true ? setup.modSetupReport(setup.claudeSetupMod(agent)) : setup.setupReport(setup.claudeSetup(agent)));
			return 0;
		}
		default:
			return unknownCommand(command);
	}
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The orrery config for a process Claude Code starts (a hook), or none, and whether a config is there (or named) but
 * could not be read: `broken`. Without any config (none named, and no file at the default paths) it says nothing: the
 * plugin is installed for every folder, and Claude Code then runs plain. A config that is named but missing, or broken,
 * gets one stderr line, `label` first.
 */
function foundConfig(configPath: string | undefined, label: string): { readonly config?: HarnessConfig; readonly broken: boolean } {
	try {
		return { config: loadConfig(configPath), broken: false };
	} catch (error) {
		const absent = absentConfig(error, configPath);
		if (!absent) process.stderr.write(`${label}: ${errorText(error)}\n`);
		return { broken: !absent };
	}
}

/** Whether `error`, from loading the config, says only that there is none: none named, and none at the default paths. */
const absentConfig = (error: unknown, configPath: string | undefined): boolean => (error as { code?: unknown }).code === "ENOENT" && configPath === undefined && !process.env.ORRERY_CONFIG;

/**
 * The config for a plugin command the gate let run (mcp): the one it read and judged (src/cli/gate.ts Gated.config),
 * never read again. Its error, when it couldn't, is said as foundConfig says it.
 */
function gatedConfig(gated: Gated, configPath: string | undefined, label: string): HarnessConfig | undefined {
	if (gated.config !== undefined || gated.configError === undefined) return gated.config;
	if (!absentConfig(gated.configError, configPath)) process.stderr.write(`${label}: ${errorText(gated.configError)}\n`);
	return undefined;
}

/** PreToolUse's answer that refuses the call, made here so it needs nothing that may have failed to load. */
const denyToolCall = (reason: string) =>
	JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Orrery guard: ${reason}` } });

/**
 * Claude Code's MCP server, for the session's agent (src/claude/pick.ts: ORRERY_AGENT's, else the project folder's).
 * Outside an agent, under a refused ORRERY_AGENT, or without an orrery config, it serves no tools rather than failing.
 * Claude Code starts it with the session, before SessionStart runs, so it may make the process's decision; a restarted
 * server reads the one recorded. The process is its parent, the Claude Code that started it (orrery-run execs), never
 * CLAUDE_PID, which a claude started from an agent's Bash inherits from the agent.
 * With --tool codex it is Codex's (src/codex/launch.ts): the agent ORRERY_AGENT names, with its token, and nothing else
 * (src/codex/pick.ts), claimed for the Codex that started it, at its start, before any SessionStart. With --tool grok it
 * is Grok's, the same way (grokAgent): Grok's config names it for every session (src/grok/install.ts), and gives it the
 * launch's ORRERY_AGENT and token, so a plain grok's gets none and serves no tools. Both are taken as the grok process
 * was started with them (src/codex/pick.ts launchedEnv): a server whose own environment names another agent or token,
 * or whose Grok's start environment can't be read, serves no tools and decides nothing. Under Grok the Claude Code
 * plugin's own server serves nothing (dispatch), so the model sees one set of tools.
 * Inside an agent's session (`inside`, src/cli/gate.ts) it serves that agent or nothing, with the config that holds the
 * session's memory (`trusted`); and when its parent is that session's recorded host (a restarted server, or the agent's
 * shell exec'ing `orrery mcp`), it only reads the decision the host made, so no folder or variable given to it can
 * change whose session the host is. A Claude Code that one of its SessionStarts found unconfirmed (src/claude/hooks.ts:
 * its start couldn't be read) gets no tools, as its view gets none (markedUnconfirmed, src/claude/pick.ts); one that
 * started after that mark reuses a gone Claude Code's pid, and gets them.
 * In a coding tool's session that is no agent's (`gated.hostAgent`) it serves only the agent its host's own launch names;
 * with none it picks nothing, so it decides nothing for its parent either.
 */
async function mcpServer(configPath: string | undefined, tool: string | undefined, gated: Gated): Promise<number> {
	if (tool !== undefined && tool !== "claude-code" && tool !== "codex" && tool !== "grok") throw new UsageError(`mcp: --tool takes claude-code, codex or grok (not ${tool}).`);
	const { agentTools, runMcp } = await import("../claude/mcp.ts");
	let tools: ReaderTool[] = [];
	const { inside, hostAgent } = gated;
	// Why it serves no agent, where the gate found a reason: its client logs stderr, and stdout stays the protocol.
	if (gated.notice !== undefined) process.stderr.write(`${gated.notice}\n`);
	const config = hostAgent === null ? undefined : gatedConfig(gated, configPath, "orrery mcp");
	const ours = (agent: AgentConfig) => (inside === undefined || agent.name === inside.agent) && (hostAgent === undefined || agent.name === hostAgent);
	if (config !== undefined && (tool === "codex" || tool === "grok")) {
		const [{ codexAgent, grokAgent, LAUNCH_VARIABLES, launchedEnv, startEnvOf }, { codexPid }, { grokPid }, { AGENT_ENV }] = await Promise.all([
			import("../codex/pick.ts"),
			import("../codex/host.ts"),
			import("../grok/host.ts"),
			import("../agent/pick.ts"),
		]);
		// Codex and Grok start their servers themselves (seen live for Grok: each session's own grok process, with its
		// launch's environment): the host is this server's parent, unless it passed over one by its name.
		const asking = { parent: process.ppid, takeover: true };
		if (tool === "codex") {
			// A shell with no parent of its own was started by no Codex: no tools.
			const pid = codexPid();
			const pick = pid === undefined ? undefined : codexAgent(config, { ...asking, env: process.env, pid });
			if (pick?.kind === "agent" && ours(pick.agent)) tools = agentTools(config, pick.agent);
		} else {
			// Grok's: whose it is comes from the grok process's own start environment, as its hooks take it
			// (src/grok/hooks.ts); a server whose own names another agent or token is refused. A plain grok (no ORRERY_AGENT
			// there: Grok's config gives every session's server the launch's, maybe none) decides nothing for its process, as
			// its hooks don't, and serves no tools. A shell with no parent of its own was started by no Grok: no tools (dispatch
			// refused it before the gate already).
			const pid = grokPid();
			const launched = pid === undefined ? undefined : launchedEnv("grok", process.env, startEnvOf(pid, LAUNCH_VARIABLES));
			if (launched !== undefined && "refused" in launched) process.stderr.write(`orrery: mcp serves no agent here: ${launched.refused}.\n`);
			else if (pid !== undefined && launched !== undefined && (launched.env[AGENT_ENV]?.trim() ?? "") !== "") {
				const pick = grokAgent(config, { ...asking, env: launched.env, pid });
				if (pick.kind === "agent" && ours(pick.agent)) tools = agentTools(config, pick.agent);
			}
		}
	} else if (config !== undefined) {
		const [{ claudeSession, markedUnconfirmed }, { liveSession }] = await Promise.all([import("../claude/pick.ts"), import("../agent/sessions.ts")]);
		const decided = inside !== undefined && liveSession(config.dataDir, process.ppid) !== undefined;
		const pick = claudeSession(config, { env: process.env, cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(), pid: process.ppid, decide: !decided });
		// A Claude Code a SessionStart found unconfirmed (src/claude/hooks.ts) gets no tools, even once its start can be read.
		if (pick.kind === "agent" && ours(pick.agent) && !markedUnconfirmed(pick.agent, process.ppid)) tools = agentTools(config, pick.agent);
	}
	await runMcp(process.stdin, process.stdout, tools);
	return 0;
}

/**
 * Reads stdin to its end, so the writer's write completes, and keeps at most `max` bytes of it: undefined when it held
 * more.
 */
async function readStdin(max: number): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
		bytes += chunk.length;
		if (bytes <= max) chunks.push(chunk);
	}
	return bytes > max ? undefined : Buffer.concat(chunks).toString("utf8");
}

/**
 * Whether Grok runs Orrery's own guard for this install (src/grok/install.ts grokHooksInstalled: its hook file, running
 * app/current's command, else this checkout's), and it is not switched off in Grok's /hooks tab (grokGuardSwitchedOff).
 * False when either can't be read.
 */
async function grokGuarded(): Promise<boolean> {
	try {
		const [{ grokGuardSwitchedOff, grokHooksInstalled }, { wiringRoot }] = await Promise.all([import("../grok/install.ts"), import("../agent/running.ts")]);
		return grokHooksInstalled(wiringRoot(process.env).root, process.env) === true && !grokGuardSwitchedOff(process.env);
	} catch {
		return false;
	}
}

/**
 * `orrery claude-hook <event>`: Claude Code's hooks never fail a session. They exit 0, print only their JSON answer,
 * and note any error in one stderr line, never with message contents. PreToolUse never lets a call through on a failure
 * of its own (Claude Code allows a call the hook says nothing about): a config that is there, or named, but cannot be
 * read denies every call until it is fixed, and so does an error. Without any config Claude Code runs plain.
 * Grok runs these hooks too (its Claude Code compatibility): when the hook's own host is a Grok (src/grok/host.ts
 * hostIsGrok), each recording one reads its input, prints nothing and records nothing, so Orrery's Grok hooks are the
 * only ones recording there. Its guard stands down there only when Grok runs Orrery's own guard for this install, not
 * switched off in Grok's /hooks tab (grokGuarded); else, or when that can't be read, it guards as in Claude Code. A Claude
 * Code started from a Grok shell is its hooks' host, and keeps them.
 */
async function claudeHook(event: string | undefined, configPath: string | undefined): Promise<number> {
	const guarding = event === "pre-tool-use";
	try {
		if ((await import("../grok/host.ts")).hostIsGrok() && (!guarding || (await grokGuarded()))) {
			await readStdin(0); // read to its end all the same, so Grok's write completes
			return 0;
		}
		const { config, broken } = foundConfig(configPath, "Orrery");
		if (config === undefined) {
			await readStdin(0); // read to its end all the same, so Claude Code's write completes
			if (guarding && broken) process.stdout.write(denyToolCall("Orrery's config could not be read, so no call can be checked; nothing was run. Fix the config file."));
			return 0;
		}
		const [hooks, { claudeHookPid }, { stdinPeer }] = await Promise.all([import("../claude/hooks.ts"), import("../claude/pick.ts"), import("../claude/peer.ts")]);
		// Who called a writing hook (src/claude/peer.ts): asked first, before stdin is read and before anything is written to
		// stdout. Claude Code closes its end of stdin before the hook runs, and macOS then names no one there, so on macOS
		// stdout is asked instead: Claude Code holds it until it has the answer, so it must not be written or closed before
		// this. PreToolUse never asks.
		const peer = guarding ? "unsupported" : stdinPeer();
		// A PreToolUse input over 1 MB is read but not kept (hookInputMax): the guard refuses it unread.
		const stdin = await readStdin(hooks.hookInputMax(event ?? ""));
		// CLAUDE_PID, checked against this hook's parent; one that names another process is no session's (fail closed).
		const host = claudeHookPid(config, process.env);
		const claudePid = host ?? process.ppid;
		const startHolder = (agent: AgentConfig, session: string, nonce: string, since: number) => hooks.spawnHolder(agent, session, nonce, claudePid, since, configPath);
		// The file the config came from, as loadConfig found it: the guard keeps it read-only, wherever it is.
		const configFile = resolvePath(configPath ?? defaultConfigPath());
		const answer = await hooks.runHook(event ?? "", stdin, { config, env: process.env, claudePid, ...(host === undefined ? { hostUnverified: true } : {}), peer: () => peer, startHolder, configFile, updateNotices: true });
		process.stdout.write(answer);
	} catch (error) {
		process.stderr.write(`Orrery: ${event ?? "claude-hook"}: ${errorText(error)}\n`);
		if (guarding) process.stdout.write(denyToolCall(`this call could not be checked (${errorText(error)}); nothing was run.`));
	}
	return 0;
}

/**
 * A Codex or Grok PreToolUse refusal: the reason on stderr and exit code 2. Codex runs a hook through the account's shell
 * (`<shell> -c`: bash, zsh or sh, src/codex/shell.ts), whose startup files (bash's $BASH_ENV, zsh's .zshenv) may print to
 * stdout: a JSON answer there would arrive garbled and the call would go through. With exit 2 Codex reads only stderr,
 * so the refusal holds whatever is on stdout. The reason has no final period: Codex adds one. Grok 1.0.70 blocks on exit
 * 2 whatever stdout holds, and takes the first line of stderr as the reason.
 */
function denyCodexCall(reason: string): number {
	process.stderr.write(reason);
	return 2;
}

/**
 * `orrery codex-hook pre-tool-use`, the guard (src/codex/guard.ts): a call it lets through gets exit 0 and nothing on
 * stdout, which Codex reads as no objection; a refusal is denyCodexCall's. Codex lets a call through when its hook
 * fails, so everything that keeps the guard from judging refuses: input over 1 MB (read to its end, not kept), a config
 * that cannot be read, any error, and a judgment not done by CODEX_GUARD_DEADLINE_MS after the process started; past
 * that, a crash or a stall is refused by src/codex/guard-exit.ts.
 */
async function codexGuardHook(configPath: string | undefined): Promise<number> {
	try {
		const guard = await import("../codex/guard.ts");
		const stdin = await readStdin(guard.CODEX_TOOL_INPUT_MAX);
		let config: HarnessConfig;
		try {
			// A synchronous read the watchdog (src/codex/guard-exit.ts) can't interrupt; its path is fixed by the launch (ORRERY_CONFIG, else the default), not chosen by the agent.
			config = loadConfig(configPath);
		} catch (error) {
			return denyCodexCall(guard.codexRefusal(`Orrery's config could not be read (${errorText(error)}), so no call can be checked; nothing was run. Fix the config file.`));
		}
		const { codexPid } = await import("../codex/host.ts");
		const pid = codexPid();
		// A shell with no parent of its own ran this hook, so no Codex did (src/codex/host.ts): nothing of it is let through.
		if (pid === undefined) return denyCodexCall(guard.codexRefusal("this hook was run by no Codex (the shell that ran it has no parent); nothing was run"));
		// The file the config came from, as loadConfig found it: the guard keeps it read-only, wherever it is.
		const configFile = resolvePath(configPath ?? defaultConfigPath());
		const refusal = guard.runCodexGuard(stdin, { config, env: process.env, codexPid: pid, codexParent: process.ppid, configFile, deadline: CODEX_GUARD_DEADLINE_MS });
		return refusal === undefined ? 0 : denyCodexCall(refusal);
	} catch (error) {
		return denyCodexCall(`Orrery guard: this call could not be checked (${errorText(error).replace(/\.+$/, "")}); nothing was run`);
	}
}

/**
 * `orrery codex-hook <event>`: the hooks `orrery agent --tool codex` gives Codex (src/codex/launch.ts). pre-tool-use is
 * the guard (codexGuardHook). The others record (src/codex/hooks.ts) and never fail the session: exit 0 (a 2 would block
 * the prompt, or keep a turn going), only their JSON answer on stdout, and an error in one stderr line, never with
 * message contents. They run with the Orrery config the Codex process was started with (its ORRERY_CONFIG, else its
 * Orrery home's or the default: src/codex/hooks.ts codexOwnConfig), which the holder is given too; one the hook would
 * read otherwise (a --config of its caller's, its own ORRERY_CONFIG or ORRERY_HOME) is refused. A config that cannot be
 * read, or refused, is said at SessionStart; the session then runs as plain Codex.
 */
async function codexHook(event: string | undefined, configPath: string | undefined): Promise<number> {
	if (event === "pre-tool-use") return codexGuardHook(configPath);
	try {
		const stdin = (await readStdin(Number.POSITIVE_INFINITY)) ?? "";
		const [hooks, { codexPid }, { spawnHolder }, { startEnvRead }, { processCwd }] = await Promise.all([
			import("../codex/hooks.ts"),
			import("../codex/host.ts"),
			import("../claude/hooks.ts"),
			import("../codex/pick.ts"),
			import("../agent/process.ts"),
		]);
		const pid = codexPid();
		// A shell with no parent of its own ran this hook, so no Codex did (src/codex/host.ts): nothing is recorded.
		if (pid === undefined) {
			if (event === "session-start") process.stdout.write(hooks.noCodexNotice());
			return 0;
		}
		// Codex's own start environment, read once: whose session it is and its Orrery config (src/codex/hooks.ts).
		const read = startEnvRead(pid, hooks.CODEX_START_VARIABLES);
		const started = read !== undefined && "env" in read ? read.env : undefined;
		// The hooks, the host record and the holder take the config Codex was started with; a hook that would read another is
		// refused. Codex's folder is read only for a relative ORRERY_CONFIG (lsof on macOS).
		const own = hooks.codexOwnConfig(configPath, process.env, started, () => processCwd(pid), read !== undefined && "cut" in read ? read.cut : undefined);
		if ("refused" in own) {
			if (event === "session-start") process.stdout.write(hooks.ownConfigNotice(own.refused));
			return 0;
		}
		let config: HarnessConfig;
		try {
			config = loadConfig(own.path);
		} catch (error) {
			if (event === "session-start") process.stdout.write(hooks.configNotice(errorText(error)));
			return 0;
		}
		const startHolder = (agent: AgentConfig, session: string, nonce: string, since: number) => spawnHolder(agent, session, nonce, pid, since, own.path, "codex");
		process.stdout.write(await hooks.runCodexHook(event ?? "", stdin, { config, env: process.env, codexPid: pid, codexParent: process.ppid, startHolder, updateNotices: true, envOf: () => started }));
	} catch (error) {
		process.stderr.write(`Orrery: ${event ?? "codex-hook"}: ${errorText(error)}\n`);
	}
	return 0;
}

/**
 * `orrery grok-hook pre-tool-use`, the guard (src/grok/guard.ts), in every Grok session: a call it lets through gets exit
 * 0 and nothing on stdout; a refusal is denyCodexCall's (exit 2, the reason on stderr). Grok lets a call through when its
 * hook fails or times out, so everything that keeps the guard from judging refuses: input over 1 MB (read to its end,
 * not kept), a config that is there, or named, but cannot be read, any error, and a judgment not done by
 * CODEX_GUARD_DEADLINE_MS after the process started; past that, a crash or a stall is refused by src/codex/guard-exit.ts
 * (6 s, inside the 10 s Orrery's hook file gives it). Without any config (none named, none at the default paths) there
 * is no Orrery data to keep: every call goes through, as in a plain Claude Code.
 */
async function grokGuardHook(configPath: string | undefined): Promise<number> {
	try {
		const guard = await import("../grok/guard.ts");
		const stdin = await readStdin(guard.GROK_TOOL_INPUT_MAX);
		let config: HarnessConfig;
		try {
			// A synchronous read the watchdog (src/codex/guard-exit.ts) can't interrupt.
			config = loadConfig(configPath);
		} catch (error) {
			if (absentConfig(error, configPath)) return 0;
			return denyCodexCall(guard.grokRefusal(`Orrery's config could not be read (${errorText(error)}), so no call can be checked; nothing was run. Fix the config file.`));
		}
		const { grokPid } = await import("../grok/host.ts");
		const pid = grokPid();
		// A shell with no parent of its own ran this hook, so no Grok did (src/grok/host.ts): nothing of it is let through.
		if (pid === undefined) return denyCodexCall(guard.grokRefusal("this hook was run by no Grok (the shell that ran it has no parent); nothing was run"));
		// The file the config came from, as loadConfig found it: the guard keeps it read-only, wherever it is.
		const configFile = resolvePath(configPath ?? defaultConfigPath());
		const refusal = guard.runGrokGuard(stdin, { config, env: process.env, grokPid: pid, grokParent: process.ppid, configFile, deadline: CODEX_GUARD_DEADLINE_MS });
		return refusal === undefined ? 0 : denyCodexCall(refusal);
	} catch (error) {
		return denyCodexCall(`Orrery guard: this call could not be checked (${errorText(error).replace(/\s*[\r\n]+\s*/g, " ").replace(/\.+$/, "")}); nothing was run`);
	}
}

/**
 * `orrery grok-hook <event>`: the hooks Orrery's install gives Grok Build (src/grok/hooks.ts), global, so they run in
 * every Grok session. pre-tool-use is the guard (grokGuardHook). The others never fail the session: exit 0 (a 2 would
 * block the prompt, or keep a turn going), only their JSON answer on stdout, and an error in one stderr line, never with
 * message contents. They run with the Orrery config the grok process was started with (its ORRERY_CONFIG, else the
 * default: src/grok/hooks.ts grokOwnConfig), which the holder is given too; one the hook would read otherwise (a
 * --config of its caller's, its own ORRERY_CONFIG or ORRERY_HOME) is refused. A config that cannot be read, or refused,
 * is said at SessionStart in a Grok opened as an agent; anywhere else (a plain grok, or no config at all) they say
 * nothing. Run by Grok's shared leader (leader mode), every event but the guard decides, claims and records nothing
 * (src/grok/hooks.ts runGrokHook); the guard judges there by Orrery's own rules. Run by a shell with no parent of its
 * own, no Grok ran them (src/grok/host.ts grokPid): they record nothing, and the guard refuses.
 */
async function grokHook(event: string | undefined, configPath: string | undefined): Promise<number> {
	if (event === "pre-tool-use") return grokGuardHook(configPath);
	try {
		const stdin = (await readStdin(Number.POSITIVE_INFINITY)) ?? "";
		const [hooks, { GROK_START_VARIABLES, grokPid }, { spawnHolder }, { startEnvRead }, { AGENT_ENV }, { processCwd }] = await Promise.all([
			import("../grok/hooks.ts"),
			import("../grok/host.ts"),
			import("../claude/hooks.ts"),
			import("../codex/pick.ts"),
			import("../agent/pick.ts"),
			import("../agent/process.ts"),
		]);
		const pid = grokPid();
		// A shell with no parent of its own ran this hook, so no Grok did (src/grok/host.ts): nothing is recorded.
		if (pid === undefined) {
			if (event === "session-start" && (process.env[AGENT_ENV]?.trim() ?? "") !== "") process.stdout.write(hooks.noGrokNotice());
			return 0;
		}
		// Grok's own start environment, read once: whose session it is, its Orrery config and its folder (src/grok/hooks.ts).
		const read = startEnvRead(pid, GROK_START_VARIABLES);
		const started = read !== undefined && "env" in read ? read.env : undefined;
		const named = (process.env[AGENT_ENV]?.trim() ?? "") !== "" || (started?.[AGENT_ENV]?.trim() ?? "") !== "";
		// The host record and the holder take the config Grok was started with; a hook that would read another is refused.
		// Grok's folder is read only for a relative ORRERY_CONFIG (lsof on macOS).
		const own = hooks.grokOwnConfig(configPath, process.env, started, () => processCwd(pid), read !== undefined && "cut" in read ? read.cut : undefined);
		if ("refused" in own) {
			if (event === "session-start" && named) process.stdout.write(hooks.ownConfigNotice(own.refused));
			return 0;
		}
		let config: HarnessConfig;
		try {
			config = loadConfig(own.path);
		} catch (error) {
			if (event === "session-start" && named) process.stdout.write(hooks.configNotice(errorText(error)));
			return 0;
		}
		const startHolder = (agent: AgentConfig, session: string, nonce: string, since: number) => spawnHolder(agent, session, nonce, pid, since, own.path, "grok");
		process.stdout.write(await hooks.runGrokHook(event ?? "", stdin, { config, env: process.env, grokPid: pid, grokParent: process.ppid, startHolder, updateNotices: true, envOf: () => started }));
	} catch (error) {
		process.stderr.write(`Orrery: ${event ?? "grok-hook"}: ${errorText(error)}\n`);
	}
	return 0;
}

/** The most of Grok's status JSON read: it is a few kilobytes; more is no status of Grok's. */
const GROK_STATUS_INPUT_MAX = 1024 * 1024;

/**
 * `orrery grok-status`: Grok Build's status row (src/grok/status.ts), which Orrery's install names in Grok's config. Grok
 * runs it with its status JSON on stdin; it prints one line, or nothing for no row. It never fails into the row (Grok
 * paints a failing command's exit code there): exit 0 and nothing on stderr, whatever happens, a config that can't be
 * read included. A plain grok's (no ORRERY_AGENT) reads no config at all.
 */
async function grokStatusCommand(configPath: string | undefined): Promise<number> {
	try {
		const stdin = (await readStdin(GROK_STATUS_INPUT_MAX)) ?? "";
		const { AGENT_ENV } = await import("../agent/pick.ts");
		if ((process.env[AGENT_ENV]?.trim() ?? "") === "") return 0;
		const config = loadConfig(configPath);
		const [{ grokStatus }, { grokPid }] = await Promise.all([import("../grok/status.ts"), import("../grok/host.ts")]);
		const pid = grokPid();
		// A shell with no parent of its own ran it, so no Grok did (src/grok/host.ts): no row.
		if (pid === undefined) return 0;
		const line = grokStatus(stdin, { config, env: process.env, grokPid: pid, grokParent: process.ppid });
		if (line !== "") process.stdout.write(`${line}\n`);
	} catch {
		// No row.
	}
	return 0;
}

/**
 * `orrery claude-mod view --cwd DIR [--session ID] [--agent NAME [--agent-token T]] [--wait-ms N [--spool-only]]`: the
 * Orrery mod's one call (src/claude/mod-view.ts). --agent and --agent-token are ORRERY_AGENT and its token as the mod
 * read them from Claude Code's environment.
 * It prints one JSON line; exit 1 with { error } when the config or memory cannot be read, or the gate refused it.
 * Nothing goes to stderr. No config at all (none named, none at the default paths) is not an error: the reply is
 * { lane: null }. It runs with the config the gate read and judged (`gated.config`, src/cli/gate.ts), never read again.
 * Inside an agent's session (`gated.inside`) it gives that agent's view or none, with the config that holds the
 * session's memory; in a coding tool's session that is no agent's, only the view of the agent its host's own launch
 * names (`gated.hostAgent`), or none.
 */
async function claudeModCommand(
	action: string | undefined,
	values: { config?: string; cwd?: string; session?: string; "wait-ms"?: string; "spool-only"?: boolean; agent?: string; "agent-token"?: string },
	gated: Gated,
): Promise<number> {
	let reply: object;
	try {
		if (action !== "view") throw new Error("claude-mod needs view");
		const { modView } = await import("../claude/mod-view.ts");
		const waitMs = values["wait-ms"] === undefined ? 0 : Number(values["wait-ms"]);
		if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 120_000) throw new Error("--wait-ms takes 0 to 120000");
		const { inside, hostAgent } = gated;
		if (hostAgent === null) return modReply({ lane: null });
		const config = gated.config;
		if (config === undefined && gated.configError !== undefined && !absentConfig(gated.configError, values.config)) throw gated.configError;
		const agent = values.agent === undefined ? {} : { agent: values.agent, ...(values["agent-token"] === undefined ? {} : { agentToken: values["agent-token"] }) };
		const serves = inside?.agent ?? hostAgent;
		const only = serves === undefined ? {} : { only: serves };
		reply = await modView(config, { cwd: values.cwd ?? process.cwd(), ...(values.session === undefined ? {} : { session: values.session }), waitMs, spoolOnly: values["spool-only"] === true, ...agent, ...only });
	} catch (error) {
		reply = { error: modError(error) };
	}
	return modReply(reply);
}

/** An error as the mod's reply carries it: one line, no control characters, at most 300 characters. */
const modError = (error: unknown) => errorText(error).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 300);

/** Prints the mod's one JSON line: exit 1 for an error. */
function modReply(reply: object): number {
	process.stdout.write(`${JSON.stringify(reply)}\n`);
	return "error" in reply ? 1 : 0;
}

// Codex's and Grok's guards refuse on anything that goes wrong, since both let a call through when their hook fails
// (src/codex/guard-exit.ts).
const guardExit = isCodexGuard(process.argv.slice(2)) || isGrokGuard(process.argv.slice(2)) ? armCodexGuard() : undefined;

main(process.argv.slice(2)).then(
	(code) => {
		guardExit?.disarm();
		exitWhenFlushed(code);
	},
	(error: unknown) => {
		if (guardExit !== undefined) {
			guardExit.refuse(`this call could not be checked (${errorText(error).replace(/\.+$/, "")}); nothing was run`);
			return;
		}
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		exitWhenFlushed(1);
	},
);
