import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentConfig, parseConfig } from "../../src/agent/config.ts";
import { fitMemory, readMemory } from "../../src/agent/memory-read.ts";
import { GROK_READ_ONLY, memorySection } from "../../src/agent/view-text.ts";
import { MemoryStore, MemoryView } from "../../src/memory/index.ts";
import { fillMemory, tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Agent A, its view_bytes `viewBytes`, with no memory yet. */
function agentA(viewBytes = 128_000): AgentConfig {
	const dir = tempDir("orrery-memory-read-");
	dirs.push(dir);
	const config = parseConfig(`data_dir = ${JSON.stringify(join(dir, "data"))}\n[agents.A]\ncompactor_model = "openai/gpt-6.1-sol"\n[agents.A.memory]\nview_bytes = ${viewBytes}\n`, dir);
	const agent = config.agents.get("A") as AgentConfig;
	mkdirSync(agent.dir, { recursive: true });
	return agent;
}

const store = (agent: AgentConfig) => join(agent.dir, "memory.sqlite");
/** Short lines of multi-byte text, about 100 bytes each. */
const line = (i: number) => `${i} ${"€".repeat(30)}`;
/** The section of the agent's own view, as a session would see it. */
function fullSection(agent: AgentConfig, options: { readonly readOnly?: boolean } = {}): string {
	const s = MemoryStore.openReadOnly(store(agent));
	try {
		return memorySection(new MemoryView(s, agent.memory.viewBytes), "grok", options);
	} finally {
		s.close();
	}
}
function savedView(agent: AgentConfig): string | undefined {
	const s = MemoryStore.openReadOnly(store(agent));
	try {
		return s.savedView();
	} finally {
		s.close();
	}
}

describe("fitMemory", () => {
	it("is undefined for an agent with no memory yet, as readMemory is {}", () => {
		const agent = agentA();
		expect(fitMemory(agent, "grok", 131_000)).toBeUndefined();
		expect(readMemory(agent, true)).toEqual({});
	});

	it("gives the section of the agent's own view when it fits", () => {
		const agent = agentA();
		fillMemory(store(agent), 40, line, true);
		expect(fitMemory(agent, "grok", 131_000)).toEqual({ section: fullSection(agent), smaller: false });
		expect(fitMemory(agent, "grok", 131_000, { readOnly: true })?.section).toContain(GROK_READ_ONLY);
	});

	it("near the default ceiling, gives a smaller view's section, merged with the summaries already built, writing nothing", () => {
		const agent = agentA();
		// About 127 KB of lines: under the 128,000 ceiling, so not merged yet, but over 131,000 bytes rendered.
		fillMemory(store(agent), 1250, line, true);
		expect(Buffer.byteLength(fullSection(agent))).toBeGreaterThan(131_000);
		const before = savedView(agent);
		const fitted = fitMemory(agent, "grok", 131_000);
		expect(fitted?.smaller).toBe(true);
		const section = fitted?.section as string;
		expect(Buffer.byteLength(section)).toBeLessThanOrEqual(131_000);
		// The whole section: Grok's words, then the view to its end, the newest message whole.
		expect(section.startsWith("# Memory\n\n")).toBe(true);
		expect(section).toContain("look for the zoom, date and search tools");
		expect(section).toContain("summary of 0+");
		expect(section.endsWith(`|user: ${line(1249)}\n</chat>`)).toBe(true);
		expect(savedView(agent)).toBe(before);
	});

	it("gives no section when no smaller view fits, the lines' summaries not built yet; a larger room fits the whole view", () => {
		const agent = agentA();
		fillMemory(store(agent), 1250, line, false);
		expect(fitMemory(agent, "grok", 131_000)).toEqual({ smaller: true });
		expect(fitMemory(agent, "grok", 1_000_000)).toEqual({ section: fullSection(agent), smaller: false });
	});
});
