#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * orrery: run and inspect agents. Each command loads its modules when it runs. The short-lived processes Claude Code
 * starts several times a turn (claude-hook) must not load pi-durable and every model provider first.
 */

import { dirname, join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import type { ReaderTool } from "../agent/memory-tools.ts";
import { defaultConfigPath, findAgent, type HarnessConfig, type AgentConfig, loadConfig } from "../agent/config.ts";
import { armCodexGuard, CODEX_GUARD_DEADLINE_MS, isCodexGuard } from "../codex/guard-exit.ts";
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

/** `orrery tools [--json]`, `orrery tools install <pi|claude-code|omp> [--yes]`. It needs no config, so a new user can run it first. */
async function toolsCommand(positionals: string[], values: { json?: boolean; yes?: boolean }): Promise<number> {
	const { checkTools, probeOri, installSteps, wiringRoot, runInstall } = await import("../agent/tools.ts");
	const tools = checkTools();
	if (positionals[1] === "install") {
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
	for (const t of tools) process.stdout.write(`${t.label.padEnd(12)} ${(t.version ?? (t.path === undefined ? "not found" : "?")).padEnd(24)} ${t.wiring.padEnd(17)} ${t.detail}\n`);
	return 0;
}

const say = (line: string) => process.stdout.write(`${line}\n`);

/** `orrery setup [--yes]`: wires the orrery command, pi, OMP, Claude Code and the backup service to app/current. 1 when something is left. */
async function setupCommand(values: { yes?: boolean }): Promise<number> {
	const [{ existsSync }, { orreryHome }, { wireReport, leftWarning }, { terminalConfirm }] = await Promise.all([import("node:fs"), import("../agent/home.ts"), import("../install/wire.ts"), import("../install/ask.ts")]);
	if (!existsSync(join(orreryHome(process.env), "app", "current"))) throw new Error("Orrery is not installed yet: see the install line in the README");
	// Each line is printed as it happens: Ctrl-C at a later question stops the process, and what was done is shown.
	const { left, unchecked } = await wireReport(process.env, { confirm: terminalConfirm({ yes: values.yes === true, say }), onLine: say });
	if (left.length > 0 || unchecked.length > 0) {
		for (const line of leftWarning(left, unchecked)) say(line);
		return 1;
	}
	return 0;
}

/**
 * `orrery install --from DIR | --rollback | --list [--yes]`: install a release folder or switch back a version, each
 * followed by setup; or list the installed copies in the home's app folder.
 */
async function installCommand(values: { from?: string; rollback?: boolean; list?: boolean; yes?: boolean }): Promise<number> {
	const { installFrom, listVersions, rollback, versionLines } = await import("../install/install.ts");
	if (values.from !== undefined) {
		if (values.rollback === true || values.list === true) throw new Error("install takes one of --from DIR, --rollback or --list.");
		const { version, removed } = installFrom({ from: values.from, env: process.env, log: say });
		say(`Installed ${version}.`);
		if (removed.length > 0) say(`Removed older versions: ${removed.join(", ")}.`);
		const status = await setupCommand(values);
		const [{ existsSync }, { homedir }, { defaultConfigPath }, { pathAdvice }] = await Promise.all([import("node:fs"), import("node:os"), import("../agent/config.ts"), import("../install/ask.ts")]);
		// Said even when setup left something (a tool not connected): the install itself is done.
		if (!existsSync(defaultConfigPath(process.env))) {
			const onPath = pathAdvice(process.env, join(process.env.HOME || homedir(), ".local", "bin")) === undefined;
			say(onPath ? "Run orrery to add your first agent." : "Run ~/.local/bin/orrery (or open a new terminal after adding it to PATH) to add your first agent.");
		}
		return status;
	}
	if (values.list === true) {
		process.stdout.write(`${versionLines(listVersions(process.env)).join("\n")}\n`);
		return 0;
	}
	if (values.rollback === true) {
		const { from, to } = rollback(process.env);
		say(`Switched back from ${from} to ${to}. pi and OMP agents keep their version until they restart.`);
		return setupCommand(values);
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
 * An agent name as given, or "." for this session's agent (Claude Code's commands use it): the one ORRERY_AGENT names, as
 * the hooks pick it (src/claude/pick.ts), else the one whose folder holds the project folder. In Claude Code
 * (CLAUDE_PID, which it sets for the commands it runs) that is the decision recorded for its process; a command runs
 * within a session, so it never decides. Elsewhere it is picked here, never claiming a token: a tool an agent started
 * with the same variables falls back to its folder.
 */
async function agentArg(config: HarnessConfig, name: string): Promise<string> {
	if (name !== ".") return name;
	const { claudePick, claudeRefusedNotice, claudeSession } = await import("../claude/pick.ts");
	const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	const claudePid = Number(process.env.CLAUDE_PID);
	const pick =
		Number.isInteger(claudePid) && claudePid > 0
			? claudeSession(config, { env: process.env, cwd: dir, pid: claudePid, decide: false })
			: claudePick(config, { env: process.env, cwd: dir, owner: process.ppid, takeover: false });
	if (pick.kind === "agent") return pick.agent.name;
	if (pick.kind === "none") throw new Error(`${dir} is in no agent's folder.`);
	throw new Error(claudeRefusedNotice(pick));
}

/**
 * `orrery agent add <Name> --folder DIR --tool T --summary provider/id [--thinking L]`, `orrery agent set <Name> --tool T |
 * --folder DIR | --view-kb N | --summary-kb N | --jobs N | --compact-at TOKENS | --reads all|none|A,B` (`add` takes --reads too), `orrery agent archive <Name>`.
 */
async function agentCommand(args: string[], values: Record<string, string | boolean | string[] | undefined>): Promise<number> {
	const [{ addAgent, archiveAgent, configWritable, editConfigFile, parseReads, readOnlyConfigText, setAgentKey, userConfigPath }, { defaultConfigPath, parseConfig }, { homedir }, { existsSync }, { archiveRefusal, agentOverview, TOOL_LABELS }] = await Promise.all([
		import("../agent/config-edit.ts"),
		import("../agent/config.ts"),
		import("node:os"),
		import("node:fs"),
		import("../agent/overview.ts"),
	]);
	const [action, name] = args;
	// --config, else $ORRERY_CONFIG, else the default config when it exists, else the user's config path.
	let path = values.config as string | undefined;
	if (path === undefined) path = process.env.ORRERY_CONFIG || (existsSync(defaultConfigPath()) ? defaultConfigPath() : userConfigPath());
	if (["push", "pull", "takeover", "local"].includes(action)) {
		const { agentRemoteCommand } = await import("./remote.ts");
		process.stdout.write(await agentRemoteCommand(path, args, { to: values.to as string | undefined, from: values.from as string | undefined, folder: values.folder as string | undefined, yes: values.yes === true, "delete-remote": values["delete-remote"] === true }, { confirm: askYes }));
		return 0;
	}
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
		const tool = required(values.tool as string | undefined, "--tool pi|omp|claude-code|codex|opencode");
		const folder = fullPath(required(values.folder as string | undefined, "--folder DIR"));
		const reads = values.reads === undefined ? undefined : parseReads(values.reads as string, existsSync(path) ? loadConfig(path) : parseConfig("", dirname(path)), agent);
		editConfigFile(path, (text, dir) => addAgent(text, dir, { name: agent, folder, tool: tool as never, compactorModel: summary, compactorThinking: thinking as never, ...(reads === undefined ? {} : { reads }) }));
		process.stdout.write(`Added agent ${agent}: ${folder}, ${(TOOL_LABELS as Record<string, string>)[tool] ?? tool}, summaries ${summary} (${thinking}).\n`);
		return 0;
	}
	if (action === "set") {
		// The name as the config spells it (`orrery agent set rowan` finds Rowan), as every other command does.
		const agent = existsSync(path) ? findAgent(loadConfig(path), required(name, "agent name")).name : required(name, "agent name");
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
		if (values.reads !== undefined) changes.push(["reads", parseReads(values.reads as string, existsSync(path) ? loadConfig(path) : parseConfig("", dirname(path)), agent)]);
		if (changes.length === 0) throw new UsageError("agent set needs one of --launcher, --ori-model, --tool, --folder, --view-kb, --summary-kb, --jobs, --compact-at, --reads.");
		editConfigFile(path, (text, dir) => changes.reduce((acc, [key, value]) => setAgentKey(acc, dir, agent, key, value), text));
		for (const [key, value] of changes) process.stdout.write(`Set agents.${agent}.${key} = ${typeof value === "string" || typeof value === "number" ? value : value.length === 0 ? "none" : value.includes("*") ? "all" : value.join(", ")}. It applies when ${agent} next opens.\n`);
		return 0;
	}
	if (action === "archive") {
		// The same refusals as the TUI's A: the agent must be closed and the config writable.
		const config = loadConfig(path);
		const agent = findAgent(config, required(name, "agent name")).name;
		const row = agentOverview(config).find((r) => r.name === agent);
		const refusal = row === undefined ? undefined : archiveRefusal(row);
		if (refusal !== undefined) throw new Error(refusal);
		if (!configWritable(path)) throw new Error(readOnlyConfigText(path));
		const { localIso } = await import("../memory/index.ts");
		editConfigFile(path, (text, dir) => archiveAgent(text, dir, agent, localIso(new Date()).slice(0, 10)));
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

/** Runs the command: everything but help and the version. */
async function dispatch(positionals: string[], values: ReturnType<typeof parseCommandLine>["values"], updateVersion: string | undefined, toolArgs: string[]): Promise<number> {
	const [command, arg] = positionals;
	// Claude Code's and Codex's hooks run several times a turn and never sign in or call a model.
	if (command !== "claude-hook" && command !== "codex-hook") await registerReleaseOAuthFlows();
	if (command === undefined && process.stdin.isTTY === true && process.stdout.isTTY === true) {
		const { runTui } = await import("../tui/run.ts");
		return runTui(values.config);
	}
	if (command === undefined) {
		process.stdout.write(shortHelp(await helpVersion()));
		return 0;
	}
	if (command === "claude-hook") return claudeHook(arg, values.config);
	if (command === "codex-hook") return codexHook(arg, values.config);
	if (command === "claude-mod") return claudeModCommand(arg, values);
	if (command === "mcp") return mcpServer(values.config, values.tool);
	if (command === "remote") {
		const { remoteCommand } = await import("./remote.ts");
		process.stdout.write(await remoteCommand(values.config, positionals.slice(1), { json: values.json === true, yes: values.yes === true, server: values.server, cloudflare: values.cloudflare, "token-file": values["token-file"], "code-file": values["code-file"], new: values.new === true }));
		return 0;
	}
	if (command === "tools") return toolsCommand(positionals, values);
	if (command === "install") return installCommand(values);
	if (command === "setup") return setupCommand(values);
	if (command === "update") return updateCommand({ check: values.check, version: updateVersion, yes: values.yes });
	if (command === "uninstall") return uninstallCommand(values);
	if (command === "agent") {
		// The config and remote subcommands. No agent may take one of their names (RESERVED_NAMES, src/agent/config.ts).
		const sub = positionals[1];
		if (sub !== undefined && ["add", "set", "archive", "push", "pull", "takeover", "local"].includes(sub)) return agentCommand(positionals.slice(1), values);
		const [{ editAgentCommand, openAgentCommand }, { agentRemoteCommand }] = await Promise.all([import("./agent.ts"), import("./remote.ts")]);
		// A question only a person answers (starting Codex without Orrery's memory and guard) needs a terminal; --yes is no answer to it.
		const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
		const io = { say, confirm: (question: string) => (values.yes === true ? Promise.resolve(true) : askYes(question)), ...(terminal ? { askPerson: (question: string) => askYes(question, "y/N") } : {}) };
		if (positionals[1] === "edit") {
			if (positionals.length > 3) throw new Error(`orrery agent edit takes one agent name (got ${positionals.slice(2).join(" ")}).`);
			return editAgentCommand(values.config, required(positionals[2], "agent name"), io);
		}
		if (positionals.length > 2) {
			const name = positionals[1] as string;
			throw new Error(`orrery agent takes one agent name; ${positionals.slice(2).join(" ")} would be dropped. The tool's arguments go after --: orrery agent ${name} -- ${positionals.slice(2).join(" ")}`);
		}
		return openAgentCommand(values.config, required(positionals[1], "agent name"), { tool: values.tool, args: toolArgs, cwd: process.cwd() }, io, {
			takeover: (name) => agentRemoteCommand(values.config, ["takeover", name], { yes: true }),
		});
	}
	const config = loadConfig(values.config);
	switch (command) {
		case "status": {
			const { statusCommand } = await import("./commands.ts");
			process.stdout.write(statusCommand(config, arg === undefined ? undefined : await agentArg(config, arg), { json: values.json === true }));
			return 0;
		}
		case "usage": {
			const { usageCommand } = await import("./commands.ts");
			const days = Number(values.days ?? "7");
			if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a whole number of days, at least 1");
			process.stdout.write(usageCommand(config, arg === undefined ? undefined : await agentArg(config, arg), days, { json: values.json === true }));
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
			const agent = findAgent(config, await agentArg(config, required(arg, "agent")));
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
			process.stdout.write(await compactorCliCommand(config, await agentArg(config, required(arg, "agent")), positionals.slice(2), values.prefix === undefined ? {} : { prefix: values.prefix }));
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
			const code = await runHarness(
				agent,
				{ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true, stop: fatal.signal },
				BACKGROUND_CONTEXT,
			);
			await agent.close();
			releaseSignals();
			return fatal.signal.reason instanceof SignalStop ? 0 : code;
		}
		case "holder": {
			// The host's process: --claude-pid, Claude Code's (as always); or --host-pid, with --tool codex for Codex's.
			if (values["claude-pid"] !== undefined && values["host-pid"] !== undefined) throw new UsageError("holder takes --claude-pid or --host-pid, not both.");
			const host = values.tool ?? "claude-code";
			if (host !== "claude-code" && host !== "codex") throw new UsageError(`holder: --tool takes claude-code or codex (not ${host}).`);
			if (host === "codex" && values["host-pid"] === undefined) throw new UsageError("holder --tool codex needs --host-pid PID.");
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
				...(host === "codex" ? { host } : {}),
			});
		}
		case "claude-setup": {
			const setup = await import("../claude/setup.ts");
			const agent = findAgent(config, await agentArg(config, required(arg, "agent")));
			process.stdout.write(values.mod === true ? setup.modSetupReport(setup.claudeSetupMod(agent)) : setup.setupReport(setup.claudeSetup(agent)));
			return 0;
		}
		default:
			return unknownCommand(command);
	}
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The orrery config for a process Claude Code starts (a hook, the MCP server), or undefined. Without any config
 * (none named, and no file at the default paths) it says nothing: the plugin is installed for every folder, and Claude
 * Code then runs plain. A config that is named but missing, or broken, gets one stderr line, `label` first.
 */
function optionalConfig(configPath: string | undefined, label: string): HarnessConfig | undefined {
	return foundConfig(configPath, label).config;
}

/** optionalConfig, and whether a config is there (or named) but could not be read: `broken`. */
function foundConfig(configPath: string | undefined, label: string): { readonly config?: HarnessConfig; readonly broken: boolean } {
	try {
		return { config: loadConfig(configPath), broken: false };
	} catch (error) {
		const absent = (error as { code?: unknown }).code === "ENOENT" && configPath === undefined && !process.env.ORRERY_CONFIG;
		if (!absent) process.stderr.write(`${label}: ${errorText(error)}\n`);
		return { broken: !absent };
	}
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
 * (src/codex/pick.ts), claimed for the Codex that started it, at its start, before any SessionStart.
 */
async function mcpServer(configPath: string | undefined, tool: string | undefined): Promise<number> {
	if (tool !== undefined && tool !== "claude-code" && tool !== "codex") throw new UsageError(`mcp: --tool takes claude-code or codex (not ${tool}).`);
	const { agentTools, runMcp } = await import("../claude/mcp.ts");
	let tools: ReaderTool[] = [];
	const config = optionalConfig(configPath, "orrery mcp");
	if (config !== undefined && tool === "codex") {
		const [{ codexAgent }, { codexPid }] = await Promise.all([import("../codex/pick.ts"), import("../codex/host.ts")]);
		const pick = codexAgent(config, { env: process.env, pid: codexPid(), takeover: true });
		if (pick.kind === "agent") tools = agentTools(config, pick.agent);
	} else if (config !== undefined) {
		const { claudeSession } = await import("../claude/pick.ts");
		const pick = claudeSession(config, { env: process.env, cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(), pid: process.ppid, decide: true });
		if (pick.kind === "agent") tools = agentTools(config, pick.agent);
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
 * `orrery claude-hook <event>`: Claude Code's hooks never fail a session. They exit 0, print only their JSON answer,
 * and note any error in one stderr line, never with message contents. PreToolUse never lets a call through on a failure
 * of its own (Claude Code allows a call the hook says nothing about): a config that is there, or named, but cannot be
 * read denies every call until it is fixed, and so does an error. Without any config Claude Code runs plain.
 */
async function claudeHook(event: string | undefined, configPath: string | undefined): Promise<number> {
	const guarding = event === "pre-tool-use";
	try {
		const { config, broken } = foundConfig(configPath, "Orrery");
		if (config === undefined) {
			await readStdin(0); // read to its end all the same, so Claude Code's write completes
			if (guarding && broken) process.stdout.write(denyToolCall("Orrery's config could not be read, so no call can be checked; nothing was run. Fix the config file."));
			return 0;
		}
		const hooks = await import("../claude/hooks.ts");
		// A PreToolUse input over 1 MB is read but not kept (hookInputMax): the guard refuses it unread.
		const stdin = await readStdin(hooks.hookInputMax(event ?? ""));
		const claudePid = Number(process.env.CLAUDE_PID) || process.ppid;
		const startHolder = (agent: AgentConfig, session: string, nonce: string, since: number) => hooks.spawnHolder(agent, session, nonce, claudePid, since, configPath);
		// The file the config came from, as loadConfig found it: the guard keeps it read-only, wherever it is.
		const configFile = resolvePath(configPath ?? defaultConfigPath());
		const answer = await hooks.runHook(event ?? "", stdin, { config, env: process.env, claudePid, startHolder, configFile, updateNotices: true });
		process.stdout.write(answer);
	} catch (error) {
		process.stderr.write(`Orrery: ${event ?? "claude-hook"}: ${errorText(error)}\n`);
		if (guarding) process.stdout.write(denyToolCall(`this call could not be checked (${errorText(error)}); nothing was run.`));
	}
	return 0;
}

/**
 * A Codex PreToolUse refusal: the reason on stderr and exit code 2. Codex runs a hook through the account's shell
 * (`<shell> -c`: bash, zsh or sh, src/codex/shell.ts), whose startup files (bash's $BASH_ENV, zsh's .zshenv) may print to
 * stdout: a JSON answer there would arrive garbled and the call would go through. With exit 2 Codex reads only stderr,
 * so the refusal holds whatever is on stdout. The reason has no final period: Codex adds one.
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
		// The file the config came from, as loadConfig found it: the guard keeps it read-only, wherever it is.
		const configFile = resolvePath(configPath ?? defaultConfigPath());
		const refusal = guard.runCodexGuard(stdin, { config, env: process.env, codexPid: codexPid(), configFile, deadline: CODEX_GUARD_DEADLINE_MS });
		return refusal === undefined ? 0 : denyCodexCall(refusal);
	} catch (error) {
		return denyCodexCall(`Orrery guard: this call could not be checked (${errorText(error).replace(/\.+$/, "")}); nothing was run`);
	}
}

/**
 * `orrery codex-hook <event>`: the hooks `orrery agent --tool codex` gives Codex (src/codex/launch.ts). pre-tool-use is
 * the guard (codexGuardHook). The others record (src/codex/hooks.ts) and never fail the session: exit 0 (a 2 would block
 * the prompt, or keep a turn going), only their JSON answer on stdout, and an error in one stderr line, never with
 * message contents. A config that cannot be read is said at SessionStart; the session then runs as plain Codex.
 */
async function codexHook(event: string | undefined, configPath: string | undefined): Promise<number> {
	if (event === "pre-tool-use") return codexGuardHook(configPath);
	try {
		const stdin = (await readStdin(Number.POSITIVE_INFINITY)) ?? "";
		const hooks = await import("../codex/hooks.ts");
		let config: HarnessConfig;
		try {
			config = loadConfig(configPath);
		} catch (error) {
			if (event === "session-start") process.stdout.write(hooks.configNotice(errorText(error)));
			return 0;
		}
		const [{ codexPid }, { spawnHolder }] = await Promise.all([import("../codex/host.ts"), import("../claude/hooks.ts")]);
		const pid = codexPid();
		const startHolder = (agent: AgentConfig, session: string, nonce: string, since: number) => spawnHolder(agent, session, nonce, pid, since, configPath, "codex");
		process.stdout.write(await hooks.runCodexHook(event ?? "", stdin, { config, env: process.env, codexPid: pid, startHolder, updateNotices: true }));
	} catch (error) {
		process.stderr.write(`Orrery: ${event ?? "codex-hook"}: ${errorText(error)}\n`);
	}
	return 0;
}

/**
 * `orrery claude-mod view --cwd DIR [--session ID] [--agent NAME [--agent-token T]] [--wait-ms N [--spool-only]]`: the
 * Orrery mod's one call (src/claude/mod-view.ts). --agent and --agent-token are ORRERY_AGENT and its token as the mod
 * read them from Claude Code's environment.
 * It prints one JSON line; exit 1 with { error } when the config or memory cannot be read. Nothing goes to stderr.
 * No config at all (none named, none at the default paths) is not an error: the reply is { lane: null }.
 */
async function claudeModCommand(
	action: string | undefined,
	values: { config?: string; cwd?: string; session?: string; "wait-ms"?: string; "spool-only"?: boolean; agent?: string; "agent-token"?: string },
): Promise<number> {
	let reply: object;
	try {
		if (action !== "view") throw new Error("claude-mod needs view");
		const { modView } = await import("../claude/mod-view.ts");
		const waitMs = values["wait-ms"] === undefined ? 0 : Number(values["wait-ms"]);
		if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 120_000) throw new Error("--wait-ms takes 0 to 120000");
		let config: HarnessConfig | undefined;
		try {
			config = loadConfig(values.config);
		} catch (error) {
			const absent = (error as { code?: unknown }).code === "ENOENT" && values.config === undefined && !process.env.ORRERY_CONFIG;
			if (!absent) throw error;
		}
		const agent = values.agent === undefined ? {} : { agent: values.agent, ...(values["agent-token"] === undefined ? {} : { agentToken: values["agent-token"] }) };
		reply = await modView(config, { cwd: values.cwd ?? process.cwd(), ...(values.session === undefined ? {} : { session: values.session }), waitMs, spoolOnly: values["spool-only"] === true, ...agent });
	} catch (error) {
		reply = { error: errorText(error).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 300) };
	}
	process.stdout.write(`${JSON.stringify(reply)}\n`);
	return "error" in reply ? 1 : 0;
}

// Codex's guard refuses on anything that goes wrong, since Codex lets a call through when its hook fails (src/codex/guard-exit.ts).
const codexGuardExit = isCodexGuard(process.argv.slice(2)) ? armCodexGuard() : undefined;

main(process.argv.slice(2)).then(
	(code) => {
		codexGuardExit?.disarm();
		exitWhenFlushed(code);
	},
	(error: unknown) => {
		if (codexGuardExit !== undefined) {
			codexGuardExit.refuse(`this call could not be checked (${errorText(error).replace(/\.+$/, "")}); nothing was run`);
			return;
		}
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		exitWhenFlushed(1);
	},
);
