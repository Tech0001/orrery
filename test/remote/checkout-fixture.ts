import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LaneConfig, parseConfig } from "../../src/lane/config.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { createKey, keyToCode } from "../../src/remote/crypto.ts";
import { FakeStorage } from "../../src/remote/fake.ts";
import { laneSettings } from "../../src/remote/save-format.ts";
import { saveRemoteSecret } from "../../src/remote/secrets.ts";
import { RemoteSession } from "../../src/remote/session.ts";
import { laneConfigToml } from "../lane/support.ts";

export async function checkoutFixture() {
	const root = mkdtempSync(join(tmpdir(), "orrery-checkout-"));
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	const config = parseConfig(`${laneConfigToml({ dataDir: join(root, "data"), workspace, extra: 'remote = "home"' })}
[remotes.home]
kind = "cloudflare"
url = "https://example.invalid"
`, root);
	const lane = config.lanes.get("Test") as LaneConfig & { readonly workspace: string };
	const key = createKey();
	saveRemoteSecret(config, "home", { key: keyToCode(key), token: "fake-token" });
	const clock = { value: Date.now() };
	const storage = new FakeStorage({ name: "home", now: () => clock.value });
	const source = join(root, "source");
	const store = MemoryStore.open(join(source, "memory.sqlite"));
	store.append("user", "from the remote");
	store.close();
	await RemoteSession.push({ lane: lane.name, laneDir: source, storage, key, holder: { machine: "macbook", device: "other", pid: 1 }, report: () => {}, settings: laneSettings(lane) });
	return { root, config, lane, key, storage, clock, close: () => rmSync(root, { recursive: true, force: true }) };
}
