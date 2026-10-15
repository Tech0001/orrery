import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/agent/config.ts";
import type { OrreryOptions } from "../../src/pi/index.ts";
import { waitUntil } from "../claude/support.ts";
import { cleanupFakes, scratch, servers } from "../release/fake-releases.ts";
import { cleanup, isolatedHome, pi, world } from "./world.ts";

afterEach(cleanup);
afterEach(cleanupFakes);
isolatedHome();

const AVAILABLE = "Orrery 0.6.1 is available. Run `orrery update`, then restart this session.";
const UPDATED = "Orrery was updated to 0.6.1; restart this session to use it.";

/** Points `home`'s app/current at `version` (made if needed), as an install does. */
function install(home: string, version: string): void {
	mkdirSync(join(home, "app", version), { recursive: true });
	writeFileSync(join(home, "app", version, "VERSION"), `${version}\n`);
	rmSync(join(home, "app", "current"), { force: true });
	symlinkSync(version, join(home, "app", "current"));
}

/** A releases server whose /latest answers 0.6.1 only once `release` is called; `hits` counts the requests. */
async function heldServer(): Promise<{ base: string; hits: string[]; release: () => void }> {
	const hits: string[] = [];
	const waiting: ServerResponse[] = [];
	let open = false;
	const answer = (res: ServerResponse) => void res.writeHead(302, { location: "/releases/tag/v0.6.1" }).end();
	const server = createServer((req, res) => {
		hits.push(req.url ?? "");
		if (open) answer(res);
		else waiting.push(res);
	});
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return {
		base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`,
		hits,
		release: () => {
			open = true;
			for (const res of waiting.splice(0)) answer(res);
		},
	};
}

/** The update options for a session running 0.6.0, with `home` as its Orrery home and no reachable releases server unless given. */
function updates(home: string, base = "http://127.0.0.1:9/releases"): NonNullable<OrreryOptions["updates"]> {
	return { env: { HOME: home, ORRERY_HOME: home, ORRERY_RELEASES_URL: base }, running: () => "0.6.0" };
}

const cached = (home: string, latest: string) => writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: Date.now() - 3600_000, latest }));

describe("update notices in pi", () => {
	it("says once, as a warning, that a newer release is out, from the cache and with no request", async () => {
		const { root, config } = world();
		const home = scratch();
		install(home, "0.6.0");
		cached(home, "0.6.1");
		const { base, hits } = await heldServer();
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { tickMs: 10, updates: updates(home, base) });
		expect(run.notices).toContainEqual({ message: AVAILABLE, type: "warning" });
		await delay(100);
		expect(run.notices.filter((n) => n.message === AVAILABLE)).toHaveLength(1);
		expect(hits).toEqual([]);
	});

	it("starts without waiting for a stale check, and says what the answer brings when it comes", async () => {
		const { root, config } = world();
		const home = scratch();
		install(home, "0.6.0");
		const { base, hits, release } = await heldServer();
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { updates: updates(home, base) });
		// The session is open while the request is still unanswered.
		expect(run.status("orrery")).toBe("Orrery · Atlas · 0 msgs");
		await waitUntil(() => hits.length === 1);
		expect(run.notices.some((n) => n.message === AVAILABLE)).toBe(false);
		release();
		await waitUntil(() => run.notices.some((n) => n.message === AVAILABLE));
		expect(JSON.parse(readFileSync(join(home, "update-check.json"), "utf8"))).toMatchObject({ latest: "0.6.1" });
		expect(hits).toHaveLength(1);
	});

	it("says once that Orrery was updated under the session when app/current moves on", async () => {
		const { root, config } = world();
		const home = scratch();
		install(home, "0.6.0");
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { tickMs: 10, updates: updates(home) });
		await delay(50);
		expect(run.notices.filter((n) => n.message.startsWith("Orrery was updated"))).toEqual([]);
		install(home, "0.6.1");
		await waitUntil(() => run.notices.some((n) => n.message === UPDATED));
		await delay(100);
		expect(run.notices.filter((n) => n.message === UPDATED)).toEqual([{ message: UPDATED, type: "warning" }]);
	});

	it("with [updates] check = false, makes no request and says nothing of a release", async () => {
		const { root, configPath } = world();
		const config = parseConfig(`${readFileSync(configPath, "utf8")}[updates]\ncheck = false\n`, root);
		const home = scratch();
		install(home, "0.6.0");
		// a day-old answer that names a newer release: neither asked again nor shown
		writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: 0, latest: "0.6.1" }));
		const { base, hits } = await heldServer();
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { tickMs: 10, updates: updates(home, base) });
		await delay(100);
		expect(hits).toEqual([]);
		expect(run.notices.some((n) => n.message.includes("is available"))).toBe(false);
	});

	it("says nothing and asks nothing outside an agent", async () => {
		const { root, config } = world();
		const home = scratch();
		install(home, "0.6.1");
		const { base, hits } = await heldServer();
		const run = await pi(root, join(root, "plain"), config, undefined, { tickMs: 10, updates: updates(home, base) });
		await delay(100);
		expect(run.notices).toEqual([]);
		expect(hits).toEqual([]);
	});

	it("says nothing without the updates option (only the entries pass it)", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config, undefined, { tickMs: 10 });
		await delay(50);
		expect(run.notices.some((n) => n.message.startsWith("Orrery ") && n.message.includes("restart this session"))).toBe(false);
	});
});
