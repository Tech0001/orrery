import { describe, expect, it } from "vitest";
import { cutNotice, type Instructions } from "../../src/agent/instructions.ts";
import { GROK_ARG_MAX, grokArgs, grokCutNotice, grokLaunch } from "../../src/grok/launch.ts";
import { isGrokProcess } from "../../src/grok/names.ts";

const agent = { name: "Atlas", dir: "/unused" };
const instructions = (text: string, cut = false): Instructions => ({ text, cut, at: 0 });
const bytes = (text: string) => Buffer.byteLength(text);

/** The `--rules` values of an argument list, in order. */
function rules(args: readonly string[]): string[] {
	return args.flatMap((arg, at) => (arg === "--rules" ? [args[at + 1] as string] : []));
}

describe("grokLaunch and grokArgs", () => {
	it("gives the memory section and the instructions through --rules, before the person's arguments", () => {
		const memory = "# Memory\n\nthe view";
		const args = grokArgs(grokLaunch(agent, memory, instructions("Keep notes.\n")), ["--resume", "abc"]);
		expect(args.slice(0, 1)).toEqual(["--rules"]);
		expect(args.slice(-2)).toEqual(["--resume", "abc"]);
		const text = rules(args).join("\n");
		expect(text).toContain(memory);
		expect(text).toContain("# Agent: Atlas");
		expect(text).toContain("Keep notes.");
		// The memory section first.
		expect(text.indexOf(memory)).toBeLessThan(text.indexOf("# Agent: Atlas"));
	});

	it("keeps every --rules value within GROK_ARG_MAX UTF-8 bytes, the memory whole, the instructions cut with their notice", () => {
		const memory = "€".repeat(42_333); // 126,999 bytes
		const text = `${"Instruction line with é and more words.\n".repeat(900)}`; // about 32 KB
		const launch = grokLaunch(agent, memory, instructions(text));
		const values = rules(launch.args);
		for (const value of values) expect(bytes(value)).toBeLessThanOrEqual(GROK_ARG_MAX);
		expect(values.join("")).toContain(memory);
		expect(values.at(-1)?.endsWith(cutNotice("Atlas"))).toBe(true);
		expect(launch.notices).toEqual([grokCutNotice("Atlas")]);
		// What is kept of the instructions is a whole number of lines.
		const kept = (values.at(-1) as string).slice(memory.length).split("\n\n").slice(1).join("\n\n");
		expect(kept.startsWith("# Agent: Atlas")).toBe(true);
	});

	it("passes a value that just fits whole, saying nothing when the instructions were whole in the file", () => {
		const section = "# Agent: Atlas\n\nShort.";
		const memory = "m".repeat(GROK_ARG_MAX - bytes(section) - 2);
		const launch = grokLaunch(agent, memory, instructions("Short.\n"));
		expect(bytes(rules(launch.args)[0] as string)).toBe(GROK_ARG_MAX);
		expect(launch.notices).toEqual([]);
	});

	it("says the 32 KB notice when the file itself was cut", () => {
		expect(grokLaunch(agent, "m", instructions("x", true)).notices).toEqual([cutNotice("Atlas")]);
	});

	it("opens with the instructions only when there is no memory yet", () => {
		const values = rules(grokLaunch(agent, "", instructions("Do the work.\n")).args);
		expect(values).toEqual(["# Agent: Atlas\n\nDo the work."]);
	});

	it("opens with the memory only when there are no instructions, and with nothing to add when there is neither", () => {
		expect(grokLaunch(agent, "# Memory", undefined)).toEqual({ args: ["--rules", "# Memory"], notices: [] });
		expect(grokArgs(grokLaunch(agent, "", undefined), ["-p", "hi"])).toEqual(["-p", "hi"]);
	});

	it("drops the instructions, with a notice, when the memory leaves no room for any", () => {
		const memory = "m".repeat(GROK_ARG_MAX - 10);
		const launch = grokLaunch(agent, memory, instructions("Hello there.\n"));
		expect(rules(launch.args)).toEqual([memory]);
		expect(launch.notices).toEqual([grokCutNotice("Atlas")]);
	});

	it("refuses a memory section that alone is over the limit", () => {
		expect(() => grokLaunch(agent, "m".repeat(GROK_ARG_MAX + 1), undefined)).toThrow(/over the 131000 bytes/);
	});
});

describe("isGrokProcess", () => {
	it("knows Grok's program names, and not its npm shim", () => {
		for (const name of ["grok", "grok-linux-x86_64", "grok-darwin-arm64", "grok-darwin-x86_64"]) expect(isGrokProcess(name), name).toBe(true);
		for (const name of ["node", "groker", "grok-helper", "xgrok", "Grok", "grok-linux", ""]) expect(isGrokProcess(name), name).toBe(false);
	});
});
