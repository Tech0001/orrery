import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFromPreview, type NewAgentFromChat, storeRefusal } from "../../src/import/create-agent.ts";
import { commitPreview, writePreview } from "../../src/import/preview.ts";
import { addAgent, editConfigFile } from "../../src/agent/config-edit.ts";
import { loadConfig } from "../../src/agent/config.ts";
import { instructionsTemplate, writeInstructions } from "../../src/agent/instructions.ts";
import { holdWriterLock, MemoryStore } from "../../src/memory/index.ts";
import { tempDir } from "../agent/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T = "2026-10-13T11:55:00.000Z";

/** A config with no agent, and a reviewed preview of two messages. */
function scene() {
	const dir = tempDir("orrery-create-agent-");
	dirs.push(dir);
	const configPath = join(dir, "config.toml");
	writeFileSync(configPath, `data_dir = ${JSON.stringify(join(dir, "data"))}\n`);
	const { previewPath } = writePreview(join(dir, "out"), [
		{ kind: "user", text: "Install RPCS3 AppImage for me.", date: T, source: "claude:s-1.jsonl" },
		{ kind: "talk", text: "Done.", date: T, source: "claude:s-1.jsonl" },
	], "# Import preview\n");
	const request: NewAgentFromChat = { name: "Rpcs3", tool: "pi", summary: { provider: "anthropic", modelId: "claude-haiku-4-5", thinking: "low" }, previewPath, title: "Install RPCS3 AppImage" };
	return { dir, configPath, request, agentDir: join(dir, "data", "agents", "Rpcs3") };
}

const texts = (agentDir: string) => {
	const store = MemoryStore.openReadOnly(join(agentDir, "memory.sqlite"));
	try {
		return store.root.map((m) => m.text);
	} finally {
		store.close();
	}
};

describe("createFromPreview", () => {
	it("adds the agent, writes its instructions from the template, and commits the preview into its memory", () => {
		const s = scene();
		expect(createFromPreview(s.configPath, { ...s.request, folder: s.dir })).toEqual({ agentDir: s.agentDir, messages: 2 });
		expect(loadConfig(s.configPath).agents.get("Rpcs3")).toMatchObject({ folder: s.dir, tool: "pi", compactor: { model: { provider: "anthropic", modelId: "claude-haiku-4-5", thinking: "low" } } });
		expect(readFileSync(join(s.agentDir, "instructions.md"), "utf8")).toBe(instructionsTemplate("Rpcs3", 'Continues the chat "Install RPCS3 AppImage".'));
		expect(texts(s.agentDir)).toEqual(["Install RPCS3 AppImage for me.", "Done."]);
	});

	it("never imports into a folder that already has a memory store (an archived agent's, even an empty one), and writes nothing then", () => {
		for (const archived of [["an archived agent's memory"], []]) {
			const s = scene();
			mkdirSync(s.agentDir, { recursive: true });
			const store = MemoryStore.open(join(s.agentDir, "memory.sqlite"));
			for (const text of archived) store.append("user", text);
			store.close();
			const before = readFileSync(s.configPath, "utf8");
			const files = readdirSync(s.agentDir).sort();
			expect(() => createFromPreview(s.configPath, s.request)).toThrow(`${s.agentDir} already has a memory store (an archived agent's, or an import that was cut short); nothing was written. Pick another name, or move that folder aside and try again.`);
			expect(storeRefusal(join(s.dir, "data"), "Rpcs3")).toMatch(/already has a memory store/);
			expect(storeRefusal(join(s.dir, "data"), "Other")).toBeUndefined();
			expect(readFileSync(s.configPath, "utf8")).toBe(before);
			expect(readdirSync(s.agentDir).sort()).toEqual(files);
			expect(texts(s.agentDir)).toEqual(archived);
		}
	});

	it("keeps instructions already in the folder", () => {
		const s = scene();
		mkdirSync(s.agentDir, { recursive: true });
		writeFileSync(join(s.agentDir, "instructions.md"), "You are Rpcs3.\n");
		createFromPreview(s.configPath, s.request);
		expect(readFileSync(join(s.agentDir, "instructions.md"), "utf8")).toBe("You are Rpcs3.\n");
	});

	// Guard: passed before the write order changed; now the taken name must be refused before memory is written.
	it("refuses a bad name, a taken one, or a broken preview before writing anything", () => {
		const s = scene();
		writeFileSync(s.configPath, `${readFileSync(s.configPath, "utf8")}[agents.rpcs3]\ncompactor_model = "openai/gpt-6.1-sol"\n`);
		expect(() => createFromPreview(s.configPath, s.request)).toThrow(/An agent named Rpcs3 already exists/);
		expect(existsSync(join(s.dir, "data"))).toBe(false);
		writeFileSync(s.configPath, `data_dir = ${JSON.stringify(join(s.dir, "data"))}\n`);
		const before = readFileSync(s.configPath, "utf8");
		expect(() => createFromPreview(s.configPath, { ...s.request, name: "push" })).toThrow(/a word orrery agent uses/);
		writeFileSync(s.request.previewPath, `${JSON.stringify({ kind: "thought", text: "x", date: T, source: "a" })}\n`);
		expect(() => createFromPreview(s.configPath, s.request)).toThrow(/Invalid preview/);
		expect(readFileSync(s.configPath, "utf8")).toBe(before);
		expect(existsSync(s.agentDir)).toBe(false);
	});
});

