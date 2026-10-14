#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * orrery: run and inspect lanes. Each command loads its modules when it runs. The short-lived processes Claude Code
 * starts several times a turn (claude-hook) must not load pi-durable and every model provider first.
 */

import { join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import type { LaneTool } from "../lane/memory-tools.ts";
import { findLane, type HarnessConfig, type LaneConfig, laneForCwd, loadConfig } from "../lane/config.ts";
import { exitWhenFlushed } from "./exit.ts";

const USAGE = `Usage: orrery <command> [--config FILE]
  (no command)               in a terminal: the Orrery TUI (lanes, logins, usage, tools)
  version, --version, -v     the running version (an install's version-commit, or the checkout's package version)
  run <Lane>                 attach this terminal to a lane (one process per lane)
  status [<Lane>] [--json]   every lane (or one): state, tool, memory, summaries
  lane add <Name> --folder DIR --tool pi|omp|claude-code|codex --summary provider/id [--thinking L]
                             add a lane to the config (the TUI's N)
  lane set <Name> --tool T | --folder DIR | --view-kb N | --summary-kb N | --jobs N | --compact-at TOKENS
                             change a lane's setting in the config, keeping its comments
  lane set <Name> launcher direct|ori | ori_model <id>   (empty value clears; also --launcher / --ori-model)
  lane archive <Name>        take a closed lane out of the config (its settings kept as comments at the end);
                             its memory stays in its data folder (the TUI's A)
  lane push <Lane> --to <remote>   upload a closed lane's memory, then use that remote
  lane pull <Lane> --from <remote> --folder <dir>   add a remote lane here and fetch its memory
  lane takeover <Lane> [--yes]    confirm taking a stale lock, then release it for the next open
  lane local <Lane> [--delete-remote]   fetch the newest memory and keep it locally (deletion asks)
  remote add <name> --server <host>:<folder> | --cloudflare <url> [--token-file FILE] [--code-file FILE]
                             add a memory remote; token and recovery code are entered hidden
  remote add <name> [--token-file FILE] [--code-file FILE] [--new]
                             recover this machine's key for an already configured remote
  remote test <name>       test reachability, lock and key
  remote key <name>        show the secret recovery code
  remote log <Lane> [--json]  show decrypted saves and recorded takeovers
  remote lanes <name> [--json]  list lanes stored on a remote and where each is open
  remote remove <name> --yes  remove an unused remote and its saved key (save the recovery code first)
  usage [<Lane>] [--days N] [--json]  token usage per day, role and model (default 7 days)
  login openai|openrouter [--manual]  sign in for summaries (--manual: paste URL/code, no browser)
  login --key <openai|anthropic|openrouter> [--from-pi]
                             save an API key (typed hidden, or copied from pi's /login)
  logins [--json]            what is saved (never the keys)
  logout openai | --key <name>   remove one login
  trust-host <host>          verify and trust an SSH host key for tools
  compact <Lane>             build every missing summary (lane must not be running)
  import <Lane> --dry-run [--claude DIR|none] [--claude-file FILE]... [--codex DIR|none] [--codex-file FILE]... [--notes FILE]... [--paste-threshold N] [--no-split] [--out DIR]
                             preview a history import for review (defaults: this lane's Claude Code
                             project and ~/.codex/sessions; --no-split skips the model pass; --claude-file adds a
                             Claude Code session that lives under another project folder; --codex-file adds a
                             rollout that started elsewhere and was resumed in the lane's folder)
  import <Lane> --commit FILE   append a reviewed preview to the lane's empty memory
  browse <Lane> [--out FILE] [--open]   write an HTML explorer of the lane's memory (--open: into the lane's
                             data folder, then open it)
  compactor <Lane> [signin|key|local [name [words] | name/model [thinking]] | provider/id [thinking] | reset]
                                         show, list or switch the lane's summary model (shared with pi's /compactor)
  backup [--keep N]          snapshot every lane's memory and export it as JSONL (keeps N days, default 14)
  restore <Lane> --from DATE|DIR   put a backup back (the lane must be stopped)
  holder <Lane> --session ID --claude-pid PID [--nonce N] [--since MS]
                             record a Claude Code session into the lane (the plugin's SessionStart hook starts it;
                             --since is when SessionStart ran, in ms since the epoch)
  launch <Lane> [--yes]      start the lane's tool (pi, omp, claude, codex) in its folder, after the checks the TUI makes
  tools [--json]             pi, Claude Code, Codex and OMP: found, version, Orrery's side installed
  tools install <pi|claude-code|omp> [--yes]   install or update Orrery's side of a tool (shows what it does first)
  install --from DIR [--yes]   install an unpacked release folder, then run setup (install.sh and orrery update run this)
  install --rollback [--yes] | --list   switch back to the previous installed version and run setup, or list versions
                             and which lanes run them
  setup [--yes]              wire the orrery command, pi, OMP, Claude Code and the backup service to the installed
                             version; asks on the terminal before replacing anything that is not Orrery's (--yes: replace)
  update [--check] [--version V] [--yes]   install the newest release (or V); --check only says whether one is out
  uninstall [--purge]        unwire pi, OMP and Claude Code, remove the command, the backup service and the installed
                             versions; lanes' memory, config and logins stay (--purge: delete them too, after typing delete)
  claude-setup <Lane> [--mod]  make Claude Code load the lane's memory view (CLAUDE.md, or CLAUDE.local.md in a
                             repo); --mod: from the Orrery mod, in the system prompt
  claude-mod view --cwd DIR [--session ID] [--wait-ms N [--spool-only]]   the Orrery mod's call: the lane's memory
                             section as JSON; --spool-only waits for the session's spool alone, not for summaries
  mcp                        the Claude Code plugin's MCP server: memory tools for the project folder's lane
  claude-hook <event>        a Claude Code plugin hook (session-start, user-prompt-submit, stop, session-end,
                             pre-tool-use)
A lane named "." is the lane whose workspace holds the current folder.
Config: --config, $ORRERY_CONFIG, ~/.orrery/config.toml (or under $ORRERY_HOME), or /etc/orrery/config.toml
`;

function required(value: string | undefined, what: string): string {
	if (!value) throw new Error(`Missing ${what}.\n${USAGE}`);
	return value;
}

/** Asks a yes/no question on the terminal; no without a terminal. */
async function askYes(question: string): Promise<boolean> {
	if (process.stdin.isTTY !== true) return false;
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await rl.question(`${question} (y/n) `)).trim());
	} finally {
		rl.close();
	}
}

