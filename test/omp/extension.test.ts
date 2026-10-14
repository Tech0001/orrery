import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessConfig } from "../../src/lane/config.ts";
import { MemoryStore } from "../../src/memory/index.ts";
import { createOrrery, type LaneSettingsResult, summaryWaitMs } from "../../src/pi/index.ts";
import { ageVisitMarks, cleanup, scratchHome, summarySourcesFor, world } from "../pi/world.ts";
import { type FakeOmp, fakeOmp, ompCleanup, ompOrrery, track } from "./world.ts";

afterEach(async () => {
	await ompCleanup();
	await cleanup();
});

const memoryOf = (root: string, lane = "Atlas") => {
	const store = MemoryStore.openReadOnly(join(root, "data", "lanes", lane, "memory.sqlite"));
	const rows = store.root.map((m) => `${m.kind}: ${m.text}`);
	store.close();
	return rows;
};

/** One turn as OMP runs it: the user's message, the hook before the run, the reply, the run's end. */
async function turn(omp: FakeOmp, user: string, reply: string, system: string[] = ["OMP base"]) {
	omp.say("user", user);
	const [result] = await omp.emit("before_agent_start", { prompt: user, systemPrompt: system });
	omp.say("assistant", reply);
	await omp.emit("message_end", { message: {} });
	await omp.emit("agent_end", { messages: [] });
	return result as { systemPrompt: string[] } | undefined;
}

/**
 * One turn in OMP's own order: the hook before the run comes before the prompt is saved, since OMP saves each message at
 * its message_end (agent-session.ts #appendSessionMessage). turn() saves the prompt first, which is the same for every
 * test but those that move the session.
 */
async function promptedTurn(omp: FakeOmp, user: string, reply: string) {
	await omp.emit("before_agent_start", { prompt: user, systemPrompt: ["OMP base"] });
	omp.say("user", user);
	await omp.emit("message_end", { message: {} });
	omp.say("assistant", reply);
	await omp.emit("message_end", { message: {} });
	await omp.emit("agent_end", { messages: [] });
}

