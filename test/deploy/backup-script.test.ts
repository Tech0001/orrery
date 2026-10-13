import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const script = new URL("../../deploy/workstation/backup.sh", import.meta.url).pathname;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(config?: string) {
	const home = mkdtempSync(join(tmpdir(), "orrery-backup-script-"));
	roots.push(home);
	const bin = join(home, ".local/bin");
	const conf = join(home, "config/orrery");
	mkdirSync(bin, { recursive: true });
	mkdirSync(conf, { recursive: true });
	if (config !== undefined) writeFileSync(join(conf, "backup.env"), config);
	for (const [name, body] of Object.entries({
		orrery: 'echo "orrery $*" >> "$HOME/calls"\n[ "${FAIL_BACKUP:-0}" = 0 ] || exit 7\nif [ "${EMPTY_BACKUP:-0}" = 0 ]; then mkdir -p "$HOME/.local/share/orrery/backups/day"; fi',
		rsync: 'printf "rsync\\n" >> "$HOME/calls"\nprintf "%s\\n" "$@" >> "$HOME/calls"',
	})) {
		const path = join(bin, name);
		writeFileSync(path, `#!/bin/sh\n${body}\n`);
		chmodSync(path, 0o755);
	}
	return {
		home,
		run: (extra = {}) => spawnSync("bash", [script], { env: { PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: join(home, "config"), ...extra }, encoding: "utf8" }),
		calls: () => existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8") : "",
	};
}
const config = 'BACKUP_HOST=backup.example.internal\nBACKUP_USER=alex\nBACKUP_IDENTITY_FILE="$HOME/keys/backup key"\n';

it("keeps the local snapshot when the copy configuration is missing", () => {
	const t = fixture();
	const result = t.run();
	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain("backup.env is missing");
	expect(t.calls()).toBe("orrery backup\n");
	expect(existsSync(join(t.home, ".local/share/orrery/backups/day"))).toBe(true);
});

it("refuses incomplete destination settings without echoing their values", () => {
	const t = fixture("BACKUP_HOST=private-example-value\n");
	const result = t.run();
	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain("BACKUP_USER");
	expect(result.stderr).not.toContain("private-example-value");
	expect(t.calls()).toBe("orrery backup\n");
	expect(existsSync(join(t.home, ".local/share/orrery/backups/day"))).toBe(true);
});

it("snapshots first and syncs with the configured identity, user and host", () => {
	const t = fixture(config);
	expect(t.run().status).toBe(0);
	const calls = t.calls();
	expect(calls).toMatch(/^orrery backup\nrsync\n-a\n--delete\n-e\n/);
	expect(calls).toContain(`ssh -i "${t.home}/keys/backup key" -o IdentitiesOnly=yes -o BatchMode=yes`);
	expect(calls).toContain(`${t.home}/.local/share/orrery/backups/\nalex@backup.example.internal:orrery-workstation-backups/`);
});

it("does not sync missing or empty local backups", () => {
	const t = fixture(config);
	for (const createEmpty of [false, true]) {
		if (createEmpty) mkdirSync(join(t.home, ".local/share/orrery/backups"), { recursive: true });
		const result = t.run({ EMPTY_BACKUP: "1" });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("missing or empty");
		expect(t.calls()).not.toContain("rsync");
	}
});

it.each([config, undefined])("does not sync or read destination settings when the snapshot fails (%j)", (settings) => {
	const t = fixture(settings);
	expect(t.run({ FAIL_BACKUP: "1" }).status).toBe(7);
	expect(t.calls()).not.toContain("rsync");
});
