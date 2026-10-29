import { describe, expect, it } from "vitest";
import { cutNotice, INSTRUCTIONS_MAX_BYTES, type Instructions } from "../../src/agent/instructions.ts";
import { GROK_ARG_MAX, grokArgs, grokArgsRefusal, grokLaunch, grokMemoryRoom, grokResumeNotice } from "../../src/grok/launch.ts";
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

	it("passes the instructions whole beside a memory of multi-byte text at its room: one value of at most GROK_ARG_MAX UTF-8 bytes", () => {
		// The most a file gives (32 KB), of multi-byte lines.
		const given = instructions("Instruction line with é and more words.\n".repeat(Math.floor(INSTRUCTIONS_MAX_BYTES / 41)));
		const room = grokMemoryRoom("Atlas", given);
		const memory = "€".repeat(Math.floor(room / 3));
		const launch = grokLaunch(agent, memory, given);
		const [value, ...more] = rules(launch.args);
		expect(more).toEqual([]);
		expect(value).toBe(`${memory}\n\n# Agent: Atlas\n\n${given.text.trimEnd()}`);
		expect(bytes(value as string)).toBeLessThanOrEqual(GROK_ARG_MAX);
		expect(launch.notices).toEqual([]);
	});

	it("fills one argument exactly with a memory at its room; a byte more throws (its caller fits the memory first)", () => {
		const given = instructions("Do the work.\n");
		const memory = "m".repeat(grokMemoryRoom("Atlas", given));
		expect(bytes(rules(grokLaunch(agent, memory, given).args)[0] as string)).toBe(GROK_ARG_MAX);
		expect(() => grokLaunch(agent, `${memory}m`, given)).toThrow(RangeError);
		expect(() => grokLaunch(agent, "m".repeat(GROK_ARG_MAX + 1), undefined)).toThrow(/over the 131000 bytes one argument may hold/);
	});

	it("gives the memory all of GROK_ARG_MAX without instructions, less the whole instructions section and the join with them", () => {
		expect(grokMemoryRoom("Atlas", undefined)).toBe(GROK_ARG_MAX);
		expect(grokMemoryRoom("Atlas", instructions("Keep notes.\n"))).toBe(GROK_ARG_MAX - bytes("\n\n# Agent: Atlas\n\nKeep notes."));
		expect(rules(grokLaunch(agent, "m".repeat(GROK_ARG_MAX), undefined).args)[0]).toHaveLength(GROK_ARG_MAX);
	});

	it("leaves the memory most of the argument beside the largest instructions, under the longest agent name", () => {
		// 32 characters, the longest name; 32 KB, the most a file gives.
		const name = `A${"b".repeat(31)}`;
		const room = grokMemoryRoom(name, instructions("x".repeat(INSTRUCTIONS_MAX_BYTES), true));
		expect(room).toBe(GROK_ARG_MAX - bytes(`\n\n# Agent: ${name}\n\n`) - INSTRUCTIONS_MAX_BYTES);
		expect(room).toBeGreaterThan(98_000);
	});

	it("says the 32 KB notice when the file itself was cut; the instructions still go in whole", () => {
		const launch = grokLaunch(agent, "m", instructions("x", true));
		expect(launch.notices).toEqual([cutNotice("Atlas")]);
		expect(rules(launch.args)).toEqual(["m\n\n# Agent: Atlas\n\nx"]);
	});

	it("opens with the instructions only when there is no memory yet", () => {
		const values = rules(grokLaunch(agent, "", instructions("Do the work.\n")).args);
		expect(values).toEqual(["# Agent: Atlas\n\nDo the work."]);
	});

	it("opens with the memory only when there are no instructions, and with nothing to add when there is neither", () => {
		expect(grokLaunch(agent, "# Memory", undefined)).toEqual({ args: ["--rules", "# Memory"], holds: ["memory"], notices: [] });
		expect(grokArgs(grokLaunch(agent, "", undefined), ["-p", "hi"])).toEqual(["-p", "hi"]);
	});
});

describe("grokArgsRefusal", () => {
	const withBoth = grokLaunch(agent, "# Memory", instructions("Keep notes.\n"));

	it("refuses the person's own --rules beside Orrery's, in each spelling, before a --", () => {
		for (const args of [["--rules", "x"], ["--rules=x"], ["-c", "--append-system-prompt", "x"], ["--append-system-prompt=x"]]) {
			expect(grokArgsRefusal("Atlas", withBoth, args), args.join(" ")).toBe("Orrery gives Grok Atlas's memory and instructions as its --rules, which Grok takes once: put your rules in Atlas's instructions.md, or open Atlas without them.");
		}
		// After a --, a prompt's words.
		expect(grokArgsRefusal("Atlas", withBoth, ["--", "--rules"])).toBeUndefined();
		expect(grokArgsRefusal("Atlas", withBoth, ["--resume", "abc", "--rulesx"])).toBeUndefined();
	});

	it("names what Orrery passes: the memory alone, or the instructions alone", () => {
		expect(grokArgsRefusal("Atlas", grokLaunch(agent, "# Memory", undefined), ["--rules", "x"])).toBe("Orrery gives Grok Atlas's memory as its --rules, which Grok takes once: put your rules in Atlas's instructions.md, or open Atlas without them.");
		expect(grokArgsRefusal("Atlas", grokLaunch(agent, "", instructions("Keep notes.\n")), ["--rules", "x"])).toBe("Orrery gives Grok Atlas's instructions as its --rules, which Grok takes once: put your rules in Atlas's instructions.md, or open Atlas without them.");
	});

	it("lets them through when Orrery passes no --rules (no memory, no instructions)", () => {
		expect(grokArgsRefusal("Atlas", grokLaunch(agent, "", undefined), ["--rules", "x"])).toBeUndefined();
	});
});

describe("grokResumeNotice", () => {
	it("says a resumed session keeps the memory of its first launch, for --resume, -r, --continue and -c before a --", () => {
		const notice = "Orrery: a resumed Grok session keeps Atlas's memory as it was at that session's first launch; newer memory is reachable with the zoom and search tools. Start a new session for a fresh view.";
		for (const args of [["--resume", "abc"], ["--resume"], ["--resume=abc"], ["-r", "abc"], ["--continue"], ["-c"], ["--model", "m", "--continue"]]) expect(grokResumeNotice("Atlas", args), args.join(" ")).toBe(notice);
		for (const args of [[], ["-p", "hi"], ["--", "--resume"], ["--resumex"], ["-cr"], ["--rules", "x"]]) expect(grokResumeNotice("Atlas", args), args.join(" ")).toBeUndefined();
	});
});

describe("isGrokProcess", () => {
	it("knows Grok's program names; its npm launcher is node", () => {
		for (const name of ["grok", "grok-linux-x86_64", "grok-darwin-arm64", "grok-darwin-x86_64"]) expect(isGrokProcess(name), name).toBe(true);
		for (const name of ["node", "groker", "grok-helper", "xgrok", "Grok", "grok-linux", ""]) expect(isGrokProcess(name), name).toBe(false);
	});
});
