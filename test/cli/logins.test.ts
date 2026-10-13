import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginCommand, loginsCommand, logoutCommand, readPiKey, readSecret } from "../../src/cli/logins.ts";
import { parseConfig } from "../../src/lane/config.ts";
import { KEY_NOT_NAME } from "../../src/lane/summary-sources.ts";
import { tempDir } from "../lane/support.ts";

const dirs: string[] = [];
beforeEach(() => {
	for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) vi.stubEnv(name, "");
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it.each(["openai", "openrouter"])("times out %s browser login at 180 seconds after stdin EOF and frees the callback port", async (provider) => {
	const { config } = setup();
	const input = new PassThrough();
	input.resume(); input.end();
	await new Promise<void>((done) => input.once("end", done));
	const output = new PassThrough();
	let auth!: URL;
	const ready = new Promise<void>((done) => output.on("data", (chunk) => {
		const text = String(chunk);
		if (text.startsWith("Open: ")) auth = new URL(text.split("\n")[0].slice(6));
		if (text.includes("or paste")) setImmediate(done);
	}));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network in timeout test"));
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const listeners = process.listenerCount("SIGINT");
	let settled = false;
	const outcome = loginCommand(config, { signin: provider, manual: true }, { input, output, terminal: false })
		.then(() => "unexpected success", (error: Error) => error.message).finally(() => { settled = true; });
	try {
		await ready;
		await vi.advanceTimersByTimeAsync(179_999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		// Server close completes on real I/O turns, independently of the fake clock.
		for (let i = 0; i < 20 && !settled; i++) await new Promise((done) => setImmediate(done));
		expect(settled).toBe(true);
		expect(await outcome).toMatch(/sign-in timed out\./);
		expect(input.listenerCount("data")).toBe(0);
		expect(process.listenerCount("SIGINT")).toBe(listeners);
		expect(vi.getTimerCount()).toBe(0);
		const callback = new URL(auth.searchParams.get(provider === "openrouter" ? "callback_url" : "redirect_uri")!);
		const server = createServer();
		await new Promise<void>((done, fail) => server.once("error", fail).listen(Number(callback.port), "127.0.0.1", done));
		await new Promise<void>((done) => server.close(() => done()));
	} finally {
		if (!settled) process.emit("SIGINT");
		await outcome;
	}
});

function setup() {
	const dir = tempDir("orrery-logins-");
	dirs.push(dir);
	const toml = `data_dir = ${JSON.stringify(dir)}\n[lanes.Test]\nworkspace = ${JSON.stringify(dir)}\nmodel = "openai/gpt-6.1-sol"\ncompactor_model = "openai/gpt-6.1-sol"\n`;
	return { dir, config: parseConfig(toml, dir) };
}

/** A terminal-mode exchange: what was typed, and everything written back. */
function typed(text: string) {
	const input = new PassThrough();
	const output = new PassThrough();
	let shown = "";
	output.on("data", (chunk) => (shown += String(chunk)));
	setImmediate(() => input.write(text));
	return { io: { input, output, terminal: true }, shown: () => shown };
}

describe("readSecret", () => {
	it("returns the trimmed entry and never writes it back", async () => {
		const { io, shown } = typed("  sk-secret-123  \n");
		expect(await readSecret("OpenRouter API key:", io)).toBe("sk-secret-123");
		expect(shown()).toContain("OpenRouter API key:");
		expect(shown()).not.toContain("sk-secret");
	});
	it("keeps an ended stdin pending until the browser cancels its manual prompt", async () => {
		const input = new PassThrough();
		const controller = new AbortController();
		const result = readSecret("Browser or paste:", { input, output: new PassThrough() }, controller.signal);
		let settled = false;
		const outcome = result.then(() => { settled = true; }, () => { settled = true; });
		input.end();
		await new Promise((done) => setTimeout(done, 20));
		expect(settled).toBe(false);
		controller.abort();
		await outcome;
		expect(input.listenerCount("data")).toBe(0);
	});

	it("keeps waiting for the browser when stdin was already at EOF", async () => {
		const input = new PassThrough(); input.resume(); input.end();
		await new Promise<void>((done) => input.once("end", done));
		const output = new PassThrough();
		const controller = new AbortController();
		let settled = false;
		const outcome = readSecret("Browser or paste:", { input, output, terminal: false }, controller.signal).finally(() => { settled = true; }).catch(() => {});
		await new Promise((done) => setTimeout(done, 20));
		expect(settled).toBe(false);
		controller.abort(); await outcome;
	});

	it.each(["\x03", "\x1b"])("still cancels an explicit terminal cancel (%j)", async (key) => {
		const { io } = typed(key);
		await expect(readSecret("Browser or paste:", io, new AbortController().signal)).rejects.toThrow();
	});

});

describe("orrery login --key", () => {
	it("saves the key under its own id (0600), lists it without the value, and logs out one source only", async () => {
		const { dir, config } = setup();
		const { io } = typed("sk-or-v1-test\n");
		expect(await loginCommand(config, { key: "openrouter" }, io)).toBe("Saved the OpenRouter key.\n");
		const file = join(dir, "credentials.json");
		expect(JSON.parse(readFileSync(file, "utf8")).openrouter).toEqual({ type: "api_key", key: "sk-or-v1-test" });
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const listed = await loginsCommand(config);
		expect(listed).toContain("openrouter   saved");
		expect(listed).not.toContain("sk-or-v1-test");
		const { io: io2 } = typed("sk-oa-test\n");
		await loginCommand(config, { key: "openai" }, io2);
		expect(await logoutCommand(config, { key: "openrouter" })).toBe("Removed the OpenRouter key.\n");
		expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["openai-api"]);
		expect(await logoutCommand(config, { key: "openrouter" })).toBe("No OpenRouter key was saved.\n");
	});

	it("saves nothing for an empty entry", async () => {
		const { config } = setup();
		const { io } = typed("   \n");
		await expect(loginCommand(config, { key: "anthropic" }, io)).rejects.toThrow("No key entered; nothing saved.");
	});

	it("refuses sign-in for unsupported providers, and login for a local server", async () => {
		const { config } = setup();
		await expect(loginCommand(config, { signin: "anthropic" })).rejects.toThrow(
			/^Sign in is for openai \(ChatGPT\) or openrouter; for a key use orrery login --key <openai\|anthropic\|openrouter>\.$/,
		);
	});

	it("never repeats a key typed where a provider name goes", async () => {
		const { config } = setup();
		for (const typed of ["sk-ant-api03-0123456789abcdef", "x9".repeat(30)]) {
			for (const request of [{ signin: typed }, { key: typed }]) {
				const message = await loginCommand(config, request).then(
					() => "",
					(error: Error) => error.message,
				);
				expect(message).toBe(KEY_NOT_NAME);
				expect(message).not.toContain(typed);
			}
		}
	});
});

describe("--from-pi", () => {
	function piDir(entries: object) {
		const dir = tempDir("orrery-pi-agent-");
		dirs.push(dir);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "auth.json"), JSON.stringify(entries), { mode: 0o600 });
		return { PI_CODING_AGENT_DIR: dir };
	}

	it("copies an API key pi saved", () => {
		expect(readPiKey("openrouter", piDir({ openrouter: { type: "api_key", key: " sk-or-pi " } }))).toBe("sk-or-pi");
	});

	it("refuses pi's sign-ins, command keys and missing entries", () => {
		const env = piDir({ openai: { type: "oauth", access: "a" }, anthropic: { type: "api_key", key: "!security find-generic-password -ws anthropic" } });
		expect(() => readPiKey("openai", env)).toThrow("pi's openai login is a sign-in, not an API key; only keys are copied.");
		expect(() => readPiKey("anthropic", env)).toThrow("pi gets its anthropic key from a command; enter the key with orrery login --key anthropic.");
		expect(() => readPiKey("openrouter", env)).toThrow("pi has no openrouter login saved.");
	});

	it("refuses keys pi takes from an environment variable ($VAR or ${VAR}), never copying the template", () => {
		const env = piDir({ openrouter: { type: "api_key", key: "$OPENROUTER_API_KEY" }, anthropic: { type: "api_key", key: "${MY_ANTHROPIC_KEY}" }, openai: { type: "api_key", key: "sk-$$x" } });
		expect(() => readPiKey("openrouter", env)).toThrow("pi gets its openrouter key from an environment variable; enter the key with orrery login --key openrouter.");
		expect(() => readPiKey("anthropic", env)).toThrow("pi gets its anthropic key from an environment variable; enter the key with orrery login --key anthropic.");
		// "$$" is pi's escape for a literal "$", not a variable.
		expect(() => readPiKey("openai", env)).not.toThrow();
	});
});


