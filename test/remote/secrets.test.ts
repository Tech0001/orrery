import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parseConfig } from "../../src/lane/config.ts";
import { readRemoteSecret, remoteSecretsPath, removeRemoteSecret, saveRemoteSecret } from "../../src/remote/secrets.ts";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "orrery-secrets-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("saves, reads and removes a remote's secret in a 0600 file", () => {
	const config = parseConfig(`data_dir = "${dir}"\n`, dir);
	expect(readRemoteSecret(config, "home")).toBeUndefined();
	saveRemoteSecret(config, "home", { key: "k".repeat(43) });
	saveRemoteSecret(config, "cloud", { key: "c".repeat(43), token: "t0k3n" });
	expect(readRemoteSecret(config, "cloud")).toEqual({ key: "c".repeat(43), token: "t0k3n" });
	expect(statSync(remoteSecretsPath(config)).mode & 0o777).toBe(0o600);
	removeRemoteSecret(config, "home");
	expect(readRemoteSecret(config, "home")).toBeUndefined();
	expect(readRemoteSecret(config, "cloud")?.token).toBe("t0k3n");
});

it("refuses a corrupt file without quoting it", () => {
	const config = parseConfig(`data_dir = "${dir}"\n`, dir);
	saveRemoteSecret(config, "home", { key: "k".repeat(43) });
	writeFileSync(remoteSecretsPath(config), "{not json sk-secret");
	expect(() => readRemoteSecret(config, "home")).toThrow(/remotes\.json is not valid JSON/);
	expect(() => readRemoteSecret(config, "home")).not.toThrow(/sk-secret/);
});
