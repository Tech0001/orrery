import { PassThrough } from "node:stream";
import { loginCommand } from "../../src/cli/logins.ts";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { openrouterSignIn } from "../../src/agent/openrouter-signin.ts";
import { signIn, saveKey, loginRows } from "../../src/agent/logins.ts";
import { summarySources } from "../../src/agent/summary-sources.ts";
import { parseConfig } from "../../src/agent/config.ts";
import { tempDir } from "./support.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const never = () => new Promise<string>(() => {});
async function fake(status = 200, body = JSON.stringify({ key: "synthetic-issued-key" })) {
	const requests: { url?: string; method?: string; body: Record<string, string> }[] = [];
	const server = createServer(async (req, res) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		requests.push({ url: req.url, method: req.method, body: JSON.parse(text) });
		res.writeHead(status, { "content-type": "application/json" }); res.end(body);
	});
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { requests, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
function interaction(action: (url: URL) => Promise<string | void>, manual = false) {
	let auth!: URL;
	let callback!: URL;
	let actionDone = Promise.resolve<string | void>(undefined);
	const notices: unknown[] = [];
	const io: AuthInteraction = {
		notify: (event) => {
			notices.push(event);
			if (event.type === "auth_url") { auth = new URL(event.url); callback = new URL(auth.searchParams.get("callback_url")!); callback.searchParams.set("state", auth.searchParams.get("state") ?? ""); if (!manual) actionDone = action(callback); }
		},
		prompt: async (prompt) => {
			expect(prompt.type).toBe("manual_code");
			if (manual) return (await action(callback))!;
			return never();
		},
	};
	return { io, notices, auth: () => auth, callback: () => callback, done: () => actionDone };
}
async function freed(url: URL) {
	const server = createServer();
	await new Promise<void>((done, fail) => server.once("error", fail).listen(Number(url.port), "127.0.0.1", done));
	await new Promise<void>((done) => server.close(() => done()));
}

describe("OpenRouter PKCE", () => {
	it("binds S256 and state to a loopback callback, exchanges the exact shape, closes the port and never reports the key", async () => {
		const api = await fake();
		const flow = interaction(async (url) => { url.searchParams.set("code", "synthetic-code"); const res = await fetch(url); expect(await res.text()).toContain("close this tab"); });
		expect(await openrouterSignIn(flow.io, { baseUrl: api.baseUrl })).toBe("synthetic-issued-key");
		await flow.done();
		const request = api.requests[0];
		expect(request.url).toBe("/api/v1/auth/keys");
		expect(request.method).toBe("POST");
		expect(request.body).toMatchObject({ code: "synthetic-code", code_challenge_method: "S256" });
		expect(request.body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
		expect(flow.auth().searchParams.get("code_challenge")).toBe(createHash("sha256").update(request.body.code_verifier).digest("base64url"));
		expect(flow.auth().searchParams.get("key_label")).toBe("Orrery");
		expect(new URL(flow.auth().searchParams.get("callback_url")!).search).toBe("");
		expect(flow.auth().searchParams.get("state")!.length).toBeGreaterThan(20);
		expect(JSON.stringify(flow.notices)).not.toContain("synthetic-issued-key");
		await freed(flow.callback());
	});

	it.each(["missing", "wrong"])("returns 400 for %s state and still accepts the later valid callback", async (kind) => {
		const api = await fake();
		const flow = interaction(async (url) => {
			const bad = new URL(url);
			bad.searchParams.set("code", "ignored-code");
			if (kind === "missing") bad.searchParams.delete("state");
			else bad.searchParams.set("state", "wrong");
			const response = await fetch(bad);
			expect(response.status).toBe(400);
			expect(response.headers.get("content-type")).toContain("text/plain");
			expect(await response.text()).not.toContain("ignored-code");
			expect(api.requests).toHaveLength(0);
			url.searchParams.set("code", "valid-code");
			expect((await fetch(url)).status).toBe(200);
		});
		const result = openrouterSignIn(flow.io, { baseUrl: api.baseUrl, timeoutMs: 1000 });
		const outcome = result.catch((error) => error);
		expect(await outcome).toBe("synthetic-issued-key");
		await flow.done();
		expect(api.requests.map((r) => r.body.code)).toEqual(["valid-code"]);
		await freed(flow.callback());
	});

	it.each(["missing", "wrong"])("does not let a denial callback with %s state end the pending login", async (kind) => {
		const api = await fake();
		const flow = interaction(async (url) => {
			if (kind === "missing") url.searchParams.delete("state"); else url.searchParams.set("state", "wrong");
			url.searchParams.set("error", "access_denied");
			const response = await fetch(url);
			expect(response.status).toBe(400);
			expect(response.headers.get("content-type")).toContain("text/plain");
		});
		// Long enough for the denial request to arrive on a loaded machine; the point is that it does not end the login.
		await expect(openrouterSignIn(flow.io, { baseUrl: api.baseUrl, timeoutMs: 500 })).rejects.toThrow(/timed out/);
		await flow.done();
		expect(api.requests).toHaveLength(0);
		await freed(flow.callback());
	});

	it("ends immediately on an authenticated denial, without echoing provider error text", async () => {
		const api = await fake();
		let response!: Response;
		const flow = interaction(async (url) => {
			url.searchParams.set("error", "synthetic-private-error");
			url.searchParams.set("error_description", "synthetic-private-description");
			response = await fetch(url);
		});
		const outcome = openrouterSignIn(flow.io, { baseUrl: api.baseUrl, timeoutMs: 1000 }).catch((error: Error) => error.message);
		expect(await outcome).toBe("OpenRouter sign-in was denied.");
		await flow.done();
		expect(response.headers.get("content-type")).toContain("text/plain");
		expect(await response.text()).toBe("OpenRouter sign-in was denied.");
		expect(api.requests).toHaveLength(0);
		expect(JSON.stringify(flow.notices)).not.toContain("synthetic-private");
		await freed(flow.callback());
	});

	it.each([[403, '{"error":"synthetic-secret"}'], [500, "synthetic-secret"], [200, "synthetic-secret"], [200, '{"key":12}'], [302, ""]])("scrubs a bad exchange (%s)", async (status, body) => {
		const api = await fake(status as number, body as string);
		const flow = interaction(async () => "synthetic-code", true);
		const error = await openrouterSignIn(flow.io, { baseUrl: api.baseUrl }).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain("synthetic-secret");
		await freed(flow.callback());
	});

	it.each(["code", "url"])("accepts a manual %s", async (kind) => {
		const api = await fake();
		const flow = interaction(async (url) => { url.searchParams.set("code", "manual-code"); return kind === "code" ? "manual-code" : url.href; }, true);
		expect(await openrouterSignIn(flow.io, { baseUrl: api.baseUrl })).toBe("synthetic-issued-key");
		expect(api.requests[0].body.code).toBe("manual-code");
		await freed(flow.callback());
	});

	it.each(["timeout", "cancel", "prompt"])("frees the port on %s even if a prompt ignores cancellation", async (kind) => {
		const controller = new AbortController();
		const flow = interaction(async () => {}, false);
		flow.io.signal = controller.signal;
		if (kind === "prompt") flow.io.prompt = async () => { throw new Error("user cancelled"); };
		const result = openrouterSignIn(flow.io, { timeoutMs: 50 });
		if (kind === "cancel") setTimeout(() => controller.abort(), 10);
		await expect(result).rejects.toThrow(kind === "timeout" ? /timed out/ : /cancelled/);
		await freed(flow.callback());
	});

	it("uses the one OpenRouter slot, records origin, replaces both ways with a notice, and saves at 0600", async () => {
		const api = await fake();
		const dir = tempDir("orrery-pkce-"); dirs.push(dir);
		const sources = summarySources(parseConfig(`data_dir = ${JSON.stringify(dir)}\n`, dir));
		await saveKey(sources, "openrouter", "synthetic-pasted-key");
		const flow = interaction(async () => "synthetic-code", true);
		await signIn(sources, flow.io, "openrouter", { baseUrl: api.baseUrl });
		expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
		const rows = (await loginRows(sources, [], {})).filter((r) => r.provider === "openrouter");
		expect(rows.map((r) => r.group)).toEqual(["signin", "key"]);
		expect(rows.every((r) => r.state === "saved" && r.note === "from sign-in")).toBe(true);
		expect(JSON.stringify(flow.notices)).toContain("Replaced the pasted OpenRouter key");
		const notices: string[] = [];
		await saveKey(sources, "openrouter", "synthetic-new-key", (s) => notices.push(s));
		expect(notices.join()).toContain("Replaced the OpenRouter key from sign-in");
		expect((await loginRows(sources, [], {})).filter((r) => r.provider === "openrouter").every((r) => r.note === "pasted key")).toBe(true);
		expect(JSON.stringify([...rows, ...notices, ...flow.notices])).not.toMatch(/synthetic-(issued|pasted|new)-key/);
	});
});


it("CLI manual sign-in prints the URL, hides pasted input and saves without exposing the issued key", async () => {
	const api = await fake();
	const dir = tempDir("orrery-pkce-cli-"); dirs.push(dir);
	const config = parseConfig(`data_dir = ${JSON.stringify(dir)}\n`, dir);
	const input = new PassThrough();
	const output = new PassThrough();
	let shown = "";
	output.on("data", (chunk) => { shown += String(chunk); if (String(chunk).includes("paste the redirect URL or code:")) setImmediate(() => input.write("manual-code\n")); });
	expect(await loginCommand(config, { signin: "openrouter", manual: true }, { input, output, terminal: true }, { baseUrl: api.baseUrl })).toBe("Signed in to OpenRouter.\n");
	expect(shown).toContain("Open: http://127.0.0.1:");
	expect(shown).not.toContain("manual-code");
	expect(shown).not.toContain("synthetic-issued-key");
});

it("rejects a pasted redirect with the wrong state without exchanging", async () => {
	const api = await fake();
	const flow = interaction(async (url) => { url.searchParams.set("state", "wrong"); url.searchParams.set("code", "manual-code"); return url.href; }, true);
	await expect(openrouterSignIn(flow.io, { baseUrl: api.baseUrl })).rejects.toThrow(/state/);
	expect(api.requests).toHaveLength(0);
	await freed(flow.callback());
});
