import { describe, expect, it } from "vitest";
import { cutNotice, type Instructions } from "../../src/agent/instructions.ts";
import { GROK_ARG_MAX, grokArgs, grokArgsRefusal, grokCutNote, grokCutNotice, grokLaunch, grokMemoryRoom } from "../../src/grok/launch.ts";
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

	it("keeps the value within GROK_ARG_MAX UTF-8 bytes, the memory whole, the instructions cut at a line and ended with a note saying so", () => {
		const memory = "€".repeat(42_333); // 126,999 bytes
		const text = "Instruction line with é and more words.\n".repeat(900); // about 36 KB
		const launch = grokLaunch(agent, memory, instructions(text));
		const [value, ...more] = rules(launch.args);
		expect(more).toEqual([]);
		expect(bytes(value as string)).toBeLessThanOrEqual(GROK_ARG_MAX);
		expect(value?.startsWith(`${memory}\n\n# Agent: Atlas\n\n`)).toBe(true);
		// The model is told the instructions were cut to fit Grok's command line, not that the file is over 32 KB.
		expect(value?.endsWith(`\n\n${grokCutNote("Atlas")}`)).toBe(true);
		expect(value).not.toContain(cutNotice("Atlas"));
		expect(launch.notices).toEqual([grokCutNotice("Atlas")]);
		// What is kept of the instructions ends where a line of them ends.
		const kept = (value as string).slice(memory.length + 2, -bytes(`\n\n${grokCutNote("Atlas")}`));
		const section = `# Agent: Atlas\n\n${text.trimEnd()}`;
		expect(section.startsWith(kept)).toBe(true);
		expect(section.charAt(kept.length)).toBe("\n");
	});

	it("still says the instructions were cut, to the model too, when none of them fits", () => {
		// Longer than the note, so they don't fit in the room kept for it.
		const given = instructions("Hello there.\n".repeat(20));
		const memory = "m".repeat(grokMemoryRoom("Atlas", given));
		const launch = grokLaunch(agent, memory, given);
		expect(rules(launch.args)).toEqual([`${memory}\n\n${grokCutNote("Atlas")}`]);
		expect(bytes(rules(launch.args)[0] as string)).toBe(GROK_ARG_MAX);
		expect(launch.notices).toEqual([grokCutNotice("Atlas")]);
	});

	it("passes instructions that just fit whole beside the largest memory, saying nothing when the file was whole; a byte more is cut", () => {
		const heading = "# Agent: Atlas\n\n";
		const exact = instructions("x".repeat(bytes(grokCutNote("Atlas")) - bytes(heading)));
		const memory = "m".repeat(grokMemoryRoom("Atlas", exact));
		const whole = grokLaunch(agent, memory, exact);
		expect(rules(whole.args)).toEqual([`${memory}\n\n${heading}${exact.text}`]);
		expect(bytes(rules(whole.args)[0] as string)).toBe(GROK_ARG_MAX);
		expect(whole.notices).toEqual([]);
		const over = grokLaunch(agent, memory, instructions(`${exact.text}x`));
		expect(rules(over.args)[0]?.endsWith(grokCutNote("Atlas"))).toBe(true);
		expect(over.notices).toEqual([grokCutNotice("Atlas")]);
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

	it("gives the memory all of GROK_ARG_MAX without instructions, less the room for the cut note with them", () => {
		expect(grokMemoryRoom("Atlas", undefined)).toBe(GROK_ARG_MAX);
		expect(grokMemoryRoom("Atlas", instructions("x"))).toBe(GROK_ARG_MAX - bytes(`\n\n${grokCutNote("Atlas")}`));
		expect(rules(grokLaunch(agent, "m".repeat(GROK_ARG_MAX), undefined).args)[0]).toHaveLength(GROK_ARG_MAX);
	});

	it("throws for a memory section over its room (its caller fits the memory first)", () => {
		expect(() => grokLaunch(agent, "m".repeat(GROK_ARG_MAX + 1), undefined)).toThrow(RangeError);
		const given = instructions("x");
		expect(() => grokLaunch(agent, "m".repeat(grokMemoryRoom("Atlas", given) + 1), given)).toThrow(/over the \d+ it may take on Grok's command line/);
	});
});

describe("grokArgsRefusal", () => {
	const withRules = grokLaunch(agent, "# Memory", undefined);

	it("refuses the person's own --rules beside Orrery's, in each spelling, before a --", () => {
		for (const args of [["--rules", "x"], ["--rules=x"], ["-c", "--append-system-prompt", "x"], ["--append-system-prompt=x"]]) {
			expect(grokArgsRefusal("Atlas", withRules, args), args.join(" ")).toBe("Orrery gives Grok Atlas's memory and instructions as its --rules, which Grok takes once: put your rules in Atlas's instructions.md, or open Atlas without them.");
		}
		// After a --, a prompt's words.
		expect(grokArgsRefusal("Atlas", withRules, ["--", "--rules"])).toBeUndefined();
		expect(grokArgsRefusal("Atlas", withRules, ["--resume", "abc", "--rulesx"])).toBeUndefined();
	});

	it("lets them through when Orrery passes no --rules (no memory, no instructions)", () => {
		expect(grokArgsRefusal("Atlas", grokLaunch(agent, "", undefined), ["--rules", "x"])).toBeUndefined();
	});
});

describe("isGrokProcess", () => {
	it("knows Grok's program names; its npm launcher is node", () => {
		for (const name of ["grok", "grok-linux-x86_64", "grok-darwin-arm64", "grok-darwin-x86_64"]) expect(isGrokProcess(name), name).toBe(true);
		for (const name of ["node", "groker", "grok-helper", "xgrok", "Grok", "grok-linux", ""]) expect(isGrokProcess(name), name).toBe(false);
	});
});
