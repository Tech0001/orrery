import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import { claimedBy, claimHeld, claimText, claimToken, newToken, pickAgent, refusedNotice, releaseClaim, workArea } from "../../src/agent/pick.ts";
import { pidNamespace } from "../../src/agent/process.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Atlas and Birch with folders, Nomad with none, and a plain folder. */
function world() {
	const root = mkdtempSync(join(tmpdir(), "orrery-pick-"));
	dirs.push(root);
	for (const folder of ["agent-Atlas/sub", "agent-Birch", "plain"]) mkdirSync(join(root, folder), { recursive: true });
	const agent = (name: string, folder?: string) =>
		`[agents.${name}]\n${folder === undefined ? "" : `folder = ${JSON.stringify(folder)}\n`}compactor_model = "openai/gpt-6.1-sol"\n`;
	const toml = `data_dir = ${JSON.stringify(join(root, "data"))}\n${agent("Atlas", join(root, "agent-Atlas"))}${agent("Birch", join(root, "agent-Birch"))}${agent("Nomad")}`;
	return { root, config: parseConfig(toml, root) };
}

const me = process.pid;

describe("pickAgent", () => {
	it("takes ORRERY_AGENT first, in any folder, ignoring case", () => {
		const { root, config } = world();
		expect(pickAgent(config, { env: { ORRERY_AGENT: "birch" }, cwd: join(root, "agent-Atlas"), owner: me })).toMatchObject({ kind: "agent", by: "env", agent: { name: "Birch" } });
		expect(pickAgent(config, { env: { ORRERY_AGENT: "Nomad" }, cwd: join(root, "plain"), owner: me })).toMatchObject({ kind: "agent", by: "env", agent: { name: "Nomad" } });
	});

	it("without ORRERY_AGENT: the agent whose folder holds the folder, else none; an agent with no folder is never found by folder", () => {
		const { root, config } = world();
		expect(pickAgent(config, { env: {}, cwd: join(root, "agent-Atlas", "sub"), owner: me })).toMatchObject({ kind: "agent", by: "folder", agent: { name: "Atlas" } });
		expect(pickAgent(config, { env: { ORRERY_AGENT: "  " }, cwd: join(root, "plain"), owner: me })).toEqual({ kind: "none" });
	});

	it("an ORRERY_AGENT that names no agent is unknown, with no fallback to the folder", () => {
		const { root, config } = world();
		expect(pickAgent(config, { env: { ORRERY_AGENT: "Nobody" }, cwd: join(root, "agent-Atlas"), owner: me })).toEqual({ kind: "unknown", name: "Nobody" });
		expect(refusedNotice({ kind: "unknown", name: "No\u001b[2Jbody" })).toBe("Orrery: ORRERY_AGENT names No[2Jbody, which is not a configured agent; this session runs without memory.");
	});

	it("an ORRERY_AGENT_TOKEN that is not 32 lowercase hex digits (empty included) is refused, with no fallback to the folder", () => {
		const { root, config } = world();
		for (const token of ["", "abc", newToken().toUpperCase(), `${newToken()}0`, "../../../escape-0123456789abcdef"]) {
			expect(pickAgent(config, { env: { ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: token }, cwd: join(root, "agent-Atlas"), owner: me })).toEqual({ kind: "bad-token", name: "Birch" });
		}
		expect(existsSync(join(config.dataDir, "agents", "Birch", "claims"))).toBe(false);
		expect(refusedNotice({ kind: "bad-token", name: "Birch" })).toBe("Orrery: ORRERY_AGENT_TOKEN is not 32 lowercase hex digits, so this session is not Birch; it runs without memory.");
		// No token at all: the session is the agent (ORRERY_AGENT set by hand).
		expect(pickAgent(config, { env: { ORRERY_AGENT: "Birch" }, cwd: join(root, "plain"), owner: me })).toMatchObject({ kind: "agent", by: "env" });
	});

	it("an empty claim younger than 60 s is one being made: never pruned, and a claimer with its token loses; an old one is dead", () => {
		const { config } = world();
		const birch = join(config.dataDir, "agents", "Birch");
		const [empty, mine] = [newToken(), newToken()];
		mkdirSync(join(birch, "claims"), { recursive: true });
		writeFileSync(join(birch, "claims", empty), "");
		expect(claimToken(birch, mine, me)).toBe(true);
		expect(existsSync(join(birch, "claims", empty))).toBe(true);
		expect(claimToken(birch, empty, 4245, () => true)).toBe(false);
		expect(readFileSync(join(birch, "claims", empty), "utf8")).toBe("");
		// Old enough, it is a crash's leftover (or an older version's): its owner is dead.
		const longAgo = new Date(Date.now() - 120_000);
		utimesSync(join(birch, "claims", empty), longAgo, longAgo);
		expect(claimToken(birch, newToken(), me)).toBe(true);
		expect(existsSync(join(birch, "claims", empty))).toBe(false);
		writeFileSync(join(birch, "claims", empty), "");
		utimesSync(join(birch, "claims", empty), longAgo, longAgo);
		expect(claimToken(birch, empty, 4245, () => true)).toBe(true);
		expect(readFileSync(join(birch, "claims", empty), "utf8")).toBe(claimText(4245));
	});

	it("a token belongs to the first process that starts with it; a live other process falls back to its folder; a dead owner hands it over", () => {
		const { root, config } = world();
		const token = newToken();
		const env = { ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: token };
		const birch = join(config.dataDir, "agents", "Birch");
		expect(pickAgent(config, { env, cwd: join(root, "plain"), owner: me })).toMatchObject({ kind: "agent", by: "env" });
		expect(pickAgent(config, { env, cwd: join(root, "plain"), owner: me })).toMatchObject({ kind: "agent", by: "env" });
		// A tool the agent started: the same variables in another process, while the owner lives.
		const alive = (pid: number) => pid === me;
		expect(pickAgent(config, { env, cwd: join(root, "plain"), owner: 4242, alive })).toEqual({ kind: "none" });
		expect(pickAgent(config, { env, cwd: join(root, "agent-Atlas"), owner: 4242, alive })).toMatchObject({ kind: "agent", by: "folder", agent: { name: "Atlas" } });
		expect(pickAgent(config, { env, cwd: join(root, "plain"), owner: 4242, alive: () => false })).toMatchObject({ kind: "agent", by: "env" });
		expect(readFileSync(join(birch, "claims", token), "utf8")).toBe(claimText(4242));
		releaseClaim(birch, token);
		expect(existsSync(join(birch, "claims", token))).toBe(false);
	});

	it("a claim holds its owner's pid, then on Linux this process's pid namespace; a one-line claim reads as before", () => {
		const { config } = world();
		const birch = join(config.dataDir, "agents", "Birch");
		const token = newToken();
		expect(claimToken(birch, token, me)).toBe(true);
		const ns = pidNamespace("self");
		expect(ns === undefined).toBe(process.platform !== "linux");
		expect(readFileSync(join(birch, "claims", token), "utf8")).toBe(ns === undefined ? `${me}\n` : `${me}\n${ns}\n`);
		expect(claimHeld(birch, token)).toEqual(ns === undefined ? { pid: me } : { pid: me, ns });
		expect(claimedBy(birch, token)).toBe(me);
		writeFileSync(join(birch, "claims", token), "4242\n");
		expect(claimHeld(birch, token)).toEqual({ pid: 4242 });
		expect(claimedBy(birch, token)).toBe(4242);
		expect(claimHeld(birch, "not-a-token")).toBeUndefined();
	});

	it("never prunes a live owner's claim, however old; prunes a dead owner's claim of another token", () => {
		const { config } = world();
		const birch = join(config.dataDir, "agents", "Birch");
		const [kept, gone, fresh] = [newToken(), newToken(), newToken()];
		const alive = (pid: number) => pid === me;
		expect(claimToken(birch, kept, me, alive)).toBe(true);
		mkdirSync(join(birch, "claims"), { recursive: true });
		writeFileSync(join(birch, "claims", gone), "4243\n");
		const monthAgo = new Date(Date.now() - 30 * 86_400_000);
		utimesSync(join(birch, "claims", kept), monthAgo, monthAgo);
		expect(claimToken(birch, fresh, 4244, alive)).toBe(true);
		expect(existsSync(join(birch, "claims", gone))).toBe(false);
		// The month-old claim of a live owner stands: another process with its token is not the agent.
		expect(claimToken(birch, kept, 4244, alive)).toBe(false);
		expect(readFileSync(join(birch, "claims", kept), "utf8")).toBe(claimText(me));
	});

	it("without takeover (a session's later events): only the claim's own owner, never a new or a dead owner's claim", () => {
		const { root, config } = world();
		const birch = join(config.dataDir, "agents", "Birch");
		const [mine, dead, unclaimed] = [newToken(), newToken(), newToken()];
		const alive = (pid: number) => pid === me;
		expect(claimToken(birch, mine, me, alive)).toBe(true);
		expect(claimToken(birch, mine, me, alive, false)).toBe(true);
		writeFileSync(join(birch, "claims", dead), "4243\n");
		expect(claimToken(birch, dead, 4244, alive, false)).toBe(false);
		expect(readFileSync(join(birch, "claims", dead), "utf8")).toBe("4243\n");
		expect(claimToken(birch, unclaimed, 4244, alive, false)).toBe(false);
		expect(existsSync(join(birch, "claims", unclaimed))).toBe(false);
		// pickAgent: the folder decides; with takeover (a session's start) the dead claim is taken over.
		const env = { ORRERY_AGENT: "Birch", ORRERY_AGENT_TOKEN: dead };
		expect(pickAgent(config, { env, cwd: join(root, "plain"), owner: 4244, alive, takeover: false })).toEqual({ kind: "none" });
		expect(pickAgent(config, { env, cwd: join(root, "plain"), owner: 4244, alive })).toMatchObject({ kind: "agent", by: "env", agent: { name: "Birch" } });
		expect(readFileSync(join(birch, "claims", dead), "utf8")).toBe(claimText(4244));
	});

	it("makes a claim whole (no temporary file left), and prunes only stray temporary files old enough to be dead", () => {
		const { config } = world();
		const birch = join(config.dataDir, "agents", "Birch");
		const [mine, other] = [newToken(), newToken()];
		const alive = (pid: number) => pid === me;
		expect(claimToken(birch, mine, me, alive)).toBe(true);
		expect(readdirSync(join(birch, "claims"))).toEqual([mine]);
		// Another process's claim being made, and one left by a crash long ago.
		const [making, stray] = [join(birch, "claims", `${other}.0a0b0c0d0e0f`), join(birch, "claims", `${other}.1a1b1c1d1e1f`)];
		writeFileSync(making, "");
		writeFileSync(stray, "4243\n");
		const longAgo = new Date(Date.now() - 120_000);
		utimesSync(stray, longAgo, longAgo);
		expect(claimToken(birch, newToken(), me, alive)).toBe(true);
		expect(existsSync(making)).toBe(true);
		expect(existsSync(stray)).toBe(false);
	});

	it("never makes a file from a token that is not hex", () => {
		const { config } = world();
		const birch = join(config.dataDir, "agents", "Birch");
		expect(claimToken(birch, "../../escape", me)).toBe(false);
		expect(existsSync(join(birch, "claims"))).toBe(false);
		expect(newToken()).toMatch(/^[0-9a-f]{32}$/);
	});
});

describe("workArea", () => {
	it("is the folder in it or below it, else the folder the session runs in", () => {
		const { root, config } = world();
		const atlas = config.agents.get("Atlas")!;
		expect(workArea(atlas, join(root, "agent-Atlas", "sub"))).toBe(join(root, "agent-Atlas"));
		expect(workArea(atlas, join(root, "plain"))).toBe(join(root, "plain"));
		expect(workArea(config.agents.get("Nomad")!, join(root, "plain"))).toBe(join(root, "plain"));
	});

	it("finds a folder through a symbolic link to it", () => {
		const { root, config } = world();
		symlinkSync(join(root, "agent-Atlas"), join(root, "link"));
		expect(pickAgent(config, { env: {}, cwd: join(root, "link", "sub"), owner: me })).toMatchObject({ kind: "agent", by: "folder", agent: { name: "Atlas" } });
		expect(workArea(config.agents.get("Atlas")!, join(root, "link"))).toBe(join(root, "agent-Atlas"));
	});
});
