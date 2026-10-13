/** Opaque lane storage on an SSH host, with pinned host keys and a binary-safe shell protocol. */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { RemoteConfig } from "../lane/config.ts";
import { ownFolder } from "../lane/private-file.ts";
import { sshTarget } from "../lane/ssh-target.ts";
import { safeText } from "../lane/source-labels.ts";
import { SERVER_SCRIPT } from "./server-script.ts";
import { CALL_TIMEOUT_MS, type FetchResult, type Holder, type LaneEntry, type LockState, RemoteError, type RemoteFile, sizedTimeoutMs, type Storage, type TakeResult } from "./types.ts";

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const configQuote = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const corrupt = () => new RemoteError("corrupt", "The server sent an invalid or incomplete reply");

function privateSshFolder(dir: string): void {
	const refused = () => new RemoteError("refused", `${dir} is not a real folder of this user's (a symlink, or someone else's); SSH was not started`);
	if (ownFolder(dir) === false) throw refused();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (ownFolder(dir) !== true) throw refused();
	chmodSync(dir, 0o700);
}

function validLane(lane: string): void {
	if (!NAME.test(lane)) throw new RemoteError("refused", "Lane names use letters, digits, - and _ (max 32)");
}
function numberArg(n: number, min = 0): string {
	// Keep shell arithmetic inside the signed 64-bit range, including counters raised by one.
	if (!Number.isSafeInteger(n) || n < min || n > 999_999_999_999_999) throw new RemoteError("refused", "Invalid remote number");
	return String(n);
}
function integer(text: string, min = 0): number {
	if (!/^\d+$/.test(text.trim())) throw corrupt();
	const value = Number(text);
	if (!Number.isSafeInteger(value) || value < min) throw corrupt();
	return value;
}
function lockState(fields: string[]): LockState {
	if (fields.length !== 7 || !/^[01]$/.test(fields[1]) || !/^[01]$/.test(fields[6])) throw corrupt();
	try {
		const lastSeen = integer(fields[2]) * 1000;
		if (!Number.isSafeInteger(lastSeen)) throw corrupt();
		return { lock: integer(fields[0], 1), held: fields[1] === "1", lastSeen, stale: fields[6] === "1",
			holder: { machine: decodeURIComponent(fields[3]), device: decodeURIComponent(fields[4]), pid: integer(fields[5]) } };
	} catch {
		throw corrupt();
	}
}

