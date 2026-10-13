import type { AgentEvent } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createPrinterState, renderEvents } from "../../src/cli/printer.ts";

const ev = (events: unknown[]) => events as AgentEvent[];

describe("renderEvents", () => {
	it("streams text, shows tool calls and results, and tracks busy state in the title", () => {
		const state = createPrinterState("Atlas", "openai/gpt-6.1-sol");
		const out = renderEvents(
			ev([
				{ type: "run_start", inputs: [1] },
				{ type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: "Checking" }] },
				{ type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: " now." }] },
				{ type: "message_end", entry: { id: 5, kind: "pi.assistant" } },
				{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "cargo test" } },
				{ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", output: { append: "ok\n" } },
				{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", entry: { id: 6, kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "bash", content: [], isError: false }] } },
				{ type: "run_end", inputs: [1] },
			]),
			state,
		);
		expect(out.text).toBe("Checking now.\n→ bash cargo test\nok\n✓ bash\n");
		expect(out.title).toBe("Atlas · idle · openai/gpt-6.1-sol · $0.00");
	});

	it("caps streamed tool output per call", () => {
		const state = createPrinterState("L", "m");
		const big = "x".repeat(10_000);
		const out = renderEvents(
			ev([
				{ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "cat big" } },
				{ type: "tool_execution_update", toolCallId: "c", toolName: "bash", output: { append: big } },
				{ type: "tool_execution_update", toolCallId: "c", toolName: "bash", output: { append: big } },
			]),
			state,
		);
		expect(out.text.length).toBeLessThan(2_200);
		expect(out.text).toContain("more output");
	});

	it("reports unanswered inputs, retries and failed tools", () => {
		const state = createPrinterState("L", "m");
		const out = renderEvents(
			ev([
				{ type: "auto_retry_start", attempt: 1, at: 0, errorMessage: "429 rate limited" },
				{ type: "submission", record: { id: 1, conversationId: 1, type: "input", status: "unanswered", reason: "model_error", detail: "boom" } },
				{ type: "tool_execution_end", toolCallId: "c", toolName: "edit", entry: { id: 9, kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "edit", content: [{ type: "text", text: "no match\nmore" }], isError: true }] } },
			]),
			state,
		);
		expect(out.text).toBe("! retrying (attempt 1): 429 rate limited\n! not answered: model_error (boom)\n✗ edit: no match more\n");
	});

	it("prints the final text that streaming did not deliver, without duplicating streamed text", () => {
		const finalEntry = (text: string) => ({ id: 7, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }] });
		const fast = createPrinterState("L", "m");
		expect(
			renderEvents(ev([{ type: "message_start", message: { role: "assistant", content: [] } }, { type: "message_end", entry: finalEntry("hello world") }]), fast).text,
		).toBe("hello world\n");
		const partial = createPrinterState("L", "m");
		expect(
			renderEvents(
				ev([
					{ type: "message_start", message: { role: "assistant", content: [] } },
					{ type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: "hello" }] },
					{ type: "message_end", entry: finalEntry("hello world") },
				]),
				partial,
			).text,
		).toBe("hello world\n");
		const userEnd = createPrinterState("L", "m");
		expect(renderEvents(ev([{ type: "message_end", entry: { id: 8, kind: "pi.user", model: [{ role: "user", content: "hi" }] } }]), userEnd).text).toBe("");
	});

	it("never passes terminal control sequences from model or tool text to the terminal", () => {
		const state = createPrinterState("L", "m");
		const out = renderEvents(
			ev([
				{ type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: "safe\x1b]52;c;ZXZpbA==\x07 text\x1b[2J\x9b31m" }] },
				{ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "cat x\x1b]0;pwned\x07" } },
				{ type: "tool_execution_update", toolCallId: "c", toolName: "bash", output: { append: "out\x1b[31mred\x1b[0m\r\x07\n" } },
				{ type: "agent_changed", agent: { model: { provider: "p\x1b]0;x\x07", modelId: "m" } } },
			]),
			state,
		);
		expect(out.text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
		expect(out.text).toContain("safe text");
		expect(out.text).toContain("outred");
		expect(out.title).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
	});

	it("prints the text a message starts with, and each reply exactly once", () => {
		const state = createPrinterState("L", "m");
		const out = renderEvents(
			ev([
				{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "The quick br" }] } },
				{ type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: "own fox" }] },
				{
					type: "message_end",
					entry: { id: 3, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "The quick brown fox." }], stopReason: "stop" }] },
				},
			]),
			state,
		);
		expect(out.text).toBe("The quick brown fox.\n");
	});
});
