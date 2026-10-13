import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore, MemoryView } from "../../src/memory/index.ts";
import { copySession, cursorKey, markSessionCopied, moveCursor } from "../../src/pi/log.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const t = (s: number) => Date.UTC(2026, 9, 6, 10, 0, s);
const user = (id: string, text: string, s: number) => ({ id, type: "message", message: { role: "user", content: text, timestamp: t(s) } });
const reply = (id: string, text: string, s: number) => ({
	id,
	type: "message",
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "openai",
		model: "gpt-6.1-sol",
		usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: t(s),
	},
});

function open() {
	dir = mkdtempSync(join(tmpdir(), "orrery-log-"));
	const store = MemoryStore.open(join(dir, "memory.sqlite"));
	return { store, view: new MemoryView(store) };
}

describe("copySession", () => {
	it("copies new entries once, with the cursor and usage in the same transaction", () => {
		const { store, view } = open();
		const branch: { id: string; type: string; message?: unknown }[] = [
			{ id: "m", type: "model_change" },
			user("a", "The codename is Cedar.", 1),
			reply("b", "Noted.", 2),
		];
		const session = { getSessionId: () => "s1", getBranch: () => branch };
		expect(copySession(view, session, 30_000)).toBe(2);
		expect(copySession(view, session, 30_000)).toBe(0);
		branch.push(user("c", "And?", 3));
		expect(copySession(view, session, 30_000)).toBe(1);
		expect(store.root.map((m) => `${m.kind}: ${m.text}`)).toEqual(["user: The codename is Cedar.", "talk: Noted.", "user: And?"]);
		expect(store.getMeta(cursorKey("s1"))).toBe("c");
		expect(store.usageRows().map((r) => [r.role, r.model, r.input])).toEqual([["agent", "openai/gpt-6.1-sol", 10]]);
		store.close();
	});

	it("never copies a resumed session twice, starts a new session from its beginning, and follows a rewind", () => {
		const { store, view } = open();
		const old = [user("a", "first session", 1), reply("b", "ok", 2)];
		copySession(view, { getSessionId: () => "s1", getBranch: () => old }, 30_000);
		const fresh = [user("x", "second session", 3)];
		expect(copySession(view, { getSessionId: () => "s2", getBranch: () => fresh }, 30_000)).toBe(1);
		expect(copySession(view, { getSessionId: () => "s1", getBranch: () => old }, 30_000)).toBe(0);
		// Rewind in s1 to "a", then a new reply on the new branch.
		moveCursor(store, "s1", "a");
		const rewound = [user("a", "first session", 1), reply("c", "a different answer", 4)];
		expect(copySession(view, { getSessionId: () => "s1", getBranch: () => rewound }, 30_000)).toBe(1);
		expect(store.root.map((m) => m.text)).toEqual(["first session", "ok", "second session", "a different answer"]);
		store.close();
	});
});

/** A session tree like pi's: entries with parent ids, getBranch(fromId) walks parents from fromId or the leaf. */
function tree(id: string) {
	const nodes = new Map<string, { entry: { id: string; type: string; message?: unknown }; parent: string | null }>();
	let leaf: string | null = null;
	return {
		getSessionId: () => id,
		getBranch(fromId?: string) {
			const out: { id: string; type: string; message?: unknown }[] = [];
			let at = fromId ?? leaf;
			while (at !== null && nodes.has(at)) {
				const node = nodes.get(at)!;
				out.unshift(node.entry);
				at = node.parent;
			}
			return out;
		},
		add(entry: { id: string; type: string; message?: unknown }) {
			nodes.set(entry.id, { entry, parent: leaf });
			leaf = entry.id;
		},
		setLeaf(next: string) {
			leaf = next;
		},
	};
}

