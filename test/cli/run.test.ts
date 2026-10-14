import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { createTerminalWriter, runLane } from "../../src/cli/run.ts";
import { parseConfig } from "../../src/lane/config.ts";
import { Lane } from "../../src/lane/lane.ts";
import { ctx, fauxModels, laneConfigToml, tempDir } from "../lane/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
}

describe("runLane", () => {
	it("submits lines in order, prints answers, handles /status and /quit", async () => {
		const dir = tempDir("orrery-run-");
		dirs.push(dir);
		const workspace = join(dir, "ws");
		mkdirSync(workspace);
		const config = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace }), dir);
		const { chat, models } = fauxModels();
		chat.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		const lane = await Lane.open({ config, lane: "Test", models, context: ctx });
		const input = new PassThrough();
		const output = new PassThrough();
		let printed = "";
		output.on("data", (chunk: Buffer) => {
			printed += chunk.toString("utf8");
		});
		const done = runLane(lane, { input, output, terminal: false }, ctx);
		input.write("one\n");
		await until(() => printed.includes("first answer"));
		input.write("two\n");
		await until(() => printed.includes("second answer"));
		input.write("/status\n");
		await until(() => printed.includes("messages"));
		input.write("/quit\n");
		expect(await done).toBe(0);
		expect(printed.indexOf("first answer")).toBeLessThan(printed.indexOf("second answer"));
		await lane.close();
	});

	it("shows, sets and resets the agent and compactor models from chat", async () => {
		const dir = tempDir("orrery-run-");
		dirs.push(dir);
		const workspace = join(dir, "ws");
		mkdirSync(workspace);
		const config = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace }), dir);
		const { models } = fauxModels();
		const lane = await Lane.open({ config, lane: "Test", models, context: ctx });
		const input = new PassThrough();
		const output = new PassThrough();
		let printed = "";
		output.on("data", (chunk: Buffer) => {
			printed += chunk.toString("utf8");
		});
		const done = runLane(lane, { input, output, terminal: false }, ctx);
		const say = async (line: string, expected: string) => {
			input.write(`${line}\n`);
			await until(() => printed.includes(expected));
		};
		await say("/compactor", "compactor: faux-compactor/faux-1 (off) · from config");
		await say("/compactor faux-agent/faux-1 low", "compactor: faux-agent/faux-1 (low) · set in chat");
		await say("/model faux-compactor/faux-1", "model: faux-compactor/faux-1 (off) · set in chat");
		await say("/compactor nobody/nothing", "Unknown model nobody/nothing");
		await say("/status", "compactor: faux-agent/faux-1 (low) · set in chat");
		await say("/compactor reset", "compactor: faux-compactor/faux-1 (off) · from config");
		await say("/model reset", "model: faux-agent/faux-1 (off) · from config");
		await say("/models", "faux-compactor (API key): faux-1 [compactor]");
		expect(printed).toContain("faux-agent (API key): faux-1 [agent]");
		input.write("/quit\n");
		expect(await done).toBe(0);
		expect(lane.compactorSource).toBe("config");
		await lane.close();
	});

	it("prints every reply to piped input before it exits at end of input", async () => {
		const dir = tempDir("orrery-run-");
		dirs.push(dir);
		const workspace = join(dir, "ws");
		mkdirSync(workspace);
		const config = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace }), dir);
		const { chat, models } = fauxModels();
		chat.setResponses([
			() => new Promise((resolve) => setTimeout(() => resolve(fauxAssistantMessage("slow piped answer")), 300)),
		]);
		const lane = await Lane.open({ config, lane: "Test", models, context: ctx });
		const input = new PassThrough();
		const output = new PassThrough();
		let printed = "";
		output.on("data", (chunk: Buffer) => {
			printed += chunk.toString("utf8");
		});
		const done = runLane(lane, { input, output, terminal: false }, ctx);
		input.end("what is the codename?\n");
		expect(await done).toBe(0);
		expect(printed).toContain("slow piped answer");
		await lane.close();
	});

	it("survives a hung-up terminal (tmux kill-server): EIO errors do not crash it, and a stop still ends it", async () => {
		const dir = tempDir("orrery-run-");
		dirs.push(dir);
		const workspace = join(dir, "ws");
		mkdirSync(workspace);
		const config = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace }), dir);
		const { models } = fauxModels();
		const lane = await Lane.open({ config, lane: "Test", models, context: ctx });
		let hungUp = false;
		const eio = () => Object.assign(new Error("read EIO"), { code: "EIO" });
		const input = Object.assign(new PassThrough(), {
			isTTY: true,
			setRawMode(_mode: boolean) {
				if (hungUp) throw eio();
				return input;
			},
		});
		const output = new PassThrough();
		const stop = new AbortController();
		const done = runLane(lane, { input, output, terminal: true, stop: stop.signal }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 50));
		hungUp = true;
		expect(input.listenerCount("error"), "input error listeners").toBeGreaterThan(0);
		expect(output.listenerCount("error"), "output error listeners").toBeGreaterThan(0);
		expect(() => input.emit("error", eio())).not.toThrow();
		expect(() => output.emit("error", eio())).not.toThrow();
		stop.abort();
		expect(await done).toBe(1);
		await lane.close();
	});

	it("exits with 1 on a fatal stop, even mid memory-wait or if stopped before it started", async () => {
		const dir = tempDir("orrery-run-");
		dirs.push(dir);
		const workspace = join(dir, "ws");
		mkdirSync(workspace);
		const config = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace }), dir);
		const { compactor, models } = fauxModels();
		compactor.setResponses([() => new Promise(() => {})]); // summaries never arrive: the view never settles
		const lane = await Lane.open({ config, lane: "Test", models, context: ctx });
		lane.view.append("user", "x".repeat(2000));
		const stop = new AbortController();
		const input = new PassThrough();
		const output = new PassThrough();
		let printed = "";
		output.on("data", (chunk: Buffer) => {
			printed += chunk.toString("utf8");
		});
		const done = runLane(lane, { input, output, terminal: false, stop: stop.signal }, ctx);
		input.write("hello\n");
		await until(() => printed.includes("waiting for memory"));
		stop.abort();
		expect(await Promise.race([done, new Promise((r) => setTimeout(() => r("hung"), 3000))])).toBe(1);

		const already = new AbortController();
		already.abort();
		const early = runLane(lane, { input: new PassThrough(), output: new PassThrough(), terminal: false, stop: already.signal }, ctx);
		expect(await Promise.race([early, new Promise((r) => setTimeout(() => r("hung"), 3000))])).toBe(1);
		await lane.close();
	});

	it("never redraws the prompt over a partially streamed line in a terminal", () => {
		let out = "";
		const sink = new PassThrough();
		sink.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
		});
		const writer = createTerminalWriter(sink, true, () => sink.write("PROMPT"));
		writer.promptShown();
		writer.write("Hello", true);
		writer.write(" world", true);
		writer.write("!\n", false);
		writer.write("next", true);
		expect(out).toBe("\r\x1b[2KHello world!\nPROMPT\r\x1b[2Knext");
	});

	it("cancelling a multi-line message during the memory wait sends none of it", async () => {
		const dir = tempDir("orrery-run-");
		dirs.push(dir);
		const workspace = join(dir, "ws");
		mkdirSync(workspace);
		const config = parseConfig(laneConfigToml({ dataDir: join(dir, "data"), workspace }), dir);
		const { compactor, models } = fauxModels();
		compactor.setResponses([() => new Promise(() => {})]);
		const lane = await Lane.open({ config, lane: "Test", models, context: ctx });
		lane.view.append("user", "x".repeat(2000));
		const input = new PassThrough();
		const output = new PassThrough();
		let printed = "";
		output.on("data", (chunk: Buffer) => {
			printed += chunk.toString("utf8");
		});
		const stop = new AbortController();
		const done = runLane(lane, { input, output, terminal: true, stop: stop.signal }, ctx);
		input.write("/paste\rline one\rline two\rline three\r/end\r");
		await until(() => printed.includes("waiting for memory"));
		input.write("\x03");
		await until(() => printed.includes("cancelled"));
		await new Promise((r) => setTimeout(r, 300));
		expect(printed.split("waiting for memory").length - 1).toBe(1);
		stop.abort();
		await done;
		await lane.close();
	});
});