/** Every path under `dir`, for "no new files". */
const tree = (dir: string) => (readdirSync(dir, { recursive: true }) as string[]).sort();

describe("createFromPreview when a step fails", () => {
	/** After a failure: the config as it was, no file it made, and a retry under the same name works. */
	function undone(s: ReturnType<typeof scene>, config: string, files: string[], retry = () => createFromPreview(s.configPath, s.request)) {
		expect(readFileSync(s.configPath, "utf8")).toBe(config);
		expect(loadConfig(s.configPath).agents.has("Rpcs3")).toBe(false);
		expect(tree(s.dir)).toEqual(files);
		expect(retry()).toEqual({ agentDir: s.agentDir, messages: 2 });
		expect(texts(s.agentDir)).toEqual(["Install RPCS3 AppImage for me.", "Done."]);
	}

	it("instructions: an agent folder that is a symlink is refused, and the link and its target stay as they were", () => {
		const s = scene();
		const elsewhere = tempDir("orrery-create-agent-elsewhere-");
		dirs.push(elsewhere);
		mkdirSync(join(s.dir, "data", "agents"), { recursive: true });
		symlinkSync(elsewhere, s.agentDir);
		const config = readFileSync(s.configPath, "utf8");
		const files = tree(s.dir);
		expect(() => createFromPreview(s.configPath, s.request)).toThrow(/not a real folder/);
		expect(readdirSync(elsewhere)).toEqual([]);
		undone(s, config, files, () => {
			rmSync(s.agentDir);
			return createFromPreview(s.configPath, s.request);
		});
	});

	it("instructions: a write that fails after making the folder takes the folder away again", () => {
		const s = scene();
		const config = readFileSync(s.configPath, "utf8");
		const files = tree(s.dir);
		const failing = (dir: string, text: string) => {
			writeInstructions(dir, text);
			throw new Error("No space left on device");
		};
		expect(() => createFromPreview(s.configPath, s.request, { writeInstructions: failing })).toThrow(/No space left/);
		expect(existsSync(join(s.dir, "data"))).toBe(false);
		undone(s, config, files);
	});

	it("memory: a store another writer holds is refused; what was there before stays", () => {
		const s = scene();
		const release = holdWriterLock(join(s.agentDir, "memory.sqlite"));
		const config = readFileSync(s.configPath, "utf8");
		const files = tree(s.dir);
		try {
			expect(() => createFromPreview(s.configPath, s.request)).toThrow(/already open by another writer/);
			expect(tree(s.dir)).toEqual(files);
		} finally {
			release();
		}
		// The test's own lock kept a journal while it held the store; releasing it removes that.
		undone(s, config, files.filter((file) => !file.endsWith(".lock-journal")));
	});

	it("memory: a commit that fails takes the store (and its -wal, -shm and lock) and the folder away", () => {
		const s = scene();
		const config = readFileSync(s.configPath, "utf8");
		const files = tree(s.dir);
		const failing = (store: MemoryStore, lines: Parameters<typeof commitPreview>[1]) => {
			commitPreview(store, lines);
			throw new Error("disk I/O error");
		};
		expect(() => createFromPreview(s.configPath, s.request, { commit: failing })).toThrow(/disk I\/O error/);
		undone(s, config, files);
	});

	// Guard: the old order (config first) passed this too; with the config written last it holds the same promise.
	it.skipIf(process.getuid?.() === 0)("config: a config folder that can't be written leaves no memory, instructions or folder", () => {
		const s = scene();
		const config = readFileSync(s.configPath, "utf8");
		const files = tree(s.dir);
		chmodSync(s.dir, 0o500);
		try {
			expect(() => createFromPreview(s.configPath, s.request)).toThrow(/EACCES/);
		} finally {
			chmodSync(s.dir, 0o700);
		}
		undone(s, config, files);
	});

	it("config: an edit that fails after writing puts the config (and its .bak) back as they were", () => {
		const s = scene();
		writeFileSync(`${s.configPath}.bak`, "an older config\n");
		const config = readFileSync(s.configPath, "utf8");
		const files = tree(s.dir);
		const failing = (path: string, edit: (text: string, dir: string) => string) => {
			editConfigFile(path, edit);
			throw new Error("after the write");
		};
		expect(() => createFromPreview(s.configPath, s.request, { editConfig: failing })).toThrow(/after the write/);
		expect(readFileSync(`${s.configPath}.bak`, "utf8")).toBe("an older config\n");
		undone(s, config, files);
	});

	it("config: another process's edit made while this call wrote memory survives the rollback", () => {
		const s = scene();
		const files = tree(s.dir);
		let theirs = "";
		const failing = (store: MemoryStore, lines: Parameters<typeof commitPreview>[1]) => {
			commitPreview(store, lines);
			// Another Orrery process adds an agent meanwhile; this call never touches the config before it fails.
			editConfigFile(s.configPath, (text, dir) => addAgent(text, dir, { name: "Other", compactorModel: "openai/gpt-6.1-sol", compactorThinking: "low" }));
			theirs = readFileSync(s.configPath, "utf8");
			throw new Error("disk I/O error");
		};
		expect(() => createFromPreview(s.configPath, s.request, { commit: failing })).toThrow(/disk I\/O error/);
		expect(readFileSync(s.configPath, "utf8")).toBe(theirs);
		expect(loadConfig(s.configPath).agents.has("Other")).toBe(true);
		expect(tree(s.dir)).toEqual([...files, "config.toml.bak"].sort());
	});

	it("config: a save that fails after copying the .bak puts the old .bak back", () => {
		const s = scene();
		writeFileSync(`${s.configPath}.bak`, "an older config\n");
		// The save's temporary file can't be written (a folder is in its place): the .bak copy is made, the rename never.
		const temp = `${s.configPath}.tmp-${process.pid}`;
		mkdirSync(temp);
		const config = readFileSync(s.configPath, "utf8");
		const files = tree(s.dir);
		expect(() => createFromPreview(s.configPath, s.request)).toThrow(/EISDIR/);
		expect(readFileSync(`${s.configPath}.bak`, "utf8")).toBe("an older config\n");
		undone(s, config, files, () => {
			rmSync(temp, { recursive: true });
			return createFromPreview(s.configPath, s.request);
		});
	});

	it("takes away only the folders it made: one another process made meanwhile stays", () => {
		const s = scene();
		const config = readFileSync(s.configPath, "utf8");
		const agents = join(s.dir, "data", "agents");
		const failing = (store: MemoryStore, lines: Parameters<typeof commitPreview>[1]) => {
			commitPreview(store, lines);
			// Another process makes a folder of its own beside this agent's.
			mkdirSync(join(agents, "Theirs"));
			throw new Error("disk I/O error");
		};
		expect(() => createFromPreview(s.configPath, s.request, { commit: failing })).toThrow(/disk I\/O error/);
		expect(readFileSync(s.configPath, "utf8")).toBe(config);
		expect(existsSync(join(agents, "Theirs"))).toBe(true);
		expect(existsSync(s.agentDir)).toBe(false);
	});
});
