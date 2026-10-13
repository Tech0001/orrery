/**
 * The Orrery badge's solar system as the small braille logo in the TUI header's top-left corner. Its data lives in
 * claude-plugin/hooks/logo.ts, the one copy the TUI and the Orrery mod in Claude Code share; scripts/orrery-art.ts
 * writes it from assets/orrery.svg.
 */

import { getTerminalColorMode, parseColor, styleText } from "@earendil-works/pi-tui";
import { LOGO } from "../../claude-plugin/hooks/logo.ts";
import type { Theme } from "./theme.ts";

export { type ArtSegment, LOGO, LOGO_HEIGHT, LOGO_WIDTH } from "../../claude-plugin/hooks/logo.ts";

/** The small logo's lines: coloured (24-bit, or 256 colours where the terminal has no more) or, with a plain theme, plain braille. */
export function orreryLogo(theme: Theme): string[] {
	if (!theme.color) return LOGO.map((line) => line.map((s) => s.text).join(""));
	const mode = getTerminalColorMode();
	return LOGO.map((line) => line.map((s) => (s.color === undefined ? s.text : styleText(s.text, { fg: parseColor(s.color) }, mode))).join(""));
}
