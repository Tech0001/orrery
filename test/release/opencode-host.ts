/**
 * A fake OpenCode server for test/release/extensions.test.ts, run by Bun as OpenCode runs plugins: it loads a packed
 * extensions/opencode/server.js (argv[2]) with the options OPENCODE_HOST_OPTIONS names, in the current folder, gives it
 * one prompt (argv[3], read from that file), waits until the plugin made a request (or 10 s), cleans up, and prints every
 * request it made, as JSON. No request leaves the process: fetch records each one and answers 401.
 */

import { readFileSync } from "node:fs";

const requests: { url: string; authorization: string | null }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const request = new Request(input, init);
	requests.push({ url: request.url, authorization: request.headers.get("authorization") });
	return Response.json({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }, { status: 401 });
}) as typeof fetch;

type Hook = (event: Record<string, unknown>) => Promise<void> | void;
const hooks = new Map<string, Hook[]>();
const ctx = {
	options: JSON.parse(process.env.OPENCODE_HOST_OPTIONS as string) as unknown,
	location: { directory: process.cwd() },
	session: {
		hook: async (name: string, hook: Hook) => {
			hooks.set(name, [...(hooks.get(name) ?? []), hook]);
			return { dispose: async () => {} };
		},
		get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID }),
		context: async () => [],
	},
	event: { subscribe: (options?: { signal?: AbortSignal }) => ({ async *[Symbol.asyncIterator]() { await new Promise((stop) => options?.signal?.addEventListener("abort", stop, { once: true })); } }) },
	tool: { transform: async () => ({ dispose: async () => {} }) },
};

const { default: plugin } = (await import(process.argv[2] as string)) as { default: { setup(ctx: unknown): Promise<() => Promise<void>> } };
const cleanup = await plugin.setup(ctx);
for (const hook of hooks.get("prompt") ?? []) await hook({ sessionID: "ses_1", messageID: "msg_1", prompt: { text: readFileSync(process.argv[3] as string, "utf8") } });
for (let waited = 0; requests.length === 0 && waited < 10_000; waited += 100) await new Promise((wait) => setTimeout(wait, 100));
await cleanup();
process.stdout.write(`${JSON.stringify({ requests })}\n`);
process.exit(0);
