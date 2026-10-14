import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import { INSTRUCTIONS_MAX_BYTES, instructionsFacts, instructionsSection, instructionsTemplate, readInstructions, writeInstructions } from "../../src/agent/instructions.ts";
import { agentOverview } from "../../src/agent/overview.ts";
import { readStatus } from "../../src/agent/status-file.ts";
import { localIso } from "../../src/memory/index.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "orrery-instructions-"));
	dirs.push(dir);
	return dir;
};

/** A status.json as an open session of `agent` writes it, with `extra` fields. */
const openStatus = (agent: string, extra: object) => ({ agent, pid: process.pid, open: true, busy: false, model: "pi", thinking: "pi", memory: {}, compactor: { stopped: false, failing: 0, model: "openai/gpt-6.1-sol", thinking: "low", source: "config" }, lastError: null, updatedAt: localIso(), ...extra });

describe("instructions.md", () => {
	it("is read whole up to 32 KB, private, and named in the section's heading", () => {
		const dir = scratch();
		writeInstructions(dir, "You are Atlas.\nShip small changes.\n");
		const found = readInstructions(dir);
		expect(found).toMatchObject({ text: "You are Atlas.\nShip small changes.\n", cut: false });
		expect(instructionsSection("Atlas", found!)).toBe("# Agent: Atlas\n\nYou are Atlas.\nShip small changes.");
		expect(statSync(join(dir, "instructions.md")).mode & 0o777).toBe(0o600);
		expect(instructionsFacts(dir).state).toBe("ok");
	});

	it("is cut at 32 KB on a character boundary when longer, and says so", () => {
		const dir = scratch();
		writeInstructions(dir, `${"a".repeat(INSTRUCTIONS_MAX_BYTES - 1)}é and more`);
		const found = readInstructions(dir);
		expect(found?.cut).toBe(true);
		expect(found?.text).toBe("a".repeat(INSTRUCTIONS_MAX_BYTES - 1));
		expect(instructionsFacts(dir).state).toBe("too large");
	});

	it("exactly 32 KB is whole, and a file that ends in U+FFFD of its own keeps it", () => {
		const dir = scratch();
		writeInstructions(dir, "a".repeat(INSTRUCTIONS_MAX_BYTES));
		expect(readInstructions(dir)).toMatchObject({ cut: false, text: "a".repeat(INSTRUCTIONS_MAX_BYTES) });
		expect(instructionsFacts(dir).state).toBe("ok");
		writeInstructions(dir, "Odd ending �");
		expect(readInstructions(dir)?.text).toBe("Odd ending �");
	});

	it("missing, empty or blank is no instructions", () => {
		const dir = scratch();
		expect(readInstructions(dir)).toBeUndefined();
		expect(instructionsFacts(dir)).toEqual({ state: "none" });
		writeFileSync(join(dir, "instructions.md"), " \n\t\n");
		expect(readInstructions(dir)).toBeUndefined();
		expect(instructionsFacts(dir).state).toBe("none");
		writeFileSync(join(dir, "instructions.md"), "");
		expect(readInstructions(dir)).toBeUndefined();
	});

	// mkfifo is a POSIX tool: where it is missing there is no FIFO to test with.
	it.skipIf(spawnSync("mkfifo", ["--version"]).error !== undefined)("a FIFO where the file should be is no instructions, at once (never a wait for a writer)", () => {
		const dir = scratch();
		expect(spawnSync("mkfifo", [join(dir, "instructions.md")]).status).toBe(0);
		expect(readInstructions(dir)).toBeUndefined();
		expect(instructionsFacts(dir)).toEqual({ state: "none" });
	});

	it("a folder where the file should be is no instructions", () => {
		const dir = scratch();
		mkdirSync(join(dir, "instructions.md"));
		expect(readInstructions(dir)).toBeUndefined();
		expect(instructionsFacts(dir)).toEqual({ state: "none" });
	});

	it("starts a new agent with its purpose and where the rest goes; the section's heading names it, once", () => {
		expect(instructionsTemplate("Atlas")).toBe("What Atlas is for, in one line.\n\nAdd how this agent should work: its role, what it owns, how it reports.\n");
		expect(instructionsTemplate("Atlas", 'Continues the chat "Install RPCS3".')).toBe('Continues the chat "Install RPCS3".\n\nAdd how this agent should work: its role, what it owns, how it reports.\n');
		const dir = scratch();
		writeInstructions(dir, instructionsTemplate("Atlas"));
		expect(instructionsSection("Atlas", readInstructions(dir)!)).toBe("# Agent: Atlas\n\nWhat Atlas is for, in one line.\n\nAdd how this agent should work: its role, what it owns, how it reports.");
	});

	it("the overview says which agents have none, and which open agents have newer instructions than their session", () => {
		const root = scratch();
		const config = parseConfig(`data_dir = ${JSON.stringify(join(root, "data"))}\n[agents.Atlas]\ncompactor_model = "openai/gpt-6.1-sol"\n[agents.Birch]\ncompactor_model = "openai/gpt-6.1-sol"\n`, root);
		const atlas = config.agents.get("Atlas")!;
		writeInstructions(atlas.dir, "You are Atlas.\n");
		const at = statSync(join(atlas.dir, "instructions.md")).mtimeMs;
		writeFileSync(join(atlas.dir, "status.json"), JSON.stringify(openStatus("Atlas", { instructionsAt: at - 1000 })));
		const rows = agentOverview(config);
		expect(rows.map((row) => [row.name, row.instructions, row.instructionsNewer ?? false])).toEqual([["Atlas", "ok", true], ["Birch", "none", false]]);
	});

	it("an open session that read the file as it is now, or a closed one, has nothing newer; one that started with none does", () => {
		const root = scratch();
		const config = parseConfig(`data_dir = ${JSON.stringify(join(root, "data"))}\n[agents.Atlas]\ncompactor_model = "openai/gpt-6.1-sol"\n`, root);
		const atlas = config.agents.get("Atlas")!;
		writeInstructions(atlas.dir, `${"a".repeat(INSTRUCTIONS_MAX_BYTES)} and more`);
		const at = statSync(join(atlas.dir, "instructions.md")).mtimeMs;
		const newer = (status: object) => {
			writeFileSync(join(atlas.dir, "status.json"), JSON.stringify(status));
			const [row] = agentOverview(config);
			return [row.instructions, row.instructionsNewer ?? false];
		};
		expect(newer(openStatus("Atlas", { instructionsAt: at }))).toEqual(["too large", false]);
		expect(newer(openStatus("Atlas", { instructionsAt: at - 1000, open: false }))).toEqual(["too large", false]);
		// 0: the session started when the agent had no instructions.
		expect(newer(openStatus("Atlas", { instructionsAt: 0 }))).toEqual(["too large", true]);
		// A status from before the field existed says nothing either way.
		expect(newer(openStatus("Atlas", {}))).toEqual(["too large", false]);
	});

	it("status.json's instructionsAt is read when it is a number, and a status with another kind is not one Orrery wrote", () => {
		const dir = scratch();
		writeFileSync(join(dir, "status.json"), JSON.stringify(openStatus("Atlas", { instructionsAt: 1234 })));
		expect(readStatus(dir)?.instructionsAt).toBe(1234);
		writeFileSync(join(dir, "status.json"), JSON.stringify(openStatus("Atlas", { instructionsAt: "1234" })));
		expect(readStatus(dir)).toBeUndefined();
	});
});
