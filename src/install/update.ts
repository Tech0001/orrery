/**
 * orrery update and the daily update check (spec 2026-10-13-orrery-releases-design §6, 2026-10-15-update-notices): the
 * TUI and the pi, OMP and Claude Code sessions share one cached answer, asked for at most once a day. Releases come from
 * ORRERY_RELEASES_URL (default GitHub's): <base>/latest redirects to <base>/tag/v<version>, and assets are at
 * <base>/download/v<version>/<asset>. A download from an https base follows only https redirects, and is checked
 * against SHA256SUMS before anything is unpacked.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { orreryHome } from "../agent/home.ts";

const DEFAULT_BASE = "https://github.com/Tech0001/orrery/releases";
const DAY_MS = 24 * 60 * 60 * 1000;
const RELEASE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
/** A release or a local build of one (0.6.0, 0.6.0-<commit>); not "checkout" or "unknown". */
const VERSION_START = /^[0-9]+\.[0-9]+\.[0-9]+/;

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

/**
 * Whether something running `running` must restart to run the installed `installed`: another build than it, and not a
 * newer release (0.6.0-aaa under an installed 0.6.0-bbb must; one left newer by a rollback need not). A checkout, an
 * unknown version, or nothing installed never must.
 */
export function needsRestart(running: string | undefined, installed: string | undefined): boolean {
	if (running === undefined || installed === undefined || !VERSION_START.test(running) || !VERSION_START.test(installed)) return false;
	return running !== installed && !newer(running, installed);
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

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 10;

/**
 * `url`'s final answer, following redirects one hop at a time (GitHub sends a release asset to another host). From an
 * https URL, a hop to anything but https is refused before it is requested.
 */
async function follow(url: string, signal: AbortSignal, onHop: () => void): Promise<{ res: Response; at: string }> {
	const httpsOnly = new URL(url).protocol === "https:";
	let at = url;
	for (let hop = 0; ; hop++) {
		const res = await fetch(at, { redirect: "manual", signal, headers: { "user-agent": "orrery-update" } });
		const location = res.headers.get("location");
		if (!REDIRECTS.has(res.status) || location === null) return { res, at };
		await res.body?.cancel();
		if (hop === MAX_HOPS) throw new Error(`${url}: more than ${MAX_HOPS} redirects`);
		const next = new URL(location, at).href;
		if (httpsOnly && new URL(next).protocol !== "https:") throw new Error(`${at} redirects to ${next}, which is not https; nothing was installed`);
		onHop();
		at = next;
	}
}

/** The body of `url`, with a timer that restarts on the headers (of each redirect too) and on every chunk. */
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
		const { res, at } = await follow(url, control.signal, arm);
		arm();
		if (res.status === 404) throw new NotFound(at);
		if (!res.ok || res.body === null) throw new Error(`${at}: ${res.status}`);
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

const cacheFile = (env: NodeJS.ProcessEnv) => join(orreryHome(env), "update-check.json");

function readCache(env: NodeJS.ProcessEnv): Cache | undefined {
	try {
		const cache = JSON.parse(readFileSync(cacheFile(env), "utf8")) as Partial<Cache> | null;
		if (typeof cache !== "object" || cache === null || typeof cache.checkedAt !== "number") return undefined;
		return typeof cache.latest === "string" && RELEASE.test(cache.latest) ? { checkedAt: cache.checkedAt, latest: cache.latest } : { checkedAt: cache.checkedAt };
	} catch {
		return undefined;
	}
}

const stale = (cache: Cache | undefined, now: number) => cache === undefined || now - cache.checkedAt >= DAY_MS || now < cache.checkedAt;

/**
 * The cached answer, read at once with no request: the latest release it names, and whether it is missing or a day old
 * (refreshUpdateCache asks again then). A session reads this; it never waits on the network.
 */
export function cachedUpdate(env: NodeJS.ProcessEnv, now: number): { latest?: string; stale: boolean } {
	const cache = readCache(env);
	return { ...(cache?.latest === undefined ? {} : { latest: cache.latest }), stale: stale(cache, now) };
}

function writeCache(env: NodeJS.ProcessEnv, cache: Cache): void {
	const file = cacheFile(env);
	const temp = `${file}.tmp-${process.pid}`;
	try {
		writeFileSync(temp, JSON.stringify(cache), { mode: 0o600 });
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/**
 * When this process last asked, per cache file: it asks at most once a day even when the answer cannot be written (a
 * session looks on every status tick).
 */
const asked = new Map<string, number>();

/** A lock older than this was left by a process that died while asking (a request takes at most 5 s). */
const LOCK_STALE_MS = 60_000;

/** Takes <home>/update-check.json.lock, so one process asks while the others go on with the cache; false when another holds it. */
function takeLock(lock: string, now: number): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
			return true;
		} catch (error) {
			if ((error as { code?: unknown }).code !== "EEXIST") return false;
			try {
				if (now - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
				rmSync(lock, { force: true });
			} catch {
				// gone meanwhile: try again
			}
		}
	}
	return false;
}

/**
 * Asks for the latest release (5 s at most) when the cache is missing or a day old, and caches the answer; at most one
 * request a day, shared by every process through <home>/update-check.json. A failed request keeps the last answer and is
 * not tried again that day. Never throws; the caller decides whether checks are on ([updates] check).
 */
export async function refreshUpdateCache(env: NodeJS.ProcessEnv, now: number): Promise<void> {
	let lock: string;
	try {
		if (!stale(readCache(env), now)) return;
		mkdirSync(orreryHome(env), { recursive: true, mode: 0o700 });
		lock = `${cacheFile(env)}.lock`;
		if (!takeLock(lock, now)) return;
	} catch {
		// a home that cannot be written: check again next time
		return;
	}
	try {
		// Another process may have asked while this one took the lock.
		const before = readCache(env);
		const last = asked.get(lock);
		if (!stale(before, now) || (last !== undefined && !stale({ checkedAt: last }, now))) return;
		asked.set(lock, now);
		let latest = before?.latest;
		try {
			latest = await latestVersion(env, { timeoutMs: 5_000 });
		} catch {
			// offline or GitHub unreachable: the last answer stands, and no second try today
		}
		writeCache(env, { checkedAt: now, ...(latest === undefined ? {} : { latest }) });
	} catch {
		// a home that cannot be written: check again next time
	} finally {
		rmSync(lock, { force: true });
	}
}

/**
 * For a long-lived process (Claude Code's recorder): refreshUpdateCache now and every `everyMs` (a no-op while the cache
 * is fresh), so a session that runs for days still checks once a day. The timer never keeps the process alive. Returns
 * what stops it.
 */
export function refreshEvery(env: NodeJS.ProcessEnv, everyMs = 60 * 60 * 1000): () => void {
	const run = () => void refreshUpdateCache(env, Date.now()).catch(() => {});
	run();
	const timer = setInterval(run, everyMs);
	timer.unref?.();
	return () => clearInterval(timer);
}

/** The newest release when it is newer than what `orrery update` would replace: the installed version, else `running`. */
export function availableRelease(env: NodeJS.ProcessEnv, latest: string | undefined, running: string | undefined): string | undefined {
	const base = installedVersion(env) ?? running;
	return latest !== undefined && base !== undefined && VERSION_START.test(base) && newer(latest, base) ? latest : undefined;
}

/** The TUI header's notice ("0.6.1 available · run orrery update"): the daily check, then the cached answer. */
export async function updateCheck(env: NodeJS.ProcessEnv, now: number, options: { enabled: boolean; running: string }): Promise<string | undefined> {
	if (!options.enabled) return undefined;
	await refreshUpdateCache(env, now);
	const latest = availableRelease(env, cachedUpdate(env, now).latest, options.running);
	return latest === undefined ? undefined : `${latest} available · run orrery update`;
}
