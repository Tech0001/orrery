/**
 * A pi-ai CredentialStore in one JSON file shared by every lane process (and `orrery login`).
 * Adapted from pi's coding-agent FileAuthStorageBackend (MIT, earendil-works/pi): proper-lockfile serializes
 * modify/delete across processes; writes go to a temp file and are renamed into place, so reads need no lock.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

export type CredentialOrigin = "signin" | "key";
export type OrreryCredential = Credential & { readonly origin?: CredentialOrigin };
export type OrreryCredentialInfo = CredentialInfo & { readonly origin?: CredentialOrigin };

export function credentialOrigin(credential: Credential | CredentialInfo | undefined): CredentialOrigin | undefined {
	const origin = (credential as OrreryCredential | undefined)?.origin;
	return origin === "signin" || origin === "key" ? origin : undefined;
}

type CredentialData = Record<string, Credential>;
const STALE_MS = 30_000;
// pi proxies fs: proper-lockfile's non-configurable precision cache must live on a plain object.
const lockFs = { ...fs };

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

export class FileCredentialStore implements CredentialStore {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	#load(): CredentialData {
		if (!existsSync(this.path)) return {};
		const text = readFileSync(this.path, "utf8");
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			// Never include the parser's message: V8 quotes the input, which holds tokens.
			data = undefined;
		}
		if (typeof data !== "object" || data === null || Array.isArray(data)) {
			throw new Error(`Credential file ${this.path} is not valid JSON; fix or remove it, then log in again`);
		}
		return data as CredentialData;
	}

	#save(data: CredentialData): void {
		const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		const fd = openSync(temp, "w", 0o600);
		try {
			writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, this.path);
	}

	async #acquire(signal: AbortSignal | undefined, onCompromised: (error: Error) => void): Promise<() => Promise<void>> {
		const deadline = Date.now() + STALE_MS;
		for (let retry = 0; ; retry++) {
			signal?.throwIfAborted();
			try {
				return await lockfile.lock(this.path, { fs: lockFs, realpath: false, retries: 0, stale: STALE_MS, onCompromised });
			} catch (error) {
				if (errorCode(error) !== "ELOCKED" || Date.now() >= deadline) throw error;
				const base = Math.min(10 * 2 ** retry, 1000);
				const delay = Math.min(Math.round(base * (1 + Math.random())), deadline - Date.now());
				await sleep(delay, undefined, signal === undefined ? undefined : { signal });
			}
		}
	}

	async #locked<T>(
		options: AuthOperationOptions | undefined,
		change: (data: CredentialData) => Promise<{ result: T; write: boolean }>,
	): Promise<T> {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		let compromised: Error | undefined;
		const release = await this.#acquire(options?.signal, (error) => {
			compromised = error;
		});
		try {
			const data = this.#load();
			const { result, write } = await change(data);
			if (compromised) throw compromised;
			if (write) this.#save(data);
			return result;
		} finally {
			try {
				await release();
			} catch {
				// A compromised lock cannot be released; the error above already surfaced.
			}
		}
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.#load()[providerId];
	}

	async list(): Promise<readonly OrreryCredentialInfo[]> {
		return Object.entries(this.#load()).map(([providerId, credential]) => ({ providerId, type: credential.type, ...(credentialOrigin(credential) === undefined ? {} : { origin: credentialOrigin(credential) }) }));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#locked(options, async (data) => {
			const next = await fn(data[providerId]);
			if (next === undefined) return { result: data[providerId], write: false };
			data[providerId] = next;
			return { result: next, write: true };
		});
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await this.#locked(options, async (data) => {
			if (!(providerId in data)) return { result: undefined, write: false };
			delete data[providerId];
			return { result: undefined, write: true };
		});
	}
}
