import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { judgedFolders } from "../../src/agent/sessions.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch tree: a data folder holding records, with a folder inside it, and a shared folder beside it. */
function tree() {
	const root = tempDir("orrery-judged-");
	dirs.push(root);
	const data = join(root, "data");
	mkdirSync(join(data, "session-hosts"), { recursive: true });
	const inner = join(data, "agents", "Birch");
	mkdirSync(inner, { recursive: true });
	const shared = join(root, "shared");
	mkdirSync(shared);
	return { root, data, inner, shared };
}

describe("judgedFolders (src/agent/sessions.ts)", () => {
	it("judges each folder given and every folder above it that holds records, a planted one nearer included", () => {
		const { data, inner } = tree();
		// Each folder given as given; those found above it by their real paths (links followed): on macOS the temporary
		// folder is a link (/var to /private/var).
		expect(judgedFolders([join(inner, "memory.sqlite")])).toEqual([join(inner, "memory.sqlite"), realpathSync(data)]);
		mkdirSync(join(inner, "session-hosts"));
		expect(judgedFolders([join(inner, "memory.sqlite")])).toEqual([join(inner, "memory.sqlite"), realpathSync(inner), realpathSync(data)]);
		// Shared parents are looked at once; no folder twice, by either spelling.
		expect(judgedFolders([inner, join(inner, "a"), join(data, "b")])).toEqual([inner, realpathSync(data), join(inner, "a"), join(data, "b")]);
	});

	it("a session-hosts that is a link (to this user's real records, from a shared folder), or another user's, or a file, holds no records", () => {
		const { data, shared } = tree();
		const file = join(shared, "x.html");
		// Another user could link a shared folder's session-hosts to this user's real records folder.
		symlinkSync(join(data, "session-hosts"), join(shared, "session-hosts"));
		expect(judgedFolders([file])).toEqual([file]);
		rmSync(join(shared, "session-hosts"));
		writeFileSync(join(shared, "session-hosts"), "");
		expect(judgedFolders([file])).toEqual([file]);
		rmSync(join(shared, "session-hosts"));
		// A real folder, but owned by another user than the one asking.
		mkdirSync(join(shared, "session-hosts"));
		expect(judgedFolders([file])).toEqual([file, realpathSync(shared)]);
		const uid = process.getuid?.();
		if (uid !== undefined) expect(judgedFolders([file], uid + 1)).toEqual([file]);
	});
});
