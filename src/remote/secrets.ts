/** Per-remote secrets (encryption key, Cloudflare token) in <data_dir>/remotes.json, mode 0600. Never in config.toml. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "../agent/config.ts";
import { writePrivate } from "../agent/private-file.ts";

export interface RemoteSecret {
	readonly key: string;
	readonly token?: string;
}

export function remoteSecretsPath(config: HarnessConfig): string {
	return join(config.dataDir, "remotes.json");
}

function load(config: HarnessConfig): Record<string, RemoteSecret> {
	const path = remoteSecretsPath(config);
	if (!existsSync(path)) return {};
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		data = undefined; // never the parser's message: it quotes the input
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error(`${path}: remotes.json is not valid JSON; fix it or add the remotes again`);
	return data as Record<string, RemoteSecret>;
}

export function readRemoteSecret(config: HarnessConfig, name: string): RemoteSecret | undefined {
	const secret = load(config)[name];
	return secret !== undefined && typeof secret.key === "string" ? secret : undefined;
}

export function saveRemoteSecret(config: HarnessConfig, name: string, secret: RemoteSecret): void {
	const data = load(config);
	data[name] = secret;
	writePrivate(remoteSecretsPath(config), `${JSON.stringify(data, null, 2)}\n`);
}

export function removeRemoteSecret(config: HarnessConfig, name: string): void {
	const data = load(config);
	if (!(name in data)) return;
	delete data[name];
	writePrivate(remoteSecretsPath(config), `${JSON.stringify(data, null, 2)}\n`);
}