describe("copySession re-anchoring", () => {
	it("re-anchors when the cursor is on an abandoned branch, so logging never stalls", () => {
		const { store, view } = open();
		const s = tree("s1");
		s.add(user("a", "one", 1));
		s.add(reply("b", "two", 2));
		expect(copySession(view, s, 30_000)).toBe(2);
		s.setLeaf("a");
		s.add(reply("c", "three", 3));
		s.add(user("d", "four", 4));
		expect(copySession(view, s, 30_000)).toBe(2);
		expect(store.getMeta(cursorKey("s1"))).toBe("d");
		s.add(reply("e", "five", 5));
		expect(copySession(view, s, 30_000)).toBe(1);
		expect(store.root.map((m) => m.text)).toEqual(["one", "two", "three", "four", "five"]);
		store.close();
	});

	it("moves an unknown cursor to the branch tail without copying", () => {
		const { store, view } = open();
		const s = tree("s1");
		s.add(user("a", "one", 1));
		s.add(reply("b", "two", 2));
		store.setMeta(cursorKey("s1"), "zzz");
		expect(copySession(view, s, 30_000)).toBe(0);
		expect(store.getMeta(cursorKey("s1"))).toBe("b");
		s.add(user("c", "three", 3));
		expect(copySession(view, s, 30_000)).toBe(1);
		store.close();
	});
});

describe("markSessionCopied", () => {
	it("skips what a forked session inherited and never moves an existing cursor", () => {
		const { store, view } = open();
		const s1 = tree("s1");
		s1.add(user("a", "one", 1));
		s1.add(reply("b", "two", 2));
		expect(copySession(view, s1, 30_000)).toBe(2);
		const s2 = tree("s2");
		s2.add(user("a", "one", 1));
		s2.add(reply("b", "two", 2));
		markSessionCopied(store, s2);
		expect(copySession(view, s2, 30_000)).toBe(0);
		s2.add(user("c", "three", 3));
		expect(copySession(view, s2, 30_000)).toBe(1);
		markSessionCopied(store, s2);
		expect(store.getMeta(cursorKey("s2"))).toBe("c");
		expect(store.root.map((m) => m.text)).toEqual(["one", "two", "three"]);
		store.close();
	});
});


describe("copySession keeps user and talk rows only", () => {
	const bash = (id: string, command: string, output: string, s: number, extra: Record<string, unknown> = {}) => ({
		id,
		type: "message",
		message: { role: "bashExecution", command, output, exitCode: 0, cancelled: false, truncated: false, timestamp: t(s), ...extra },
	});

	it("drops tool calls and results, keeps usage rows, and the cursor still ends at the last entry", () => {
		const { store, view } = open();
		const call = {
			id: "b",
			type: "message",
			message: {
				...reply("b", "Looking.", 2).message,
				content: [{ type: "text", text: "Looking." }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			},
		};
		const result = {
			id: "c",
			type: "message",
			message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false, timestamp: t(3) },
		};
		const branch = [user("a", "Read a.ts", 1), call, result, reply("d", "It is empty.", 4)];
		expect(copySession(view, { getSessionId: () => "s1", getBranch: () => branch }, 200)).toBe(3);
		expect(store.root.map((m) => `${m.kind}: ${m.text}`)).toEqual(["user: Read a.ts", "talk: Looking.", "talk: It is empty."]);
		expect(store.getMeta(cursorKey("s1"))).toBe("d");
		expect(store.usageRows().map((r) => r.role)).toEqual(["agent", "agent"]);
		store.close();
	});

	it("logs no !cmd or !!cmd at all", () => {
		const { store, view } = open();
		const branch = [bash("a", "git status", "On branch main", 1), bash("c", "cat secret.txt", "hidden", 3, { excludeFromContext: true }), user("e", "What changed?", 5)];
		expect(copySession(view, { getSessionId: () => "s1", getBranch: () => branch }, 200)).toBe(1);
		expect(store.root.map((m) => `${m.kind}: ${m.text}`)).toEqual(["user: What changed?"]);
		expect(store.getMeta(cursorKey("s1"))).toBe("e");
		store.close();
	});
});
