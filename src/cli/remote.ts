/** Remote lane commands shared by the CLI and TUI; credentials never appear in listings. */

import { dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { ConfigError, defaultConfigPath, findLane, type HarnessConfig, type LaneConfig, loadConfig, parseConfig } from "../lane/config.ts";
import { addLane, addRemote, configWritable, type NewLane, type NewRemote, editConfigFile, readOnlyConfigText, removeRemote, saveConfigText, setLaneKey } from "../lane/config-edit.ts";
import { safeText } from "../lane/source-labels.ts";
import { holdWriterLock, type WriterLock } from "../memory/store.ts";
import { writePrivate } from "../lane/private-file.ts";
import { CloudflareStorage } from "../remote/cloudflare.ts";
import { codeToKey, createKey, keyMatches, keyToCode, sealCheck, unseal } from "../remote/crypto.ts";
import { laneSettings, remoteLaneSettings, type SaveHeader } from "../remote/save-format.ts";
import { heldMessage, RemoteSession, TAKEOVER_FILE } from "../remote/session.ts";
import { holderFor, openStorage } from "../remote/index.ts";
import { readRemoteSecret, type RemoteSecret, removeRemoteSecret, saveRemoteSecret } from "../remote/secrets.ts";
import { type LaneEntry, RemoteError, type Storage } from "../remote/types.ts";
import { clean } from "./printer.ts";

type StorageFactory = (config: HarnessConfig, name: string, secret?: RemoteSecret) => Storage;
let storageForTests: StorageFactory | undefined;

/** Replaces network storage in command tests without environment variables; undefined restores the real factory. */
export function setStorageForTests(factory: StorageFactory | undefined): void {
	storageForTests = factory;
}

/** Copies only the storage contract's public fields, never transport metadata or credentials. */
function publicLane(entry: LaneEntry): LaneEntry {
	const { lane, newestSave, lock } = entry;
	return {
		lane, newestSave,
		...(lock === undefined ? {} : { lock: {
			holder: { machine: lock.holder.machine, device: lock.holder.device, pid: lock.holder.pid },
			lock: lock.lock, lastSeen: lock.lastSeen, stale: lock.stale, held: lock.held,
		} }),
	};
}

const shown = (value: string): string => safeText(clean(value));

function laneLine(entry: LaneEntry): string {
	const { lock } = entry;
	const lastSeen = lock === undefined ? "" : new Date(lock.lastSeen).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	const state = lock?.held === true ? `open on ${shown(lock.holder.machine)} (last seen ${lastSeen}${lock.stale ? "; stale" : ""})` : "closed";
	return `${shown(entry.lane)} · save ${entry.newestSave} · ${state}`;
}

export interface RemoteOptions {
	readonly json?: boolean;
	readonly yes?: boolean;
	readonly server?: string;
	readonly cloudflare?: string;
	readonly "token-file"?: string;
	readonly "code-file"?: string;
	/** remote add: create the key for a remote already in the config that has no key check (it is new). */
	readonly new?: boolean;
}

/** Both a terminal's hidden prompt and the TUI's SecretModal implement this. */
export interface RemoteInteraction {
	secret(message: string): Promise<string | undefined>;
	/** TUI confirmation for removing this machine's saved recovery key. CLI removal requires --yes. */
	confirm?(message: string): Promise<boolean>;
}

export interface RemoteAddResult {
	readonly name: string;
	/** Present only for a new key or a recovered, interrupted setup, to show once on completion. */
	readonly recoveryCode?: string;
}

const terminalInteraction: RemoteInteraction = {
	async secret(message) {
		const { readSecret } = await import("./logins.ts");
		return readSecret(message);
	},
};

async function secretValue(file: string | undefined, label: string, flag: string, interaction: RemoteInteraction): Promise<string> {
	if (file !== undefined) {
		const content = readFileSync(file, "utf8").replace(/\r?\n$/, "");
		if (flag === "--token-file" && /[\r\n]/.test(content)) throw new Error("--token-file must contain a single line (one trailing newline is allowed).");
		const value = content.trim();
		if (!value) throw new Error(`${flag} must name a file containing the ${label}.`);
		return value;
	}
	if (interaction === terminalInteraction && process.stdin.isTTY !== true) throw new Error(`No terminal for the ${label}; use ${flag} <path>.`);
	const value = (await interaction.secret(`${label} (hidden):`))?.trim();
	if (!value) throw new Error("Remote setup cancelled.");
	return value;
}

/** Opens with a just-entered token before it is saved; all other callers use the normal factory. */
function storageFor(config: HarnessConfig, name: string, secret?: RemoteSecret): Storage {
	if (storageForTests !== undefined) return storageForTests(config, name, secret);
	const remote = config.remotes.get(name);
	if (remote?.kind === "cloudflare" && secret?.token !== undefined) {
		return new CloudflareStorage(remote, secret.token);
	}
	return openStorage(config, name);
}

function errorText(error: unknown, ...secrets: (string | undefined)[]): string {
	let text = error instanceof Error ? error.message : String(error);
	for (const secret of secrets) if (secret) text = text.split(secret).join("[secret]");
	return shown(text);
}

function keyFor(config: HarnessConfig, name: string): Uint8Array {
	const secret = readRemoteSecret(config, name);
	if (secret === undefined) throw new RemoteError("key-missing", `No key for remote ${name} on this machine; add it with its recovery code.`);
	return codeToKey(secret.key);
}

/** Sets up a remote for the CLI or TUI. The caller decides how to present the optional new recovery code. */
export async function addRemoteCommand(configPath: string | undefined, name: string, options: RemoteOptions, interaction: RemoteInteraction = terminalInteraction): Promise<RemoteAddResult> {
	const path = configPath ?? defaultConfigPath();
	const config = loadConfig(path);
	const existing = config.remotes.get(name);
	if (existing === undefined && (options.server === undefined) === (options.cloudflare === undefined)) throw new Error("Choose exactly one of --server <host>:<folder> or --cloudflare <url>.");
	let remote: NewRemote;
	if (existing !== undefined) {
		if (options.server !== undefined || options.cloudflare !== undefined) throw new Error(`Remote ${name} is already configured; omit --server and --cloudflare to recover its key on this machine.`);
		remote = existing.kind === "server" ? { ...existing, host: existing.host.name } : existing;
	} else if (options.server !== undefined) {
		const colon = options.server.indexOf(":");
		if (colon <= 0 || colon === options.server.length - 1) throw new Error("--server takes a configured host and folder: <host>:<folder>.");
		remote = { name, kind: "server", host: options.server.slice(0, colon), folder: options.server.slice(colon + 1) };
	} else remote = { name, kind: "cloudflare", url: options.cloudflare! };
	if (remote.kind === "server" && options["token-file"] !== undefined) throw new Error("--token-file is only for a Cloudflare remote.");
	const candidate = existing === undefined ? parseConfig(addRemote(readFileSync(path, "utf8"), dirname(resolve(path)), remote), dirname(resolve(path))) : config;
	const previous = readRemoteSecret(config, name);
	let token: string | undefined;
	let code: string | undefined;
	let wroteCheck = false;
	try {
		token = remote.kind === "cloudflare"
			? options["token-file"] === undefined && previous?.token ? previous.token : await secretValue(options["token-file"], "Cloudflare access token", "--token-file", interaction)
			: undefined;
		const storage = storageFor(candidate, name, token === undefined ? undefined : { key: "", token });
		const check = await storage.getCheck();
		let key: Uint8Array;
		let showCode = false;
		if (check === undefined) {
			// A remote already in the config was set up somewhere, so a missing key check is suspicious (a remote host
			// could hide it to get a second, mismatched key made): refuse unless the user says it is new. A remote
			// with lanes but no check is refused either way.
			if (existing !== undefined && options.new !== true) throw new Error(`This configured remote has no key check. If it is new, run orrery remote add ${name} --new to create its key; otherwise restore its key check first.`);
			if (options["code-file"] !== undefined) throw new Error("This remote has no key check; --code-file is only for an existing remote with a key check. Verify the remote's address before trying again.");
			if ((await storage.list()).length > 0) throw new Error("This remote has lanes but no key check. Restore its original key check before adding it; a new key would not unlock those lanes.");
			key = createKey();
			showCode = true;
		} else {
			// An interrupted first registration kept its key before uploading the check. Recover without losing it.
			let saved: Uint8Array | undefined;
			try { if (previous !== undefined) saved = codeToKey(previous.key); } catch { /* ask for a valid code below */ }
			if (options["code-file"] === undefined && saved !== undefined && keyMatches(saved, check)) {
				key = saved;
				showCode = existing === undefined;
			} else {
				code = await secretValue(options["code-file"], "Recovery code", "--code-file", interaction);
				key = codeToKey(code);
				if (!keyMatches(key, check)) throw new RemoteError("corrupt", "That recovery code does not match this remote.");
			}
		}
		code = keyToCode(key);
		// Persist before the first remote mutation: even a lost reply must not strand encrypted data without its key.
		saveRemoteSecret(config, name, { key: code, ...(token === undefined ? {} : { token }) });
		if (check === undefined) {
			wroteCheck = true;
			await storage.putCheck(sealCheck(key));
			const stored = await storage.getCheck();
			if (stored === undefined || !keyMatches(key, stored)) throw new RemoteError("corrupt", "Another setup chose this remote's key; add it with that recovery code.");
		}
		if (existing === undefined) editConfigFile(path, (text, dir) => addRemote(text, dir, remote));
		return { name, ...(showCode ? { recoveryCode: code } : {}) };
	} catch (error) {
		// If uploading a key may have succeeded, retain it so a retry can verify and finish registration.
		if (!wroteCheck) {
			if (previous === undefined) removeRemoteSecret(config, name);
			else saveRemoteSecret(config, name, previous);
		}
		throw new Error(errorText(error, token, code, previous?.key, previous?.token));
	}
}

async function testRemote(config: HarnessConfig, name: string): Promise<string> {
	const lines: string[] = [];
	let step = "reachable";
	const secret = readRemoteSecret(config, name);
	try {
		const storage = storageFor(config, name);
		await storage.list(); lines.push("✓ reachable");
		step = "lock writable";
		const taken = await storage.take("orrery-test", holderFor(config));
		if (!taken.ok) throw new Error(`test lane is open on ${shown(taken.held.holder.machine)}`);
		lines.push("✓ lock writable");
		step = "test lane removed";
		try {
			const copy = await storage.fetch("orrery-test", -1);
			if (copy.snapshot !== undefined || copy.saves.length > 0) throw new Error("orrery-test contains memory; its copy was kept.");
			await storage.drop("orrery-test", taken.lock);
		}
		catch (error) { await storage.release("orrery-test", taken.lock).catch(() => {}); throw error; }
		lines.push("✓ test lane removed");
		step = "key decrypts";
		const check = await storage.getCheck();
		if (check === undefined || !keyMatches(keyFor(config, name), check)) throw new Error("the recovery code does not match this remote");
		lines.push("✓ key decrypts");
		return `${lines.join("\n")}\n`;
	} catch (error) {
		throw new Error([...lines, `✗ ${step}: ${errorText(error, secret?.key, secret?.token)}`].join("\n"));
	}
}

/** Validate decrypted JSON and select only header fields, never arbitrary extra payload properties. */
function logHeader(plain: Uint8Array, n: number): SaveHeader {
	try {
		const h = JSON.parse(Buffer.from(plain).toString("utf8")) as SaveHeader;
		if (h?.v !== 1 || h.n !== n || !Number.isSafeInteger(h.lock) || h.lock < 1 || typeof h.machine !== "string" || typeof h.device !== "string" || typeof h.at !== "string" || !Number.isFinite(Date.parse(h.at)) || !/^[a-f0-9]{64}$/.test(h.sha256)) throw new Error();
		for (const field of ["main", "tree", "usage", "meta"] as const) if (!Number.isSafeInteger(h.rows?.[field]) || h.rows[field] < 0) throw new Error();
		if (h.takeover !== undefined && (h.takeover === null || typeof h.takeover.from !== "string")) throw new Error();
		return { v: 1, n, lock: h.lock, machine: h.machine, device: h.device, at: h.at, sha256: h.sha256, rows: { main: h.rows.main, tree: h.rows.tree, usage: h.rows.usage, meta: h.rows.meta }, ...(h.takeover === undefined ? {} : { takeover: { from: h.takeover.from } }) };
	} catch { throw new RemoteError("corrupt", `Log entry ${n} from the remote is not a valid save header.`); }
}

/** Remote management commands, shared with the TUI. Only explicit key display and creation return secrets. */
export async function remoteCommand(configPath: string | undefined, args: readonly string[], options: RemoteOptions = {}, interaction: RemoteInteraction = terminalInteraction): Promise<string> {
	const [action, name] = args;
	if (args.length !== 2 || !name || !["add", "test", "key", "log", "lanes", "remove"].includes(action)) {
		throw new Error("Use orrery remote add|test|key|log|lanes|remove <name>. Lists and logs accept --json.");
	}
	if (action !== "lanes" && action !== "log" && options.json === true) throw new Error("--json is only for remote lanes and remote log.");
	if (options.yes === true && action !== "remove") throw new Error("--yes is only for remote remove.");
	if (action === "add") {
		const added = await addRemoteCommand(configPath, name, options, interaction);
		return `Added remote ${name}.\n${added.recoveryCode === undefined ? "" : `${added.recoveryCode}\nKeep this recovery code somewhere safe. Another machine needs it to read this remote.\n`}`;
	}
	if (options.server !== undefined || options.cloudflare !== undefined || options["token-file"] !== undefined || options["code-file"] !== undefined) throw new Error("Remote connection and secret-file options are only for remote add.");
	const path = configPath ?? defaultConfigPath();
	const config = loadConfig(path);
	if (action === "log") {
		const lane = findLane(config, name);
		if (lane.remote === undefined) throw new Error(`${lane.name} keeps its memory locally.`);
		const key = keyFor(config, lane.remote);
		const entries = await storageFor(config, lane.remote).log(lane.name);
		const log = entries.map((entry) => logHeader(unseal(key, lane.name, "log", entry.n, entry.file), entry.n));
		if (options.json === true) return `${JSON.stringify({ lane: lane.name, remote: lane.remote, log: log.map((h) => ({ ...h, takeover: h.takeover !== undefined, ...(h.takeover === undefined ? {} : { takeoverFrom: h.takeover.from }) })) }, null, 2)}\n`;
		return log.length === 0 ? `No saves for ${lane.name}.\n` : `${log.map((h) => `${h.n} · ${shown(h.at)} · ${shown(h.machine)} · rows: ${h.rows.main} messages, ${h.rows.tree} summaries, ${h.rows.usage} usage, ${h.rows.meta} settings${h.takeover ? ` · taken over from ${shown(h.takeover.from)}` : ""}`).join("\n")}\n`;
	}
	if (!config.remotes.has(name)) throw new ConfigError(`unknown remote "${shown(name)}"`);
	if (action === "test") return testRemote(config, name);
	if (action === "key") return `This is a secret.\n${keyToCode(keyFor(config, name))}\n`;
	if (action === "lanes") {
		const lanes = (await storageFor(config, name).list()).map(publicLane);
		if (options.json === true) return `${JSON.stringify({ remote: name, lanes }, null, 2)}\n`;
		return lanes.length === 0 ? `No lanes on remote ${name}.\n` : `${lanes.map(laneLine).join("\n")}\n`;
	}
	// Validate the credential file before changing the config. Removal is local: remote data is never deleted.
	readRemoteSecret(config, name);
	removeRemote(readFileSync(path, "utf8"), dirname(resolve(path)), name);
	const warning = `Removing remote ${name} deletes this machine's saved encryption key. Keep its recovery code somewhere safe; without it, this remote's memory cannot be recovered on this machine.`;
	if (options.yes !== true) {
		if (interaction.confirm === undefined) throw new Error(`${warning} Run orrery remote key ${name} to save it, then rerun remote remove ${name} --yes.`);
		if (!(await interaction.confirm(`${warning} Remove it?`))) return "Not removed.\n";
	}
	let before = "";
	let after = "";
	editConfigFile(path, (text, dir) => {
		before = text;
		after = removeRemote(text, dir, name);
		return after;
	});
	try {
		removeRemoteSecret(config, name);
	} catch (error) {
		// Keep a failed removal retryable, without overwriting a concurrent hand edit.
		if (readFileSync(path, "utf8") !== after) {
			throw new Error(`Could not remove remote ${name}'s credentials, and the config changed before it could be restored. Restore its remote entry before retrying.`, { cause: error });
		}
		saveConfigText(path, before);
		throw error;
	}
	return `${warning}\nRemoved remote ${name}. Its remote data is unchanged.\n`;
}

export interface LaneRemoteOptions {
	readonly to?: string;
	readonly from?: string;
	readonly folder?: string;
	readonly yes?: boolean;
	readonly "delete-remote"?: boolean;
}

export interface LaneRemoteInteraction {
	confirm(question: string): Promise<boolean>;
}

const terminalLaneInteraction: LaneRemoteInteraction = {
	async confirm(question) {
		if (process.stdin.isTTY !== true) return false;
		const { createInterface } = await import("node:readline/promises");
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try { return /^y(es)?$/i.test((await rl.question(`${question} (y/n) `)).trim()); }
		finally { rl.close(); }
	},
};

function writable(path: string): void {
	if (!configWritable(path)) throw new Error(readOnlyConfigText(path));
}

function remoteStorage(config: HarnessConfig, name: string): Storage {
	if (!config.remotes.has(name)) throw new ConfigError(`unknown remote "${shown(name)}"`);
	return storageFor(config, name);
}

function sessionOptions(config: HarnessConfig, lane: LaneConfig, storage: Storage, report: (message: string) => void) {
	return { lane: lane.name, laneDir: lane.dir, storage, key: keyFor(config, storage.name), holder: holderFor(config), settings: laneSettings(lane), report, renewMs: 0 };
}

/** Pull shared by the CLI and N: copy portable settings once, then check out and close to fetch the working copy. */
export async function pullLaneCommand(configPath: string | undefined, name: string, remote: string, folder: string): Promise<string> {
	const path = configPath ?? defaultConfigPath();
	writable(path);
	const config = loadConfig(path);
	if ([...config.lanes.keys()].some((n) => n.toLowerCase() === name.toLowerCase())) throw new ConfigError(`A lane named ${shown(name)} already exists.`);
	if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name)) throw new ConfigError("Lane names use letters, digits, - and _ (at most 32), starting with a letter.");
	const workspace = folder === "~" || folder.startsWith("~/") ? `${homedir()}${folder.slice(1)}` : folder;
	if (!isAbsolute(workspace)) throw new Error("The folder must be an absolute path (or start with ~/).");
	let directory = false;
	try { directory = statSync(workspace).isDirectory(); } catch { /* report a missing folder below */ }
	if (!directory) throw new Error(`The folder must already exist and be a directory: ${shown(workspace)}`);
	const storage = remoteStorage(config, remote);
	const secret = readRemoteSecret(config, remote);
	let before: string | undefined;
	let after: string | undefined;
	let writer: WriterLock | undefined;
	const laneDir = join(config.dataDir, "lanes", name);
	const existed = existsSync(laneDir);
	let failed = false;
	try {
		// The config entry may be absent while a process still holds this lane's working copy.
		writer = holdWriterLock(join(laneDir, "memory.sqlite"));
		const { settings } = await remoteLaneSettings(storage, keyFor(config, remote), name);
		const missing = settings.reads?.filter((n) => n !== "*" && n !== name && !config.lanes.has(n)) ?? [];
		if (missing.length) throw new Error(`Pull these lanes first (${missing.map(shown).join(", ")}): ${name}'s reads setting needs them on this machine.`);
		const lane: NewLane = { ...settings, name, workspace, remote, tool: settings.tool as NewLane["tool"], compactorThinking: settings.compactorThinking as NewLane["compactorThinking"] };
		const updated = editConfigFile(path, (text, dir) => {
			const next = addLane(text, dir, lane);
			before = text; after = next;
			return next;
		});
		const notices: string[] = [];
		const session = await RemoteSession.checkOut({ ...sessionOptions(updated, updated.lanes.get(name)!, storage, (m) => notices.push(shown(m))), writer });
		await session.close();
		return [...notices, `Pulled ${name} from remote ${remote} into ${shown(workspace)}.\n`].join("\n");
	} catch (error) {
		failed = true;
		if (before !== undefined && after !== undefined) {
			if (readFileSync(path, "utf8") !== after) throw new Error(`Pull failed: ${errorText(error, secret?.key, secret?.token)}. The config changed during the fetch; review lanes.${name} before retrying.`);
			saveConfigText(path, before);
		}
		throw new Error(errorText(error, secret?.key, secret?.token));
	} finally {
		writer?.();
		// A failed pull leaves no new lane folder behind (one that was already there, say an archived lane's, stays).
		if (failed && !existed) rmSync(laneDir, { recursive: true, force: true });
	}
}

