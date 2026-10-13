/** The TUI's few styles. Plain text when colors are off (NO_COLOR, TERM=dumb, or not a terminal). */

export type Style = (text: string) => string;

export interface Theme {
	/** Whether these styles color anything (false for PLAIN). */
	readonly color: boolean;
	readonly bold: Style;
	readonly dim: Style;
	readonly inverse: Style;
	readonly red: Style;
	readonly yellow: Style;
	readonly green: Style;
	readonly accent: Style;
}

const wrap = (on: string, off: string): Style => (text) => `\x1b[${on}m${text}\x1b[${off}m`;
const same: Style = (text) => text;

/** Styles with ANSI codes, or none. */
export function makeTheme(color: boolean): Theme {
	if (!color) return { color, bold: same, dim: same, inverse: same, red: same, yellow: same, green: same, accent: same };
	return {
		color,
		bold: wrap("1", "22"),
		dim: wrap("2", "22"),
		inverse: wrap("7", "27"),
		red: wrap("31", "39"),
		yellow: wrap("33", "39"),
		green: wrap("32", "39"),
		accent: wrap("36", "39"),
	};
}

export const PLAIN: Theme = makeTheme(false);

/** Whether to color: a terminal, no NO_COLOR, and not TERM=dumb. */
export function colorWanted(env: NodeJS.ProcessEnv = process.env, tty = process.stdout.isTTY === true): boolean {
	return tty && !env.NO_COLOR && env.TERM !== "dumb";
}
