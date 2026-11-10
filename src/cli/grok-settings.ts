/**
 * `orrery grok-settings [--yes]` (spec 2026-11-10-grok-settings-check-design, Goal 4): Grok's settings, for Grok's folder
 * and the folder it runs in, against the record of the ones the person approved (src/grok/settings.ts). It says when
 * there are no changes, with the approval's date; otherwise it lists every change (or, with no record yet, everything
 * Grok loads), as the launch does but with no limit, and asks the launch's question. `--yes` approves what it just
 * listed, without asking. With no terminal and no `--yes`, it lists them and approves nothing. Agents' shells, and
 * sessions that are no agent's, never get here: the CLI's gate refuses it there, as it refuses `orrery agent`.
 */

import { approvalDate, approveGrokSettings, checkGrokSettings, REVIEW_IN_TERMINAL, settingsQuestion } from "../grok/settings.ts";

export interface GrokSettingsIo {
	say(line: string): void;
	/** The question, shown whole: its last line names the answer Enter gives (`defaultYes`). Absent without a terminal. */
	ask?(question: string, defaultYes: boolean): Promise<boolean>;
}

/** 0 when Grok's settings are as approved, or approved now; 1 when they are left unapproved. */
export async function grokSettingsCommand(dataDir: string, options: { readonly yes: boolean; readonly cwd: string; readonly env: NodeJS.ProcessEnv }, io: GrokSettingsIo): Promise<number> {
	const check = checkGrokSettings(dataDir, options.env, options.cwd);
	const asked = settingsQuestion(check, Number.POSITIVE_INFINITY);
	if (asked === undefined) {
		io.say(check.state === "unchanged" && check.approvedAt !== undefined ? `No changes to Grok's settings since you approved them on ${approvalDate(check.approvedAt)}.` : "No changes to Grok's settings: Grok loads none of the settings Orrery checks.");
		return 0;
	}
	if (options.yes) {
		for (const line of asked.lines) io.say(line);
		approveGrokSettings(dataDir, check.shown);
		io.say("Approved Grok's settings.");
		return 0;
	}
	if (io.ask === undefined) {
		for (const line of asked.lines) io.say(line);
		io.say(`Not approved: there is no terminal to ask on. ${REVIEW_IN_TERMINAL}`);
		return 1;
	}
	if (!(await io.ask([...asked.lines, asked.question].join("\n"), asked.defaultYes))) {
		io.say("Not approved.");
		return 1;
	}
	// What the list showed, whatever is on disk by now.
	approveGrokSettings(dataDir, check.shown);
	io.say("Approved Grok's settings.");
	return 0;
}
