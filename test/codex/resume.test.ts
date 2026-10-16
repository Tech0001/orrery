import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexResumeLine, codexSessionOf, recordCodexSession } from "../../src/codex/resume.ts";
import { tempDir } from "../agent/support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agentDir(): string {
	const dir = tempDir("orrery-codex-resume-");
	dirs.push(dir);
	return dir;
}

const S1 = "01a146c5-9608-7e51-9376-7ac91c238b48";
const S2 = "01a146c5-ac30-7272-8230-b42589e5eec4";

describe("the session a Codex process is on", () => {
	it("is the last one its session-start hook recorded, per Codex process; dead processes' entries go", () => {
		const dir = agentDir();
		const alive = new Set([11, 22]);
		const isAlive = (pid: number) => alive.has(pid);
		recordCodexSession(dir, 11, S1, isAlive);
		recordCodexSession(dir, 22, S2, isAlive);
		expect(codexSessionOf(dir, 11)).toBe(S1);
		expect(codexSessionOf(dir, 22)).toBe(S2);
		// /clear in the same Codex: its newer session.
		recordCodexSession(dir, 11, S2, isAlive);
		expect(codexSessionOf(dir, 11)).toBe(S2);
		// A Codex that ended is forgotten at the next record (its own launcher read it at its end).
		alive.delete(22);
		recordCodexSession(dir, 11, S1, isAlive);
		expect(Object.keys(JSON.parse(readFileSync(join(dir, "claude", "codex-sessions.json"), "utf8")))).toEqual(["11"]);
		expect(codexSessionOf(dir, 33)).toBeUndefined();
	});

	it("is never a session id that is not one, and a file that can't be read is none", () => {
		const dir = agentDir();
		recordCodexSession(dir, 11, "../../etc", () => true);
		expect(codexSessionOf(dir, 11)).toBeUndefined();
		expect(codexSessionOf(agentDir(), 11)).toBeUndefined();
	});
});

describe("codexResumeLine", () => {
	it("gives the Orrery way to resume only this Codex's own session: never a guess, which could be another agent's chat", () => {
		const dir = agentDir();
		recordCodexSession(dir, 11, S1, () => true);
		expect(codexResumeLine({ name: "Atlas", dir }, 11)).toBe(`To continue it as Atlas, with its memory and the guard: orrery agent Atlas --tool codex -- resume ${S1}`);
		// A Codex that noted no session (it ended before a first prompt), or never claimed the agent's token: nothing.
		expect(codexResumeLine({ name: "Atlas", dir }, 12)).toBeUndefined();
		expect(codexResumeLine({ name: "Atlas", dir }, undefined)).toBeUndefined();
	});
});
