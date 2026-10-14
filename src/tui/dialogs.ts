/**
 * The TUI's dialogs (spec §3): a list to pick from (type to filter), a text field, a hidden field for keys, a yes/no
 * question, a message; and for turning a chat into an agent (spec 2026-10-13-orrery-agents-design §6) the chat list,
 * a progress line and a report to act on. Each resolves its `result` once. ModalHost stacks them; the App draws the
 * top one.
 */

import { Input, matchesKey, sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Chat, chatMatches, folderLabel } from "../import/chats.ts";
import type { MenuUI } from "../lane/compactor-menu.ts";
import { ago } from "../lane/overview.ts";
import { fit } from "./table.ts";
import type { Theme } from "./theme.ts";

export abstract class Modal<T> {
	readonly title: string;
	readonly result: Promise<T>;
	#resolve: (value: T) => void = () => {};
	#done = false;

	constructor(title: string) {
		this.title = title;
		this.result = new Promise<T>((resolve) => {
			this.#resolve = resolve;
		});
	}

	get done(): boolean {
		return this.#done;
	}

	protected finish(value: T): void {
		if (this.#done) return;
		this.#done = true;
		this.#resolve(value);
	}

	/** The dialog's lines: at most `height`, none wider than `width`. */
	abstract render(width: number, height: number, theme: Theme): string[];
	abstract handleInput(data: string): void;
	/** Escape, or the App closing it: resolves with the "no answer" value. */
	abstract cancel(): void;
}

const titleLines = (title: string, width: number, theme: Theme) => title.split("\n").map((line) => theme.bold(fit(line, width)));
const isPrintable = (data: string) => data.length > 0 && !data.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(data);

/** A list to pick one from; typing narrows it (every word must appear). */
export class SelectModal extends Modal<string | undefined> {
	readonly options: readonly string[];
	#selected = 0;
	#filter = "";

	constructor(title: string, options: readonly string[]) {
		super(title);
		this.options = options;
	}

	#visible(): string[] {
		const words = this.#filter.toLowerCase().split(/\s+/).filter(Boolean);
		return this.options.filter((o) => words.every((w) => o.toLowerCase().includes(w)));
	}

	render(width: number, height: number, theme: Theme): string[] {
		const head = titleLines(this.title, width, theme);
		const visible = this.#visible();
		const filter = this.#filter === "" ? [] : [theme.dim(fit(`filter: ${this.#filter}`, width))];
		const room = Math.max(1, height - head.length - filter.length - 1);
		const start = this.#selected >= room ? this.#selected - room + 1 : 0;
		const items = visible.slice(start, start + room).map((o, k) => {
			const text = fit(`${start + k === this.#selected ? "› " : "  "}${o}`, width);
			return start + k === this.#selected ? theme.inverse(text) : text;
		});
		const empty = visible.length === 0 ? [theme.dim(fit("  nothing matches", width))] : [];
		return [...head, ...filter, ...items, ...empty, theme.dim(fit("↑↓ choose · Enter pick · type to filter · Esc back", width))].slice(0, height);
	}

