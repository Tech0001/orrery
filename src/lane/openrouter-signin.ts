/** OpenRouter's public PKCE flow. The issued API key belongs to Orrery, independently of Ori's login. */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AuthInteraction } from "@earendil-works/pi-ai";

export interface OpenRouterSignInOptions {
	/** Local fake service in tests only; never read from config or environment. */
	readonly baseUrl?: string;
	readonly timeoutMs?: number;
}

/** Exchanges a browser callback or manually pasted code; never includes provider responses in errors. */
export async function openrouterSignIn(interaction: AuthInteraction, options: OpenRouterSignInOptions = {}): Promise<string> {
	const verifier = randomBytes(32).toString("base64url");
	const state = randomBytes(32).toString("base64url");
	const controller = new AbortController();
	const manual = new AbortController();
	const cancelled = () => controller.abort(new Error("OpenRouter sign-in cancelled."));
	interaction.signal?.addEventListener("abort", cancelled, { once: true });
	if (interaction.signal?.aborted) cancelled();
	const timer = setTimeout(() => controller.abort(new Error("OpenRouter sign-in timed out.")), options.timeoutMs ?? 180_000);
	const signal = controller.signal;
	let accept!: (code: string) => void;
	const callback = new Promise<string>((resolve) => { accept = resolve; });
	callback.catch(() => {});
	let redirect: URL;
	const validateCallback = (url: URL): void => {
		if (url.origin !== redirect.origin || url.pathname !== redirect.pathname || url.searchParams.get("state") !== state) throw new Error("OpenRouter sign-in state did not match; try again.");
	};
	const codeFromUrl = (url: URL): string => {
		validateCallback(url);
		if (url.searchParams.has("error")) throw new Error("OpenRouter sign-in was denied.");
		return validCode(url.searchParams.get("code") ?? "");
	};
	const server = createServer((req, res) => {
		res.setHeader("content-type", "text/plain; charset=utf-8");
		res.setHeader("cache-control", "no-store");
		res.setHeader("connection", "close");
		const url = new URL(req.url ?? "/", redirect);
		if (req.method !== "GET" || url.pathname !== "/callback") { res.writeHead(404); res.end("Not found."); return; }
		try {
			validateCallback(url);
			if (url.searchParams.has("error")) {
				const denial = new Error("OpenRouter sign-in was denied.");
				res.end(denial.message, () => controller.abort(denial));
				return;
			}
			const code = validCode(url.searchParams.get("code") ?? "");
			res.end("Orrery received your sign-in. You can close this tab.", () => accept(code));
		} catch {
			res.writeHead(400); res.end("Sign-in could not finish. Return to Orrery.");
		}
	});
	server.requestTimeout = 5000;
	server.headersTimeout = 5000;
	const stopServer = async () => {
		const closed = new Promise<void>((done) => server.close(() => done()));
		server.closeAllConnections();
		await closed;
	};
	const aborted = new Promise<never>((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
	aborted.catch(() => {});
	try {
		signal.throwIfAborted();
		await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
		redirect = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/callback`);
		const base = options.baseUrl ?? "https://openrouter.ai";
		const auth = new URL("/auth", base);
		auth.searchParams.set("callback_url", redirect.href);
		auth.searchParams.set("state", state);
		auth.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
		auth.searchParams.set("code_challenge_method", "S256");
		auth.searchParams.set("key_label", "Orrery");
		interaction.notify({ type: "auth_url", url: auth.href, instructions: "Authorize Orrery. If the callback cannot reach this machine, paste the redirect URL or code here." });
		const pasted = Promise.resolve().then(() => interaction.prompt({ type: "manual_code", message: "Complete sign-in in your browser, or paste the redirect URL or code:", signal: AbortSignal.any([manual.signal, signal]) })).then((input) => {
			const text = input.trim();
			if (/^https?:\/\//i.test(text)) {
				let url: URL;
				try { url = new URL(text); } catch { throw new Error("The sign-in redirect URL is invalid."); }
				return codeFromUrl(url);
			}
			return validCode(text);
		}, () => { throw new Error("OpenRouter sign-in cancelled."); });
		const code = await Promise.race([callback, pasted, aborted]);
		manual.abort();
		await stopServer();
		interaction.notify({ type: "progress", message: "Finishing OpenRouter sign-in…" });
		try {
			const response = await fetch(new URL("/api/v1/auth/keys", base), {
				method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal,
				body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
			});
			if (!response.ok) { await response.body?.cancel(); throw new Error("exchange"); }
			const data: unknown = await response.json();
			const key = typeof data === "object" && data !== null && "key" in data ? data.key : undefined;
			if (typeof key !== "string" || key.length === 0 || key.length > 8192 || /[\s\p{Cc}]/u.test(key)) throw new Error("exchange");
			return key;
		} catch {
			if (signal.aborted) throw signal.reason;
			throw new Error("OpenRouter could not exchange the sign-in code. Run orrery login openrouter again.");
		}
	} finally {
		clearTimeout(timer);
		manual.abort();
		controller.abort();
		interaction.signal?.removeEventListener("abort", cancelled);
		await stopServer();
	}
}

function validCode(code: string): string {
	if (code.length === 0 || code.length > 8192 || /[\s\p{Cc}]/u.test(code)) throw new Error("No valid sign-in code received.");
	return code;
}
