/** @jsxImportSource @opentui/solid */
/**
 * Orrery in OpenCode's TUI (spec 2026-10-16-opencode-design, "Status and notices"): the agent's status in the prompt's
 * footer ("Orrery · <Name> · <n> msgs · recording"), and Orrery's notices (an update, summary
 * trouble, the agent open elsewhere) as toasts. The TUI entry gets no options: it reads what the server plugin writes
 * for it (tui-feed.ts, src/opencode/feed.ts), every second. OpenCode loads this file as it is (JSX through its Solid
 * transform; "solid-js" is OpenCode's own), so it is copied into a release as tui.tsx, and kept out of tsc. A failure
 * here never stops the TUI: the footer stays empty. Every 5 s it also reads OpenCode's plugin list: when OpenCode has
 * turned the server plugin off (a reload that failed), the footer and a toast say the session has no guard and no memory.
 * It adds /compactor (and "Orrery: summary model" in the command palette): the summary-model picker, in OpenCode's
 * dialogs, which asks the server plugin through its RPC (src/opencode/summary-menu.ts).
 */

import { createSignal } from "solid-js";
import { pickSummaryModel, pluginFolder, pluginOff, SUMMARY_RPC, tuiFeed } from "./tui-feed.js";

/** The prompt's footer: OpenCode shows it on the home screen and in a session alike. */
const SLOTS = ["prompt.footer.status"];
/** How often OpenCode's plugin list is read, to say when OpenCode has turned the server plugin off. */
const LIST_MS = 5000;

export default {
	id: "orrery.tui",
	setup(context: any) {
		let feed: ReturnType<typeof tuiFeed>;
		try {
			feed = tuiFeed(process.env, process.pid, import.meta.url);
		} catch {
			return;
		}
		if (feed === undefined) return;
		const reader = feed;
		const [line, setLine] = createSignal("");
		/** Set when OpenCode's plugin list has the server plugin failed: the session runs with no guard and no memory. */
		let off: string | undefined;
		let last = "";
		const look = () => {
			try {
				const { line: now, fresh } = reader.look();
				if (now !== undefined) last = now;
				setLine(off ?? last);
				for (const notice of fresh) context.ui.toast.show({ title: "Orrery", message: notice.text, variant: notice.level, duration: 10_000 });
			} catch {
				// the next look tries again
			}
		};
		const folder = pluginFolder(import.meta.url);
		const where = typeof context.location?.directory === "string" ? { location: { directory: context.location.directory } } : undefined;
		const list = async () => {
			try {
				const warning = pluginOff(await context.client.plugin.list(where), folder);
				if (warning === off) return;
				off = warning;
				setLine(off ?? last);
				if (warning !== undefined) context.ui.toast.show({ title: "Orrery", message: warning, variant: "error", duration: 30_000 });
			} catch {
				// the next read tries again
			}
		};
		/** /compactor: the summary-model picker, through the server plugin's RPC (src/opencode/summary-menu.ts). */
		const compactor = async () => {
			const toast = (message: string, variant: string) => context.ui.toast.show({ title: "Orrery", message, variant, duration: 10_000 });
			try {
				const call = context.client.rpc(SUMMARY_RPC);
				const options = where ?? {};
				const rpc = {
					menu: () => call.menu({}, options),
					models: (input: { provider: string }) => call.models(input, options),
					switch: (input: object) => call.switch(input, options),
				};
				const result = await pickSummaryModel({ select: (asked) => context.ui.dialog.select(asked) }, rpc);
				if (result !== undefined) toast(result.text, result.ok ? "success" : "warning");
			} catch (error) {
				toast(`Orrery: the summary-model picker failed (${error instanceof Error ? error.message : String(error)}).`, "error");
			}
		};
		try {
			context.keymap.layer(() => ({
				commands: [
					{
						id: "orrery.compactor",
						title: "Orrery: summary model",
						description: "Choose the model that makes this agent's summaries",
						group: "Orrery",
						palette: true,
						slash: { name: "compactor" },
						run: () => {
							void compactor();
						},
					},
				],
			}));
		} catch {
			// an OpenCode without plugin commands: `orrery compactor <Name>` in a shell still works
		}
		const disposers: Array<() => void> = [];
		for (const slot of SLOTS) {
			try {
				disposers.push(context.ui.slot({ append: slot, render: () => <text>{line()}</text> }));
			} catch {
				// a slot this OpenCode doesn't have: the others still show
			}
		}
		look();
		const timer = setInterval(look, 1000);
		const lister = setInterval(() => void list(), LIST_MS);
		return () => {
			clearInterval(timer);
			clearInterval(lister);
			for (const dispose of disposers) {
				try {
					dispose();
				} catch {
					// already gone
				}
			}
		};
	},
};
