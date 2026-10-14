import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { browse, compactorCommand, memoryReport, pageOpener } from "../../src/pi/commands.ts";
import { FAUX, FAUX_SUMMARY } from "./harness.ts";
import { cleanup, isolatedHome, lastAgent, pi, world } from "./world.ts";

afterEach(cleanup);
isolatedHome();

describe("commands", () => {
	it("/memory reports the agent, /compactor shows, sets (persisting) and resets, /browse writes a private page", async () => {
		const { root, config } = world();
		await pi(root, join(root, "agent-Atlas"), config);
		const agent = lastAgent();
		const model = `${FAUX.provider}/${FAUX.model}`;
		const summaries = `${FAUX_SUMMARY.provider}/${FAUX_SUMMARY.model}`;
		expect(memoryReport(agent)).toMatch(/Atlas: 0 messages, 0 summaries/);
		expect(compactorCommand(agent, "")).toBe(`summaries: ${summaries} (off) · from config`);
		expect(compactorCommand(agent, `${model} low`)).toBe(`summaries: ${model} (low) · set in chat`);
		expect(agent.store.getMeta("lane.compactor-model")).toContain('"low"');
		expect(compactorCommand(agent, "reset")).toBe(`summaries: ${summaries} (off) · from config`);
		expect(() => compactorCommand(agent, "nobody/nothing")).toThrow(/Unknown model/);
		const page = browse(agent);
		expect(existsSync(page) && (statSync(page).mode & 0o777) === 0o600).toBe(true);
	});

	it("/compactor provider/model [thinking] typed into pi switches after a test call; an unknown model is refused", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		const summaries = `${FAUX_SUMMARY.provider}/${FAUX_SUMMARY.model}`;
		run.setSummaryResponses([fauxAssistantMessage("OK")]);
		await run.session.prompt(`/compactor ${summaries} low`);
		expect(run.notices.at(-1)).toEqual({ message: `summaries: ${summaries} (low) · set in chat`, type: "info" });
		await run.session.prompt("/compactor nobody/nothing");
		expect(run.notices.at(-1)?.type).toBe("error");
		expect(run.notices.at(-1)?.message).toMatch(/^Not switched: unknown model nobody\/nothing/);
		expect(lastAgent().compactorModel.thinking).toBe("low");
	});

	it("blocks a write outside the agent's folder through pi's tool loop", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		run.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "/etc/orrery-test.txt", content: "x" })]), fauxAssistantMessage("done")]);
		await run.session.prompt("write it");
		expect(existsSync("/etc/orrery-test.txt")).toBe(false);
		const results = run.session.messages.filter((m: { role: string }) => m.role === "toolResult") as { content: { text?: string }[]; isError?: boolean }[];
		expect(results.at(-1)?.content.map((c) => c.text ?? "").join("")).toMatch(/outside this agent's folder/);
	});

	it("refuses, through pi's tool loop, a search over Orrery's data folder (it holds Orrery's credentials.json)", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		run.session.setActiveToolsByName([...run.session.getActiveToolNames(), "grep"]);
		run.setResponses([fauxAssistantMessage([fauxToolCall("grep", { pattern: "key", path: join(root, "data") })]), fauxAssistantMessage("done")]);
		await run.session.prompt("search it");
		const results = run.session.messages.filter((m: { role: string }) => m.role === "toolResult") as { content: { text?: string }[] }[];
		expect(results.at(-1)?.content.map((c) => c.text ?? "").join("")).toMatch(/narrower folder/);
	});

	it("/browse writes the page, opens it, and names it in the notice", async () => {
		const { root, config } = world();
		const opened: string[] = [];
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { openPage: (path) => opened.push(path) });
		await run.session.prompt("/browse");
		const page = join(root, "data", "agents", "Atlas", "memory.html");
		expect(run.notices.at(-1)).toEqual({ message: `Wrote ${page}`, type: "info" });
		expect(opened).toEqual([page]);
	});

	it("opens pages with xdg-open on a Linux desktop and open on macOS, and not at all without a display", () => {
		expect(pageOpener({}, "linux")).toBeUndefined();
		expect(pageOpener({ WAYLAND_DISPLAY: "wayland-1" }, "linux")?.command).toBe("xdg-open");
		expect(pageOpener({ DISPLAY: ":0" }, "linux")?.command).toBe("xdg-open");
		expect(pageOpener({}, "darwin")?.command).toBe("open");
		expect(pageOpener({ DISPLAY: ":0" }, "win32")).toBeUndefined();
	});
});
