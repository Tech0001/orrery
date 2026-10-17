/** @jsxImportSource @opentui/solid */
/**
 * Orrery in OpenCode's TUI (spec 2026-10-16-opencode-design, "Status and notices"): the agent's status in the prompt's
 * footer ("Orrery · <Name> · <n> msgs · recording"), and Orrery's notices (an update, summary
 * trouble, the agent open elsewhere) as toasts. The TUI entry gets no options: it reads what the server plugin writes
 * for it (tui-feed.ts, src/opencode/feed.ts), every second. OpenCode loads this file as it is (JSX through its Solid
 * transform; "solid-js" is OpenCode's own), so it is copied into a release as tui.tsx, and kept out of tsc. A failure
 * here never stops the TUI: the footer stays empty.
 */

import { createSignal } from "solid-js";
import { tuiFeed } from "./tui-feed.js";

/** The prompt's footer: OpenCode shows it on the home screen and in a session alike. */
const SLOTS = ["prompt.footer.status"];

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
		const look = () => {
			try {
				const { line: now, fresh } = reader.look();
				if (now !== undefined) setLine(now);
				for (const notice of fresh) context.ui.toast.show({ title: "Orrery", message: notice.text, variant: notice.level, duration: 10_000 });
			} catch {
				// the next look tries again
			}
		};
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
		return () => {
			clearInterval(timer);
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
