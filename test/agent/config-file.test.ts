import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addAgent, configText, editConfigOnce, stillWritten, writeConfigOnce } from "../../src/agent/config-edit.ts";
import { configAbsent, readConfigFile, unchangedConfig } from "../../src/agent/config.ts";
import { tempDir } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
	const dir = realpathSync(tempDir("orrery-config-file-"));
	dirs.push(dir);
	const path = join(dir, "config.toml");
	writeFileSync(path, `# mine\ndata_dir = ${JSON.stringify(join(dir, "data"))}\n`);
	return { dir, path };
}

/** `path` as the gate reads it in a coding tool's session: written back only as it was read. */
const checkedRead = (path: string) => ({ ...readConfigFile(path), checked: true });

const gamma = (text: string, dir: string) => addAgent(text, dir, { name: "Gamma", compactorModel: "openai/gpt-6.1-sol", compactorThinking: "low" });

describe("a config read once: what the gate judged is what the command runs with", () => {
	it("reads the text, the config and the file in one; with none there, where a new one goes", () => {
		const { dir, path } = scratch();
		const file = readConfigFile(path);
		expect(file).toMatchObject({ path, text: readFileSync(path, "utf8"), config: { dataDir: join(dir, "data"), file: path } });
		expect(file.id).toMatchObject({ real: path, ino: statSync(path, { bigint: true }).ino });
		expect(unchangedConfig(file)).toBe(true);
		const none = readConfigFile(join(dir, "none.toml"));
		expect(none).toMatchObject({ path: join(dir, "none.toml"), error: { code: "ENOENT" } });
		expect(configAbsent(none)).toBe(true);
		// No config named: the default's place; with none there, where a new one goes (ORRERY_HOME's).
		const home = join(dir, "home");
		expect(readConfigFile(undefined, { HOME: dir, ORRERY_HOME: home, ORRERY_CONFIG: "" }).path).toBe(join(home, "config.toml"));
		// A file that isn't a config still names its file, with why.
		writeFileSync(path, "not = = toml\n");
		expect(readConfigFile(path)).toMatchObject({ path, text: "not = = toml\n", error: expect.any(Error) });
	});

	it("with an ORRERY_HOME that is no absolute path and no config named, throws nothing: the config has no place, and is never written", () => {
		const { dir, path } = scratch();
		const env = { HOME: dir, ORRERY_HOME: "relative/home" };
		const file = readConfigFile(undefined, env);
		expect(file).toMatchObject({ unplaced: true, error: { message: "ORRERY_HOME must be an absolute path (got relative/home)" } });
		expect(file.config).toBeUndefined();
		expect(configAbsent(file)).toBe(false);
		for (const checked of [false, true]) {
			expect(() => editConfigOnce({ ...file, checked }, gamma)).toThrow("ORRERY_HOME must be an absolute path (got relative/home)");
			expect(() => writeConfigOnce({ ...file, checked }, "# new\n")).toThrow("ORRERY_HOME must be an absolute path (got relative/home)");
		}
		// A config named is read as ever.
		expect(readConfigFile(path, env)).toMatchObject({ path, config: { file: path } });
		expect(readConfigFile(undefined, { ...env, ORRERY_CONFIG: path })).toMatchObject({ path, config: { file: path } });
	});

	it("is unchanged only while its path leads to the file read, written by none since", () => {
		const { dir, path } = scratch();
		const other = join(dir, "other.toml");
		writeFileSync(other, readFileSync(path, "utf8"));
		// Re-pointed: a link to another file, with the same text.
		let file = readConfigFile(path);
		rmSync(path);
		symlinkSync(other, path);
		expect(unchangedConfig(file)).toBe(false);
		// Replaced: another file renamed over it.
		rmSync(path);
		writeFileSync(path, readFileSync(other, "utf8"));
		file = readConfigFile(path);
		writeFileSync(`${path}.new`, readFileSync(path, "utf8"));
		renameSync(`${path}.new`, path);
		expect(unchangedConfig(file)).toBe(false);
		// Written in place: the same file, other text.
		file = readConfigFile(path);
		writeFileSync(path, `${readFileSync(path, "utf8")}# more\n`);
		expect(unchangedConfig(file)).toBe(false);
		// A link read through: unchanged while it leads to the same file.
		rmSync(path);
		symlinkSync(other, path);
		file = readConfigFile(path);
		expect(file.id?.real).toBe(other);
		expect(unchangedConfig(file)).toBe(true);
		// None there: unchanged while still none.
		const none = readConfigFile(join(dir, "new.toml"));
		expect(unchangedConfig(none)).toBe(true);
		writeFileSync(join(dir, "new.toml"), "");
		expect(unchangedConfig(none)).toBe(false);
	});

	it("in a coding tool's session, writes the text it read, edited, to the file it read, keeping that text as .bak; a later write checks the file written", () => {
		const { path } = scratch();
		const before = readFileSync(path, "utf8");
		const file = checkedRead(path);
		const written = editConfigOnce(file, gamma);
		expect(readFileSync(path, "utf8")).toBe(written.text);
		expect(written.text).toContain("[agents.Gamma]");
		expect(written.config?.agents.has("Gamma")).toBe(true);
		expect(readFileSync(`${path}.bak`, "utf8")).toBe(before);
		expect(unchangedConfig(written)).toBe(true);
		expect(stillWritten(written)).toBe(true);
		// The file as it was read is no longer there: a second write of the first read is refused.
		expect(() => editConfigOnce(file, (text) => text)).toThrow(`The config (${path}) changed after Orrery read it, so nothing was written to it. Run the command again.`);
		writeConfigOnce(written, before);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("in a coding tool's session, never writes a file put in its place, nor over another's write, nor a config where one appeared", () => {
		const { dir, path } = scratch();
		const changed = `The config (${path}) changed after Orrery read it, so nothing was written to it. Run the command again.`;
		// Its path re-pointed at another config (the real one, say) after the read: that one is left alone, and so is the link.
		const real = join(dir, "real.toml");
		writeFileSync(real, "# the real one\n");
		let file = checkedRead(path);
		rmSync(path);
		symlinkSync(real, path);
		expect(() => editConfigOnce(file, gamma)).toThrow(changed);
		expect(readFileSync(real, "utf8")).toBe("# the real one\n");
		expect(existsSync(`${real}.bak`)).toBe(false);
		// Written by another since: theirs stays.
		rmSync(path);
		writeFileSync(path, "");
		file = checkedRead(path);
		writeFileSync(path, "# theirs\n");
		expect(() => editConfigOnce(file, gamma)).toThrow(changed);
		expect(readFileSync(path, "utf8")).toBe("# theirs\n");
		// None there when read: a new one is made; one that appeared since stays.
		const fresh = join(dir, "fresh", "config.toml");
		const none = checkedRead(fresh);
		expect(editConfigOnce(none, gamma).text).toContain("[agents.Gamma]");
		const later = checkedRead(join(dir, "later.toml"));
		writeFileSync(join(dir, "later.toml"), "# appeared\n");
		expect(() => editConfigOnce(later, gamma)).toThrow(`The config (${join(dir, "later.toml")}) changed after Orrery read it`);
		expect(readFileSync(join(dir, "later.toml"), "utf8")).toBe("# appeared\n");
	});

	it("in the user's own terminal, a write reads the file's text again and keeps another's edit, as 0.9.0", () => {
		const { path } = scratch();
		const file = readConfigFile(path);
		expect(file.checked).toBeUndefined();
		writeFileSync(path, `${readFileSync(path, "utf8")}# theirs\n`);
		const theirs = readFileSync(path, "utf8");
		expect(configText(file)).toBe(theirs);
		const written = editConfigOnce(file, gamma);
		expect(readFileSync(path, "utf8")).toBe(written.text);
		expect(written.text).toContain("# theirs\n");
		expect(written.text).toContain("[agents.Gamma]");
		expect(readFileSync(`${path}.bak`, "utf8")).toBe(theirs);
		// An undo compares the text, as 0.9.0 did.
		expect(stillWritten(written)).toBe(true);
		writeFileSync(path, `${written.text}# more\n`);
		expect(stillWritten(written)).toBe(false);
	});

});