/** `orrery tools [--json]`, `orrery tools install <pi|claude-code|omp> [--yes]`. It needs no config, so a new user can run it first. */
async function toolsCommand(positionals: string[], values: { json?: boolean; yes?: boolean }): Promise<number> {
	const { checkTools, probeOri, installSteps, wiringRoot, runInstall } = await import("../lane/tools.ts");
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
	const [{ existsSync }, { orreryHome }, { wireReport, leftWarning }, { terminalConfirm }] = await Promise.all([import("node:fs"), import("../lane/home.ts"), import("../install/wire.ts"), import("../install/ask.ts")]);
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
		const [{ existsSync }, { defaultConfigPath }] = await Promise.all([import("node:fs"), import("../lane/config.ts")]);
		if (status === 0 && !existsSync(defaultConfigPath(process.env))) say("Run orrery to add your first lane.");
		return status;
	}
	if (values.list === true) {
		process.stdout.write(`${versionLines(listVersions(process.env)).join("\n")}\n`);
		return 0;
	}
	if (values.rollback === true) {
		const { from, to } = rollback(process.env);
		say(`Switched back from ${from} to ${to}. pi and OMP lanes keep their version until they restart.`);
		return setupCommand(values);
	}
	throw new Error("install takes --from DIR, --rollback or --list.");
}

