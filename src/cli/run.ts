/** The agent terminal: readline input, plain streaming output from watchEvents (spec §2 "Interface"). */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Context } from "@earendil-works/chord";
import { watchEvents } from "@earendil-works/pi-durable";
import { type ModelChoice, parseModelChoice } from "../agent/config.ts";
import { availableModels } from "../agent/models.ts";
import type { Agent, AgentStatus } from "../agent/agent.ts";
import type { UsageRow } from "../memory/index.ts";
import { clean, createPrinterState, renderEvents } from "./printer.ts";

export interface RunIo {
	readonly input: Readable;
	readonly output: Writable;
	readonly terminal: boolean;
	/** Aborted when the agent hit a fatal problem; runHarness then resolves 1. */
	readonly stop?: AbortSignal;
}

const HELP = `Enter sends (joins the running work if busy). Ctrl-C stops the run (or cancels the memory wait).
/paste … /end   multi-line message      /model [provider/id [thinking] | reset]       agent model
/status         agent and memory state   /compactor [provider/id [thinking] | reset]   summary model
/usage          token usage             /models                                       models your logins offer
/quit           exit the agent process
Models chosen with /model and /compactor survive restarts; reset returns to the config.
`;

const source = (from: "config" | "chat") => (from === "chat" ? "set in chat" : "from config");

