import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ConfirmModal, hardWrap, InputModal, MessageModal, ModalHost, menuUI, SecretModal, SelectModal } from "../../src/tui/dialogs.ts";
import { PLAIN } from "../../src/tui/theme.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
/** Esc under the Kitty keyboard protocol, which pi-tui turns on when the terminal has it. */
const KITTY_ESC = "\x1b[27u";

describe("dialogs", () => {
	it("SelectModal moves, filters by typing, picks with Enter, and cancels with Esc", async () => {
		const pick = new SelectModal("Pick:", ["Sign in", "API key", "Local"]);
		pick.handleInput(DOWN);
		pick.handleInput(ENTER);
		expect(await pick.result).toBe("API key");
		const typed = new SelectModal("Pick:", ["claude-haiku-4-5", "claude-opus-5", "claude-sonnet-5"]);
		for (const c of "son") typed.handleInput(c);
		expect(typed.render(60, 10, PLAIN).join("\n")).toContain("claude-sonnet-5");
		expect(typed.render(60, 10, PLAIN).join("\n")).not.toContain("claude-opus-5");
		typed.handleInput(ENTER);
		expect(await typed.result).toBe("claude-sonnet-5");
		const gone = new SelectModal("Pick:", ["a"]);
		gone.handleInput(ESC);
		expect(await gone.result).toBeUndefined();
	});

	it("InputModal edits and submits; Esc cancels", async () => {
		const input = new InputModal("Name:", "Al");
		for (const c of "pha") input.handleInput(c);
		input.handleInput(ENTER);
		expect(await input.result).toBe("Alpha");
		const left = new InputModal("Name:", "Al");
		left.handleInput(ESC);
		expect(await left.result).toBeUndefined();
		const kitty = new InputModal("Name:");
		kitty.handleInput(KITTY_ESC);
		expect(await kitty.result).toBeUndefined();
	});

	it("SecretModal cancels on Esc, also as the Kitty protocol sends it", async () => {
		for (const esc of [ESC, KITTY_ESC]) {
			const secret = new SecretModal("Key:");
			for (const c of "abc") secret.handleInput(c);
			secret.handleInput(esc);
			expect(await secret.result).toBeUndefined();
		}
	});

	it("hardWrap cuts by what the terminal shows, never inside a style or a wide letter", () => {
		const link = "https://example.com/very/long/link/here";
		const styled = hardWrap(`\x1b[31m${link}\x1b[39m`, 10);
		expect(styled.map((l) => visibleWidth(l))).toEqual([10, 10, 10, 9]);
		expect(styled.map((l) => stripTerminalSequences(l)).join("")).toBe(link);
		const family = "👨‍👩‍👧".repeat(3);
		expect(hardWrap(family, 10)).toEqual([family]);
		const wide = hardWrap("漢字漢字漢字漢字", 5);
		expect(wide.every((l) => visibleWidth(l) <= 5)).toBe(true);
		expect(wide.join("")).toBe("漢字漢字漢字漢字");
	});

	it("SecretModal never draws what is typed or pasted, and cleans a bracketed paste", async () => {
		const secret = new SecretModal("Anthropic API key:");
		secret.handleInput("\x1b[200~  sk-ant-SECRET-42 \n\x1b[201~");
		expect(await secret.result).toBe("sk-ant-SECRET-42");
		expect(secret.render(80, 10, PLAIN).join("\n")).not.toContain("SECRET");
		const typed = new SecretModal("Key:");
		for (const c of "abc") typed.handleInput(c);
		typed.handleInput("\x7f");
		typed.handleInput("\x1b[A");
		const frame = typed.render(80, 10, PLAIN).join("\n");
		expect(frame).not.toContain("ab");
		typed.handleInput(ENTER);
		expect(await typed.result).toBe("ab");
	});

	it("ConfirmModal takes y or n; MessageModal closes on Enter", async () => {
		const yes = new ConfirmModal("Go?");
		yes.handleInput("y");
		expect(await yes.result).toBe(true);
		const no = new ConfirmModal("Go?");
		no.handleInput(ESC);
		expect(await no.result).toBe(false);
		const message = new MessageModal("Done", "line one\nline two");
		expect(message.render(40, 10, PLAIN).join("\n")).toContain("line two");
		message.handleInput(ENTER);
		await message.result;
		expect(message.done).toBe(true);
	});

	it("ModalHost stacks modals, routes input to the top one, and menuUI asks through it", async () => {
		const host = new ModalHost();
		const ui = menuUI(host);
		const answer = ui.select("Group:", ["Sign in", "API key"]);
		expect(host.current?.title).toBe("Group:");
		expect(host.handleInput(ENTER)).toBe(true);
		expect(await answer).toBe("Sign in");
		await Promise.resolve();
		expect(host.current).toBeUndefined();
		expect(host.handleInput("x")).toBe(false);
	});
});
