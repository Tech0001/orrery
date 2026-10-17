/**
 * The plugin-load check (spec 2026-10-16-opencode-design, "Launch"; research note, live test §9): OpenCode's V2 plugin
 * API is new and changes between versions, and a plugin that fails to load leaves a session without memory or guard,
 * with no word in the TUI. So before OpenCode opens an agent, an OpenCode version (with this Orrery) that has not been
 * verified is asked whether Orrery's plugin loads: a private `opencode serve --stdio --port 0` in a scratch home
 * (src/opencode/scratch.ts) is given the launch's own OPENCODE_CONFIG_CONTENT, and its plugin list (GET /api/plugin)
 * is read until Orrery's plugin is active or failed. No model call, nothing written to the person's OpenCode setup. One
 * request at start is not enough: OpenCode loads plugins after its server answers. The last result is kept in
 * Orrery's home, in opencode-check.json (src/agent/load-check.ts).
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { get } from "node:http";
import { relative, isAbsolute } from "node:path";
import { type LoadCheck, loadCheckDetail, readLoadCheck, versionedCheck } from "../agent/load-check.ts";
import { cleanUpOnSignals, type SignalTarget } from "../agent/signal-cleanup.ts";
import { safeText } from "../agent/source-labels.ts";
import { makeScratch, type Scratch } from "./scratch.ts";

/** How long the private server may take to start, load the plugin and say so. */
const PROBE_MS = 10_000;
/** How often the plugin list is read. */
const POLL_MS = 100;
/** How long a plugin list without Orrery's plugin is taken as loading still, before it counts as an answer. */
const ABSENT_MS = 1_000;
/** The most of a plugin list read (2.0.30's is about 20 KB, with its built-in plugins). */
const LIST_MAX = 4 * 1024 * 1024;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const plain = (text: string) => safeText(text).slice(0, 300);

/** Whether `path` is `folder` or inside it, by its given path or its real one (OpenCode lists a loaded plugin's real file). */
function within(path: string, folder: string): boolean {
	const folders = new Set([folder]);
	try {
		folders.add(realpathSync(folder));
	} catch {
		// not there: the given path only
	}
	for (const root of folders) {
		const rel = relative(root, path);
		if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
	}
	return false;
}

/** Orrery's plugin in OpenCode's plugin list (its source is the plugin folder), the list's size, or undefined for a list in a shape Orrery doesn't know. */
function findPlugin(answer: unknown, folder: string): { readonly entry?: { readonly status?: unknown; readonly error?: unknown }; readonly size: number } | undefined {
	const data = (answer as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return undefined;
	for (const item of data as { source?: { type?: unknown; path?: unknown }; state?: { status?: unknown; error?: unknown } }[]) {
		const source = item?.source;
		if (source?.type === "local" && typeof source.path === "string" && within(source.path, folder)) return { entry: item.state ?? {}, size: data.length };
	}
	return { size: data.length };
}

/** GET `path` from the private server, as JSON; rejects on anything else. No proxy: the server is on this machine. */
function getJson(base: URL, path: string, password: string, timeoutMs: number): Promise<unknown> {
	return new Promise((done, fail) => {
		const request = get(new URL(path, base), { auth: `opencode:${password}`, timeout: timeoutMs }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
				if (body.length > LIST_MAX) request.destroy(new Error("the plugin list is too long"));
			});
			response.on("end", () => {
				if (response.statusCode !== 200) {
					fail(new Error(`HTTP ${response.statusCode}`));
					return;
				}
				try {
					done(JSON.parse(body));
				} catch {
					fail(new Error("the plugin list is not JSON"));
				}
			});
			response.on("error", fail);
		});
		request.on("timeout", () => request.destroy(new Error("no answer")));
		request.on("error", fail);
	});
}