/** Moves lane memory between its local working copy and remote home; independent of agent checkout adapters. */
export async function laneRemoteCommand(configPath: string | undefined, args: readonly string[], options: LaneRemoteOptions = {}, interaction: LaneRemoteInteraction = terminalLaneInteraction): Promise<string> {
	const [action, name] = args;
	if (args.length !== 2 || !name || !["push", "pull", "takeover", "local"].includes(action)) throw new Error("Use orrery lane push|pull|takeover|local <Lane>.");
	if ((options.to !== undefined && action !== "push") || ((options.from !== undefined || options.folder !== undefined) && action !== "pull") || (options.yes === true && action !== "takeover") || (options["delete-remote"] === true && action !== "local")) throw new Error("These options do not apply to this lane command.");
	if (action === "pull") {
		if (!options.from || !options.folder) throw new Error("lane pull needs --from <remote> and --folder <dir>.");
		return pullLaneCommand(configPath, name, options.from, options.folder);
	}
	const path = configPath ?? defaultConfigPath();
	const config = loadConfig(path);
	const lane = findLane(config, name);
	const remote = action === "push" ? options.to : lane.remote;
	if (!remote) throw new Error(action === "push" ? "lane push needs --to <remote>." : `${lane.name} keeps its memory locally.`);
	const storage = remoteStorage(config, remote);
	const secret = readRemoteSecret(config, remote);
	const notices: string[] = [];
	let writer: WriterLock | undefined;
	try {
		if (action === "push") {
			writable(path);
			if (lane.remote !== undefined && lane.remote !== remote) throw new Error(`${lane.name} already keeps its memory on remote ${lane.remote}; run orrery lane local ${lane.name} first.`);
			// Validate the edit before sending anything; write it only once the upload succeeds.
			setLaneKey(readFileSync(path, "utf8"), dirname(resolve(path)), lane.name, "remote", remote);
			await RemoteSession.push(sessionOptions(config, lane, storage, (m) => notices.push(shown(m))));
			editConfigFile(path, (text, dir) => setLaneKey(text, dir, lane.name, "remote", remote));
			return [...notices, `Pushed ${lane.name} to remote ${remote}.\n`].join("\n");
		}
		writer = holdWriterLock(join(lane.dir, "memory.sqlite"));
		if (action === "takeover") {
			const entry = (await storage.list()).find((e) => e.lane === lane.name);
			if (entry === undefined) throw new RemoteError("not-found", `${lane.name} is not on remote ${remote}.`);
			if (entry.lock?.held !== true) return `${lane.name} is already closed on remote ${remote}.\n`;
			const message = shown(heldMessage(lane.name, entry.lock));
			if (!entry.lock.stale) throw new RemoteError("held", `${message}; its lock is not stale.`);
			if (options.yes !== true && !(await interaction.confirm(`${message}. Take over?`))) return `${message}. Not taken over.\n`;
			const taken = await storage.take(lane.name, holderFor(config), { force: true });
			if (!taken.ok) throw new RemoteError("held", shown(heldMessage(lane.name, taken.held)));
			try { writePrivate(join(lane.dir, TAKEOVER_FILE), JSON.stringify({ machine: entry.lock.holder.machine })); }
			finally { await storage.release(lane.name, taken.lock); }
			return `${message}. Taken over and released; the next open fetches its memory.\n`;
		}
		writable(path);
		setLaneKey(readFileSync(path, "utf8"), dirname(resolve(path)), lane.name, "remote", "");
		const session = await RemoteSession.checkOut({ ...sessionOptions(config, lane, storage, (m) => notices.push(shown(m))), writer });
		await session.close();
		const state = JSON.parse(readFileSync(join(lane.dir, "remote-state.json"), "utf8")) as { save: number; lock: number };
		editConfigFile(path, (text, dir) => setLaneKey(text, dir, lane.name, "remote", ""));
		let deleted = false;
		if (options["delete-remote"] === true && await interaction.confirm(`Delete ${lane.name}'s copy on remote ${remote}? Its updated local copy stays on this machine.`)) {
			const taken = await storage.take(lane.name, holderFor(config));
			if (!taken.ok) throw new RemoteError("held", `${shown(heldMessage(lane.name, taken.held))}; its remote copy was kept. ${lane.name} now uses its local copy.`);
			try {
				if (taken.newestSave !== state.save || taken.lock !== state.lock + 1) throw new Error(`${lane.name}'s remote copy changed after fetching; it was kept. ${lane.name} now uses its local copy.`);
				await storage.drop(lane.name, taken.lock);
				deleted = true;
			} finally {
				if (!deleted) await storage.release(lane.name, taken.lock);
			}
		}
		return [...notices, `${lane.name} now keeps its memory locally. Its remote copy was ${deleted ? "deleted" : "kept"}.\n`].join("\n");
	} catch (error) {
		throw new Error(errorText(error, secret?.key, secret?.token));
	} finally { writer?.(); }
}