/** Length-delimited frames allow arbitrary bytes, including NUL and newlines, without escaping. */
class Reply {
	readonly #data: Buffer;
	#at = 0;
	constructor(data: Buffer) { this.#data = data; }
	get done(): boolean { return this.#at === this.#data.length; }
	line(): string[] {
		const end = this.#data.indexOf(10, this.#at);
		if (end < 0 || end - this.#at > 16_384) throw corrupt();
		const line = this.#data.toString("utf8", this.#at, end);
		this.#at = end + 1;
		return line.split("\t");
	}
	bytes(length: number): Uint8Array {
		if (length > this.#data.length - this.#at) throw corrupt();
		const bytes = new Uint8Array(this.#data.subarray(this.#at, this.#at + length));
		this.#at += length;
		return bytes;
	}
	file(): RemoteFile & { kind: string } {
		const fields = this.line();
		if (fields.length !== 4 || fields[0] !== "file") throw corrupt();
		return { kind: fields[1], n: integer(fields[2]), file: this.bytes(integer(fields[3])) };
	}
	end(): void { if (!this.done) throw corrupt(); }
	ok(): void {
		const fields = this.line();
		if (fields.length !== 1 || fields[0] !== "ok") throw corrupt();
		this.end();
	}
}

export class ServerStorage implements Storage {
	readonly name: string;
	readonly #folder: string;
	readonly #ssh: string;
	readonly #sshDir: string;
	readonly #sshArgs: string[];
	#controlUsable: boolean;
	#retiring: Promise<void> = Promise.resolve();

	constructor(remote: Extract<RemoteConfig, { kind: "server" }>, sshDir: string, options: { ssh?: string; now?: never } = {}) {
		this.name = remote.name;
		this.#folder = remote.folder;
		this.#ssh = options.ssh ?? "ssh";
		this.#sshDir = sshDir;
		if (!remote.folder.trim() || /[\p{Cc}]/u.test(remote.folder)) throw new RemoteError("refused", "The server folder must not be empty or contain control characters");
		if (!NAME.test(remote.host.name) || !/^[^\s-][^\s]*$/.test(remote.host.host) || /[\p{Cc}]/u.test(remote.host.host)) throw new RemoteError("refused", "Invalid SSH host");
		privateSshFolder(sshDir);
		const target = sshTarget(remote.host, sshDir);
		// %C is a 40-byte hash; OpenSSH also binds a temporary .<16-byte suffix>.
		// Keep the whole pathname below the 104-byte Unix socket limit on macOS/BSD.
		// An oversized socket path is fatal in SSH, so choose a normal connection up front.
		const fitsSocket = Buffer.byteLength(join(sshDir, `cm-${"0".repeat(40)}`)) + 17 < 104;
		this.#controlUsable = fitsSocket;
		// SSH expands % and ${...} after parsing quotes. Environment substitutions are
		// not expanded again, so indirection preserves these literal directory names.
		const controlPath = /%|\$\{/.test(sshDir) ? "${ORRERY_SSH_CONTROL_DIR}/cm-%C" : join(sshDir, "cm-%C");
		this.#sshArgs = [
			"-F", target.configFile!, "-i", target.identityFile!,
			"-o", `UserKnownHostsFile=${configQuote(target.knownHostsFile!)}`, "-o", `HostKeyAlias=${target.hostKeyAlias}`,
			"-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes",
			"-o", "ServerAliveInterval=5",
			// OpenSSH auto falls back to a fresh connection when the socket is absent or stale.
			// Let SSH do this before sending the command; retrying here could replay a mutation.
			"-o", "ControlMaster=auto", "-o", `ControlPath=${fitsSocket ? configQuote(controlPath) : "none"}`, "-o", "ControlPersist=60",
			...(target.port === undefined ? [] : ["-p", String(target.port)]),
			`${target.user === undefined ? "" : `${target.user}@`}${target.host}`, "--",
		];
	}

	/** A timeout kills its command, then retires the shared connection before another call can reuse it. */
	async #retireConnection(): Promise<void> {
		if (!this.#controlUsable) return;
		try {
			privateSshFolder(this.#sshDir);
			const exited = await new Promise<boolean>((resolve) => {
				const child = spawn(this.#ssh, ["-O", "exit", ...this.#sshArgs.slice(0, -1)], {
					stdio: "ignore", env: { ...process.env, ORRERY_SSH_CONTROL_DIR: this.#sshDir }, timeout: 1000, killSignal: "SIGKILL",
				});
				child.once("error", () => resolve(false));
				child.once("close", (code) => resolve(code === 0));
			});
			// If the master won't answer even this bounded request, bypass it for this client.
			if (!exited) this.#controlUsable = false;
		} catch { this.#controlUsable = false; }
	}

	async #call(op: string, lane = "", args: string[] = [], payload: readonly Uint8Array[] = [], timeout = CALL_TIMEOUT_MS): Promise<Reply> {
		await this.#retiring;
		privateSshFolder(this.#sshDir);
		// SSH joins its command arguments into a string for the login shell. Quote EVERY argument,
		// including the fixed script; only payload bytes use stdin. No shell is spawned locally.
		const command = ["sh", "-c", SERVER_SCRIPT, `orrery-${randomUUID()}`, op, this.#folder, lane, ...args].map(shellQuote).join(" ");
		const output = await new Promise<Buffer>((resolve, reject) => {
			const child = spawn(this.#ssh, [...(this.#controlUsable ? [] : ["-o", "ControlPath=none"]), ...this.#sshArgs, command], {
				stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ORRERY_SSH_CONTROL_DIR: this.#sshDir },
			});
			const chunks: Buffer[] = [];
			let stderr = "";
			let head = Buffer.alloc(0);
			let gotHeader = false;
			let settled = false;
			const started = performance.now();
			let timer: ReturnType<typeof setTimeout>;
			const fail = (error: RemoteError) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.kill("SIGKILL");
				reject(error);
			};
			const arm = (ms: number) => {
				clearTimeout(timer);
				timer = setTimeout(() => {
					if (settled) return;
					fail(new RemoteError("unreachable", `Remote ${this.name} timed out`));
					this.#retiring = this.#retireConnection();
				}, Math.max(1, ms - (performance.now() - started)));
			};
			arm(timeout);
			child.on("error", (error) => fail(new RemoteError("unreachable", `Cannot reach remote ${this.name}: ${safeText(error.message.split("\n")[0])}`)));
			child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length); });
			child.stdout.on("data", (chunk: Buffer) => {
				chunks.push(chunk);
				if (!gotHeader && (op === "fetch" || op === "log")) {
					// The server announces total bytes before streaming, so even a slow first pull gets
					// its full size allowance. A malicious endless header cannot extend the timeout.
					head = Buffer.concat([head, chunk.subarray(0, 256)]);
					const newline = head.indexOf(10);
					if (newline >= 0) {
						gotHeader = true;
						const fields = head.toString("ascii", 0, newline).split("\t");
						if (fields[0] === "ok") {
							try { arm(sizedTimeoutMs(integer(fields[op === "fetch" ? 2 : 1] ?? ""))); }
							catch { fail(corrupt()); }
						}
					} else if (head.length >= 256) fail(corrupt());
				}
			});
			child.on("close", (code, signal) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				const message = safeText(stderr.split("\n")[0]).slice(0, 500);
				if (code === 0) resolve(Buffer.concat(chunks));
				else if (code === 3) reject(new RemoteError("lock-lost", `${lane}: the lock is no longer current`));
				else if (code === 4) reject(new RemoteError("out-of-order", `${lane}: the save number or bytes do not match`));
				else if (code === 5) reject(new RemoteError("not-found", `No lane ${lane} on remote ${this.name}`));
				else if (code === 255) reject(new RemoteError(/Permission denied|Host key verification failed/i.test(stderr) ? "auth" : "unreachable", message || `Cannot reach remote ${this.name}`));
				else if (signal !== null) reject(new RemoteError("unreachable", `The connection to remote ${this.name} closed`));
				else reject(new RemoteError("refused", message || `Remote ${this.name} refused the operation`));
			});
			// A refusal can close stdin before the payload has been sent. Its exit/stderr above
			// carries the useful error (auth, fencing, etc.); EPIPE must never crash the caller.
			child.stdin.on("error", () => {});
			for (const part of payload) child.stdin.write(part);
			child.stdin.end();
		});
		return new Reply(output);
	}

	async take(lane: string, holder: Holder, options: { force?: boolean } = {}): Promise<TakeResult> {
		validLane(lane);
		if (!holder.machine || !holder.device || holder.machine.length > 1024 || holder.device.length > 1024) throw new RemoteError("refused", "Invalid holder name or device");
		const reply = await this.#call("take", lane, [encodeURIComponent(holder.machine), encodeURIComponent(holder.device), numberArg(holder.pid), options.force ? "1" : "0"]);
		const fields = reply.line();
		reply.end();
		if (fields[0] === "held") return { ok: false, held: lockState(fields.slice(1)) };
		if (fields.length !== 3 || fields[0] !== "ok") throw corrupt();
		return { ok: true, lock: integer(fields[1], 1), newestSave: integer(fields[2]) };
	}
	async renew(lane: string, lock: number): Promise<void> {
		validLane(lane);
		(await this.#call("renew", lane, [numberArg(lock, 1)])).ok();
	}
	async release(lane: string, lock: number): Promise<void> {
		validLane(lane);
		(await this.#call("release", lane, [numberArg(lock, 1)])).ok();
	}
	async save(lane: string, lock: number, n: number, file: Uint8Array, logEntry: Uint8Array): Promise<void> {
		validLane(lane);
		(await this.#call("save", lane, [numberArg(lock, 1), numberArg(n, 1), numberArg(file.byteLength), numberArg(logEntry.byteLength)], [logEntry, file])).ok();
	}
	async snapshot(lane: string, lock: number, n: number, file: Uint8Array): Promise<void> {
		validLane(lane);
		(await this.#call("snapshot", lane, [numberArg(lock, 1), numberArg(n), numberArg(file.byteLength)], [file], sizedTimeoutMs(file.byteLength))).ok();
	}
	async fetch(lane: string, after: number): Promise<FetchResult> {
		validLane(lane);
		const reply = await this.#call("fetch", lane, [numberArg(after, -1)]);
		const fields = reply.line();
		if (fields.length !== 3 || fields[0] !== "ok") throw corrupt();
		const newestSave = integer(fields[1]);
		const total = integer(fields[2]);
		let received = 0;
		let snapshot: RemoteFile | undefined;
		const saves: RemoteFile[] = [];
		let previous = Math.max(after, 0);
		while (!reply.done) {
			const { kind, n, file } = reply.file();
			received += file.byteLength;
			if (kind === "snapshot" && snapshot === undefined && saves.length === 0 && n > after && n <= newestSave) {
				snapshot = { n, file }; previous = n;
			} else if (kind === "save" && n === previous + 1 && n <= newestSave) {
				saves.push({ n, file }); previous = n;
			} else throw corrupt();
		}
		if (received !== total || previous < newestSave) throw corrupt();
		return { ...(snapshot === undefined ? {} : { snapshot }), saves, newestSave };
	}
	async list(): Promise<LaneEntry[]> {
		const reply = await this.#call("list");
		const entries: LaneEntry[] = [];
		const seen = new Set<string>();
		while (!reply.done) {
			const fields = reply.line();
			if (fields.length === 1 && fields[0] === "ok") { reply.end(); return entries; }
			if (fields.length !== 10 || fields[0] !== "lane" || !NAME.test(fields[1]) || seen.has(fields[1])) throw corrupt();
			seen.add(fields[1]);
			entries.push({ lane: fields[1], newestSave: integer(fields[2]), lock: lockState(fields.slice(3)) });
		}
		throw corrupt();
	}
	async log(lane: string): Promise<RemoteFile[]> {
		validLane(lane);
		const reply = await this.#call("log", lane);
		const fields = reply.line();
		if (fields.length !== 2 || fields[0] !== "ok") throw corrupt();
		const total = integer(fields[1]);
		let received = 0;
		const files: RemoteFile[] = [];
		while (!reply.done) {
			const { kind, n, file } = reply.file();
			if (kind !== "log" || n !== files.length + 1) throw corrupt();
			received += file.byteLength;
			files.push({ n, file });
		}
		if (received !== total) throw corrupt();
		return files;
	}
	async getCheck(): Promise<Uint8Array | undefined> {
		const reply = await this.#call("getCheck");
		const fields = reply.line();
		if (fields.length === 1 && fields[0] === "none") { reply.end(); return undefined; }
		if (fields.length !== 2 || fields[0] !== "ok") throw corrupt();
		const file = reply.bytes(integer(fields[1]));
		reply.end();
		return file;
	}
	async putCheck(file: Uint8Array): Promise<void> {
		(await this.#call("putCheck", "", [numberArg(file.byteLength)], [file])).ok();
	}
	async drop(lane: string, lock: number): Promise<void> {
		validLane(lane);
		(await this.#call("drop", lane, [numberArg(lock, 1)])).ok();
	}
}
