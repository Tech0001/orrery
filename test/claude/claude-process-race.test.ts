/**
 * Two deciders of one Claude Code process at once (src/claude/pick.ts claudeSession): the MCP server and SessionStart
 * both find no record, or both find a stale one (another identity's). Each test runs the second decision at an instant
 * inside the first: between writing its record whole and linking it into place, or at its rename of the stale record
 * away. The first then finds the second's record there and must answer with it, not its own.
 */

import { mkdirSync, type PathLike, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClaudePicked, claudeSession } from "../../src/claude/pick.ts";
import { writeSetupMarker } from "../../src/claude/view-file.ts";
import { parseConfig } from "../../src/lane/config.ts";
import { tempDir } from "../lane/support.ts";

/** Runs once, before the first decider's first link or first rename. */
const hook = vi.hoisted(() => ({ beforeLink: undefined as (() => void) | undefined, beforeRename: undefined as (() => void) | undefined }));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const once = (slot: "beforeLink" | "beforeRename") => {
		const run = hook[slot];
		hook[slot] = undefined;
		run?.();
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
			return fs.renameSync(source, target);
		},
	};
});

const dirs: string[] = [];
afterEach(() => {
	hook.beforeLink = undefined;
	hook.beforeRename = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Test and Other, Other's folder set up the file way (an agent opened there by ORRERY_AGENT is refused), and elsewhere. */
function world() {
	const root = tempDir("orrery-decide-race-");
	dirs.push(root);
	for (const folder of ["agent-Test", "agent-Other", "elsewhere"]) mkdirSync(join(root, folder));
	const lane = (name: string) => `[lanes.${name}]\nworkspace = ${JSON.stringify(join(root, `agent-${name}`))}\ncompactor_model = "faux-compactor/faux-1"\n`;
	const config = parseConfig(`data_dir = ${JSON.stringify(join(root, "data"))}\n${lane("Test")}${lane("Other")}`, root);
	writeSetupMarker(config.lanes.get("Other")?.dir as string, join(root, "agent-Other"), "CLAUDE.md");
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
		writeFileSync(join(records, `${process.pid}.json`), JSON.stringify({ agent: "Birch", token: "", kind: "lane", lane: "Test", by: "env" }));
		let winner: ClaudePicked | undefined;
		hook.beforeRename = () => {
			winner = claudeSession(config, { env, cwd: join(root, "agent-Other"), pid: process.pid, decide: true });
		};
		const loser = claudeSession(config, { env, cwd: join(root, "elsewhere"), pid: process.pid, decide: true });
		expect(winner).toEqual({ kind: "in-view-folder", name: "Test", host: "Other" });
		expect(loser).toEqual(winner);
		expect(JSON.parse(readFileSync(join(records, `${process.pid}.json`), "utf8"))).toEqual({ agent: "Test", token: "", kind: "refused", why: "in-view-folder", name: "Test", host: "Other" });
		expect(readdirSync(records)).toEqual([`${process.pid}.json`]);
	});
});
