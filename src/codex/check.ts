/**
 * The hook-load check (spec 2026-10-16-codex-design, decision 1): Codex skips a hook it does not trust without a word,
 * and its trust values and keys may change from one version to the next. So before Codex opens an agent, a Codex
 * version (with this Orrery) that has not been verified is asked whether Orrery's hooks load: its app server lists the
 * hooks the launch's `-c` flags give it, with their trust, in a scratch CODEX_HOME (no model call, nothing written to
 * the person's Codex home). The last result is kept in Orrery's home, in codex-check.json.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orreryHome } from "../agent/home.ts";
import { writePrivate } from "../agent/private-file.ts";
import { safeText } from "../agent/source-labels.ts";
import { CODEX_HOOKS, trustKey } from "./launch.ts";

export type HookCheck = { readonly ok: true } | { readonly ok: false; readonly why: string };

/** How long Codex's app server may take to start and answer. */
const PROBE_MS = 15_000;
/** The most of the app server's output read (its hook list is a few KB). */
const OUTPUT_MAX = 4 * 1024 * 1024;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const plain = (text: string) => safeText(text).slice(0, 300);

/** The hook list's first entry (one cwd was asked for), or why there is none. */
function hookList(result: unknown): { readonly hooks: readonly Record<string, unknown>[]; readonly errors: readonly Record<string, unknown>[] } | undefined {
	const entry = (result as { data?: unknown } | null)?.data;
	if (!Array.isArray(entry) || entry.length === 0) return undefined;
	const first = entry[0] as { hooks?: unknown; errors?: unknown };
	if (!Array.isArray(first.hooks)) return undefined;
	return { hooks: first.hooks as Record<string, unknown>[], errors: Array.isArray(first.errors) ? (first.errors as Record<string, unknown>[]) : [] };
}

/** Whether every Orrery hook is in the list, given by the session flags, trusted and on; else what is wrong. */
function judge(result: unknown): HookCheck {
	const list = hookList(result);
	if (list === undefined) return { ok: false, why: "Codex's hook list was not in a shape Orrery knows" };
	const error = list.errors[0];
	if (error !== undefined) return { ok: false, why: `Codex could not read the hooks: ${plain(String(error.message ?? ""))}` };
	for (const hook of CODEX_HOOKS) {
		const found = list.hooks.find((entry) => entry.key === trustKey(hook.event) && entry.source === "sessionFlags");
		if (found === undefined) return { ok: false, why: `Codex lists no ${hook.event} hook from Orrery` };
		if (found.trustStatus !== "trusted") return { ok: false, why: `Codex does not trust Orrery's ${hook.event} hook (${plain(String(found.trustStatus))})` };
		if (found.enabled !== true) return { ok: false, why: `Codex has Orrery's ${hook.event} hook turned off` };
	}
	return { ok: true };
}

/** What hooks/list answered (its JSON-RPC result), or why there is no answer. */
export type HookListing = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly why: string };

/**
 * Asks `codex app-server` (stdio JSON-RPC: initialize, then hooks/list) for the hooks `config` gives, with their trust.
 * It runs in a scratch CODEX_HOME and folder, both removed after, with no other CODEX_ variable (one could name the
 * person's own state), and is stopped once it has answered or after `timeoutMs`. Never throws, and always settles.
 * `home`: a prepared CODEX_HOME to ask instead of a scratch one, left as it is (tests).
 */
