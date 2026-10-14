import type { AuthInteraction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { LoginRow } from "../../src/agent/logins.ts";
import { loginsPage } from "../../src/tui/pages/logins.ts";
import { signInInteraction } from "../../src/tui/signin.ts";
import { answer, fakeDeps, keys, makeApp, screen, settle } from "./support.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";

const LOGINS: LoginRow[] = [
	{ group: "signin", name: "openai", provider: "openai", state: "saved", label: "ChatGPT", agents: ["Alpha"] },
	{ group: "key", name: "openai", provider: "openai-api", state: "not saved", label: "OpenAI", agents: [] },
	{ group: "key", name: "anthropic", provider: "anthropic", state: "not saved", label: "Anthropic", agents: [] },
	{ group: "key", name: "openrouter", provider: "openrouter", state: "not saved", label: "OpenRouter", agents: [] },
];

async function loginsApp(overrides = {}) {
	const deps = fakeDeps({ sources: async () => ({ config: { providers: [] } }) as never, loginRows: async () => LOGINS, ...overrides });
	const app = makeApp(deps, [loginsPage]);
	app.refresh();
	await settle();
	return { deps, app };
}

describe("the Logins page", () => {
	it("lists each login, whether it is saved, and the agents that use it", async () => {
		const { app } = await loginsApp();
		const text = screen(app);
		expect(text).toMatch(/Sign in · ChatGPT\s+saved\s+Alpha/);
		expect(text).toMatch(/API key · Anthropic\s+not saved\s+—/);
	});

	it("shows the Note column only when a row has a note, and then the full Used by list", async () => {
		const names = ["Atlas", "Birch", "Elm", "Cedar", "Maple", "Aspen", "Olive", "Larch", "Willow", "Rowan"];
		const { app } = await loginsApp({ loginRows: async () => [{ ...LOGINS[0], agents: names }, ...LOGINS.slice(1)] });
		const text = screen(app, 120);
		expect(text).not.toContain("Note");
		expect(text).toContain(names.join(", "));
	});

	it("shows the Note column when a local-server row has a key note", async () => {
		const local: LoginRow = { group: "local", name: "mac", provider: "mac", state: "saved", label: "Mac", agents: [] };
		const { app } = await loginsApp({ loginRows: async () => [...LOGINS, local] });
		const text = screen(app, 120);
		expect(text).toContain("Note");
		expect(text).toContain("no key");
	});

	it("A saves a pasted key, trimmed, and no frame ever shows it", async () => {
		const saved: string[] = [];
		const { app } = await loginsApp({ saveKey: async (_s: unknown, name: string, key: string) => (saved.push(`${name}:${key}`), "Anthropic") });
		const frames: string[] = [];
		keys(app, DOWN, DOWN, "A");
		await settle();
		frames.push(screen(app));
		await answer(app, "Anthropic API key", "\x1b[200~  sk-ant-NEW-SECRET-77 \n\x1b[201~");
		frames.push(screen(app));
		await app.idle();
		frames.push(screen(app));
		expect(saved).toEqual(["anthropic:sk-ant-NEW-SECRET-77"]);
		expect(frames.join("\n")).not.toContain("NEW-SECRET");
		expect(frames.at(-1)).toContain("Saved the Anthropic key.");
	});

	it("A on the sign-in shows the link, opens it if it can, and closes it when the sign-in finishes", async () => {
		let finish: () => void = () => {};
		const signIn = async (_s: unknown, interaction: AuthInteraction) => {
			interaction.notify({ type: "auth_url", url: "https://auth.example/very/long/path?state=abc123" });
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		};
		const { app } = await loginsApp({ signIn });
		keys(app, "A");
		await settle();
		expect(screen(app)).toContain("https://auth.example/very/long/path?state=abc123");
		finish();
		await app.idle();
		await settle();
		expect(app.host.current).toBeUndefined();
		expect(screen(app)).toContain("Signed in to ChatGPT.");
	});

	it("T tests with the model of an agent that uses the login", async () => {
		const tested: unknown[] = [];
		const { app } = await loginsApp({ testChoice: async (_s: unknown, choice: unknown) => (tested.push(choice), { ok: true as const }) });
		keys(app, "T");
		await app.idle();
		expect(tested).toEqual([{ provider: "openai", modelId: "gpt-6.1-sol", thinking: "low" }]);
		expect(screen(app)).toContain("Works: openai/gpt-6.1-sol answered.");
	});

	it("D asks first, naming the agents that use it, then removes it", async () => {
		const removed: unknown[] = [];
		const { app } = await loginsApp({ removeLogin: async (_s: unknown, request: unknown) => (removed.push(request), "Removed the ChatGPT sign-in.\n") });
		keys(app, "D");
		await answer(app, "Alpha summarize with it", "y");
		await app.idle();
		expect(removed).toEqual([{ signin: "openai" }]);
		expect(screen(app)).toContain("Removed the ChatGPT sign-in.");
	});

	it("D lists every agent that uses the login and warns, even with many agents", async () => {
		const names = Array.from({ length: 11 }, (_, i) => `Agentabcdef${i}`);
		const rows = [{ ...LOGINS[0], agents: names }, ...LOGINS.slice(1)];
		const { app } = await loginsApp({ loginRows: async () => rows });
		keys(app, "D");
		await settle();
		const text = app.render(100).join("\n");
		for (const n of names) expect(text).toContain(n);
		expect(text).toContain("fail");
	});
});

describe("the sign-in link while a code prompt is open", () => {
	it("shows the link above the prompt, and closes the prompt when it is withdrawn", async () => {
		const { app } = await loginsApp();
		const { interaction } = signInInteraction(app);
		const controller = new AbortController();
		interaction.notify({ type: "auth_url", url: "https://auth.example/very/long/path?state=abc123" });
		const asked = interaction.prompt({ type: "manual_code", message: "Or paste the final redirect URL", signal: controller.signal });
		const failure = asked.then(() => "no", () => "rejected");
		await settle();
		const text = screen(app);
		expect(text).toContain("https://auth.example/very/long/path?state=abc123");
		expect(text).toContain("Or paste the final redirect URL");
		controller.abort();
		expect(await failure).toBe("rejected");
		expect(app.host.current?.title).not.toContain("redirect");
	});

	it("rejects at once when the prompt is already withdrawn", async () => {
		const { app } = await loginsApp();
		const { interaction } = signInInteraction(app);
		const controller = new AbortController();
		controller.abort();
		await expect(interaction.prompt({ type: "text", message: "Code?", signal: controller.signal })).rejects.toThrow();
		expect(app.host.current).toBeUndefined();
	});

	it("a failed sign-in is explained in plain words", async () => {
		const { app } = await loginsApp({ signIn: async () => { throw new Error("OAuth refresh failed: 401 sk-secret-xyz"); } });
		keys(app, "A");
		await app.idle();
		const text = screen(app);
		expect(text).toContain("ChatGPT sign-in expired");
		expect(text).not.toContain("sk-secret");
	});
});