/** The server's address from its first line (`{"url":"http://127.0.0.1:<port>"}`): on this machine only. */
function readyUrl(line: string): URL | undefined {
	try {
		const url = new URL((JSON.parse(line) as { url?: unknown }).url as string);
		return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? url : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether the plugin in `folder` loads in the OpenCode at `opencode`, given `content` (OPENCODE_CONFIG_CONTENT): a
 * private `opencode serve --stdio --port 0` in a scratch home and folder (removed after), its first line read for its
 * address and its plugin list read every 100 ms. Ends the server's lease (stdin) once it has an answer or after
 * `timeoutMs`. Never throws, and always settles. The scratch folder goes even when this process is stopped meanwhile,
 * by a Ctrl-C too (the server stops on its own when its stdin closes). `signals`: the process whose signals count
 * (default this one; tests give a stand-in).
 */
export function probePlugin(opencode: string, content: string, folder: string, options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number; readonly signals?: SignalTarget } = {}): Promise<LoadCheck> {
	const timeoutMs = options.timeoutMs ?? PROBE_MS;
	let scratch: Scratch;
	try {
		scratch = makeScratch(options.env ?? process.env);
	} catch (error) {
		return Promise.resolve({ ok: false, why: `no scratch folder for the check (${plain(errorText(error))})` });
	}
	const undo = cleanUpOnSignals(() => scratch.remove(), options.signals, ["SIGINT", "SIGTERM", "SIGHUP"]);
	const password = randomBytes(24).toString("base64url");
	const query = `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(scratch.cwd)}`;
	return new Promise<LoadCheck>((done) => {
		let answer: LoadCheck | undefined;
		let finished = false;
		let child: ReturnType<typeof spawn>;
		const timers: NodeJS.Timeout[] = [];
		const finish = () => {
			if (finished) return;
			finished = true;
			for (const timer of timers) clearTimeout(timer);
			undo();
			scratch.remove();
			done(answer ?? { ok: false, why: "OpenCode's server stopped before answering" });
		};
		try {
			// OPENCODE_PASSWORD: the server asks for it (user "opencode"), as OpenCode's own --standalone does.
			child = spawn(opencode, ["serve", "--stdio", "--port", "0"], { cwd: scratch.cwd, env: { ...scratch.env, OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: content }, stdio: ["pipe", "pipe", "ignore"] });
		} catch (error) {
			answer = { ok: false, why: `OpenCode's server could not start (${plain(errorText(error))})` };
			finish();
			return;
		}
		let stopping = false;
		/** Ends the lease: the server stops on its own when stdin closes; a server that doesn't is stopped. */
		const stop = (result: LoadCheck) => {
			answer ??= result;
			if (stopping || finished) return;
			stopping = true;
			child.stdin?.end();
			timers.push(setTimeout(() => child.kill("SIGTERM"), 3_000), setTimeout(() => child.kill("SIGKILL"), 5_000));
		};
		timers.push(setTimeout(() => stop({ ok: false, why: `OpenCode's server did not answer within ${timeoutMs / 1000} s` }), timeoutMs));
		child.on("error", (error) => {
			answer ??= { ok: false, why: `OpenCode's server could not start (${plain(errorText(error))})` };
			finish();
		});
		child.on("exit", (code, signal) => {
			answer ??= { ok: false, why: `OpenCode's server stopped before answering (${signal === null ? `exit ${code}` : signal})` };
			finish();
		});
		child.stdin?.on("error", () => {}); // it may be gone before the lease ends: its exit says so
		let output = "";
		let base: URL | undefined;
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (data: string) => {
			// The server writes on after its first line; it is read and dropped, so it never blocks.
			if (base !== undefined || answer !== undefined) return;
			output += data;
			const end = output.indexOf("\n");
			if (end === -1) {
				if (output.length > 64 * 1024) stop({ ok: false, why: "OpenCode's server did not say where it listens" });
				return;
			}
			base = readyUrl(output.slice(0, end));
			if (base === undefined) {
				stop({ ok: false, why: `OpenCode's server did not say where it listens (it said ${plain(output.slice(0, end))})` });
				return;
			}
			void poll(base);
		});
		/** Reads the plugin list until Orrery's plugin is active or failed, or a full list without it stays so. */
		const poll = async (url: URL) => {
			let absentSince: number | undefined;
			while (answer === undefined) {
				let list: unknown;
				try {
					list = await getJson(url, query, password, 2_000);
				} catch (error) {
					stop({ ok: false, why: `OpenCode's plugin list could not be read (${plain(errorText(error))})` });
					return;
				}
				const found = findPlugin(list, folder);
				if (found === undefined) {
					stop({ ok: false, why: "OpenCode's plugin list was not in a shape Orrery knows" });
					return;
				}
				const status = found.entry?.status;
				if (status === "active") {
					stop({ ok: true });
					return;
				}
				if (status === "failed") {
					stop({ ok: false, why: `OpenCode could not load Orrery's plugin (${plain(String(found.entry?.error ?? "no reason given").split("\n")[0] as string)})` });
					return;
				}
				// An empty list: OpenCode is still loading. A full one without the plugin: wait a little, then say so.
				if (found.entry === undefined && found.size > 0) {
					absentSince ??= Date.now();
					if (Date.now() - absentSince >= ABSENT_MS) {
						stop({ ok: false, why: "OpenCode loaded its plugins without Orrery's (a policy or a config may leave it out)" });
						return;
					}
				}
				await new Promise((wait) => setTimeout(wait, POLL_MS));
			}
		};
	});
}

const STATE = { file: "opencode-check.json", key: "opencode" } as const;

/** The last check: OpenCode's version, Orrery's version that checked, and what it found. */
export function readOpenCodeCheck(env: NodeJS.ProcessEnv = process.env) {
	return readLoadCheck(env, STATE.file, STATE.key);
}

export type OpenCodeGate = { readonly ok: true } | { readonly ok: false; readonly text: string };

/**
 * Before OpenCode opens an agent: ok at once when this OpenCode version was verified by this Orrery version, else the
 * check (probePlugin), kept for next time. Not ok, or a check that could not run: the text that says so.
 */
export async function opencodePluginGate(
	target: { readonly path: string; readonly version?: string; readonly content: string; readonly folder: string },
	options: { readonly env?: NodeJS.ProcessEnv; readonly orrery: string; readonly probe?: typeof probePlugin; readonly now?: () => number; readonly onCheck?: () => void },
): Promise<OpenCodeGate> {
	const env = options.env ?? process.env;
	const result = await versionedCheck(target.version, { env, orrery: options.orrery, ...STATE, ...(options.now === undefined ? {} : { now: options.now }), ...(options.onCheck === undefined ? {} : { onCheck: options.onCheck }) }, () =>
		(options.probe ?? probePlugin)(target.path, target.content, target.folder, { env }),
	);
	if (result.ok) return { ok: true };
	return { ok: false, text: `Orrery's plugin doesn't load in OpenCode ${target.version ?? "(its version is unknown)"}: ${result.why}. Without it a session has no memory and no guard.` };
}

/** The Tools page's word on the check: which OpenCode it verified, or what happens at the next launch. */
export function opencodeCheckDetail(env: NodeJS.ProcessEnv, version: string | undefined, orrery: string): string {
	return loadCheckDetail(readOpenCodeCheck(env), version, orrery, { what: "plugin", are: "is", tool: "OpenCode" });
}