/** `orrery update`: the newest release (or --version V), downloaded, checked and installed by that release's own installer. */
async function updateCommand(values: { check?: boolean; version?: string; yes?: boolean }): Promise<number> {
	const { latestVersion, downloadRelease, newer, releasesBase } = await import("../install/update.ts");
	const { versionNumber, compiled } = await import("../lane/running.ts");
	const { laneVersions } = await import("../install/install.ts");
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
		if (r.error) throw new Error(`could not run the installer of ${target}: ${r.error.message}`);
		if (r.signal) return 128 + (constants.signals[r.signal] ?? 0);
		if (r.status !== 0) {
			process.stderr.write(`The install of ${target} failed; Orrery stays on ${running}.\n`);
			return r.status ?? 1;
		}
	} finally {
		if (shown) process.stdout.write("\n");
		for (const [i, name] of names.entries()) process.off(name, handlers[i] as () => void);
		rmSync(work, { recursive: true, force: true });
	}
	process.stdout.write(`Updated ${running} → ${target}. Release notes: ${releasesBase(process.env)}/tag/v${target}\n`);
	const live = [...laneVersions(process.env).versions].filter(([v]) => v !== target);
	if (live.length > 0) process.stdout.write(`These lanes keep their version until they restart: ${live.map(([v, lanes]) => `${lanes.join(", ")} (${v})`).join("; ")}\n`);
	if (!compiled) process.stdout.write("This Orrery runs from a checkout; the installed copy was updated, the checkout was not.\n");
	return 0;
}

/** `orrery uninstall [--purge]`: 1 when something of Orrery's was left, lanes are open, or the purge was not confirmed. */
async function uninstallCommand(values: { purge?: boolean }): Promise<number> {
	const [{ uninstall }, { askTyped }, { orreryHome }] = await Promise.all([import("../install/uninstall.ts"), import("../install/ask.ts"), import("../lane/home.ts")]);
	const home = orreryHome(process.env);
	const { lines, ok } = await uninstall({
		env: process.env,
		purge: values.purge === true,
		confirmPurge: () => askTyped(`This deletes every lane's memory, logins and backups in ${home}.`, "delete"),
	});
	for (const line of lines) say(line);
	return ok ? 0 : 1;
}

/** A lane name as given, or "." for the lane whose workspace holds the project folder (Claude Code's commands use it). */
async function laneArg(config: HarnessConfig, name: string): Promise<string> {
	if (name !== ".") return name;
	const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	const lane = laneForCwd(config, dir);
	if (lane === undefined) throw new Error(`${dir} is in no lane's workspace.`);
	return lane.name;
}

/**
 * `orrery lane add <Name> --folder DIR --tool T --summary provider/id [--thinking L]`, `orrery lane set <Name> --tool T |
 * --folder DIR | --view-kb N | --summary-kb N | --jobs N | --compact-at TOKENS`, `orrery lane archive <Name>`.
 */
