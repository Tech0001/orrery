import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/lane/config.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { createKey, keyToCode, seal } from "../../src/remote/crypto.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { encodeRows, encodeSnapshot, laneSettings, snapshotBytes } from "../../src/remote/save-format.ts";
import { saveRemoteSecret } from "../../src/remote/secrets.ts";

export async function readCopyFixture() {
	const root = mkdtempSync(join(tmpdir(), "orrery-read-copy-"));
	const config = parseConfig(`data_dir = ${JSON.stringify(join(root, "data"))}
[remotes.home]
kind = "cloudflare"
url = "https://example.invalid"
[lanes.Atlas]
workspace = ${JSON.stringify(join(root, "atlas"))}
compactor_model = "openai/gpt-5.1-mini"
remote = "home"
[lanes.Birch]
workspace = ${JSON.stringify(join(root, "birch"))}
compactor_model = "openai/gpt-5.1-mini"
reads = ["Atlas"]
[lanes.Cedar]
workspace = ${JSON.stringify(join(root, "cedar"))}
compactor_model = "openai/gpt-5.1-mini"
`, root);
	const lane = config.lanes.get("Atlas")!;
	const key = createKey();
	saveRemoteSecret(config, "home", { key: keyToCode(key), token: "fake-token" });
	const clock = { value: new Date(2026, 9, 12, 14, 2).getTime() };
	const storage = new FakeStorage({ name: "home", now: () => clock.value });
	const take = await storage.take("Atlas", { machine: "macbook", device: "other", pid: 1 });
	if (!take.ok) throw new Error("held");
	const source = MemoryStore.open(join(root, "source", "memory.sqlite"));
	source.append("user", "from the snapshot");
	let marks = source.marks();
	let n = 0;
	const snapshot = async () => storage.snapshot("Atlas", take.lock, n, seal(key, "Atlas", "snapshot", n, encodeSnapshot({ v: 1, n, lock: take.lock, machine: "macbook", at: new Date(clock.value).toISOString(), settings: laneSettings(lane) }, snapshotBytes(source.path))));
	await snapshot();
	return {
		root, config, lane, key, storage, clock, source, snapshot,
		now: () => clock.value,
		async save(text = "from a later save") {
			source.append("talk", text);
			const changed = source.rowsAfter(marks, [])!;
			n += 1;
			await storage.save("Atlas", take.lock, n, seal(key, "Atlas", "save", n, encodeRows(changed.rows)), new Uint8Array());
			marks = changed.next;
		},
		close() { source.close(); rmSync(root, { recursive: true, force: true }); },
	};
}
