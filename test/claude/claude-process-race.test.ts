/**
 * Two deciders of one Claude Code process at once (src/claude/pick.ts claudeSession): the MCP server and SessionStart
 * both find no record, or both find a stale one (another identity's). Each test runs the second decision at an instant
 * inside the first: between writing its record whole and linking it into place, or at its rename of the stale record
 * away. The first then finds the second's record there and must answer with it, not its own.
 */

import { mkdirSync, type PathLike, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClaudePicked, claudeSession } from "../../src/claude/pick.ts";
import { writeSetupMarker } from "../../src/claude/view-file.ts";
import { parseConfig } from "../../src/agent/config.ts";
import { tempDir } from "../agent/support.ts";

/** Runs once, before the first decider's first link or first rename, or right after that rename. */
const hook = vi.hoisted(() => ({
	beforeLink: undefined as (() => void) | undefined,
	beforeRename: undefined as (() => void) | undefined,
	afterRename: undefined as ((source: string, target: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const once = <A extends unknown[]>(slot: "beforeLink" | "beforeRename" | "afterRename", ...args: A) => {
		const run = hook[slot] as ((...args: A) => void) | undefined;
		hook[slot] = undefined;
		run?.(...args);
	};
	return {
		...fs,
		default: fs,
		linkSync: (source: PathLike, target: PathLike) => {
			once("beforeLink");
			return fs.linkSync(source, target);
		},
		renameSync: (source: PathLike, target: PathLike) => {
			once("beforeRename");
			fs.renameSync(source, target);
			once("afterRename", String(source), String(target));
		},
	};
});

const dirs: string[] = [];
afterEach(() => {
	hook.beforeLink = undefined;
	hook.beforeRename = undefined;
	hook.afterRename = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Test and Other, Other's folder set up the file way (an agent opened there by ORRERY_AGENT is refused), and elsewhere. */
function world() {
	const root = tempDir("orrery-decide-race-");
	dirs.push(root);
	for (const folder of ["agent-Test", "agent-Other", "elsewhere"]) mkdirSync(join(root, folder));
	const agent = (name: string) => `[agents.${name}]\nfolder = ${JSON.stringify(join(root, `agent-${name}`))}\ncompactor_model = "faux-compactor/faux-1"\n`;
	const config = parseConfig(`data_dir = ${JSON.stringify(join(root, "data"))}\n${agent("Test")}${agent("Other")}`, root);
	writeSetupMarker(config.agents.get("Other")?.dir as string, join(root, "agent-Other"), "CLAUDE.md");
	return { root, config, records: join(config.dataDir, "claude-processes") };
}

const env = { ORRERY_AGENT: "Test" };

describe("two deciders of one Claude Code process", () => {
	it("race: the loser reads the winner's record and answers with it", () => {
		const { root, config, records } = world();
		// The two would decide differently (their folders differ), so the answer tells whose record stands.
		let winner: ClaudePicked | undefined;
		hook.beforeLink = () => {
			winner = claudeSession(config, { env, cwd: join(root, "agent-Other"), pid: process.pid, decide: true });
		};
		const loser = claudeSession(config, { env, cwd: join(root, "elsewhere"), pid: process.pid, decide: true });
		expect(winner).toEqual({ kind: "in-view-folder", name: "Test", host: "Other" });
		expect(loser).toEqual(winner);
		expect(JSON.parse(readFileSync(join(records, `${process.pid}.json`), "utf8"))).toMatchObject({ kind: "refused", why: "in-view-folder" });
	});

	it("race over a stale record: the loser answers with the winner's decision, which is the record that stands", () => {
		const { root, config, records } = world();
		mkdirSync(records, { recursive: true, mode: 0o700 });
		writeFileSync(join(records, `${process.pid}.json`), JSON.stringify({ agent: "Birch", token: "", kind: "agent", name: "Test", by: "env" }));
		let winner: ClaudePicked | undefined;
		hook.beforeRename = () => {
			winner = claudeSession(config, { env, cwd: join(root, "agent-Other"), pid: process.pid, decide: true });
		};
		const loser = claudeSession(config, { env, cwd: join(root, "elsewhere"), pid: process.pid, decide: true });
		expect(winner).toEqual({ kind: "in-view-folder", name: "Test", host: "Other" });
		expect(loser).toEqual(winner);
		expect(JSON.parse(readFileSync(join(records, `${process.pid}.json`), "utf8"))).toEqual({ agent: "Test", token: "", start: expect.any(String), kind: "refused", why: "in-view-folder", name: "Test", host: "Other" });
		expect(readdirSync(records)).toEqual([`${process.pid}.json`]);
	});

	it("a stale record's graveyard swept as a stray by another decider's prune, between the move and the judgment: the decision is still recorded", () => {
		const { root, config, records } = world();
		mkdirSync(records, { recursive: true, mode: 0o700 });
		const file = join(records, `${process.pid}.json`);
		writeFileSync(file, JSON.stringify({ agent: "Birch", token: "", kind: "none" }));
		// An old stale record: its graveyard keeps the mtime, so another process's prune takes it for a stray.
		const longAgo = new Date(Date.now() - 3_600_000);
		utimesSync(file, longAgo, longAgo);
		hook.afterRename = (_source, target) => rmSync(target);
		expect(claudeSession(config, { env, cwd: join(root, "elsewhere"), pid: process.pid, decide: true })).toMatchObject({ kind: "agent", by: "env", agent: { name: "Test" } });
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ agent: "Test", token: "", start: expect.any(String), kind: "agent", name: "Test", by: "env" });
		expect(readdirSync(records)).toEqual([`${process.pid}.json`]);
	});
});
