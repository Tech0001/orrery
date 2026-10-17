/**
 * A fake OpenAI-compatible model server for the real-OpenCode tests (chat completions, streamed): no real model, no
 * network beyond 127.0.0.1. It keeps every request it gets. What it answers is read from the latest user message, one
 * directive per line:
 *   TEXT <words>             reply with these words
 *   TOOL <name> <json args>  reply with one call of that tool
 * After a tool's result it replies "TOOLRESULT: <the result's start>"; with no directive, "fake reply <n>".
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
	readonly n: number;
	readonly path: string;
	readonly body: { readonly messages?: { role: string; content: unknown }[]; readonly tools?: unknown[]; readonly [key: string]: unknown };
}

const textOf = (content: unknown): string =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: unknown })?.text ?? "").filter((text) => typeof text === "string").join("\n") : "";

/** The system prompt a request carries, its system messages' text joined. */
export function systemOf(request: FakeRequest): string {
	return (request.body.messages ?? []).filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n");
}

/** The text of every non-system message, in order, one string each ("role: text"). */
export function conversationOf(request: FakeRequest): string[] {
	return (request.body.messages ?? []).filter((message) => message.role !== "system").map((message) => `${message.role}: ${textOf(message.content)}`);
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((done, fail) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => (body += chunk));
		request.on("end", () => done(body));
		request.on("error", fail);
	});
}

export interface FakeModel {
	readonly baseURL: string;
	readonly requests: FakeRequest[];
	close(): Promise<void>;
}

export async function startFakeModel(): Promise<FakeModel> {
	const requests: FakeRequest[] = [];
	const server: Server = createServer(async (request, response) => {
		const raw = await readBody(request);
		if (request.method === "GET") {
			response.writeHead(request.url?.endsWith("/models") ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
			return;
		}
		let body: FakeRequest["body"] = {};
		try {
			body = JSON.parse(raw) as FakeRequest["body"];
		} catch {
			// kept as an empty body
		}
		const n = requests.length + 1;
		requests.push({ n, path: request.url ?? "", body });
		const messages = body.messages ?? [];
		const last = messages.at(-1);
		let text: string | undefined;
		let call: { name: string; arguments: string } | undefined;
		if (last?.role === "tool") text = `TOOLRESULT: ${textOf(last.content).slice(0, 400)}`;
		else {
			const user = [...messages].reverse().find((message) => message.role === "user");
			let said = textOf(user?.content);
			// `opencode run` sends its message as a JSON string.
			if (said.startsWith('"') && said.endsWith('"')) {
				try {
					said = JSON.parse(said) as string;
				} catch {
					// as it is
				}
			}
			for (const line of said.split("\n")) {
				const trimmed = line.trim();
				if (trimmed.startsWith("TEXT ")) text = trimmed.slice(5);
				else if (trimmed.startsWith("TOOL ")) {
					const [, name, ...rest] = trimmed.split(" ");
					call = { name: name as string, arguments: rest.join(" ") || "{}" };
				}
			}
			if (text === undefined && call === undefined) text = `fake reply ${n}`;
		}
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
		const base = { id: `chatcmpl-${n}`, object: "chat.completion.chunk", created: 0, model: body.model ?? "fake-model" };
		const send = (value: object) => response.write(`data: ${JSON.stringify(value)}\n\n`);
		if (call !== undefined) {
			send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: call }] }, finish_reason: null }] });
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
		} else {
			send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		}
		send({ ...base, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } });
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
	const { port } = server.address() as AddressInfo;
	return {
		baseURL: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () => new Promise((closed) => server.close(() => closed())),
	};
}
