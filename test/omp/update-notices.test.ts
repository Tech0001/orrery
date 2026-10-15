import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupFakes, scratch } from "../release/fake-releases.ts";
import { cleanup, world } from "../pi/world.ts";
import { ompCleanup, ompOrrery } from "./world.ts";

afterEach(async () => {
	await ompCleanup();
	await cleanup();
	cleanupFakes();
});

/** An Orrery home with `installed` as app/current and 0.6.2 as the cached latest release. */
function home(installed: string): NodeJS.ProcessEnv {
	const dir = scratch();
	mkdirSync(join(dir, "app", installed), { recursive: true });
	writeFileSync(join(dir, "app", installed, "VERSION"), `${installed}\n`);
	symlinkSync(installed, join(dir, "app", "current"));
	writeFileSync(join(dir, "update-check.json"), JSON.stringify({ checkedAt: Date.now(), latest: "0.6.2" }));
	return { HOME: dir, ORRERY_HOME: dir, ORRERY_RELEASES_URL: "http://127.0.0.1:9/releases" };
}

describe("update notices in OMP", () => {
	it("warns the main session once of an update under it and of a newer release, and says nothing in a subagent", async () => {
		const { root, config } = world();
		const updates = { env: home("0.6.1"), running: () => "0.6.0" };
		const main = await ompOrrery(join(root, "agent-Atlas"), config, { updates });
		expect(main.notices.filter((n) => n.message.includes("restart this session"))).toEqual([
			{ message: "Orrery was updated to 0.6.1; restart this session to use it.", type: "warning" },
			{ message: "Orrery 0.6.2 is available. Run `orrery update`, then restart this session.", type: "warning" },
		]);
		const sub = await ompOrrery(join(root, "agent-Atlas"), config, { updates, agent: "sub", session: "s2" });
		expect(sub.notices).toEqual([]);
	});
});