async function laneCommand(args: string[], values: Record<string, string | boolean | string[] | undefined>): Promise<number> {
	const [{ addLane, archiveLane, configWritable, editConfigFile, readOnlyConfigText, setLaneKey, userConfigPath }, { defaultConfigPath }, { homedir }, { existsSync }, { archiveRefusal, laneOverview, TOOL_LABELS }] = await Promise.all([
		import("../lane/config-edit.ts"),
		import("../lane/config.ts"),
		import("node:os"),
		import("node:fs"),
		import("../lane/overview.ts"),
	]);
	const [action, name] = args;
	// --config, else $ORRERY_CONFIG, else the default config when it exists, else the user's config path.
	let path = values.config as string | undefined;
	if (path === undefined) path = process.env.ORRERY_CONFIG || (existsSync(defaultConfigPath()) ? defaultConfigPath() : userConfigPath());
	if (["push", "pull", "takeover", "local"].includes(action)) {
		const { laneRemoteCommand } = await import("./remote.ts");
		process.stdout.write(await laneRemoteCommand(path, args, { to: values.to as string | undefined, from: values.from as string | undefined, folder: values.folder as string | undefined, yes: values.yes === true, "delete-remote": values["delete-remote"] === true }, { confirm: askYes }));
		return 0;
	}
	const folder = (value: string) => resolvePath(value === "~" || value.startsWith("~/") ? `${homedir()}${value.slice(1)}` : value);
	const kb = (flag: string) => {
		const n = Number(values[flag]);
		if (!Number.isInteger(n) || n < 1) throw new Error(`--${flag} must be a whole number of KB`);
		return n * 1000;
	};
	if (action === "add") {
		const lane = required(name, "lane name");
		const summary = required(values.summary as string | undefined, "--summary provider/id");
		const thinking = (values.thinking as string | undefined) ?? "low";
		const tool = required(values.tool as string | undefined, "--tool pi|omp|claude-code|codex");
		const workspace = folder(required(values.folder as string | undefined, "--folder DIR"));
		editConfigFile(path, (text, dir) => addLane(text, dir, { name: lane, workspace, tool: tool as never, compactorModel: summary, compactorThinking: thinking as never }));
		process.stdout.write(`Added lane ${lane}: ${workspace}, ${(TOOL_LABELS as Record<string, string>)[tool] ?? tool}, summaries ${summary} (${thinking}).\n`);
		return 0;
	}
	if (action === "set") {
		// The name as the config spells it (`orrery lane set rowan` finds Rowan), as every other command does.
		const lane = existsSync(path) ? findLane(loadConfig(path), required(name, "lane name")).name : required(name, "lane name");
		const changes: [Parameters<typeof setLaneKey>[3], string | number][] = [];
		if (args.length > 2) {
			const key = args[2];
			if (args.length !== 4 || (key !== "launcher" && key !== "ori_model")) throw new Error("Use lane set <Name> launcher direct|ori or ori_model <id> (empty value clears).");
			changes.push([key, args[3]]);
		}
		if (values.launcher !== undefined) changes.push(["launcher", values.launcher as string]);
		if (values["ori-model"] !== undefined) changes.push(["ori_model", values["ori-model"] as string]);
		if (values.tool !== undefined) changes.push(["tool", values.tool as string]);
		if (values.folder !== undefined) changes.push(["workspace", folder(values.folder as string)]);
		if (values["view-kb"] !== undefined) changes.push(["view_bytes", kb("view-kb")]);
		if (values["summary-kb"] !== undefined) changes.push(["compactor_context_bytes", kb("summary-kb")]);
		if (values.jobs !== undefined) changes.push(["compactor_jobs", Number(values.jobs)]);
		if (values["compact-at"] !== undefined) changes.push(["compact_at", Number(values["compact-at"])]);
		if (changes.length === 0) throw new Error(`lane set needs one of --launcher, --ori-model, --tool, --folder, --view-kb, --summary-kb, --jobs, --compact-at.\n${USAGE}`);
		editConfigFile(path, (text, dir) => changes.reduce((acc, [key, value]) => setLaneKey(acc, dir, lane, key, value), text));
		for (const [key, value] of changes) process.stdout.write(`Set lanes.${lane}.${key} = ${value}. It applies when ${lane} next opens.\n`);
		return 0;
	}
	if (action === "archive") {
		// The same refusals as the TUI's A: the lane must be closed and the config writable.
		const config = loadConfig(path);
		const lane = findLane(config, required(name, "lane name")).name;
		const row = laneOverview(config).find((r) => r.name === lane);
		const refusal = row === undefined ? undefined : archiveRefusal(row);
		if (refusal !== undefined) throw new Error(refusal);
		if (!configWritable(path)) throw new Error(readOnlyConfigText(path));
		const { localIso } = await import("../memory/index.ts");
		editConfigFile(path, (text, dir) => archiveLane(text, dir, lane, localIso(new Date()).slice(0, 10)));
		process.stdout.write(`Archived ${lane}.\n`);
		return 0;
	}
	throw new Error(`lane needs add, set, archive, push, pull, takeover or local.\n${USAGE}`);
}