	handleInput(data: string): void {
		const visible = this.#visible();
		if (matchesKey(data, "escape")) return this.cancel();
		if (matchesKey(data, "enter")) {
			if (visible[this.#selected] !== undefined) this.finish(visible[this.#selected]);
			return;
		}
		if (matchesKey(data, "up")) this.#selected = Math.max(0, this.#selected - 1);
		else if (matchesKey(data, "down")) this.#selected = Math.min(Math.max(0, visible.length - 1), this.#selected + 1);
		else if (matchesKey(data, "backspace")) {
			this.#filter = this.#filter.slice(0, -1);
			this.#selected = 0;
		} else if (isPrintable(data)) {
			this.#filter += data;
			this.#selected = 0;
		}
	}

	cancel(): void {
		this.finish(undefined);
	}
}

/** A one-line text field (pi-tui's Input), answered trimmed. */
export class InputModal extends Modal<string | undefined> {
	readonly #input = new Input();

	constructor(title: string, initial = "") {
		super(title);
		this.#input.setValue(initial);
		this.#input.handleInput("\x05"); // Ctrl+E: the cursor goes to the end of the initial text
		this.#input.focused = true;
		this.#input.onSubmit = (value) => this.finish(value.trim());
		this.#input.onEscape = () => this.cancel();
	}

	render(width: number, height: number, theme: Theme): string[] {
		return [...titleLines(this.title, width, theme), ...this.#input.render(width), theme.dim(fit("Enter to accept · Esc to cancel", width))].slice(0, height);
	}

	handleInput(data: string): void {
		this.#input.handleInput(data);
	}

	cancel(): void {
		this.finish(undefined);
	}
}

/** Takes the bracketed-paste markers out of terminal input. */
export function stripPaste(data: string): string {
	return data.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
}

/** A field whose contents are never drawn, not even their length. */
export class SecretModal extends Modal<string | undefined> {
	#value = "";

	render(width: number, height: number, theme: Theme): string[] {
		return [...titleLines(this.title, width, theme), theme.dim(fit("(typing is hidden) · Enter to save · Esc to cancel", width))].slice(0, height);
	}

	handleInput(data: string): void {
		// matchesKey: under the Kitty keyboard protocol Esc arrives as "\x1b[27u", not "\x1b".
		if (matchesKey(data, "escape")) return this.cancel();
		if (matchesKey(data, "enter")) return this.finish(this.#value.trim());
		if (matchesKey(data, "backspace")) {
			this.#value = this.#value.slice(0, -1);
			return;
		}
		const text = stripPaste(data);
		if (text.startsWith("\x1b")) return; // arrows and other keys
		// A paste that ends with a newline submits what came before it.
		const newline = text.search(/[\r\n]/);
		this.#value += (newline === -1 ? text : text.slice(0, newline)).replace(/[\x00-\x1f\x7f]/g, "");
		if (newline !== -1) this.finish(this.#value.trim());
	}

	cancel(): void {
		this.#value = "";
		this.finish(undefined);
	}
}

/** A yes/no question: y, or n / Esc. */
export class ConfirmModal extends Modal<boolean> {
	render(width: number, height: number, theme: Theme): string[] {
		return [...titleLines(this.title, width, theme), theme.dim(fit("y yes · n no", width))].slice(0, height);
	}

	handleInput(data: string): void {
		if (data === "y" || data === "Y") this.finish(true);
		else if (data === "n" || data === "N" || matchesKey(data, "escape")) this.cancel();
	}

	cancel(): void {
		this.finish(false);
	}
}

/** `piece` cut into lines of at most `width` columns, by what the terminal shows: wide letters and styles stay whole. */
function cutToWidth(piece: string, width: number): string[] {
	const out: string[] = [];
	let rest = piece;
	while (visibleWidth(rest) > width) {
		const head = sliceByColumn(rest, 0, width, true);
		const used = visibleWidth(head);
		if (used === 0) break; // one letter wider than the whole line: keep it as it is
		out.push(head);
		rest = sliceByColumn(rest, used, visibleWidth(rest) - used);
	}
	out.push(rest);
	return out;
}

/** Wraps at spaces, then cuts what is still too wide (a long link) into pieces, so nothing is lost. */
export function hardWrap(text: string, width: number): string[] {
	return text.split("\n").flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)).flatMap((piece) => cutToWidth(piece, width)));
}

/** Text to read, scrolled with ↑↓; Enter or Esc closes it. */
export class MessageModal extends Modal<void> {
	readonly text: string;
	#top = 0;
	/** Lines at the last drawn width. */
	#count = 0;

	constructor(title: string, text: string) {
		super(title);
		this.text = text;
	}

	render(width: number, height: number, theme: Theme): string[] {
		const head = titleLines(this.title, width, theme);
		const room = Math.max(1, height - head.length - 1);
		const wrapped = hardWrap(this.text, width);
		this.#count = wrapped.length;
		const lines = wrapped.slice(this.#top, this.#top + room).map((l) => fit(l, width));
		return [...head, ...lines, theme.dim(fit("Enter to close · ↑↓ scroll", width))].slice(0, height);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "enter") || matchesKey(data, "escape")) this.finish();
		else if (matchesKey(data, "up")) this.#top = Math.max(0, this.#top - 1);
		else if (matchesKey(data, "down")) this.#top = Math.min(Math.max(0, this.#count - 1), this.#top + 1);
	}

	cancel(): void {
		this.finish();
	}
}

const sizeText = (bytes: number) => (bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`);

/**
 * The chats to turn into an agent, one row each (title, folder, tool, last active, size, "in use"), newest first. Typing
 * filters by title or folder. Space marks several chats of one folder, to import together, while no filter is typed
 * (then a space is part of the filter); Tab marks always. Enter goes on with the marked ones, or the one under the
 * cursor.
 */
export class ChatListModal extends Modal<readonly Chat[] | undefined> {
	readonly #chats: readonly Chat[];
	readonly #home: string;
	readonly #now: number;
	/** The marked chats' files. */
	readonly #marked = new Set<string>();
	#filter = "";
	#cursor = 0;
	#note = "";

	constructor(title: string, chats: readonly Chat[], options: { readonly home: string; readonly now: number }) {
		super(title);
		this.#chats = chats;
		this.#home = options.home;
		this.#now = options.now;
	}

	#visible(): Chat[] {
		return this.#chats.filter((chat) => chatMatches(chat, this.#filter, this.#home));
	}

	render(width: number, height: number, theme: Theme): string[] {
		const head = titleLines(this.title, width, theme);
		const visible = this.#visible();
		const extra = [...(this.#filter === "" ? [] : [theme.dim(fit(`filter: ${this.#filter}`, width))]), ...(this.#note === "" ? [] : [theme.yellow(fit(this.#note, width))])];
		const room = Math.max(1, height - head.length - extra.length - 1);
		const start = this.#cursor >= room ? this.#cursor - room + 1 : 0;
		const rows = visible.slice(start, start + room).map((chat, k) => {
			const at = start + k;
			const where = chat.folder === undefined ? "?" : folderLabel(chat.folder, this.#home);
			const tool = chat.tool === "codex" ? "Codex" : "Claude Code";
			const line = fit(`${at === this.#cursor ? "› " : "  "}${this.#marked.has(chat.file) ? "[x]" : "[ ]"} ${chat.title}  ·  ${where}  ·  ${tool}  ·  ${ago(new Date(chat.lastActive).toISOString(), this.#now)}  ·  ${sizeText(chat.size)}${chat.inUse ? "  ·  in use" : ""}`, width);
			return at === this.#cursor ? theme.inverse(line) : line;
		});
		const empty = visible.length === 0 ? [theme.dim(fit("  nothing matches", width))] : [];
		const mark = this.#filter === "" ? "space or Tab mark several" : "Tab mark several";
		return [...head, ...extra, ...rows, ...empty, theme.dim(fit(`↑↓ choose · ${mark} · Enter go on · type to filter · Esc back`, width))].slice(0, height);
	}

	handleInput(data: string): void {
		const visible = this.#visible();
		if (matchesKey(data, "escape")) return this.cancel();
		if (matchesKey(data, "enter")) {
			const marked = this.#chats.filter((chat) => this.#marked.has(chat.file));
			const current = visible[this.#cursor];
			if (marked.length > 0) this.finish(marked);
			else if (current !== undefined) this.finish([current]);
			return;
		}
		if (matchesKey(data, "up")) this.#cursor = Math.max(0, this.#cursor - 1);
		else if (matchesKey(data, "down")) this.#cursor = Math.min(Math.max(0, visible.length - 1), this.#cursor + 1);
		else if (matchesKey(data, "tab") || (data === " " && this.#filter === "")) this.#toggle(visible[this.#cursor]);
		else if (matchesKey(data, "backspace")) {
			this.#filter = this.#filter.slice(0, -1);
			this.#cursor = 0;
		} else if (isPrintable(data)) {
			this.#filter += data;
			this.#cursor = 0;
		}
	}

	#toggle(chat: Chat | undefined): void {
		if (chat === undefined) return;
		this.#note = "";
		if (this.#marked.delete(chat.file)) return;
		const first = this.#chats.find((other) => this.#marked.has(other.file));
		if (first !== undefined && first.folder !== chat.folder) {
			this.#note = `Mark chats of one folder: the first is in ${first.folder === undefined ? "an unknown folder" : folderLabel(first.folder, this.#home)}.`;
			return;
		}
		this.#marked.add(chat.file);
	}

	cancel(): void {
		this.finish(undefined);
	}
}

/** Work in progress: one line the work updates; Esc cancels it (its `signal` aborts) and closes it. */
export class ProgressModal extends Modal<void> {
	readonly #controller = new AbortController();
	#line = "Starting…";

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	say(line: string): void {
		this.#line = line;
	}

	/** The work is over: closes without aborting. */
	close(): void {
		this.finish();
	}

	render(width: number, height: number, theme: Theme): string[] {
		return [...titleLines(this.title, width, theme), fit(this.#line, width), theme.dim(fit("Esc cancels (nothing is written)", width))].slice(0, height);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.cancel();
	}

	cancel(): void {
		this.#controller.abort();
		this.finish();
	}
}

/** A report to act on: Enter does it, R shows the full report, Esc leaves. */
export class ReportModal extends Modal<"import" | "full" | undefined> {
	readonly #text: string;

	constructor(title: string, text: string) {
		super(title);
		this.#text = text;
	}

	render(width: number, height: number, theme: Theme): string[] {
		const head = titleLines(this.title, width, theme);
		// The keys stay in view: a report longer than the room ends in a pointer to the full one.
		const room = Math.max(1, height - head.length - 1);
		const body = hardWrap(this.#text, width);
		const shown = body.length > room ? [...body.slice(0, room - 1), "… (R shows the full report)"] : body;
		return [...head, ...shown.map((line) => fit(line, width)), theme.dim(fit("Enter import · R full report · Esc leave without writing", width))].slice(0, height);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "enter")) this.finish("import");
		else if (data === "r" || data === "R") this.finish("full");
		else if (matchesKey(data, "escape")) this.cancel();
	}

	cancel(): void {
		this.finish(undefined);
	}
}

/** The open dialogs, newest on top. */
export class ModalHost {
	readonly #stack: Modal<unknown>[] = [];
	/** Called when a dialog opens or closes (the App asks for a render). */
	onChange: () => void = () => {};

	get current(): Modal<unknown> | undefined {
		return this.#stack.at(-1);
	}

	/** Shows `modal` until it resolves; returns its answer. */
	open<T>(modal: Modal<T>): Promise<T> {
		this.#stack.push(modal as Modal<unknown>);
		this.onChange();
		return modal.result.finally(() => {
			const at = this.#stack.indexOf(modal as Modal<unknown>);
			if (at !== -1) this.#stack.splice(at, 1);
			this.onChange();
		});
	}

	/** Gives the input to the top dialog; false when none is open. */
	handleInput(data: string): boolean {
		const top = this.current;
		if (top === undefined) return false;
		top.handleInput(data);
		return true;
	}

	/** Cancels every open dialog, newest first. */
	closeAll(): void {
		for (const modal of [...this.#stack].reverse()) modal.cancel();
	}
}

/** The summary picker's questions, asked as dialogs. */
export function menuUI(host: ModalHost): MenuUI {
	return {
		select: (title, options) => host.open(new SelectModal(title, options)),
		input: async (title, _placeholder, options) => {
			if (options?.signal?.aborted) return undefined;
			const modal = new InputModal(title);
			const cancel = () => modal.cancel();
			options?.signal?.addEventListener("abort", cancel, { once: true });
			try { return await host.open(modal); } finally { options?.signal?.removeEventListener("abort", cancel); }
		},
	};
}
