/**
 * orrery update and the TUI's daily notice (spec 2026-10-13-orrery-releases-design §6). Releases come from
 * ORRERY_RELEASES_URL (default GitHub's): <base>/latest redirects to <base>/tag/v<version>, and assets are at
 * <base>/download/v<version>/<asset>. A download is checked against SHA256SUMS before anything is unpacked.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { orreryHome } from "../lane/home.ts";

const DEFAULT_BASE = "https://github.com/Tech0001/orrery/releases";
const DAY_MS = 24 * 60 * 60 * 1000;
const RELEASE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export function releasesBase(env: NodeJS.ProcessEnv): string {
	return (env.ORRERY_RELEASES_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

/** orrery-<os>-<arch>.tar.gz for this machine. */
export function platformAsset(): string {
	const os = process.platform === "darwin" ? "darwin" : "linux";
	return `orrery-${os}-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`;
}

const parts = (v: string) => v.split("-")[0].split(".").map(Number);

/** Whether release `a` is newer than `b`; a local build (0.6.0-<commit>) counts as its release (0.6.0). */
export function newer(a: string, b: string): boolean {
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
	return false;
}

async function get(url: string, timeoutMs: number, redirect: "follow" | "manual"): Promise<Response> {
	return fetch(url, { redirect, signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "orrery-update" } });
}

/** The newest published release's version, from where <base>/latest redirects. */
export async function latestVersion(env: NodeJS.ProcessEnv, options: { timeoutMs?: number } = {}): Promise<string> {
	const res = await get(`${releasesBase(env)}/latest`, options.timeoutMs ?? 10_000, "manual");
	const location = res.headers.get("location") ?? "";
	let path = "";
	try {
		path = new URL(location, `${releasesBase(env)}/latest`).pathname;
	} catch {
		// not a URL: rejected below
	}
	const version = /\/tag\/v([^/]+)$/.exec(path)?.[1];
	if (res.status < 300 || res.status >= 400 || version === undefined || !RELEASE.test(version)) throw new Error(`could not tell the latest release from ${releasesBase(env)}/latest (${res.status})`);
	return version;
}

/** Where the installed `app/current` points: its VERSION (or the folder's name), or undefined when nothing is installed. */
export function installedVersion(env: NodeJS.ProcessEnv): string | undefined {
	try {
		const dir = realpathSync(join(orreryHome(env), "app", "current"));
		try {
			return readFileSync(join(dir, "VERSION"), "utf8").trim();
		} catch {
			return basename(dir);
		}
	} catch {
		return undefined;
	}
}

export interface DownloadOptions {
	/** Give up when nothing arrives (headers or a chunk) for this long; there is no total limit. Default 30 s. */
	idleMs?: number;
	/** Called as the archive arrives. */
	onProgress?: (bytes: number, total: number | undefined) => void;
	/** Aborts the download (a signal received while updating). */
	signal?: AbortSignal;
}

class NotFound extends Error {}

/** The body of `url`, with a timer that restarts on the headers and on every chunk. */
async function fetchBytes(url: string, options: DownloadOptions, progress: boolean): Promise<Buffer> {
	const idleMs = options.idleMs ?? 30_000;
	const control = new AbortController();
	const stop = () => control.abort();
	options.signal?.addEventListener("abort", stop);
	if (options.signal?.aborted) stop();
	let timer: NodeJS.Timeout | undefined;
	const arm = () => {
		clearTimeout(timer);
		timer = setTimeout(() => control.abort(new Error(`no data from ${url} for ${Math.round(idleMs / 1000)} s`)), idleMs);
	};
	try {
		arm();
		const res = await fetch(url, { redirect: "follow", signal: control.signal, headers: { "user-agent": "orrery-update" } });
		arm();
		if (res.status === 404) throw new NotFound(url);
		if (!res.ok || res.body === null) throw new Error(`${url}: ${res.status}`);
		const length = Number(res.headers.get("content-length"));
		const total = Number.isFinite(length) && length > 0 ? length : undefined;
		const chunks: Buffer[] = [];
		let bytes = 0;
		const reader = res.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			arm();
			chunks.push(Buffer.from(value));
			bytes += value.length;
			if (progress) options.onProgress?.(bytes, total);
		}
		return Buffer.concat(chunks);
	} catch (error) {
		if (control.signal.aborted && control.signal.reason instanceof Error) throw control.signal.reason;
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", stop);
	}
}

