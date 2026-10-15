/** A real pi or OMP in RPC mode, and the OpenAI-compatible server its model calls go to. */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

export interface Call {
	readonly system: string;
	readonly users: string[];
}

/** An OpenAI-compatible server answering every chat call with `reply`; it records each call's system text and user messages. */
export async function fakeModel(reply: string) {
	const calls: Call[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			if (req.method === "GET") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "m", object: "model" }] }));
				return;
			}
			const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content));
			const messages = (JSON.parse(body || "{}") as { messages?: { role: string; content: unknown }[] }).messages ?? [];
			calls.push({
				system: messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => text(m.content)).join("\n"),
				users: messages.filter((m) => m.role === "user").map((m) => text(m.content)),
			});
			res.writeHead(200, { "content-type": "text/event-stream" });
			const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m" };
			res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { calls, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => server.close() };
}

export type Frame = Record<string, unknown>;

/** pi or OMP in RPC mode (docs/rpc.md): JSON lines out (responses, events, extension UI requests), commands in. */
export function rpc(child: ChildProcessWithoutNullStreams) {
	const frames: Frame[] = [];
	const waiters: { test: (frame: Frame) => boolean; done: (frame: Frame) => void }[] = [];
	let buffer = "";
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk));
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			let frame: Frame;
			try {
				frame = JSON.parse(line) as Frame;
			} catch {
				continue;
			}
			frames.push(frame);
			for (const waiter of [...waiters]) {
				if (waiter.test(frame)) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.done(frame);
				}
			}
		}
	});
	const waitFor = (test: (frame: Frame) => boolean, ms = 60_000): Promise<Frame> => {
		const seen = frames.find(test);
		if (seen !== undefined) return Promise.resolve(seen);
		return new Promise((done, fail) => {
			const timer = setTimeout(() => fail(new Error(`no such frame in ${ms} ms. Last frames: ${JSON.stringify(frames.slice(-5))}\nstderr: ${stderr.slice(-2000)}`)), ms);
			waiters.push({
				test,
				done: (frame) => {
					clearTimeout(timer);
					done(frame);
				},
			});
		});
	};
	let next = 0;
	const send = (command: Frame): Promise<Frame> => {
		const id = `t${++next}`;
		child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		return waitFor((f) => f.type === "response" && f.id === id);
	};
	return { frames, send, waitFor, stderr: () => stderr };
}
