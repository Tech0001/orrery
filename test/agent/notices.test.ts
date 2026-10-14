import { describe, expect, it } from "vitest";
import { noticeKey, noticeText } from "../../src/agent/notices.ts";

describe("noticeText", () => {
	const failing = { state: "failing" as const, plain: "the OpenRouter account has no balance" };
	it("speaks once per change: failing, then recovered; silent when nothing changed or all was well", () => {
		expect(noticeText("Rowan", null, undefined, "/compactor")).toBeUndefined();
		expect(noticeText("Rowan", failing, "ok", "/compactor")).toBe(
			"Orrery: Rowan's summaries are failing: the OpenRouter account has no balance. They keep retrying; nothing is lost. Switch with /compactor.",
		);
		expect(noticeText("Rowan", failing, noticeKey(failing), "/compactor")).toBeUndefined();
		expect(noticeText("Rowan", null, noticeKey(failing), "/compactor")).toBe("Orrery: Rowan's summaries are working again.");
		expect(noticeText("Rowan", { state: "stopped", plain: "unknown model x/y" }, "ok", "/orrery:compactor")).toBe(
			"Orrery: Rowan's summaries stopped: unknown model x/y. Switch with /orrery:compactor.",
		);
	});

	it("keys on the state alone: silent when only the reason changes (a retry's new request id), and while all is well", () => {
		const other = { state: "failing" as const, plain: "Anthropic: 529 overloaded_error request_id req_2" };
		expect(noticeKey(failing)).toBe("failing");
		expect(noticeKey({ state: "stopped", plain: "unknown model x/y" })).toBe("stopped");
		expect(noticeKey(undefined)).toBe("ok");
		expect(noticeText("Rowan", other, noticeKey(failing), "/compactor")).toBeUndefined();
		expect(noticeText("Rowan", undefined, "ok", "/compactor")).toBeUndefined();
		// failing → stopped is a change of state: it speaks, with the current reason.
		expect(noticeText("Rowan", { state: "stopped", plain: "unknown model x/y" }, noticeKey(failing), "/compactor")).toBe(
			"Orrery: Rowan's summaries stopped: unknown model x/y. Switch with /compactor.",
		);
	});
});
