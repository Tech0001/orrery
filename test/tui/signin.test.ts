import { describe, expect, it } from "vitest";
import { signInInteraction } from "../../src/tui/signin.ts";
import { fakeDeps, keys, makeApp, screen, settle } from "./support.ts";

describe("the sign-in's questions", () => {
	it("a cancelled prompt rejects with Sign-in cancelled.", async () => {
		const app = makeApp(fakeDeps(), []);
		const { interaction } = signInInteraction(app);
		const asked = interaction.prompt({ type: "text", message: "Code?" });
		const failure = asked.then(() => "no", (error: Error) => error.message);
		await settle();
		keys(app, "\x1b");
		expect(await failure).toBe("Sign-in cancelled.");
	});

	it("a withdrawn prompt closes its dialog and rejects", async () => {
		const app = makeApp(fakeDeps(), []);
		const { interaction } = signInInteraction(app);
		const controller = new AbortController();
		const asked = interaction.prompt({ type: "secret", message: "Paste", signal: controller.signal });
		const failure = asked.then(() => "no", () => "rejected");
		await settle();
		expect(app.host.current).toBeDefined();
		controller.abort();
		expect(await failure).toBe("rejected");
		expect(app.host.current).toBeUndefined();
	});

	it("a select prompt returns the option's id, and the link dialog closes with close()", async () => {
		const app = makeApp(fakeDeps(), []);
		const { interaction, close } = signInInteraction(app);
		const asked = interaction.prompt({ type: "select", message: "Which?", options: [{ id: "a1", label: "First" }, { id: "b2", label: "Second" }] });
		await settle();
		keys(app, "\x1b[B", "\r");
		expect(await asked).toBe("b2");
		interaction.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://x.example/device" });
		await settle();
		expect(screen(app)).toContain("ABCD-1234");
		close();
		await settle();
		expect(app.host.current).toBeUndefined();
	});
});
