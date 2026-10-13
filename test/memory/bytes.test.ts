import { afterEach, describe, expect, it } from "vitest";
import { byteSize, capText, cutBytes, flatten, localIso, tailBytes, validDate } from "../../src/memory/bytes.ts";

const savedTz = process.env.TZ;
afterEach(() => {
	if (savedTz === undefined) delete process.env.TZ;
	else process.env.TZ = savedTz;
});

describe("bytes", () => {
	it("counts UTF-8 bytes", () => {
		expect(byteSize("a")).toBe(1);
		expect(byteSize("é")).toBe(2);
		expect(byteSize("🌳")).toBe(4);
	});

	it("cuts a prefix without splitting characters", () => {
		expect(cutBytes("éé", 3)).toBe("é");
		expect(cutBytes("abc", 10)).toBe("abc");
		expect(cutBytes("🌳x", 3)).toBe("");
		expect(cutBytes("a🌳", 4)).toBe("a");
	});

	it("keeps a suffix without splitting characters", () => {
		expect(tailBytes("éé", 3)).toBe("é");
		expect(tailBytes("abc", 2)).toBe("bc");
		expect(tailBytes("🌳x", 2)).toBe("x");
		expect(tailBytes("abc", 10)).toBe("abc");
	});

	it("flattens every newline style to spaces", () => {
		expect(flatten("a\r\nb\nc\rd")).toBe("a b c d");
	});

	it("accepts only dates with a timezone", () => {
		expect(validDate("2026-01-01T12:00:00-07:00")).toBe("2026-01-01T12:00:00-07:00");
		expect(validDate("2026-01-01T12:00:00.000Z")).toBe("2026-01-01T12:00:00.000Z");
		expect(() => validDate("2026-01-01T12:00:00")).toThrow(RangeError);
		expect(() => validDate("nonsense+00:00")).toThrow(RangeError);
	});

	it("formats local ISO time with an offset", () => {
		process.env.TZ = "UTC";
		expect(localIso(new Date("2026-01-01T19:00:00Z"))).toBe("2026-01-01T19:00:00.000+00:00");
		process.env.TZ = "America/Denver";
		expect(localIso(new Date("2026-01-01T19:00:00Z"))).toBe("2026-01-01T12:00:00.000-07:00");
	});
});

describe("capText", () => {
	it("matches the Python reference cap_text", () => {
		expect(capText("a".repeat(100), 60)).toBe(`${"a".repeat(14)}\n... [73 characters omitted] ...\n${"a".repeat(13)}`);
		expect(capText("0123456789".repeat(10), 40)).toBe("0123\n... [93 characters omitted] ...\n789");
		expect(capText("short", 40)).toBe("short");
		expect(capText("é".repeat(50), 45)).toBe(`${"é".repeat(6)}\n... [38 characters omitted] ...\n${"é".repeat(6)}`);
	});

	it("counts code points, not UTF-16 units", () => {
		expect(capText("🌳".repeat(10), 10)).toBe("🌳".repeat(10));
	});
});
