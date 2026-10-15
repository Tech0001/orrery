/**
 * A fake OMP for test/release/extensions.test.ts, run by Bun as OMP runs extensions: it loads a packed extensions/omp.js
 * (argv[2]), opens the agent whose folder is the current folder, runs `/compactor <argv[3]>` there, and prints the
 * notices and every request the extension made, as JSON. The shapes are test/omp/world.ts's. No request leaves the
 * process: fetch records each one and answers 401.
 */

const requests: { url: string; authorization: string | null }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const request = new Request(input, init);
	requests.push({ url: request.url, authorization: request.headers.get("authorization") });
	return Response.json({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }, { status: 401 });
}) as typeof fetch;

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();
const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
const notices: { message: string; type?: string }[] = [];
const ctx = {
	cwd: process.cwd(),
	hasUI: true,
	agent: { kind: "main", id: "Main", name: "main", depth: 0 },
	isIdle: () => true,
	ui: {
		notify: (message: string, type?: string) => notices.push({ message, type }),
		setStatus: () => {},
		select: async () => undefined,
		input: async () => undefined,
	},
	sessionManager: {
		getSessionId: () => "s1",
		getHeader: () => ({ type: "session", id: "s1" }),
		getBranch: () => [],
	},
};
const api = {
	arktype: {},
	zod: {},
	on(event: string, handler: Handler) {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	},
	registerTool: () => {},
	registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command.handler),
};
const emit = async (event: string) => {
	for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
};

const { default: factory } = (await import(process.argv[2] as string)) as { default: (pi: unknown) => void };
factory(api);
await emit("session_start");
await commands.get("compactor")?.(process.argv[3] ?? "", ctx);
await emit("session_shutdown");
process.stdout.write(`${JSON.stringify({ notices, requests })}\n`);
process.exit(0);
