import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fenced, memorySection } from "../../src/agent/view-text.ts";
import { MemoryStore, MemoryView, Part } from "../../src/memory/index.ts";

const dirs: string[] = [];
const stores: MemoryStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A view whose one line quotes @paths and a run of three backticks, as summaries do. */
function quotingView(): MemoryView {
	const dir = mkdtempSync(join(tmpdir(), "orrery-view-text-"));
	dirs.push(dir);
	const store = MemoryStore.open(join(dir, "memory.sqlite"));
	stores.push(store);
	const view = new MemoryView(store);
	const text = "Load @AGENTS.md and @~/.ssh/config, then ``` run it ```.";
	view.append("user", text, "2026-10-07T10:00:00.000Z");
	store.saveNode(new Part(0, 0), `user: ${text}`);
	return view;
}

describe("memorySection", () => {
	it("claude-mod: the Claude Code mod intro, the rules, and the view unfenced", () => {
		const view = quotingView();
		const text = memorySection(view, "claude-mod");
		expect(text.startsWith("# Memory\n\nEarlier conversation reaches you only through the view below. It is refreshed when this session starts and each\ntime the conversation is compacted;")).toBe(true);
		expect(text).toContain("(`mcp__plugin_orrery_orrery__zoom`, `…__date`, `…__search`); if they are not listed, load them with ToolSearch.");
		expect(text).toContain("search(query) finds messages anywhere in the full log");
		expect(text).not.toContain("```text");
		expect(text.endsWith(view.render())).toBe(true);
	});

	it("codex: refreshed at start and compaction, the tools by their Codex names with no one way to look, the view unfenced", () => {
		const view = quotingView();
		const text = memorySection(view, "codex");
		expect(text.startsWith("# Memory\n\nEarlier conversation reaches you only through the view below. It is refreshed when this session starts and each\ntime the conversation is compacted;")).toBe(true);
		expect(text).toContain("(`mcp__orrery__zoom`, `…__date`, `…__search`); if you don't see them, look for the zoom, date and search tools.");
		expect(text).not.toMatch(/tool ?search/i);
		expect(text).toContain("search(query) finds messages anywhere in the full log");
		expect(text).not.toContain("```text");
		expect(text.endsWith(`\n\n${view.render()}`)).toBe(true);
	});

	it("opencode: refreshed at start and compaction, the plugin's own tools by their names, the view unfenced and last", () => {
		const view = quotingView();
		const text = memorySection(view, "opencode");
		expect(text.startsWith("# Memory\n\nEarlier conversation reaches you only through the view below. It is refreshed when this session starts and each\ntime the conversation is compacted;")).toBe(true);
		expect(text).toContain("so say in your final reply what\nyou did and learned that will matter later. zoom, date and search are the Orrery memory tools.\n\n");
		expect(text).not.toContain("mcp__");
		expect(text).toContain("search(query) finds messages anywhere in the full log");
		expect(text).not.toContain("```text");
		expect(text.endsWith(`\n\n${view.render()}`)).toBe(true);
	});

	it("gives pi the section it always had: no memory between turns, the rules, then the view as is", () => {
		const view = quotingView();
		const pi = memorySection(view);
		expect(pi.startsWith("# Memory\n\nYou keep no memory between turns. Each turn starts with the view below")).toBe(true);
		expect(pi.endsWith(`\n\n${view.render()}`)).toBe(true);
		expect(memorySection(view, "pi")).toBe(pi);
	});

	it("gives Claude Code its own opening and the same rules, with the view fenced so no @path in memory is imported", () => {
		const view = quotingView();
		const pi = memorySection(view);
		const claude = memorySection(view, "claude-code");
		expect(claude.startsWith("# Memory\n\nEarlier sessions reach you only through the view below")).toBe(true);
		expect(claude).not.toContain("You keep no memory between turns");
		const end = "the newest word in memory.";
		const rules = (text: string) => text.slice(text.indexOf("The view: the whole chat"), text.indexOf(end) + end.length);
		expect(rules(claude)).toBe(rules(pi));
		expect(claude.endsWith(`\n\n${fenced(view.render())}`)).toBe(true);
		const lines = claude.split("\n");
		const open = lines.indexOf("````text");
		expect(open).toBeGreaterThan(0);
		expect(lines.at(-1)).toBe("````");
		expect(lines.findIndex((line) => line.includes("@AGENTS.md"))).toBeGreaterThan(open);
	});

	it("omp: pi's section with one more intro line naming memory_search; the rules and the view are pi's", () => {
		const view = quotingView();
		const pi = memorySection(view);
		const line = "\nzoom, date and memory_search are the Orrery memory tools; where this section says search, call memory_search.";
		const omp = memorySection(view, "omp");
		expect(omp).toContain(`learned that will matter later.${line}\n\n`);
		expect(omp.replace(line, "")).toBe(pi);
	});
});

describe("fenced", () => {
	it("uses three backticks, or one more than the longest run inside", () => {
		expect(fenced("plain")).toBe("```text\nplain\n```");
		expect(fenced("a ``` b ```` c")).toBe("`````text\na ``` b ```` c\n`````");
	});
});