export function formatStatus(status: AgentStatus): string {
	const m = status.memory;
	return (
		`${status.agent}: ${status.busy ? "busy" : "idle"} · ${status.model} (${status.thinking}) · ${source(status.modelSource)}\n` +
		`memory: ${m.messages} messages, ${m.nodes} summaries, view ${Math.round(m.viewBytes / 1000)}/${Math.round(m.viewBudget / 1000)} KB` +
		`${m.settled ? "" : ` (summarizing from #${m.firstUnsummarized})`}\n` +
		`compactor: ${status.compactor.model} (${status.compactor.thinking}) · ${source(status.compactor.source)}\n` +
		`${status.compactor.stopped ? "COMPACTOR STOPPED — restart the agent\n" : ""}` +
		`${status.lastError ? `last error: ${status.lastError}\n` : ""}`
	);
}

export function formatUsage(rows: readonly UsageRow[]): string {
	const totals = new Map<string, { calls: number; input: number; cacheRead: number; cacheWrite: number; output: number }>();
	for (const row of rows) {
		const key = `${row.at.slice(0, 10)}  ${row.role.padEnd(9)} ${row.model}`;
		const t = totals.get(key) ?? { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
		t.calls++;
		t.input += row.input;
		t.cacheRead += row.cacheRead;
		t.cacheWrite += row.cacheWrite;
		t.output += row.output;
		totals.set(key, t);
	}
	let out = "day         role      model  calls  input  cache-read  cache-write  output\n";
	for (const [key, t] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
		out += `${key}  ${t.calls}  ${t.input}  ${t.cacheRead}  ${t.cacheWrite}  ${t.output}\n`;
	}
	return out;
}

/**
 * Terminal output that never redraws the prompt over a partial line: the prompt is cleared before output and
 * redrawn only after a complete line, once streaming has finished (redrawing mid-stream erased each chunk).
 */
export function createTerminalWriter(output: Pick<Writable, "write">, terminal: boolean, redrawPrompt: () => void) {
	let shown = false;
	return {
		promptShown(): void {
			shown = true;
		},
		write(text: string, streaming: boolean): void {
			if (!text) return;
			if (terminal && shown) {
				output.write("\r\x1b[2K");
				shown = false;
			}
			output.write(clean(text));
			if (terminal && text.endsWith("\n") && !streaming) {
				redrawPrompt();
				shown = true;
			}
		},
	};
}

export async function runHarness(agent: Agent, io: RunIo, context: Context): Promise<number> {
	const state = createPrinterState(agent.config.name, `${agent.model.provider}/${agent.model.modelId}`);
	// Open the event stream before readline exists: input that arrives meanwhile stays buffered in the stream,
	// whereas a readline "line" event emitted before its handler is attached would be lost.
	const stream = await watchEvents(agent.harness, agent.conversation.id, context);
	// tmux kill-server or a dropped SSH session leaves a dead terminal: reads, writes and raw-mode switches fail with
	// EIO. Stop touching it instead of crashing, so a stop still reaches agent.close().
	let gone = false;
	const hangUp = () => {
		gone = true;
	};
	io.input.on("error", hangUp);
	io.output.on("error", hangUp);
	const tty = io.input as Readable & { setRawMode?: (mode: boolean) => unknown };
	if (io.terminal && typeof tty.setRawMode === "function") {
		const setRawMode = tty.setRawMode.bind(tty);
		tty.setRawMode = (mode: boolean) => {
			try {
				return setRawMode(mode);
			} catch {
				hangUp();
				return tty;
			}
		};
	}
	const terminalOut = {
		write(chunk: string): boolean {
			if (gone) return true;
			try {
				return io.output.write(chunk);
			} catch {
				hangUp();
				return true;
			}
		},
	};
	const rl = createInterface({ input: io.input, output: io.output, terminal: io.terminal, prompt: "› " });
	rl.on("error", hangUp); // readline re-emits its input's errors on itself
	const writer = createTerminalWriter(terminalOut, io.terminal, () => {
		if (!gone) rl.prompt(true);
	});
	const write = (text: string) => writer.write(text, state.streaming);
	const setTitle = (text: string | undefined) => {
		if (text !== undefined && io.terminal) terminalOut.write(`\x1b]2;${text}\x07`);
	};
	agent.report = (message) => write(`! ${message}\n`);

	const initial = renderEvents([stream.snapshot], state);
	write(initial.text);
	setTitle(initial.title);
	stream.start(async (events) => {
		const rendered = renderEvents(events, state);
		write(rendered.text);
		setTitle(rendered.title);
	});

	let resolveDone: (code: number) => void = () => {};
	const done = new Promise<number>((resolve) => {
		resolveDone = resolve;
	});
	let waiting: AbortController | undefined;
	let chain = Promise.resolve();
	const submitted: Promise<unknown>[] = [];
	let pasting = false;
	let pasted: string[] = [];
	let multiline: string[] | undefined;

	const handle = async (line: string): Promise<void> => {
		const trimmed = line.trim();
		if (!trimmed) return;
		if (trimmed === "/quit") return resolveDone(0);
		if (trimmed === "/help") return write(HELP);
		if (trimmed === "/status") return write(formatStatus(await agent.status()));
		if (trimmed === "/usage") return write(formatUsage(agent.store.usageRows()));
		if (trimmed === "/models") {
			const groups = await availableModels(agent.models);
			if (groups.length === 0) return write("No signed-in models: run `orrery login openai` (ChatGPT) or `orrery login anthropic`.\n");
			const mark = (provider: string, id: string) => {
				const tags = [
					agent.model.provider === provider && agent.model.modelId === id ? "agent" : "",
					agent.compactorModel.provider === provider && agent.compactorModel.modelId === id ? "compactor" : "",
				].filter(Boolean);
				return tags.length > 0 ? `${id} [${tags.join(", ")}]` : id;
			};
			const lines = groups.map((g) => `${g.provider}${g.label ? ` (${g.label})` : ""}: ${g.ids.map((id) => mark(g.provider, id)).join(", ")}`);
			return write(`${lines.join("\n")}\nSwitch with /model provider/id [thinking] (agent) or /compactor provider/id [thinking] (summaries).\n`);
		}
		for (const [command, label] of [
			["/model", "model"],
			["/compactor", "compactor"],
		] as const) {
			if (trimmed !== command && !trimmed.startsWith(`${command} `)) continue;
			const current = () => {
				const choice = label === "model" ? agent.model : agent.compactorModel;
				const from = label === "model" ? agent.modelSource : agent.compactorSource;
				return write(`${label}: ${choice.provider}/${choice.modelId} (${choice.thinking}) · ${source(from)}\n`);
			};
			const [, ref, thinking] = trimmed.split(/\s+/);
			if (!ref) return current();
			const set = label === "model" ? (c?: ModelChoice) => agent.setModel(c) : (c?: ModelChoice) => agent.setCompactorModel(c);
			const level = thinking ?? (label === "model" ? agent.model : agent.compactorModel).thinking;
			await set(ref === "reset" ? undefined : parseModelChoice(ref, level));
			return current();
		}
		if (trimmed.startsWith("/")) return write(`unknown command ${trimmed.split(/\s/)[0]}; /help lists commands\n`);
		if (!state.busy && !agent.view.settled) write("(waiting for memory summaries; Ctrl-C cancels)\n");
		waiting = new AbortController();
		const result = await agent.submit(line, randomUUID(), waiting.signal);
		waiting = undefined;
		if (result !== undefined) submitted.push(result.submission.wait(context).catch(() => {}));
		if (result === undefined) {
			if (!io.terminal) return write("(cancelled; the message was not sent)\n");
			// readline's write() emits a "line" per embedded newline, which would send the first lines; restore a
			// multi-line message into /paste mode instead and give back only its last line for editing.
			const lines = line.split("\n");
			if (lines.length > 1) {
				multiline = lines.slice(0, -1);
				write("(cancelled; the message was not sent. Restored in /paste mode: finish with /end)\n");
			} else write("(cancelled; the message was not sent)\n");
			rl.write(lines[lines.length - 1]);
		}
	};

	const enqueue = (line: string) => {
		chain = chain.then(() => handle(line)).catch((error: unknown) => write(`! ${error instanceof Error ? error.message : String(error)}\n`));
	};

	if (io.terminal) {
		terminalOut.write("\x1b[?2004h");
		io.input.on("keypress", (_text: string, key: { name?: string } | undefined) => {
			if (key?.name === "paste-start") pasting = true;
			else if (key?.name === "paste-end") pasting = false;
		});
	}
	rl.on("line", (raw) => {
		if (pasting) {
			pasted.push(raw);
			return;
		}
		let line = raw;
		if (pasted.length > 0) {
			line = [...pasted, raw].join("\n");
			pasted = [];
		}
		if (multiline === undefined && line.trim() === "/paste") {
			// Enter multi-line mode here, not in the async queue: lines that follow arrive before the queue runs.
			multiline = [];
			write("(multi-line: finish with /end)\n");
			return;
		}
		if (multiline !== undefined) {
			if (line.trim() === "/end") {
				const text = multiline.join("\n");
				multiline = undefined;
				enqueue(text);
			} else multiline.push(line);
			return;
		}
		enqueue(line);
	});
	rl.on("SIGINT", () => {
		if (waiting !== undefined) {
			waiting.abort();
			return;
		}
		if (state.busy) {
			write("[stopping…]\n");
			agent.conversation.abort(context).catch((error: unknown) => write(`! ${String(error)}\n`));
		} else write("(idle; /quit exits the agent)\n");
	});
	// End of piped input: answer everything that was sent before exiting (a terminal's Ctrl-D exits at once).
	const finishInput = async () => {
		await chain.catch(() => {});
		await Promise.all(submitted);
		const end = Date.now() + 10_000;
		while (state.busy && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
		resolveDone(0);
	};
	rl.on("close", () => {
		if (io.terminal) resolveDone(0);
		else void finishInput();
	});
	// A fatal stop must end the agent even mid memory-wait (nothing would ever settle it) or if it came first.
	const onStop = () => {
		waiting?.abort();
		resolveDone(1);
	};
	if (io.stop?.aborted) onStop();
	else io.stop?.addEventListener("abort", onStop, { once: true });
	rl.prompt();
	writer.promptShown();

	const code = await done;
	await Promise.race([chain.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2_000).unref())]);
	if (io.terminal) terminalOut.write("\x1b[?2004l");
	try {
		rl.close();
	} catch {
		hangUp();
	}
	await stream.stop();
	return code;
}
