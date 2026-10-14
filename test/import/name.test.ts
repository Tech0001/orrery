import { describe, expect, it } from "vitest";
import { suggestName } from "../../src/import/name.ts";
import { agentNameProblem } from "../../src/agent/config.ts";

describe("suggestName", () => {
	it("makes a valid, free name from a chat's title", () => {
		const cases: [string, string[], string][] = [
			["Set up the build cache", [], "Set-up-the-build-cache"],
			["Установка Python3 на Linux", [], "Python3-Linux"],
			["Café crème", [], "Cafe-creme"],
			["2026 plans", [], "Chat-2026-plans"],
			["🎮", [], "Chat"],
			["Edit", [], "Edit-agent"],
			["Atlas", ["atlas", "Atlas-2"], "Atlas-3"],
			["A very long title that goes on well past thirty-two letters", [], "A-very-long-title-that-goes-on"],
			["Supercalifragilisticexpialidocious-and-more-words", [], "Supercalifragilisticexpialidocio"],
			["1234567890123456789012345678901234567890", [], "Chat-123456789012345678901234567"],
			["(untitled)", [], "untitled"],
			["A very long title that goes on well past thirty-two letters", ["A-very-long-title-that-goes-on"], "A-very-long-title-that-goes-on-2"],
		];
		for (const [title, taken, want] of cases) {
			const name = suggestName(title, taken);
			expect(name, title).toBe(want);
			expect(agentNameProblem(name), title).toBeUndefined();
		}
	});

	it("skips names it is told are not free (a folder that already has a memory store)", () => {
		const stored = new Set(["Set-up-the-build-cache", "Set-up-the-build-cache-2"]);
		expect(suggestName("Set up the build cache", [], (name) => stored.has(name))).toBe("Set-up-the-build-cache-3");
	});
});
