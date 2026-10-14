import { expect, it } from "vitest";

// A guard: it passes trivially in a plain shell, and matters in a run started inside an agent (`orrery agent`).
it("starts every test file without ORRERY_AGENT or ORRERY_AGENT_TOKEN (test/setup-env.ts)", () => {
	expect(process.env.ORRERY_AGENT).toBeUndefined();
	expect(process.env.ORRERY_AGENT_TOKEN).toBeUndefined();
});
