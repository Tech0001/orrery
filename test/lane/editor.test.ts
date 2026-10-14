import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editInstructionsFile, editorCommand, runEditor } from "../../src/lane/editor.ts";
import { instructionsTemplate } from "../../src/lane/instructions.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
	const dir = tempDir(prefix);
	dirs.push(dir);
	return dir;
}

describe("the instructions editor", () => {
	it("is $EDITOR, else nano when it is on PATH, else vi", () => {
		const bin = scratch("orrery-editor-bin-");
		expect(editorCommand({ EDITOR: "code --wait", PATH: bin })).toBe("code --wait");
		expect(editorCommand({ EDITOR: "  ", PATH: bin })).toBe("vi");
		expect(editorCommand({ PATH: bin })).toBe("vi");
		writeFileSync(join(bin, "nano"), "#!/bin/sh\n", { mode: 0o755 });
		expect(editorCommand({ PATH: bin })).toBe("nano");
	});

	it("runs an $EDITOR that carries arguments, on the file", async () => {
		const dir = scratch("orrery-editor-");
		mkdirSync(join(dir, "bin"));
		writeFileSync(join(dir, "bin", "fake-editor"), `#!/bin/sh\n[ "$1" = --wait ] || exit 9\nprintf 'Edited.\\n' >> "$2"\n`, { mode: 0o755 });
		writeFileSync(join(dir, "instructions.md"), "# Atlas\n");
		const exit = await runEditor(join(dir, "instructions.md"), { env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, EDITOR: "fake-editor --wait" } });
		expect(exit).toEqual({ code: 0, signal: null });
		expect(readFileSync(join(dir, "instructions.md"), "utf8")).toBe("# Atlas\nEdited.\n");
	});

	it("hands the path to the editor as an argument, never as shell text, and gives back its exit and Ctrl-C", async () => {
		const dir = scratch("orrery-editor-");
		mkdirSync(join(dir, "bin"));
		writeFileSync(join(dir, "bin", "fake-editor"), `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(join(dir, "seen"))}\nexit 4\n`, { mode: 0o755 });
		const odd = join(dir, `a $(touch ${join(dir, "pwned")}) 'b'.md`);
		const before = process.listenerCount("SIGINT");
		const exit = await runEditor(odd, { env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, EDITOR: "fake-editor" } });
		expect(exit).toEqual({ code: 4, signal: null });
		expect(readFileSync(join(dir, "seen"), "utf8")).toBe(odd);
		expect(existsSync(join(dir, "pwned"))).toBe(false);
		expect(process.listenerCount("SIGINT")).toBe(before);
		await expect(runEditor(odd, { spawn: (() => { throw new Error("no spawn"); }) as never })).rejects.toThrow("no spawn");
		expect(process.listenerCount("SIGINT")).toBe(before);
	});
});

describe("editing an agent's instructions (orrery agent edit, the TUI's E)", () => {
	const lane = (dir: string) => ({ name: "Atlas", dir: join(dir, "lanes", "Atlas") });
	const closed = { state: "closed" as const, tool: "pi" as const };

	it("writes the template when there are none, opens the editor on the file, and keeps what is there otherwise", async () => {
		const atlas = lane(scratch("orrery-edit-"));
		const path = join(atlas.dir, "instructions.md");
		const opened: string[] = [];
		const done = await editInstructionsFile(atlas, () => closed, async (file) => {
			opened.push(file);
			expect(readFileSync(file, "utf8")).toBe(instructionsTemplate("Atlas"));
			return { code: 0, signal: null };
		});
		expect(done).toEqual({ path, exit: { code: 0, signal: null } });
		expect(opened).toEqual([path]);
		writeFileSync(path, "Mine.\n");
		await editInstructionsFile(atlas, () => undefined, async () => ({ code: 0, signal: null }));
		expect(readFileSync(path, "utf8")).toBe("Mine.\n");
	});

	it("says how the editor failed", async () => {
		const atlas = lane(scratch("orrery-edit-"));
		expect((await editInstructionsFile(atlas, () => closed, async () => ({ code: 3, signal: null }))).failed).toBe("exited with code 3");
		expect((await editInstructionsFile(atlas, () => closed, async () => ({ code: null, signal: "SIGTERM" }))).failed).toBe("was stopped (SIGTERM)");
	});

	it("says when an open session reads them: pi and OMP at their next start, Claude Code at its next session; looked at after the edit", async () => {
		const atlas = lane(scratch("orrery-edit-"));
		const ok = async () => ({ code: 0, signal: null });
		expect((await editInstructionsFile(atlas, () => ({ state: "open", openIn: "pi", tool: "pi" }), ok)).readsAt).toBe("next start");
		expect((await editInstructionsFile(atlas, () => ({ state: "working", openIn: "omp", tool: "pi" }), ok)).readsAt).toBe("next start");
		expect((await editInstructionsFile(atlas, () => ({ state: "open", openIn: "claude-code", tool: "pi" }), ok)).readsAt).toBe("next session");
		expect((await editInstructionsFile(atlas, () => closed, ok)).readsAt).toBeUndefined();
		let state: "open" | "closed" = "closed";
		const opensWhileEditing = async () => {
			state = "open";
			return { code: 0, signal: null };
		};
		expect((await editInstructionsFile(atlas, () => ({ state, openIn: "pi", tool: "pi" }), opensWhileEditing)).readsAt).toBe("next start");
	});
});