export function listHooks(codex: string, config: readonly string[], options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number; readonly home?: string } = {}): Promise<HookListing> {
	const timeoutMs = options.timeoutMs ?? PROBE_MS;
	let scratch: string;
	try {
		scratch = mkdtempSync(join(tmpdir(), "orrery-codex-check-"));
		mkdirSync(join(scratch, "home"), { mode: 0o700 });
		mkdirSync(join(scratch, "cwd"));
	} catch (error) {
		return Promise.resolve({ ok: false, why: `no scratch folder for the check (${plain(errorText(error))})` });
	}
	const cwd = join(scratch, "cwd");
	const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([key]) => !key.startsWith("CODEX_")));
	return new Promise<HookListing>((done) => {
		let answer: HookListing | undefined;
		let child: ReturnType<typeof spawn>;
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			try {
				rmSync(scratch, { recursive: true, force: true });
			} catch {
				// left in the temporary folder: the answer stands
			}
			done(answer ?? { ok: false, why: "Codex's app server stopped before answering" });
		};
		try {
			child = spawn(codex, ["app-server", ...config], { cwd, env: { ...env, CODEX_HOME: options.home ?? join(scratch, "home") }, stdio: ["pipe", "pipe", "ignore"] });
		} catch (error) {
			answer = { ok: false, why: `Codex's app server could not start (${plain(errorText(error))})` };
			finish();
			return;
		}
		let stopping: NodeJS.Timeout | undefined;
		const stop = (result: HookListing) => {
			answer ??= result;
			child.stdin?.end();
			child.kill("SIGTERM");
			stopping ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
		};
		const timer = setTimeout(() => stop({ ok: false, why: `Codex's app server did not answer within ${timeoutMs / 1000} s` }), timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			answer ??= { ok: false, why: `Codex's app server could not start (${plain(errorText(error))})` };
			finish();
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			if (stopping !== undefined) clearTimeout(stopping);
			answer ??= { ok: false, why: `Codex's app server stopped before answering (${signal === null ? `exit ${code}` : signal})` };
			finish();
		});
		child.stdin?.on("error", () => {}); // it may be gone before the questions are written: its exit says so
		let output = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (data: string) => {
			if (answer !== undefined) return;
			output += data;
			if (output.length > OUTPUT_MAX) {
				stop({ ok: false, why: "Codex's app server said too much" });
				return;
			}
			for (let end = output.indexOf("\n"); end !== -1; end = output.indexOf("\n")) {
				const line = output.slice(0, end);
				output = output.slice(end + 1);
				let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
				try {
					message = JSON.parse(line) as typeof message;
				} catch {
					continue; // not a message
				}
				if (message.id !== 2) continue;
				clearTimeout(timer);
				stop(message.error !== undefined ? { ok: false, why: `Codex could not list its hooks (${plain(String(message.error?.message ?? "no reason given"))})` } : { ok: true, result: message.result });
				return;
			}
		});
		const questions = [
			{ id: 1, method: "initialize", params: { clientInfo: { name: "orrery", version: "1" } } },
			{ method: "initialized" },
			{ id: 2, method: "hooks/list", params: { cwds: [cwd] } },
		];
		child.stdin?.write(`${questions.map((message) => JSON.stringify(message)).join("\n")}\n`);
	});
}

/** Whether Orrery's hooks load in the Codex at `codex`, given `config`: listHooks, then each hook found trusted and on. */
export async function probeHooks(codex: string, config: readonly string[], options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {}): Promise<HookCheck> {
	const listing = await listHooks(codex, config, options);
	return listing.ok ? judge(listing.result) : listing;
}

/** The last check, as codex-check.json keeps it. */
export interface CodexCheckState {
	/** Codex's version ("0.162.1"). */
	readonly codex: string;
	/** Orrery's version that checked (its hooks are its own). */
	readonly orrery: string;
	readonly ok: boolean;
	readonly why?: string;
	readonly at: string;
}

/** The state file, where Orrery's home really is (a home that is a link keeps it too). */
function stateFile(env: NodeJS.ProcessEnv): string {
	const home = orreryHome(env);
	try {
		return join(realpathSync(home), "codex-check.json");
	} catch {
		return join(home, "codex-check.json");
	}
}