it.each(["openai", "openrouter"])("finishes %s browser login after stdin EOF (fake exchange only)", async (provider) => {
	const { config, dir } = setup();
	const input = new PassThrough();
	const output = new PassThrough();
	const realFetch = globalThis.fetch;
	const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
		const target = new URL(String(url));
		if (target.href === "https://auth.openai.com/api/accounts/oauth/token") return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", id_token: "synthetic-id", expires_in: 3600, scope: "chatgpt.tokens.use.direct" });
		if (target.href === "https://openrouter.ai/api/v1/auth/keys") return Response.json({ key: "synthetic-router-key" });
		if (target.hostname !== "127.0.0.1" || options?.method === "POST") throw new Error("Unexpected external request");
		return realFetch(url, options);
	});
	let auth!: URL;
	const ready = new Promise<void>((done) => output.on("data", (chunk) => {
		const text = String(chunk);
		if (text.startsWith("Open: ")) auth = new URL(text.split("\n")[0].slice(6));
		if (text.includes("or paste")) setImmediate(done);
	}));
	let settled = false;
	const outcome = loginCommand(config, { signin: provider, manual: true }, { input, output, terminal: false }, { timeoutMs: 1000 }).then((value) => { settled = true; return value; }, (error) => { settled = true; return error; });
	await ready;
	input.end();
	await new Promise((done) => setTimeout(done, 20));
	try {
		expect(settled).toBe(false);
		const callback = new URL(auth.searchParams.get(provider === "openrouter" ? "callback_url" : "redirect_uri")!);
		callback.searchParams.set("state", auth.searchParams.get("state")!);
		callback.searchParams.set("code", "synthetic-code");
		if (provider === "openai") callback.searchParams.set("client_id", "synthetic-client");
		expect((await fetch(callback)).status).toBe(200);
		expect(await outcome).toBe(`Signed in to ${provider === "openrouter" ? "OpenRouter" : "ChatGPT"}.\n`);
		expect(JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"))[provider].type).toBe(provider === "openrouter" ? "api_key" : "oauth");
		expect(exchange.mock.calls).toHaveLength(2);
	} finally {
		// The EOF regression must also leave its provider's callback server closed on failure.
		if (!settled) process.emit("SIGINT");
		await outcome;
	}
});
