import { mkdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { orreryHome, passwordHome, systemPasswordHome } from "../../src/agent/home.ts";
import { DEFAULT_CONFIG_PATH, defaultConfigPath } from "../../src/agent/config.ts";
import { newConfigText, userConfigPath } from "../../src/agent/config-edit.ts";
import { parseConfig } from "../../src/agent/config.ts";
import { tempDir } from "./support.ts";

describe("Orrery's home", () => {
	it("is ~/.orrery unless ORRERY_HOME moves it, with ~ expanded", () => {
		const home = tempDir("orrery-home-");
		expect(orreryHome({ HOME: home })).toBe(join(home, ".orrery"));
		expect(orreryHome({ HOME: home, ORRERY_HOME: "/srv/orrery" })).toBe("/srv/orrery");
		expect(orreryHome({ HOME: home, ORRERY_HOME: "~/elsewhere" })).toBe(join(home, "elsewhere"));
	});

	it("refuses a relative ORRERY_HOME instead of resolving it against the current folder", () => {
		expect(() => orreryHome({ HOME: "/h", ORRERY_HOME: "orrery-data" })).toThrow(/ORRERY_HOME must be an absolute path/);
	});
});

describe("finding the config", () => {
	it("prefers ORRERY_CONFIG, then the home's config, then the server path, and ignores the old folders", () => {
		const home = tempDir("orrery-home-");
		const env = { HOME: home };
		mkdirSync(join(home, ".config", "orrery"), { recursive: true });
		writeFileSync(join(home, ".config", "orrery", "config.toml"), "");
		expect(defaultConfigPath(env)).toBe(DEFAULT_CONFIG_PATH);
		mkdirSync(join(home, ".orrery"), { recursive: true });
		writeFileSync(join(home, ".orrery", "config.toml"), "");
		expect(defaultConfigPath(env)).toBe(join(home, ".orrery", "config.toml"));
		expect(defaultConfigPath({ ...env, ORRERY_CONFIG: "/x/c.toml" })).toBe("/x/c.toml");
	});

	it("puts a new config in the home, and a new config keeps its data beside it", () => {
		const home = tempDir("orrery-home-");
		expect(userConfigPath({ HOME: home })).toBe(join(home, ".orrery", "config.toml"));
		expect(newConfigText()).not.toMatch(/data_dir/);
		expect(parseConfig(newConfigText(), join(home, ".orrery")).dataDir).toBe(join(home, ".orrery"));
		expect(newConfigText("/srv/memory")).toMatch(/^data_dir = "\/srv\/memory"$/m);
	});
});

describe("the password database's home", () => {
	it("is this user's record in the system, never $HOME (the test run's HOME is a scratch folder)", () => {
		const home = passwordHome();
		expect(home !== undefined && isAbsolute(home)).toBe(true);
		expect(home).not.toBe(process.env.HOME);
		// Read without Node's userInfo, as under Bun, whose userInfo().homedir is $HOME: the same record.
		if (process.platform === "linux" || process.platform === "darwin") expect(systemPasswordHome()).toBe(home);
		if (process.versions.bun === undefined) expect(home).toBe(userInfo().homedir);
	});

	it("Linux: the uid's line in /etc/passwd, else getent's (NSS), each by its full path", () => {
		const passwd = "root:x:0:0:root:/root:/bin/bash\nu:x:1000:1000:U Person,,,:/home/u:/bin/bash\nshadow:x:1000:1000::/home/shadow:/bin/sh\n";
		const asked: string[][] = [];
		const run = (program: string, args: readonly string[]) => (asked.push([program, ...args]), args[1] === "1001" ? "n:*:1001:1001:N:/home/n:/usr/bin/zsh\n" : undefined);
		const there = (...files: string[]) => (file: string) => files.includes(file);
		const linux = (uid: number, exists = there("/usr/bin/getent", "/bin/getent")) => systemPasswordHome({ uid, platform: "linux", read: () => passwd, run, exists });
		// The first line for the uid, as getpwuid gives it.
		expect(linux(1000)).toBe("/home/u");
		expect(asked).toEqual([]);
		expect(linux(1001)).toBe("/home/n");
		expect(asked).toEqual([["/usr/bin/getent", "passwd", "1001"]]);
		// Neither knows it: none (the caller fails closed), with getent asked once: /bin/getent only when /usr/bin's isn't there.
		expect(linux(1002)).toBeUndefined();
		expect(asked).toEqual([["/usr/bin/getent", "passwd", "1001"], ["/usr/bin/getent", "passwd", "1002"]]);
		expect(linux(1001, there("/bin/getent"))).toBe("/home/n");
		expect(asked.at(-1)).toEqual(["/bin/getent", "passwd", "1001"]);
		expect(linux(1001, there())).toBeUndefined();
		expect(asked).toHaveLength(3);
		// No /etc/passwd to read.
		expect(systemPasswordHome({ uid: 1001, platform: "linux", read: () => { throw new Error("EACCES"); }, run, exists: there("/usr/bin/getent") })).toBe("/home/n");
		// A home that is no absolute path, or a line that is no record: none.
		expect(systemPasswordHome({ uid: 7, platform: "linux", read: () => "x:x:7:7::home/x:/bin/sh\n7:7\n", run: () => undefined })).toBeUndefined();
	});

	it("macOS: id -P's record of this user (Directory Services), checked against the uid", () => {
		const asked: string[][] = [];
		const record = "u:********:501:20::0:0:U Person:/Users/u:/bin/zsh\n";
		const run = (program: string, args: readonly string[]) => (asked.push([program, ...args]), record);
		expect(systemPasswordHome({ uid: 501, platform: "darwin", read: () => "", run })).toBe("/Users/u");
		expect(asked).toEqual([["/usr/bin/id", "-P"]]);
		expect(systemPasswordHome({ uid: 502, platform: "darwin", read: () => "", run })).toBeUndefined();
		expect(systemPasswordHome({ uid: 501, platform: "darwin", read: () => "", run: () => undefined })).toBeUndefined();
		// Elsewhere: none.
		expect(systemPasswordHome({ uid: 501, platform: "win32", read: () => "", run })).toBeUndefined();
	});
});
