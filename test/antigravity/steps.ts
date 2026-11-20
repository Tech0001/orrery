/** Antigravity transcript steps as agy 1.5.13 writes them (seen live), for tests. */

export interface FakeStep {
	readonly step_index: number;
	readonly source: string;
	readonly type: string;
	readonly status: string;
	readonly created_at: string;
	readonly content: string;
}

export const agyStep = (index: number, source: string, type: string, content: string): FakeStep => ({
	step_index: index,
	source,
	type,
	status: "DONE",
	created_at: "2026-11-20T20:26:46Z",
	content,
});

/** A typed prompt, wrapped as Antigravity wraps it (`settings`: with a settings-change block, as the first prompt has). */
export const typed = (index: number, text: string, settings = false): FakeStep =>
	agyStep(
		index,
		"USER_EXPLICIT",
		"USER_INPUT",
		`<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-20T13:26:46-07:00.\n</ADDITIONAL_METADATA>${settings ? "\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash (Low).\n</USER_SETTINGS_CHANGE>" : ""}`,
	);