/** Downloads, checks and unpacks this machine's archive of `version` into `into`; returns the release folder. */
export async function downloadRelease(env: NodeJS.ProcessEnv, version: string, into: string, options: DownloadOptions = {}): Promise<string> {
	const asset = platformAsset();
	const base = `${releasesBase(env)}/download/v${version}`;
	mkdirSync(into, { recursive: true, mode: 0o700 });
	try {
		let archive: Buffer;
		let sums: Buffer;
		try {
			sums = await fetchBytes(`${base}/SHA256SUMS`, options, false);
			archive = await fetchBytes(`${base}/${asset}`, options, true);
		} catch (error) {
			if (error instanceof NotFound) throw new Error(`no Orrery release ${version} (${error.message})`);
			throw error;
		}
		const line = sums.toString("utf8").split("\n").find((l) => l.trim().split(/\s+\*?/)[1] === asset);
		if (line === undefined) throw new Error(`SHA256SUMS of ${version} has no line for ${asset}`);
		const want = line.trim().split(/\s+/)[0];
		const got = createHash("sha256").update(archive).digest("hex");
		if (want !== got) throw new Error(`${asset} does not match SHA256SUMS (expected ${want}, got ${got}); nothing was installed`);
		writeFileSync(join(into, asset), archive);
		const tar = spawnSync("tar", ["-xzf", join(into, asset), "-C", into], { encoding: "utf8" });
		if (tar.status !== 0) throw new Error(`could not unpack ${asset}: ${(tar.stderr ?? "").trim()}`);
		const top = readdirSync(into).filter((name) => name.startsWith("orrery-") && !name.endsWith(".tar.gz"));
		if (top.length !== 1) throw new Error(`${asset} does not hold one Orrery release`);
		const folder = join(into, top[0] as string);
		let held = "";
		try {
			held = readFileSync(join(folder, "VERSION"), "utf8").trim();
		} catch {
			// reported below
		}
		if (held !== version) throw new Error(`${asset} holds Orrery ${held === "" ? "with no VERSION" : held}, not ${version}; nothing was installed`);
		return folder;
	} catch (error) {
		rmSync(into, { recursive: true, force: true });
		throw error;
	}
}

interface Cache {
	checkedAt: number;
	latest?: string;
}

/** The TUI notice: at most one check a day (5 s, silent on failure), cached in <home>/update-check.json. */
export async function updateCheck(env: NodeJS.ProcessEnv, now: number, options: { enabled: boolean; running: string }): Promise<string | undefined> {
	if (!options.enabled) return undefined;
	const file = join(orreryHome(env), "update-check.json");
	let cache: Cache | undefined;
	try {
		cache = JSON.parse(readFileSync(file, "utf8")) as Cache;
	} catch {
		// first check
	}
	if (cache === undefined || typeof cache.checkedAt !== "number" || now - cache.checkedAt >= DAY_MS || now < cache.checkedAt) {
		let latest: string | undefined;
		try {
			latest = await latestVersion(env, { timeoutMs: 5_000 });
		} catch {
			// offline or GitHub unreachable: no notice, and no second try today
		}
		cache = { checkedAt: now, ...(latest === undefined ? {} : { latest }) };
		try {
			mkdirSync(orreryHome(env), { recursive: true, mode: 0o700 });
			const temp = `${file}.tmp-${process.pid}`;
			writeFileSync(temp, JSON.stringify(cache), { mode: 0o600 });
			renameSync(temp, file);
		} catch {
			// a home that cannot be written: check again next time
		}
	}
	return typeof cache.latest === "string" && RELEASE.test(cache.latest) && newer(cache.latest, options.running) ? `Orrery ${cache.latest} is available: orrery update` : undefined;
}
