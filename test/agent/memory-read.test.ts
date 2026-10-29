import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentConfig, parseConfig } from "../../src/agent/config.ts";
import { fitMemory, readMemory } from "../../src/agent/memory-read.ts";
import { GROK_READ_ONLY, grokLeftOut, memorySection } from "../../src/agent/view-text.ts";
import { MemoryStore, MemoryView, Part } from "../../src/memory/index.ts";
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

/** The view of the agent's memory at `ceiling`, read-only, given to `use`. */
function withView<T>(agent: AgentConfig, ceiling: number, use: (view: MemoryView) => T): T {
	const s = MemoryStore.openReadOnly(store(agent));
	try {
		return use(new MemoryView(s, ceiling));
	} finally {
		s.close();
	}
}

/** Grok's section of `view` from its line `k` on, the older lines left out. */
const fromLine = (view: MemoryView, k: number, options: { readonly readOnly?: boolean } = {}) => memorySection(view, "grok", { ...options, from: view.parts[k] });

describe("fitMemory", () => {
	it("is undefined for an agent with no memory yet, as readMemory is {}", () => {
		const agent = agentA();
		expect(fitMemory(agent, 131_000)).toBeUndefined();
		expect(readMemory(agent, true)).toEqual({});
	});

	it("gives the section of the agent's own view when it fits", () => {
		const agent = agentA();
		fillMemory(store(agent), 40, line, true);
		expect(fitMemory(agent, 131_000)).toEqual({ section: fullSection(agent), smaller: false });
		expect(fitMemory(agent, 131_000, { readOnly: true })?.section).toContain(GROK_READ_ONLY);
	});

	it("near the default ceiling, gives a smaller view's section, merged with the summaries already built, writing nothing", () => {
		const agent = agentA();
		// About 127 KB of lines: under the 128,000 ceiling, so not merged yet, but over 131,000 bytes rendered.
		fillMemory(store(agent), 1250, line, true);
		expect(Buffer.byteLength(fullSection(agent))).toBeGreaterThan(131_000);
		const before = savedView(agent);
		const fitted = fitMemory(agent, 131_000);
		expect(fitted?.smaller).toBe(true);
		expect(fitted?.from).toBeUndefined();
		const section = fitted?.section as string;
		expect(Buffer.byteLength(section)).toBeLessThanOrEqual(131_000);
		// The whole section: Grok's words, then the view to its end, the newest message whole.
		expect(section.startsWith("# Memory\n\n")).toBe(true);
		expect(section).toContain("look for the zoom, date and search tools");
		expect(section).toContain("summary of 0+");
		expect(section).not.toContain("left out");
		expect(section.endsWith(`|user: ${line(1249)}\n</chat>`)).toBe(true);
		expect(savedView(agent)).toBe(before);
	});

	it("with no summaries built, keeps the newest whole lines that fit, after a line naming the first one kept", () => {
		const agent = agentA();
		fillMemory(store(agent), 1250, line, false);
		const before = savedView(agent);
		const fitted = fitMemory(agent, 131_000);
		const section = fitted?.section as string;
		const from = fitted?.from as string;
		expect(fitted?.smaller).toBe(true);
		expect(from).toMatch(/^\d+\+1$/);
		const k = Number.parseInt(from, 10);
		// The normal section (Grok's words, how memory works), then the line naming the first line kept, right before <chat>.
		expect(section.startsWith("# Memory\n\n")).toBe(true);
		expect(section).toContain("look for the zoom, date and search tools");
		expect(section).toContain(`\n\n${grokLeftOut(from)}\n<chat>\n${from}|user: ${line(k)}\n`);
		expect(grokLeftOut(from)).toBe(`The view below starts at line ${from}: older lines are left out to fit Grok's command line; reach their messages with the zoom and search tools.`);
		expect(section).not.toContain(`\n${k - 1}+1|`);
		expect(section.endsWith(`|user: ${line(1249)}\n</chat>`)).toBe(true);
		// Measured on the rendered section: as many lines as fit, and one more would not.
		expect(Buffer.byteLength(section)).toBeLessThanOrEqual(131_000);
		withView(agent, 128_000, (view) => {
			expect(section).toBe(fromLine(view, k));
			expect(Buffer.byteLength(fromLine(view, k - 1))).toBeGreaterThan(131_000);
		});
		// Read-only wording too; nothing written.
		const readOnly = fitMemory(agent, 131_000, { readOnly: true });
		expect(readOnly?.section).toContain(GROK_READ_ONLY);
		expect(readOnly?.section).toContain(`\n\n${grokLeftOut(readOnly?.from as string)}\n<chat>\n${readOnly?.from}|`);
		expect(Buffer.byteLength(readOnly?.section as string)).toBeLessThanOrEqual(131_000);
		expect(savedView(agent)).toBe(before);
		// A larger room fits the whole view.
		expect(fitMemory(agent, 1_000_000)).toEqual({ section: fullSection(agent), smaller: false });
	});

	it("keeps the newest lines of the smallest view it reached: older lines merged where their summaries are built", () => {
		const agent = agentA();
		// 1,250 messages; summaries built only within the first 1,000, each longer than the line naming the first kept.
		fillMemory(store(agent), 1250, line, false);
		const s = MemoryStore.open(store(agent));
		try {
			for (let l = 1; 2 ** l <= 1000; l++) {
				for (let i = 0; (i + 1) * 2 ** l <= 1000; i++) s.saveNode(new Part(l, i), `summary of ${new Part(l, i).address} ${"s".repeat(300)}`);
			}
		} finally {
			s.close();
		}
		// Merged as far as the summaries go: 0+512, 512+256, 768+128, 896+64, 960+32, 992+8, then 250 messages.
		const room = withView(agent, 1, (merged) => {
			expect(merged.parts.slice(0, 7).map((part) => part.address)).toEqual(["0+512", "512+256", "768+128", "896+64", "960+32", "992+8", "1000+1"]);
			return Buffer.byteLength(fromLine(merged, 2));
		});
		const fitted = fitMemory(agent, room);
		expect(fitted?.from).toBe("768+128");
		const section = fitted?.section as string;
		expect(Buffer.byteLength(section)).toBe(room);
		expect(section).toContain(`${grokLeftOut("768+128")}\n<chat>\n768+128|summary of 768+128 `);
		expect(section).not.toContain("512+256|");
		expect(section.endsWith(`|user: ${line(1249)}\n</chat>`)).toBe(true);
	});

	it("gives no section when not even the newest line fits", () => {
		const agent = agentA();
		fillMemory(store(agent), 2, (i) => (i === 1 ? "x".repeat(140_000) : "hello"), false);
		expect(fitMemory(agent, 131_000)).toEqual({ smaller: true });
	});
});