/** The last check, or undefined when there is none or it cannot be read. */
export function readCodexCheck(env: NodeJS.ProcessEnv = process.env): CodexCheckState | undefined {
	try {
		const read = JSON.parse(readFileSync(stateFile(env), "utf8")) as Partial<CodexCheckState> | null;
		if (typeof read?.codex !== "string" || typeof read.orrery !== "string" || typeof read.ok !== "boolean") return undefined;
		return { codex: read.codex, orrery: read.orrery, ok: read.ok, ...(typeof read.why === "string" ? { why: read.why } : {}), at: typeof read.at === "string" ? read.at : "" };
	} catch {
		return undefined;
	}
}

/** Keeps the check's result. One that cannot be written is not fatal: the next launch checks again. */
function writeCodexCheck(env: NodeJS.ProcessEnv, state: CodexCheckState): void {
	try {
		writePrivate(stateFile(env), `${JSON.stringify(state, null, 2)}\n`, { keepFolderMode: true });
	} catch {
		// not kept
	}
}

/**
 * Whether Codex may open the agent: ok; or not, with what to say. Orrery's hooks that don't load: a yes starts plain
 * Codex (withoutOrrery). A hook shell that prints (src/codex/shell.ts, `noisyShell`): the hooks load and record, so a
 * yes (to `question`) starts Codex as the agent all the same.
 */
export type CodexGate =
	| { readonly ok: true }
	| { readonly ok: false; readonly text: string }
	| { readonly ok: false; readonly text: string; readonly noisyShell: true; readonly question: string };

/** What the person is asked when the hooks don't load (default no). */
export const WITHOUT_ORRERY_QUESTION = "Start Codex without Orrery anyway? The session won't be recorded and the guard will be off.";
/** What is said when they say yes. */
export const WITHOUT_ORRERY_SAID = "Starting Codex without Orrery: this session isn't recorded and the guard is off.";

/**
 * Before Codex opens an agent: ok at once when this Codex version was verified by this Orrery version, else the check
 * (probeHooks), kept for next time. Not ok, or a check that could not run: the text that says so.
 */
export async function codexHookGate(
	target: { readonly path: string; readonly version?: string; readonly config: readonly string[] },
	options: { readonly env?: NodeJS.ProcessEnv; readonly orrery: string; readonly probe?: typeof probeHooks; readonly now?: () => number; readonly onCheck?: () => void },
): Promise<CodexGate> {
	const env = options.env ?? process.env;
	const saved = readCodexCheck(env);
	if (target.version !== undefined && saved?.ok === true && saved.codex === target.version && saved.orrery === options.orrery) return { ok: true };
	options.onCheck?.();
	const result = await (options.probe ?? probeHooks)(target.path, target.config, { env });
	if (target.version !== undefined) {
		const at = new Date((options.now ?? Date.now)()).toISOString();
		writeCodexCheck(env, { codex: target.version, orrery: options.orrery, ok: result.ok, ...(result.ok ? {} : { why: result.why }), at });
	}
	if (result.ok) return { ok: true };
	return { ok: false, text: `Orrery's hooks don't load in Codex ${target.version ?? "(its version is unknown)"}: ${result.why}. Without them a session has no memory and no guard.` };
}

/** The Tools page's word on the check: which Codex it verified, or what happens at the next launch. */
export function codexCheckDetail(env: NodeJS.ProcessEnv, version: string | undefined, orrery: string): string {
	const saved = readCodexCheck(env);
	if (saved === undefined) return version === undefined ? "hooks are checked at each launch" : "hooks are checked at the first launch";
	if (version === undefined) return `hooks checked with Codex ${saved.codex}; this Codex is checked at each launch`;
	if (saved.codex !== version) return `hooks checked with Codex ${saved.codex}; ${version} is checked at its first launch`;
	if (!saved.ok) return `hooks did not load in Codex ${version}: ${saved.why ?? "no reason kept"}`;
	if (saved.orrery !== orrery) return `hooks checked with Codex ${version} by Orrery ${saved.orrery}; checked again at the next launch`;
	return `hooks checked with Codex ${version}`;
}
