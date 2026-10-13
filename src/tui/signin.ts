/** The ChatGPT sign-in's questions and link, as TUI dialogs (pi-ai's AuthInteraction). */

import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { App } from "./app.ts";
import { hardWrap, InputModal, MessageModal, Modal, SecretModal, SelectModal } from "./dialogs.ts";
import { fit } from "./table.ts";
import type { Theme } from "./theme.ts";

/** A question drawn under the sign-in link and code, so a prompt never hides what the user must act on. */
class WithContext extends Modal<string | undefined> {
	readonly #inner: Modal<string | undefined>;
	readonly #context: () => string;

	constructor(inner: Modal<string | undefined>, context: () => string) {
		super(inner.title);
		this.#inner = inner;
		this.#context = context;
		void inner.result.then((value) => this.finish(value));
	}

	render(width: number, height: number, theme: Theme): string[] {
		const text = this.#context();
		const lines = text === "" ? [] : [...hardWrap(text, width).map((l) => fit(l, width)), ""];
		const room = Math.max(1, height - lines.length);
		return [...lines, ...this.#inner.render(width, room, theme)].slice(0, height);
	}

	handleInput(data: string): void {
		this.#inner.handleInput(data);
	}

	cancel(): void {
		this.#inner.cancel();
	}
}

/** An interaction that asks through dialogs; `close()` takes down the link's dialog once the sign-in is over. */
export function signInInteraction(app: App, label = "ChatGPT"): { interaction: AuthInteraction; close(): void } {
	const shown: { cancel(): void }[] = [];
	let link = "";
	const ask = async (prompt: AuthPrompt): Promise<string> => {
		if (prompt.signal?.aborted) throw new Error("withdrawn");
		let modal: Modal<string | undefined>;
		let ids: readonly string[] | undefined;
		if (prompt.type === "secret") modal = new SecretModal(prompt.message);
		else if (prompt.type === "select") {
			modal = new SelectModal(prompt.message, prompt.options.map((o) => o.label));
			ids = prompt.options.map((o) => o.id);
		} else modal = new WithContext(new InputModal(prompt.message), () => link);
		// A prompt raced against the browser's callback is withdrawn when the callback wins.
		prompt.signal?.addEventListener("abort", () => modal.cancel(), { once: true });
		const answer = await app.host.open(modal);
		if (answer === undefined) throw new Error(prompt.signal?.aborted ? "withdrawn" : "Sign-in cancelled.");
		if (prompt.type === "select" && ids !== undefined) return ids[prompt.options.findIndex((o) => o.label === answer)] ?? answer;
		return answer;
	};
	const interaction: AuthInteraction = {
		prompt: ask,
		notify: (event) => {
			if (event.type === "auth_url") {
				link = `Open this link in a browser and sign in:\n${event.url}`;
				const opened = app.deps.openUrl(event.url);
				const modal = new MessageModal(`Sign in to ${label}`, `${opened === undefined ? "Open this link in a browser and sign in:" : "Your browser should open. If it does not, open this link:"}\n\n${event.url}\n\n${event.instructions ?? ""}\nThis closes by itself when the sign-in finishes.`);
				shown.push(modal);
				void app.host.open(modal);
			} else if (event.type === "device_code") {
				link = `Go to ${event.verificationUri} and enter the code ${event.userCode}.`;
				const modal = new MessageModal(`Sign in to ${label}`, `Go to ${event.verificationUri} and enter the code ${event.userCode}.`);
				shown.push(modal);
				void app.host.open(modal);
			} else app.say(event.message);
		},
	};
	return { interaction, close: () => shown.forEach((m) => m.cancel()) };
}
