import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore, MemoryView, Part, renderMemoryHtml } from "../../src/memory/index.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("renderMemoryHtml", () => {
	it("renders view, messages and tree with escaped text and child links", () => {
		dir = mkdtempSync(join(tmpdir(), "orrery-export-"));
		const store = MemoryStore.open(join(dir, "memory.sqlite"));
		const view = new MemoryView(store);
		view.append("user", "<script>alert(1)</script>", "2026-08-01T10:00:00.000Z");
		view.append("talk", "fine & dandy", "2026-08-01T10:00:01.000Z");
		store.saveNode(new Part(0, 0), "user: <script>alert(1)</script>");
		store.saveNode(new Part(0, 1), "talk: fine & dandy");
		store.saveNode(new Part(1, 0), "both");
		const html = renderMemoryHtml(view, "Atlas");
		expect(html).toContain("<title>Atlas · Memory</title>");
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("fine &amp; dandy");
		expect(html).toContain('id="message-0"');
		expect(html).toContain('href="#node-0-0"');
		expect(html).toContain("Level 1");
		expect(html).toContain("2 messages · 3 summaries");
		expect(html).not.toMatch(/https?:\/\//);
		store.close();
	});

	it("renders an empty memory", () => {
		dir = mkdtempSync(join(tmpdir(), "orrery-export-"));
		const store = MemoryStore.open(join(dir, "memory.sqlite"));
		expect(renderMemoryHtml(new MemoryView(store), "Empty")).toContain("No messages yet.");
		store.close();
	});
});
