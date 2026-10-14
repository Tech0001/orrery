import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { Chat } from "../../src/import/chats.ts";
import { ChatListModal, ConfirmModal, hardWrap, InputModal, MessageModal, ModalHost, menuUI, ProgressModal, ReportModal, SecretModal, SelectModal } from "../../src/tui/dialogs.ts";
import { PLAIN } from "../../src/tui/theme.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
/** Esc under the Kitty keyboard protocol, which pi-tui turns on when the terminal has it. */
const KITTY_ESC = "\x1b[27u";
const TAB = "\t";

const chat = (title: string, folder: string | undefined, lastActive: number, fields: Partial<Chat> = {}): Chat => ({ tool: "claude-code", file: `/f/${title}`, id: title, title, ...(folder === undefined ? {} : { folder }), lastActive, size: 1000, inUse: false, ...fields });

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

	it("ChatListModal marks several chats of one folder with space, refuses another folder's, and goes on with them", async () => {
		const modal = new ChatListModal("Pick", [chat("One", "/w/a", 3), chat("Two", "/w/b", 2), chat("Three", "/w/a", 1)], { home: "/home/x", now: 10 });
		modal.handleInput(" ");
		modal.handleInput(DOWN);
		modal.handleInput(" ");
		expect(modal.render(120, 20, PLAIN).join("\n")).toContain("Mark chats of one folder: the first is in /w/a.");
		modal.handleInput(DOWN);
		modal.handleInput(" ");
		modal.handleInput(ENTER);
		expect((await modal.result)?.map((c) => c.title)).toEqual(["One", "Three"]);
	});

	it("ChatListModal: once a filter is typed, space is part of it and Tab marks", async () => {
		const chats = [chat("Install RPCS3", "/w/a", 3), chat("Install Steam", "/w/a", 2), chat("Plan the trip", "/w/a", 1)];
		const modal = new ChatListModal("Pick", chats, { home: "/home/x", now: 10 });
		for (const c of "install rpcs3") modal.handleInput(c);
		const shown = modal.render(120, 20, PLAIN).join("\n");
		expect(shown).toContain("filter: install rpcs3");
		expect(shown).toContain("Install RPCS3");
		expect(shown).not.toContain("Install Steam");
		modal.handleInput(TAB);
		for (let i = 0; i < "install rpcs3".length; i++) modal.handleInput("\x7f");
		modal.handleInput(DOWN);
		modal.handleInput(DOWN);
		modal.handleInput(TAB);
		modal.handleInput(ENTER);
		expect((await modal.result)?.map((c) => c.title)).toEqual(["Install RPCS3", "Plan the trip"]);
	});

	it("ChatListModal shows each chat's folder, tool, age, size and use; Enter takes the one under the cursor; Esc leaves", async () => {
		const now = Date.parse("2026-10-13T12:00:00.000Z");
		const chats = [
			chat("Install RPCS3", "/home/x/Work", now - 5 * 60_000, { tool: "codex", size: 2_500_000, inUse: true }),
			chat("Lost folder", undefined, now - 3 * 3_600_000),
		];
		const modal = new ChatListModal("Turn which chat into an agent?", chats, { home: "/home/x", now });
		const lines = modal.render(120, 20, PLAIN);
		expect(lines.map((line) => line.trimEnd())).toContain("› [ ] Install RPCS3  ·  ~/Work  ·  Codex  ·  5 min  ·  2.5 MB  ·  in use");
		expect(lines.join("\n")).toContain("  [ ] Lost folder  ·  ?  ·  Claude Code  ·  3 h  ·  1 KB");
		expect(lines.join("\n")).toContain("space or Tab mark several");
		for (const line of modal.render(60, 20, PLAIN)) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		modal.handleInput(DOWN);
		modal.handleInput(ENTER);
		expect((await modal.result)?.map((c) => c.title)).toEqual(["Lost folder"]);
		const left = new ChatListModal("Pick", chats, { home: "/home/x", now });
		left.handleInput(ESC);
		expect(await left.result).toBeUndefined();
	});

	it("ProgressModal shows the line the work says; Esc aborts its signal and closes it; close() does not abort", async () => {
		const progress = new ProgressModal("Preparing Atlas's memory");
		progress.say("Reading 1 chat…");
		expect(progress.render(60, 10, PLAIN).join("\n")).toContain("Reading 1 chat…");
		progress.handleInput(ESC);
		await progress.result;
		expect(progress.signal.aborted).toBe(true);
		const done = new ProgressModal("Preparing");
		done.close();
		await done.result;
		expect(done.signal.aborted).toBe(false);
	});

	it("ReportModal: Enter imports, R asks for the full report, Esc leaves", async () => {
		const answers: unknown[] = [];
		for (const key of [ENTER, "r", "R", ESC]) {
			const report = new ReportModal("Import preview for Atlas", "2 messages, 2026-10-13 to 2026-10-13");
			expect(report.render(60, 10, PLAIN).join("\n")).toContain("2 messages, 2026-10-13 to 2026-10-13");
			report.handleInput(key);
			answers.push(await report.result);
		}
		expect(answers).toEqual(["import", "full", "full", undefined]);
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