describe("Orrery inside OMP (an OMP-shaped host)", () => {
	it("opens the lane, says omp in status.json, and registers zoom, date, memory_search (essential) and /orrery", async () => {
		const { root, config } = world();
		const omp = await ompOrrery(join(root, "agent-Atlas"), config);
		const status = JSON.parse(readFileSync(join(root, "data", "lanes", "Atlas", "status.json"), "utf8"));
		expect(status).toMatchObject({ lane: "Atlas", model: "omp", open: true });
		expect(omp.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		expect([...omp.tools.keys()].sort()).toEqual(["date", "memory_search", "zoom"]);
		expect([...omp.tools.values()].every((tool) => tool.loadMode === "essential")).toBe(true);
		expect([...omp.commands.keys()].sort()).toEqual(["browse", "compactor", "orrery"]);
		await omp.run("orrery");
		expect(omp.notices.at(-1)).toEqual({ message: expect.stringMatching(/^Atlas: 0 messages, /), type: "info" });
	});

	it("registers /orrery, /compactor and /browse at load, before any session event, for OMP's autocomplete", async () => {
		const { root, config } = world();
		const plain = fakeOmp(join(root, "plain"), [createOrrery({ config, host: "omp", ...scratchHome(dirname(config.dataDir)) })]);
		expect([...plain.commands.keys()].sort()).toEqual(["browse", "compactor", "orrery"]);
		expect(plain.tools.size).toBe(0);
		await plain.emit("session_start");
		// outside a lane folder they warn and do not throw
		for (const name of ["orrery", "compactor", "browse"]) await plain.run(name);
		expect(plain.notices).toEqual(Array(3).fill({ message: "Orrery: no lane memory is open in this OMP", type: "warning" }));
		expect(plain.tools.size).toBe(0);
		// registered once; a lane opening later uses the same commands
		const lane = fakeOmp(join(root, "agent-Atlas"), [createOrrery({ config, host: "omp", ...scratchHome(dirname(config.dataDir)) })]);
		track(lane);
		const before = [...lane.commands.values()];
		await lane.emit("session_start");
		expect([...lane.commands.values()]).toEqual(before);
		await lane.run("orrery");
		expect(lane.notices.at(-1)).toEqual({ message: expect.stringMatching(/^Atlas: 0 messages, /), type: "info" });
	});

	it("pi's entry registers no commands before a lane opens, then /memory, /compactor and /browse (unchanged)", async () => {
		const { root, config } = world();
		const pi = track(fakeOmp(join(root, "agent-Atlas"), [createOrrery({ config, ...scratchHome(dirname(config.dataDir)) })], { omp: false }));
		expect(pi.commands.size).toBe(0);
		await pi.emit("session_start");
		expect([...pi.commands.keys()].sort()).toEqual(["browse", "compactor", "memory"]);
	});

	it("gives a reading lane lanes and lane_memory, essential too", async () => {
		const { root, config } = world();
		const omp = await ompOrrery(join(root, "agent-Birch"), config);
		expect(omp.tools.get("lanes")?.loadMode).toBe("essential");
		expect(omp.tools.get("lane_memory")?.loadMode).toBe("essential");
	});

	it("adds the memory section as the last system block, naming memory_search, and records the turn", async () => {
		const { root, config } = world();
		const omp = await ompOrrery(join(root, "agent-Atlas"), config);
		const result = await turn(omp, "The codename is Cedar.", "Noted.", ["OMP base", "OMP tools"]);
		expect(result?.systemPrompt).toHaveLength(3);
		expect(result?.systemPrompt.slice(0, 2)).toEqual(["OMP base", "OMP tools"]);
		expect(result?.systemPrompt[2]).toMatch(/^# Memory\n\nYou keep no memory between turns\./);
		expect(result?.systemPrompt[2]).toContain("zoom, date and memory_search are the Orrery memory tools; where this section says search, call memory_search.");
		expect(memoryOf(root)).toEqual(["user: The codename is Cedar.", "talk: Noted."]);
		expect(omp.status("orrery")).toMatch(/^Orrery · Atlas · 2 msgs/);
	});

	it("records /fork, a rewind, /new and /resume (session_switch, session_branch) without copying a message twice", async () => {
		const { root, config } = world();
		const omp = await ompOrrery(join(root, "agent-Atlas"), config);
		await turn(omp, "One.", "First.");
		const first = omp.session;
		// /fork: a new session id over the same entries, its header naming the parent
		omp.session = { id: "s2", parentSession: "/sessions/s1.jsonl", entries: [...first.entries] };
		await omp.emit("session_switch", { reason: "fork", previousSessionFile: "/sessions/s1.jsonl" });
		await turn(omp, "Two.", "Second.");
		// a rewind to the first reply: session_branch, a new id holding entries already copied
		omp.session = { id: "s3", parentSession: "/sessions/s2.jsonl", entries: omp.session.entries.slice(0, 2) };
		await omp.emit("session_branch", { reason: "branch", previousSessionFile: "/sessions/s2.jsonl" });
		await turn(omp, "Three.", "Third.");
		// /new: an empty session
		omp.session = { id: "s4", entries: [] };
		await omp.emit("session_switch", { reason: "new", previousSessionFile: "/sessions/s3.jsonl" });
		await turn(omp, "Four.", "Fourth.");
		// /resume of the first session: nothing new in it
		omp.session = first;
		await omp.emit("session_switch", { reason: "resume", previousSessionFile: "/sessions/s4.jsonl" });
		expect(memoryOf(root)).toEqual(["user: One.", "talk: First.", "user: Two.", "talk: Second.", "user: Three.", "talk: Third.", "user: Four.", "talk: Fourth."]);
	});

	it("records a rewind told only by session_branch (no parent in the header), and keeps what a /btw branch adds", async () => {
		// OMP names the parent in a branch's header when the session is saved; session_branch alone must be enough.
		for (const parentSession of [undefined, "/sessions/s2.jsonl"]) {
			const { root, config } = world();
			const omp = await ompOrrery(join(root, "agent-Atlas"), config);
			await turn(omp, "One.", "First.");
			await turn(omp, "Two.", "Second.");
			// a rewind to the first reply: a new id over entries already copied
			omp.session = { id: "s2", entries: omp.session.entries.slice(0, 2) };
			await omp.emit("session_branch", { reason: "branch", previousSessionFile: "/sessions/s1.jsonl" });
			await turn(omp, "Three.", "Third.");
			// "branch from /btw": OMP asks before branching at the leaf, branches there, appends the side question and its
			// answer, then says session_branch "btw" (agent-session.ts branchFromBtw)
			const leaf = omp.session.entries.at(-1)?.id;
			await omp.emit("session_before_branch", { reason: "btw", entryId: leaf });
			omp.session = { id: "s3", ...(parentSession === undefined ? {} : { parentSession }), entries: [...omp.session.entries] };
			omp.say("user", "By the way?");
			omp.say("assistant", "Aside.");
			await omp.emit("session_branch", { reason: "btw", previousSessionFile: "/sessions/s2.jsonl" });
			await turn(omp, "Four.", "Fourth.");
			// a /btw branch Orrery was not told the leaf of copies nothing twice
			omp.session = { id: "s4", entries: [...omp.session.entries] };
			await omp.emit("session_branch", { reason: "btw", previousSessionFile: "/sessions/s3.jsonl" });
			await turn(omp, "Five.", "Fifth.");
			expect([parentSession, memoryOf(root)]).toEqual([
				parentSession,
				["One.", "First.", "Two.", "Second.", "Three.", "Third.", "By the way?", "Aside.", "Four.", "Fourth.", "Five.", "Fifth."].map((text, i) => `${i % 2 === 0 ? "user" : "talk"}: ${text}`),
			]);
		}
	});

	it("gives an OMP subagent the guard, and no memory, tools or notices", async () => {
		const { root, config } = world();
		const cwd = join(root, "agent-Atlas");
		const main = await ompOrrery(cwd, config);
		const sub = await ompOrrery(cwd, config, { agent: "sub" });
		expect(sub.tools.size).toBe(0);
		// The commands exist from load (a subagent is not known then); they only warn there.
		expect(sub.notices).toEqual([]);
		const escape = `${root}-escape.txt`; // outside the lane's allowed roots (the workspace's parent folder)
		expect(await sub.emit("tool_call", { toolName: "write", toolCallId: "t1", input: { path: escape, content: "x" } })).toEqual([
			{ block: true, reason: expect.stringMatching(/outside this lane's workspace/) },
		]);
		await turn(main, "Still here.", "Yes.");
		expect(memoryOf(root)).toEqual(["user: Still here.", "talk: Yes."]);
	});

	it("tells a second OMP on a held lane that it runs without memory, naming OMP", async () => {
		const { root, config } = world();
		await ompOrrery(join(root, "agent-Atlas"), config);
		const second = await ompOrrery(join(root, "agent-Atlas"), config);
		expect(second.tools.size).toBe(0);
		expect(second.notices).toContainEqual({ message: "Atlas is already open in another session; this OMP runs without memory.", type: "warning" });
	});

	it("cancels OMP's compaction in a lane (its event has no reason), without a notice", async () => {
		const { root, config } = world();
		const omp = await ompOrrery(join(root, "agent-Atlas"), config);
		expect(await omp.emit("session_before_compact", { branchEntries: [] })).toEqual([{ cancel: true }]);
		expect(omp.notices).toEqual([]);
	});

	it("guards OMP's multi-file edit through the tool_call hook", async () => {
		const { root, config } = world();
		const omp = await ompOrrery(join(root, "agent-Atlas"), config);
		expect(await omp.emit("tool_call", { toolName: "edit", toolCallId: "t1", input: { paths: ["a.ts", `${root}-escape.ts`] } })).toEqual([
			{ block: true, reason: expect.stringMatching(/outside this lane's workspace/) },
		]);
	});

	it("judges OMP's spellings, and the given home's OMP profiles, through the tool_call hook (fix round 1)", async () => {
		const { root, config } = world();
		const profile = join(root, "home", ".omp", "profiles", "work");
		mkdirSync(join(profile, "agent"), { recursive: true });
		const omp = await ompOrrery(join(root, "agent-Atlas"), config);
		const call = async (toolName: string, input: object) => (await omp.emit("tool_call", { toolName, toolCallId: "t1", input }))[0];
		expect(await call("grep", { pattern: "k", path: profile })).toEqual({ block: true, reason: expect.stringMatching(/narrower folder/) });
		expect(await call("grep", { pattern: "k", path: ":~" })).toEqual({ block: true, reason: expect.stringMatching(/narrower folder/) });
		expect(await call("write", { path: "[/etc/x#1a2b]", content: "x" })).toEqual({ block: true, reason: expect.stringMatching(/outside this lane's workspace/) });
		expect(await call("grep", { pattern: "k", path: "src" })).toBeUndefined();
	});

	it("runs each entry only in its own tool (pi and OMP may share one extensions folder); in the other, its guard's session_start and the session-owner notes", () => {
		const { root, config } = world();
		const cwd = join(root, "agent-Atlas");
		const other = ["session_start", "message_end", "agent_end", "session_shutdown"];
		expect(fakeOmp(cwd, [createOrrery({ config, host: "omp", ...scratchHome(root) })], { omp: false }).events()).toEqual(other);
		expect(fakeOmp(cwd, [createOrrery({ config, ...scratchHome(root) })]).events()).toEqual(other);
		expect(fakeOmp(cwd, [createOrrery({ config, host: "omp", ...scratchHome(root) })]).events()).toContain("session_switch");
	});
});

describe("a session that moves to another folder (OMP's /resume of another folder's session, /move)", () => {
	const statusOf = (root: string, lane: string) => JSON.parse(readFileSync(join(root, "data", "lanes", lane, "status.json"), "utf8")) as { open: boolean; model: string };

	/** OMP's laneSettings as a log: what was switched for which lane folder, and taken back. */
	function settingsLog() {
		const log: string[] = [];
		const laneSettings = async (_ctx: unknown, workspace: string): Promise<LaneSettingsResult> => {
			log.push(`apply ${basename(workspace)}`);
			return { applied: true, restore: () => log.push(`restore ${basename(workspace)}`) };
		};
		return { log, laneSettings };
	}

	/** /resume of a saved session from `cwd`: OMP moves the session there, then says session_switch "resume". */
	async function resume(omp: FakeOmp, cwd: string, id: string, question: string, answer: string) {
		omp.cwd = cwd;
		omp.session = { id, entries: [] };
		omp.say("user", question);
		omp.say("assistant", answer);
		await omp.emit("session_switch", { reason: "resume", previousSessionFile: "/sessions/s1.jsonl" });
	}

	it("into a folder outside lanes: closes the lane (status, lock, footer, OMP's settings), copies nothing from there, runs as plain OMP", async () => {
		const { root, config } = world();
		const { log, laneSettings } = settingsLog();
		const omp = await ompOrrery(join(root, "agent-Atlas"), config, { laneSettings });
		await turn(omp, "One.", "First.");
		await resume(omp, join(root, "plain"), "elsewhere", "Foreign question.", "Foreign answer.");
		expect(omp.notices).toEqual([{ message: "Orrery: this session moved from Atlas to another folder; Atlas's memory is closed.", type: "info" }]);
		expect(log).toEqual(["apply agent-Atlas", "restore agent-Atlas"]);
		expect(statusOf(root, "Atlas").open).toBe(false);
		expect(omp.status("orrery")).toBeUndefined();
		expect(await turn(omp, "Plain question.", "Plain answer.")).toBeUndefined();
		await omp.emit("session_shutdown");
		expect(memoryOf(root)).toEqual(["user: One.", "talk: First."]);
		// Plain OMP: no lane guard, no lane memory.
		expect(await omp.emit("tool_call", { toolName: "write", toolCallId: "t1", input: { path: `${root}-escape.txt`, content: "x" } })).toEqual([undefined]);
		await omp.run("orrery");
		expect(omp.notices.at(-1)).toEqual({ message: "Orrery: no lane memory is open in this OMP", type: "warning" });
		// The lock is free: another OMP opens Atlas.
		const next = await ompOrrery(join(root, "agent-Atlas"), config);
		expect(next.notices).toEqual([]);
		expect(next.tools.size).toBe(3);
	});

	it("into another lane's folder: closes this lane and opens that one, which records only what comes after the move", async () => {
		const { root, config } = world();
		const { log, laneSettings } = settingsLog();
		const omp = await ompOrrery(join(root, "agent-Atlas"), config, { laneSettings });
		await turn(omp, "One.", "First.");
		await resume(omp, join(root, "agent-Birch"), "birch-1", "Birch question.", "Birch answer.");
		expect(omp.notices).toEqual([{ message: "Orrery: this session moved from Atlas to another folder; Atlas's memory is closed. Opened Birch: it records from here on.", type: "info" }]);
		expect(log).toEqual(["apply agent-Atlas", "restore agent-Atlas", "apply agent-Birch"]);
		expect(statusOf(root, "Atlas").open).toBe(false);
		expect(statusOf(root, "Birch")).toMatchObject({ open: true, model: "omp" });
		expect(omp.status("orrery")).toMatch(/^Orrery · Birch · 0 msgs/);
		await turn(omp, "Two.", "Second.");
		expect(memoryOf(root)).toEqual(["user: One.", "talk: First."]);
		// Lane privacy: none of the session's earlier messages enter Birch's memory, only the turn after the move.
		expect(memoryOf(root, "Birch")).toEqual(["user: Two.", "talk: Second."]);
		const next = await ompOrrery(join(root, "agent-Atlas"), config);
		expect(next.notices).toEqual([]);
	});

	it("by /move into another lane's folder and back: neither lane gets the other's turns", async () => {
		const { root, config } = world();
		const omp = await ompOrrery(join(root, "agent-Atlas"), config);
		await turn(omp, "One.", "First.");
		omp.cwd = join(root, "agent-Birch");
		await promptedTurn(omp, "Two.", "Second.");
		omp.cwd = join(root, "agent-Atlas");
		await promptedTurn(omp, "Three.", "Third.");
		expect(memoryOf(root)).toEqual(["user: One.", "talk: First.", "user: Three.", "talk: Third."]);
		expect(memoryOf(root, "Birch")).toEqual(["user: Two.", "talk: Second."]);
	});

	it("into a lane held elsewhere: closes this lane, guards that one, and says it opened nothing", async () => {
		const { root, config } = world();
		await ompOrrery(join(root, "agent-Birch"), config);
		const omp = await ompOrrery(join(root, "agent-Atlas"), config);
		await resume(omp, join(root, "agent-Birch"), "birch-1", "Birch question.", "Birch answer.");
		expect(omp.notices).toEqual([
			{ message: "Birch is already open in another session; this OMP runs without memory.", type: "warning" },
			{ message: "Orrery: this session moved from Atlas to another folder; Atlas's memory is closed.", type: "info" },
		]);
		expect(await omp.emit("tool_call", { toolName: "write", toolCallId: "t1", input: { path: `${root}-escape.txt`, content: "x" } })).toEqual([
			{ block: true, reason: expect.stringMatching(/outside this lane's workspace/) },
		]);
		expect(memoryOf(root)).toEqual([]);
	});

	it("within the same lane (a subfolder): changes nothing and says nothing", async () => {
		const { root, config } = world();
		const { log, laneSettings } = settingsLog();
		mkdirSync(join(root, "agent-Atlas", "src"));
		const omp = await ompOrrery(join(root, "agent-Atlas"), config, { laneSettings });
		await turn(omp, "One.", "First.");
		await resume(omp, join(root, "agent-Atlas", "src"), "s2", "Two.", "Second.");
		expect(omp.notices).toEqual([]);
		expect(log).toEqual(["apply agent-Atlas"]);
		expect(memoryOf(root)).toEqual(["user: One.", "talk: First.", "user: Two.", "talk: Second."]);
		expect(omp.status("orrery")).toMatch(/^Orrery · Atlas · 4 msgs/);
	});

	it("by /move (no session event): the next message, or the end, finds the new folder; nothing from there reaches the lane", async () => {
		const { root, config } = world();
		const omp = await ompOrrery(join(root, "agent-Atlas"), config);
		await turn(omp, "One.", "First.");
		omp.cwd = join(root, "plain");
		omp.say("user", "A note while idle.");
		await omp.emit("message_end", { message: {} });
		await turn(omp, "Moved question.", "Moved answer.");
		expect(omp.notices).toEqual([{ message: "Orrery: this session moved from Atlas to another folder; Atlas's memory is closed.", type: "info" }]);
		expect(memoryOf(root)).toEqual(["user: One.", "talk: First."]);
		expect(statusOf(root, "Atlas").open).toBe(false);
		// Moved, then ended before another message: the lane closes without the session's new entries.
		const { root: other, config: otherConfig } = world();
		const quiet = await ompOrrery(join(other, "agent-Atlas"), otherConfig);
		await turn(quiet, "One.", "First.");
		quiet.cwd = join(other, "plain");
		quiet.say("user", "A note while idle.");
		await quiet.emit("session_shutdown");
		expect(memoryOf(other)).toEqual(["user: One.", "talk: First."]);
		expect(statusOf(other, "Atlas").open).toBe(false);
		// Moved, then rewound: the branch event finds the new folder too.
		const { root: third, config: thirdConfig } = world();
		const rewound = await ompOrrery(join(third, "agent-Atlas"), thirdConfig);
		await turn(rewound, "One.", "First.");
		rewound.cwd = join(third, "plain");
		rewound.say("user", "A note while idle.");
		rewound.session = { id: "s2", entries: [...rewound.session.entries] };
		await rewound.emit("session_branch", { reason: "branch" });
		expect(rewound.notices).toEqual([{ message: "Orrery: this session moved from Atlas to another folder; Atlas's memory is closed.", type: "info" }]);
		expect(memoryOf(third)).toEqual(["user: One.", "talk: First."]);
	});

	it("from a folder outside lanes into a lane's: opens it, recording from the move on, without a move notice", async () => {
		const { root, config } = world();
		const omp = await ompOrrery(join(root, "plain"), config);
		expect(omp.tools.size).toBe(0);
		await resume(omp, join(root, "agent-Atlas"), "atlas-1", "Question.", "Answer.");
		expect(omp.notices).toEqual([]);
		expect(omp.tools.size).toBe(3);
		expect(statusOf(root, "Atlas").open).toBe(true);
		await turn(omp, "Two.", "Second.");
		expect(memoryOf(root)).toEqual(["user: Two.", "talk: Second."]);
	});

	it("a lane opened by ORRERY_AGENT stays the session's when /move takes it into another lane's folder", async () => {
		const { root, config } = world();
		const omp = await ompOrrery(join(root, "plain"), config, { env: { ORRERY_AGENT: "Atlas" } });
		await turn(omp, "One.", "First.");
		omp.cwd = join(root, "agent-Birch");
		await promptedTurn(omp, "Two.", "Second.");
		expect(memoryOf(root)).toEqual(["user: One.", "talk: First.", "user: Two.", "talk: Second."]);
		expect(existsSync(join(root, "data", "lanes", "Birch", "memory.sqlite"))).toBe(false);
		expect(omp.notices.filter((n) => n.message.includes("moved"))).toEqual([]);
	});

	it("a lane opened by ORRERY_AGENT: /resume of a session from another lane's folder copies none of its turns", async () => {
		const { root, config } = world();
		const omp = await ompOrrery(join(root, "plain"), config, { env: { ORRERY_AGENT: "Atlas" } });
		await turn(omp, "One.", "First.");
		await resume(omp, join(root, "agent-Birch"), "birch-1", "Birch question.", "Birch answer.");
		expect(omp.notices).toEqual([]);
		expect(omp.status("orrery")).toMatch(/^Orrery · Atlas · 2 msgs/);
		await turn(omp, "Two.", "Second.");
		expect(memoryOf(root)).toEqual(["user: One.", "talk: First.", "user: Two.", "talk: Second."]);
		expect(existsSync(join(root, "data", "lanes", "Birch"))).toBe(false);
	});

	it("a lane opened by ORRERY_AGENT: its guard lets it write where the session moved, and no longer where it was", async () => {
		const { root, config } = world();
		const outside = mkdtempSync(join(tmpdir(), "orrery-outside-"));
		try {
			const write = async (omp: FakeOmp, path: string) => (await omp.emit("tool_call", { toolName: "write", toolCallId: "t1", input: { path, content: "x" } }))[0];
			const blocked = { block: true, reason: expect.stringMatching(/outside this lane's workspace/) };
			const omp = await ompOrrery(outside, config, { env: { ORRERY_AGENT: "Atlas" } });
			const elsewhere = mkdtempSync(join(tmpdir(), "orrery-elsewhere-"));
			try {
				expect(await write(omp, join(outside, "a.md"))).toBeUndefined();
				expect(await write(omp, join(elsewhere, "a.md"))).toEqual(blocked);
				omp.cwd = elsewhere;
				await promptedTurn(omp, "Moved.", "Here.");
				expect(await write(omp, join(elsewhere, "a.md"))).toBeUndefined();
				expect(await write(omp, join(outside, "a.md"))).toEqual(blocked);
			} finally {
				rmSync(elsewhere, { recursive: true, force: true });
			}
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("/resume of a session another agent recorded in this lane's folder records only what comes after", async () => {
		const { root, config } = world();
		const atlas = await ompOrrery(join(root, "agent-Birch"), config, { env: { ORRERY_AGENT: "Atlas" }, session: "x1" });
		await turn(atlas, "Atlas secret question.", "Atlas secret answer.");
		await atlas.emit("session_shutdown");
		const birch = await ompOrrery(join(root, "agent-Birch"), config, { session: "b1" });
		await turn(birch, "One.", "First.");
		birch.session = { id: "x1", entries: [...atlas.session.entries] };
		await birch.emit("session_switch", { reason: "resume", previousSessionFile: "/sessions/s1.jsonl" });
		await turn(birch, "Two.", "Second.");
		expect(memoryOf(root, "Birch")).toEqual(["user: One.", "talk: First.", "user: Two.", "talk: Second."]);
		expect(memoryOf(root)).toEqual(["user: Atlas secret question.", "talk: Atlas secret answer."]);
	});

	it("a lane opened by ORRERY_AGENT: any switch into a session with turns in it, whatever its reason, records from its tail", async () => {
		const { root, config } = world();
		const omp = await ompOrrery(join(root, "plain"), config, { env: { ORRERY_AGENT: "Atlas" } });
		await turn(omp, "One.", "First.");
		for (const [id, reason] of [["r1", undefined], ["r2", "reload"]] as const) {
			omp.session = { id, entries: [] };
			omp.say("user", `Foreign ${id}.`);
			omp.say("assistant", "Foreign answer.");
			await omp.emit("session_switch", reason === undefined ? {} : { reason });
		}
		await turn(omp, "Two.", "Second.");
		expect(memoryOf(root)).toEqual(["user: One.", "talk: First.", "user: Two.", "talk: Second."]);
	});

	it("an ORRERY_AGENT that names no agent: no memory, but the guard runs, with the folder's lane's rules or the default ones", async () => {
		const { root, config } = world();
		const call = async (omp: FakeOmp, toolName: string, input: Record<string, unknown>) => (await omp.emit("tool_call", { toolName, toolCallId: "t1", input }))[0];
		const outside = { block: true, reason: expect.stringMatching(/outside this lane's workspace/) };
		const secret = { block: true, reason: expect.stringMatching(/sensitive file/) };
		const inLane = await ompOrrery(join(root, "agent-Atlas"), config, { env: { ORRERY_AGENT: "Nobody" } });
		expect(inLane.tools.size).toBe(0);
		expect(inLane.notices).toEqual([{ type: "warning", message: "Orrery: ORRERY_AGENT names Nobody, which is not a configured agent; this session runs without memory." }]);
		expect(await call(inLane, "read", { path: config.credentialsPath })).toEqual(secret);
		// Atlas's rules: its workspace and its allowed root (the world's folder).
		expect(await call(inLane, "write", { path: join(root, "plain", "x.md"), content: "x" })).toBeUndefined();
		expect(await call(inLane, "write", { path: `${root}-escape.txt`, content: "x" })).toEqual(outside);
		const inPlain = await ompOrrery(join(root, "plain"), config, { env: { ORRERY_AGENT: "Nobody" } });
		expect(await call(inPlain, "read", { path: config.credentialsPath })).toEqual(secret);
		// No lane here: the session's folder only, as for an agent with no default folder.
		expect(await call(inPlain, "write", { path: join(root, "plain", "x.md"), content: "x" })).toBeUndefined();
		expect(await call(inPlain, "write", { path: join(root, "agent-Atlas", "x.md"), content: "x" })).toEqual(outside);
		expect(existsSync(join(root, "data", "lanes"))).toBe(false);
	});

	it("a visitor on the other tool's entry, running when the owner opens: the turns it says after that stay out of the owner", async () => {
		const { root, config } = world();
		const owner = await ompOrrery(join(root, "agent-Birch"), config, { session: "s-b" });
		await turn(owner, "One.", "First.");
		const history = [...owner.session.entries];
		owner.session = { id: "n1", entries: [] };
		await owner.emit("session_switch", { reason: "new" });
		// OMP's entry loaded in pi under ORRERY_AGENT=Atlas: the guard and the notes, no memory.
		const visitor = track(fakeOmp(join(root, "agent-Birch"), [createOrrery({ config, host: "omp", ...scratchHome(dirname(config.dataDir)), env: { ORRERY_AGENT: "Atlas" } })], { omp: false }));
		visitor.session = { id: "s-b", entries: [...history] };
		await visitor.emit("session_start");
		ageVisitMarks(config.dataDir);
		owner.session = { id: "s-b", entries: [...history] };
		await owner.emit("session_switch", { reason: "resume" });
		visitor.say("user", "Atlas secret question.");
		visitor.say("assistant", "Atlas secret answer.");
		await visitor.emit("message_end", { message: {} });
		await visitor.emit("agent_end", { messages: [] });
		await visitor.emit("session_shutdown");
		owner.session = { id: "s-b", entries: [...visitor.session.entries] };
		await owner.emit("session_switch", { reason: "resume" });
		await turn(owner, "Two.", "Second.");
		expect(memoryOf(root, "Birch")).toEqual(["user: One.", "talk: First.", "user: Two.", "talk: Second."]);
	});

	it("a visitor that says a turn after the owner loaded and is then killed (no run end, no shutdown): its turn stays out of the owner", async () => {
		const { root, config } = world();
		const owner = await ompOrrery(join(root, "agent-Birch"), config, { session: "s-b" });
		await turn(owner, "One.", "First.");
		const history = [...owner.session.entries];
		owner.session = { id: "n1", entries: [] };
		await owner.emit("session_switch", { reason: "new" });
		const visitor = await ompOrrery(join(root, "agent-Birch"), config, { env: { ORRERY_AGENT: "Atlas" }, session: "s-b" });
		ageVisitMarks(config.dataDir);
		owner.session = { id: "s-b", entries: [...history] };
		await owner.emit("session_switch", { reason: "resume" });
		visitor.say("user", "Atlas secret question.");
		await visitor.emit("message_end", { message: {} });
		owner.session = { id: "s-b", entries: [...history, ...visitor.session.entries] };
		await owner.emit("session_switch", { reason: "resume" });
		await turn(owner, "Two.", "Second.");
		expect(memoryOf(root, "Birch")).toEqual(["user: One.", "talk: First.", "user: Two.", "talk: Second."]);
	});

	it("pi is unchanged: its sessions never move (pi starts a new session instead), so its entry never looks", async () => {
		const { root, config } = world();
		const pi = track(fakeOmp(join(root, "agent-Atlas"), [createOrrery({ config, summarySources: async (cfg) => summarySourcesFor(cfg), ...scratchHome(root) })], { omp: false }));
		await pi.emit("session_start");
		await turn(pi, "One.", "First.");
		pi.cwd = join(root, "plain");
		await turn(pi, "Two.", "Second.");
		expect(pi.notices).toEqual([]);
		expect(memoryOf(root)).toEqual(["user: One.", "talk: First.", "user: Two.", "talk: Second."]);
	});
});

describe("an entry loaded in the other tool", () => {
	const cases = [
		{
			name: "pi's entry in OMP",
			start: (cwd: string, config: HarnessConfig, agent?: "main" | "sub") => track(fakeOmp(cwd, [createOrrery({ config, ...scratchHome(dirname(config.dataDir)) })], { agent })),
			notice: "Orrery's pi extension is loaded in OMP: no memory in this session (the guard still runs). Install Orrery for OMP from orrery's Tools page.",
		},
		{
			name: "OMP's entry in pi",
			start: (cwd: string, config: HarnessConfig) => track(fakeOmp(cwd, [createOrrery({ config, host: "omp", ...scratchHome(dirname(config.dataDir)) })], { omp: false })),
			notice: "Orrery's OMP extension is loaded in pi: no memory in this session (the guard still runs). Install Orrery for pi from orrery's Tools page.",
		},
	];

	for (const { name, start, notice } of cases) {
		it(`${name}: in a lane folder, guards credentials, says so once, and opens no memory, tools or commands`, async () => {
			const { root, config } = world();
			const host = start(join(root, "agent-Atlas"), config);
			await host.emit("session_start");
			expect(host.notices).toEqual([{ message: notice, type: "warning" }]);
			expect(await host.emit("tool_call", { toolName: "read", toolCallId: "t1", input: { path: config.credentialsPath } })).toEqual([
				{ block: true, reason: expect.stringMatching(/sensitive file/) },
			]);
			expect(host.events().sort()).toEqual(["agent_end", "message_end", "session_shutdown", "session_start", "tool_call"]);
			expect(host.tools.size).toBe(0);
			expect(host.commands.size).toBe(0);
			expect(existsSync(join(root, "data", "lanes", "Atlas", "memory.sqlite"))).toBe(false);
			// The lane stays free for the right entry.
			const omp = await ompOrrery(join(root, "agent-Atlas"), config);
			expect(omp.tools.size).toBe(3);
		});

		it(`${name}: outside lane folders, does nothing and says nothing`, async () => {
			const { root, config } = world();
			const host = start(join(root, "plain"), config);
			await host.emit("session_start");
			expect(host.notices).toEqual([]);
			expect(host.events()).toEqual(["session_start", "message_end", "agent_end", "session_shutdown"]);
			expect(await host.emit("tool_call", { toolName: "read", toolCallId: "t1", input: { path: config.credentialsPath } })).toEqual([]);
			expect(host.tools.size + host.commands.size).toBe(0);
		});
	}

	it("records who the session belongs to, as the right entry does: the folder's lane, or - under a refused ORRERY_AGENT", async () => {
		const { root, config } = world();
		const owner = (id: string) => readFileSync(join(root, "data", "session-owners", createHash("sha256").update(id).digest("hex")), "utf8");
		const home = scratchHome(dirname(config.dataDir));
		const inLane = track(fakeOmp(join(root, "agent-Atlas"), [createOrrery({ config, ...home })]));
		inLane.session.id = "m1";
		await inLane.emit("session_start");
		expect(owner("m1")).toBe("Atlas\n");
		const refused = track(fakeOmp(join(root, "agent-Atlas"), [createOrrery({ config, host: "omp", ...home, env: { ORRERY_AGENT: "Nobody" } })], { omp: false }));
		refused.session.id = "m2";
		await refused.emit("session_start");
		expect(owner("m2")).toBe("-\n");
		expect(existsSync(join(root, "data", "lanes", "Atlas", "memory.sqlite"))).toBe(false);
	});

	it("pi's entry in an OMP subagent: the guard, no second notice", async () => {
		const { root, config } = world();
		const sub = track(fakeOmp(join(root, "agent-Atlas"), [createOrrery({ config, ...scratchHome(root) })], { agent: "sub" }));
		await sub.emit("session_start");
		expect(sub.notices).toEqual([]);
		expect(await sub.emit("tool_call", { toolName: "read", toolCallId: "t1", input: { path: config.credentialsPath } })).toEqual([
			{ block: true, reason: expect.stringMatching(/sensitive file/) },
		]);
	});

	it("judges tool calls the way the tool it runs in shapes them, not the entry's", async () => {
		const { root, config } = world();
		const cwd = join(root, "agent-Atlas");
		const edit = { toolName: "edit", toolCallId: "t1", input: { paths: ["a.ts", `${root}-escape.ts`] } };
		const grep = { toolName: "grep", toolCallId: "t2", input: { pattern: "key", path: "a;/" } };
		// pi's entry in OMP: OMP's multi-file edit and its ;-separated path list, each path judged.
		const inOmp = track(fakeOmp(cwd, [createOrrery({ config, ...scratchHome(root) })]));
		await inOmp.emit("session_start");
		expect(await inOmp.emit("tool_call", edit)).toEqual([{ block: true, reason: expect.stringMatching(/outside this lane's workspace/) }]);
		expect(await inOmp.emit("tool_call", grep)).toEqual([{ block: true, reason: expect.stringMatching(/narrower folder/) }]);
		// OMP's entry in pi: pi's grep reads "a;/" as one folder name inside the lane, so pi's judgment lets it through.
		const inPi = track(fakeOmp(cwd, [createOrrery({ config, host: "omp", ...scratchHome(root) })], { omp: false }));
		await inPi.emit("session_start");
		expect(await inPi.emit("tool_call", grep)).toEqual([undefined]);
	});
});

describe("summaryWaitMs", () => {
	it("is 60 s in pi, and what is left of 25 s since the handler began in OMP (OMP drops a result after 30 s)", () => {
		expect(summaryWaitMs("pi", 0)).toBe(60_000);
		expect(summaryWaitMs("pi", 40_000)).toBe(60_000);
		expect(summaryWaitMs("omp", 0)).toBe(25_000);
		expect(summaryWaitMs("omp", 5_000)).toBe(20_000);
		expect(summaryWaitMs("omp", 30_000)).toBe(0);
		expect(summaryWaitMs("omp", 5_000, 1_000)).toBe(1_000);
		expect(summaryWaitMs("pi", 5_000, 1_000)).toBe(1_000);
	});
});

describe("Orrery's home through the extension's guard, with a lane's real config", () => {
	it.each(["pi", "omp"] as const)("%s's entry refuses the remote keys, the lanes' memory and a search of the home", async (entry) => {
		const { root, config } = world();
		const host = track(
			fakeOmp(join(root, "agent-Atlas"), [createOrrery({ summarySources: async (cfg) => summarySourcesFor(cfg), ...scratchHome(dirname(config.dataDir)), config, host: entry })], { omp: entry === "omp" }),
		);
		await host.emit("session_start");
		const call = (toolName: string, input: Record<string, unknown>) => host.emit("tool_call", { toolName, toolCallId: "t1", input });
		const blocked = [{ block: true, reason: expect.stringMatching(/sensitive/) }];
		expect(await call("read", { path: join(config.dataDir, "remotes.json") })).toEqual(blocked);
		expect(await call("read", { path: join(config.dataDir, "lanes", "Atlas", "memory.sqlite") })).toEqual(blocked);
		expect(await call("grep", { pattern: "x", path: config.dataDir })).toEqual([{ block: true, reason: expect.stringMatching(/credential/) }]);
		expect(await call("read", { path: join(config.dataDir, "config.toml") })).toEqual([undefined]);
	});
});