async function main(rawArgv: string[]): Promise<number> {
	// --version is the version flag everywhere but `update`, where it names a release: take its value out first.
	// The command is the first token that is not an option (--config takes a value).
	let updateVersion: string | undefined;
	let argv = rawArgv;
	let first: string | undefined;
	for (let i = 0; i < rawArgv.length; i++) {
		const a = rawArgv[i] as string;
		if (a === "--config") i++;
		else if (!a.startsWith("-")) {
			first = a;
			break;
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
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
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
			session: { type: "string" },
			cwd: { type: "string" },
			"wait-ms": { type: "string" },
			"spool-only": { type: "boolean" },
			"claude-pid": { type: "string" },
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
		},
	});
	const [command, arg] = positionals;
	if (values.help === true) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (values.version === true || command === "version") {
		const { versionLine } = await import("../lane/running.ts");
		process.stdout.write(versionLine());
		return 0;
	}
	if (command === undefined && process.stdin.isTTY === true && process.stdout.isTTY === true) {
		const { runTui } = await import("../tui/run.ts");
		return runTui(values.config);
	}
	if (command === undefined || command === "help") {
		process.stdout.write(USAGE);
		return 0;
	}
	if (command === "claude-hook") return claudeHook(arg, values.config);
	if (command === "claude-mod") return claudeModCommand(arg, values);
	if (command === "mcp") return mcpServer(values.config);
	if (command === "lane") return laneCommand(positionals.slice(1), values);
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
	const config = loadConfig(values.config);
	switch (command) {
		case "status": {
			const { statusCommand } = await import("./commands.ts");
			process.stdout.write(statusCommand(config, arg === undefined ? undefined : await laneArg(config, arg), { json: values.json === true }));
			return 0;
		}
		case "usage": {
			const { usageCommand } = await import("./commands.ts");
			const days = Number(values.days ?? "7");
			if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a whole number of days, at least 1");
			process.stdout.write(usageCommand(config, arg === undefined ? undefined : await laneArg(config, arg), days, { json: values.json === true }));
			return 0;
		}
		case "login": {
			const [{ loginCommand }, { configureHttp }] = await Promise.all([import("./logins.ts"), import("../lane/http.ts")]);
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
			const [{ compactCommand }, { configureHttp }] = await Promise.all([import("./commands.ts"), import("../lane/http.ts")]);
			configureHttp();
			await compactCommand(config, required(arg, "lane"));
			return 0;
		}
		case "import": {
			const [{ importCommitCommand, importDryRunCommand }, { configureHttp }] = await Promise.all([import("./commands.ts"), import("../lane/http.ts")]);
			const lane = required(arg, "lane");
			if (values.commit !== undefined) {
				process.stdout.write(importCommitCommand(config, lane, values.commit));
				return 0;
			}
			if (values["dry-run"] !== true) throw new Error(`import needs --dry-run or --commit FILE.\n${USAGE}`);
			const threshold = Number(values["paste-threshold"] ?? "1200");
			if (!Number.isInteger(threshold) || threshold < 0) throw new Error("--paste-threshold must be a whole number of bytes");
			configureHttp();
			process.stdout.write(
				await importDryRunCommand(config, lane, {
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
			const { backupLanes } = await import("../lane/backup.ts");
			const keep = Number(values.keep ?? "14");
			if (!Number.isInteger(keep) || keep < 1) throw new Error("--keep must be a whole number of days, at least 1");
			const report = backupLanes(config, { keep });
			for (const lane of report.lanes) process.stdout.write(`${lane.name}: ${lane.messages} messages, ${lane.nodes} summaries -> ${report.dir}/${lane.name}\n`);
			if (report.lanes.length === 0) process.stdout.write(`No lane has memory yet; wrote ${report.dir}\n`);
			if (report.pruned.length > 0) process.stdout.write(`Removed old backups: ${report.pruned.join(", ")}\n`);
			return 0;
		}
		case "restore": {
			const { restoreLane } = await import("../lane/backup.ts");
			const lane = required(arg, "lane");
			if (values.from === undefined) throw new Error(`restore needs --from DATE (YYYY-MM-DD) or --from DIR.\n${USAGE}`);
			const report = restoreLane(config, lane, { from: values.from });
			process.stdout.write(`Restored ${report.lane} from ${report.from}: ${report.messages} messages, ${report.nodes} summaries (${report.files.join(", ")})\n`);
			return 0;
		}
		case "browse": {
			const { browseCommand } = await import("./commands.ts");
			const lane = findLane(config, await laneArg(config, required(arg, "lane")));
			// --open writes where pi's /browse does (the lane's data folder), not into the folder Claude Code runs in.
			const path = browseCommand(config, lane.name, values.out ?? (values.open === true ? join(lane.dir, "memory.html") : undefined));
			if (values.open !== true) {
				process.stdout.write(`Wrote ${path}\n`);
				return 0;
			}
			const { pageOpener } = await import("../lane/lane-commands.ts");
			// ORRERY_NO_OPEN=1 (tests) never opens a page, even with a display.
			const opener = process.env.ORRERY_NO_OPEN === "1" ? undefined : pageOpener();
			opener?.open(path);
			process.stdout.write(`Wrote ${path}${opener === undefined ? " (no display here: open it yourself)" : ` and opened it with ${opener.command}`}\n`);
			return 0;
		}
		case "compactor": {
			const [{ compactorCliCommand }, { configureHttp }] = await Promise.all([import("./commands.ts"), import("../lane/http.ts")]);
			configureHttp(); // a switch makes a test call to the model
			process.stdout.write(await compactorCliCommand(config, await laneArg(config, required(arg, "lane")), positionals.slice(2), values.prefix === undefined ? {} : { prefix: values.prefix }));
			return 0;
		}
		case "run": {
			const [{ BACKGROUND_CONTEXT }, { configureHttp }, { Lane }, { runLane }, { SignalStop, stopOnSignals }] = await Promise.all([
				import("@earendil-works/chord/context"),
				import("../lane/http.ts"),
				import("../lane/lane.ts"),
				import("./run.ts"),
				import("./signals.ts"),
			]);
			configureHttp();
			const fatal = new AbortController();
			const lane = await Lane.open({
				config,
				lane: required(arg, "lane"),
				onFatal: (reason) => {
					process.stderr.write(`\nFATAL: ${reason}\n`);
					fatal.abort();
				},
			});
			// systemctl stop (SIGTERM) and tmux kill-server (SIGHUP) close the lane like a fatal stop, but exit 0.
			const releaseSignals = stopOnSignals(fatal);
			const code = await runLane(
				lane,
				{ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true, stop: fatal.signal },
				BACKGROUND_CONTEXT,
			);
			await lane.close();
			releaseSignals();
			return fatal.signal.reason instanceof SignalStop ? 0 : code;
		}
		case "holder": {
			const claudePid = Number(values["claude-pid"]);
			if (!Number.isInteger(claudePid) || claudePid < 1) throw new Error(`holder needs --claude-pid PID.\n${USAGE}`);
			const since = values.since === undefined ? undefined : Number(values.since);
			if (since !== undefined && !(Number.isInteger(since) && since >= 0)) throw new Error(`holder: --since must be a time in ms since the epoch.\n${USAGE}`);
			const { runHolder } = await import("../claude/holder.ts");
			return runHolder(config, required(arg, "lane"), {
				session: required(values.session, "--session"),
				claudePid,
				nonce: values.nonce ?? "",
				...(since === undefined ? {} : { since }),
			});
		}
		case "claude-setup": {
			const setup = await import("../claude/setup.ts");
			const lane = findLane(config, await laneArg(config, required(arg, "lane")));
			process.stdout.write(values.mod === true ? setup.modSetupReport(setup.claudeSetupMod(lane)) : setup.setupReport(setup.claudeSetup(lane)));
			return 0;
		}
		case "launch": {
			const [{ laneOverview }, { applyFix, exitText, launchLabel, launchPlan, runTool }, { checkTools }] = await Promise.all([import("../lane/overview.ts"), import("../lane/launch.ts"), import("../lane/tools.ts")]);
			const name = findLane(config, await laneArg(config, required(arg, "lane"))).name;
			const row = laneOverview(config).find((r) => r.name === name);
			if (row === undefined) throw new Error(`No lane named ${name}.`);
			const tools = checkTools();
			const plan = launchPlan(config, row, tools);
			if (plan.blocked !== undefined) throw new Error(plan.blocked);
			for (const step of plan.steps) {
				if (!step.confirm) {
					process.stdout.write(`${step.text}\n`);
					continue;
				}
				if (values.yes !== true && !(await askYes(step.text))) {
					process.stdout.write("Not launched.\n");
					return 1;
				}
				if (step.fix !== undefined) process.stdout.write(`${applyFix(step.fix, config, row, tools)}\n`);
			}
			const exit = await runTool(plan, typeof values.config === "string" ? { env: { ...process.env, ORRERY_CONFIG: resolvePath(values.config) } } : {});
			const text = exitText(launchLabel(plan), exit);
			if (text !== undefined) process.stderr.write(`${text}\n`);
			return exit.code ?? 1;
		}
		default:
			process.stderr.write(`Unknown command ${command}.\n${USAGE}`);
			return 2;
	}
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The orrery config for a process Claude Code starts (a hook, the MCP server), or undefined. Without any config
 * (none named, and no file at the default paths) it says nothing: the plugin is installed for every folder, and Claude
 * Code then runs plain. A config that is named but missing, or broken, gets one stderr line, `label` first.
 */
function optionalConfig(configPath: string | undefined, label: string): HarnessConfig | undefined {
	try {
		return loadConfig(configPath);
	} catch (error) {
		const absent = (error as { code?: unknown }).code === "ENOENT" && configPath === undefined && !process.env.ORRERY_CONFIG;
		if (!absent) process.stderr.write(`${label}: ${errorText(error)}\n`);
		return undefined;
	}
}

/** Claude Code's MCP server. Outside a lane, or without an orrery config, it serves no tools rather than failing. */
async function mcpServer(configPath: string | undefined): Promise<number> {
	const { laneTools, runMcp } = await import("../claude/mcp.ts");
	let tools: LaneTool[] = [];
	const config = optionalConfig(configPath, "orrery mcp");
	if (config !== undefined) {
		const lane = laneForCwd(config, process.env.CLAUDE_PROJECT_DIR || process.cwd());
		if (lane !== undefined) tools = laneTools(config, lane);
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
 * and note any error in one stderr line, never with message contents.
 */
async function claudeHook(event: string | undefined, configPath: string | undefined): Promise<number> {
	try {
		const config = optionalConfig(configPath, "Orrery");
		if (config === undefined) {
			await readStdin(0); // read to its end all the same, so Claude Code's write completes
			return 0;
		}
		const hooks = await import("../claude/hooks.ts");
		// A PreToolUse input over 1 MB is read but not kept (hookInputMax): the guard refuses it unread.
		const stdin = await readStdin(hooks.hookInputMax(event ?? ""));
		const claudePid = Number(process.env.CLAUDE_PID) || process.ppid;
		const startHolder = (lane: LaneConfig, session: string, nonce: string, since: number) => hooks.spawnHolder(lane, session, nonce, claudePid, since, configPath);
		process.stdout.write(await hooks.runHook(event ?? "", stdin, { config, env: process.env, claudePid, startHolder }));
	} catch (error) {
		process.stderr.write(`Orrery: ${event ?? "claude-hook"}: ${errorText(error)}\n`);
	}
	return 0;
}

/**
 * `orrery claude-mod view --cwd DIR [--session ID] [--wait-ms N [--spool-only]]`: the Orrery mod's one call
 * (src/claude/mod-view.ts).
 * It prints one JSON line; exit 1 with { error } when the config or memory cannot be read. Nothing goes to stderr.
 * No config at all (none named, none at the default paths) is not an error: the reply is { lane: null }.
 */
async function claudeModCommand(action: string | undefined, values: { config?: string; cwd?: string; session?: string; "wait-ms"?: string; "spool-only"?: boolean }): Promise<number> {
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
		reply = await modView(config, { cwd: values.cwd ?? process.cwd(), ...(values.session === undefined ? {} : { session: values.session }), waitMs, spoolOnly: values["spool-only"] === true });
	} catch (error) {
		reply = { error: errorText(error).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 300) };
	}
	process.stdout.write(`${JSON.stringify(reply)}\n`);
	return "error" in reply ? 1 : 0;
}

main(process.argv.slice(2)).then(
	(code) => exitWhenFlushed(code),
	(error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		exitWhenFlushed(1);
	},
);
