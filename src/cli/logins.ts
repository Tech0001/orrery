/** `orrery login`, `orrery logins`, `orrery logout`: summary logins, kept in orrery's credential file (0600). */

import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { HarnessConfig } from "../lane/config.ts";
import type { OpenRouterSignInOptions } from "../lane/openrouter-signin.ts";
import { pageOpener } from "../lane/lane-commands.ts";
import { loginRows, readPiKey, removeLogin, saveKey, signIn } from "../lane/logins.ts";
import { KEY_NOT_NAME, listSources, looksLikeKey, openSummarySources, providerFor, providerLabel } from "../lane/summary-sources.ts";
import { formatSources } from "../lane/summary-text.ts";

export { readPiKey } from "../lane/logins.ts";

export interface SecretIo {
	readonly input: NodeJS.ReadableStream;
	readonly output: NodeJS.WritableStream;
	/** Terminal mode (default: whether input is a TTY). */
	readonly terminal?: boolean;
}

const STDIO: SecretIo = { input: process.stdin, output: process.stdout };

/** Reads one line without echoing it: readline echoes into a sink that drops everything. */
export async function readSecret(message: string, io: SecretIo = STDIO, signal?: AbortSignal): Promise<string> {
	io.output.write(`${message} `);
	const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
	const rl = createInterface({ input: io.input, output: sink, terminal: io.terminal ?? (io.input as { isTTY?: boolean }).isTTY === true });
	const cancelled = new AbortController();
	const cancel = () => cancelled.abort();
	const escape = (data: unknown) => { if (String(data) === "\x1b") cancel(); };
	rl.on("SIGINT", cancel);
	// EOF ends key entry, but the browser can still finish a pending sign-in.
	if (signal === undefined) rl.on("close", cancel);
	io.input.on("data", escape);
	try {
		return (await rl.question("", { signal: signal === undefined ? cancelled.signal : AbortSignal.any([signal, cancelled.signal]) })).trim();
	} finally {
		io.input.off("data", escape);
		rl.close();
		io.output.write("\n");
	}
}

export interface LoginRequest {
	readonly signin?: string;
	readonly key?: string;
	readonly fromPi?: boolean;
	readonly manual?: boolean;
}

export async function loginCommand(config: HarnessConfig, request: LoginRequest, io: SecretIo = STDIO, options: OpenRouterSignInOptions = {}): Promise<string> {
	const sources = await openSummarySources(config);
	if (request.key !== undefined) {
		const key = request.fromPi ? readPiKey(request.key) : await readSecret(`${providerLabel(providerFor(config, "key", request.key))} API key (hidden):`, io);
		const label = await saveKey(sources, request.key, key, (text) => io.output.write(`${text}\n`));
		return `Saved the ${label} key${request.fromPi ? " from pi" : ""}.\n`;
	}
	const name = request.signin ?? "";
	if (config.providers.some((p) => p.id === name)) throw new Error(`${name} is a local server: it needs no login (a key, if any, comes from api_key_env in the config).`);
	// Never the typed name: it may be a key pasted in the wrong place.
	if (name !== "openai" && name !== "openrouter") throw new Error(looksLikeKey(name) ? KEY_NOT_NAME : "Sign in is for openai (ChatGPT) or openrouter; for a key use orrery login --key <openai|anthropic|openrouter>.");
	const controller = new AbortController();
	const timeout = new Error(`${name === "openrouter" ? "OpenRouter" : "ChatGPT"} sign-in timed out.`);
	const timer = setTimeout(() => controller.abort(timeout), options.timeoutMs ?? 180_000);
	const cancel = () => controller.abort();
	process.on("SIGINT", cancel);
	const interaction: AuthInteraction = {
		signal: controller.signal,
		prompt: async (prompt) => {
			if (prompt.type === "secret" || prompt.type === "manual_code") return readSecret(prompt.message, io, prompt.signal);
			const rl = createInterface({ input: io.input, output: io.output });
			try {
				if (prompt.type === "select") {
					prompt.options.forEach((option, index) => io.output.write(`  ${index + 1}. ${option.label}\n`));
					const answer = (await rl.question(`${prompt.message} `, { signal: prompt.signal })).trim();
					return prompt.options[Number(answer) - 1]?.id ?? answer;
				}
				return (await rl.question(`${prompt.message} `, { signal: prompt.signal })).trim();
			} finally {
				rl.close();
			}
		},
		notify: (event) => {
			if (event.type === "auth_url") {
				io.output.write(`Open: ${event.url}\n${event.instructions ?? ""}\n`);
				if (!request.manual && process.env.ORRERY_NO_OPEN !== "1") pageOpener()?.open(event.url);
			}
			else if (event.type === "device_code") io.output.write(`Code ${event.userCode} at ${event.verificationUri}\n`);
			else io.output.write(`${event.message}\n`);
		},
	};
	try {
		await signIn(sources, interaction, name, options);
		return `Signed in to ${name === "openrouter" ? "OpenRouter" : "ChatGPT"}.\n`;
	} catch (error) {
		// Providers can replace the abort reason with their own generic cancellation message.
		if (controller.signal.reason === timeout) throw timeout;
		throw error;
	} finally {
		clearTimeout(timer);
		process.off("SIGINT", cancel);
	}
}

export async function loginsCommand(config: HarnessConfig, options: { json?: boolean } = {}): Promise<string> {
	const sources = await openSummarySources(config);
	if (options.json === true) {
		const { laneOverview } = await import("../lane/overview.ts");
		return `${JSON.stringify({ logins: await loginRows(sources, laneOverview(config)) }, null, 2)}\n`;
	}
	return `${formatSources(await listSources(sources))}\nAdd: orrery login openai|openrouter · orrery login --key <openai|anthropic|openrouter> [--from-pi]\n`;
}

export async function logoutCommand(config: HarnessConfig, request: { readonly signin?: string; readonly key?: string }): Promise<string> {
	return removeLogin(await openSummarySources(config), request);
}
