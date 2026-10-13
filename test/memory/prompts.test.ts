import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPACT, ELIDED_NOTE, LEAF_TASK, MASTER, MERGE_TASK, TOO_LONG, VIEW_DOC } from "../../src/memory/prompts.ts";

const python = readFileSync(new URL("../../reference/optchat-py/optchat/prompts.py", import.meta.url), "utf8");

function pythonPrompt(name: string): string {
	const match = new RegExp(`^${name} = """([\\s\\S]*?)"""`, "m").exec(python);
	if (match === null) throw new Error(`${name} not found in prompts.py`);
	return match[1];
}

describe("prompts", () => {
	it("match the Python reference byte for byte", () => {
		for (const [name, text] of Object.entries({ COMPACT, LEAF_TASK, MERGE_TASK, TOO_LONG, ELIDED_NOTE, MASTER, VIEW_DOC })) {
			expect(text, name).toBe(pythonPrompt(name));
		}
		expect(COMPACT).not.toMatch(/[{}]/); // never formatted, and safe if it ever is
	});
});
