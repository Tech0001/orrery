/** Grok's guard rules: its own commands from any session's shell, and its folder, in every gate. The shared shell reading they use stays in src/agent/guard-rules.ts. */

import { homedir } from "node:os";
import { posix } from "node:path";
import { ANSI_C, ansiC, blank, BRACE_ONE, BRACE_WORD, COMMAND_ENDS, ESCAPE_AT, ESCAPE_BEFORE, firstFrom, FOLDER_OPTIONS, GLOB, GLOB_WORDS, globCouldName, globMatches, globUnits, literal, LOOK_BACK, NAME_GOES_ON, namesFolder, only, PLAIN, PLUMBING_END, PLUMBING_START, program, type Reading, readings, REDIRECTION, separatorsOf, skipBlanks, spelledFromHome, within, WORD, words, XARGS } from "../agent/guard-rules.ts";

// ---- Grok's own commands from any session's shell ----
//
// Grok's CLI writes, past the guard, what the guard keeps in Grok's folder (its MCP servers, plugins, trusted folders,
// managed config, sign-in, memory and saved sessions: Grok's manual, 07-mcp-servers.md and 09-plugins.md); it runs
// sessions and leaders outside Orrery's launch (agent's servers, leader, worker, the dashboard); and it can open a
// session that is live in another Grok, an agent's among them, whose log is what Orrery confirms that session's prompts
// by: a second Grok resuming it appends its own prompt there, which reads as typed (src/grok/hooks.ts marks such a
// session, and its recording stops). So in every session, as Grok's folder is kept, shell text is refused where Grok's
// program (grok, or a release binary's name, grok-<os>-<arch>, alone or ending a path, whatever a shell drops from it)
// is named and followed in the same command by a word, wherever it stands, that names (grokCommandIn):
// - a command grok --help 1.0.70 or a command's own --help lists but a read-only one (GROK_REFUSED);
// - an option that picks a session or names one (-r/--resume, -c/--continue, -s/--session-id, in a cluster of short
//   options too), --trust (it trusts a folder for good), or a read-only command's option that writes (GROK_OPTIONS);
// - or any of them, being built at run time as a whole (grok $C, grok "$C", grok $(cat x): builtAtRunTime). A quoted
//   word with other text around its expansions ("summarize $FILE please") can name no command.
// Where a word stands isn't read: Grok takes its subcommand after its prompt too (grok hi mcp list runs mcp list: seen
// live), an option's value may be optional (-w), and a shell makes a brace group several words. So each word is read
// alone, as every word it may be: a brace group and a part built at run time as a glob's * (grok {x,mcp} disable, grok
// mcp dis$X), a glob as each name it could match. Where the program runs as the command (RUNS_AS_COMMAND), a word that
// is one quoted string holding a blank is its prompt, whatever it says (grok "update the docs"), but one that holds a
// substitution or a ${…}, or starts with a "-" (grok "--trust x"); elsewhere, unquoted (grok -p update), and in a text
// with a brace group (grokCommandOf), each of its words counts. Each time the program is named it is read on its own,
// in another's words or substitution too (grok "x $(grok mcp disable orrery)"), but as the argument of a program that
// never runs its arguments with no assignment before it (namesOnly: git commit -m "add grok support and update docs"
// passes; a case arm, eval, sh -c, npx, echo grok update | sh and GIT_EDITOR=sh git commit -e don't). What xargs or
// parallel feed the program counts wherever it stands. A command that only asks for a command's help passes (asksHelp).
// Limits: src/agent/guard-paths.ts, Known limits.

/** What a shell drops from a word: a quote, a backslash, a line continuation, an empty substitution, the $ of $"…". */
const DROPS = "(?:\\\\\\n|[\\\\\"']|\\$\\(\\)|\\$(?=[\"'])|``)";
/**
 * Grok's program as a word (src/grok/names.ts isGrokProcess's names), what a shell drops from it aside (gr""ok), its
 * name in group 1; also after "[", "!" or "\".
 */
const GROK_RUN = new RegExp(
	`(?:${PLUMBING_START}|[[!\\\\])(g${DROPS}*r${DROPS}*o${DROPS}*k(?:${DROPS}*-(?:${DROPS}*[a-z])+${DROPS}*-(?:${DROPS}*[a-z0-9_])+)?)(?=$|[\\s"';|&()<>\`{}$\\\\,\\]])`,
	"g",
);

/** Grok's worker's subcommands (grok worker, grok leader worker). */
const GROK_WORKER = ["start", "stop", "status", "list", "controller", "help"];
/** Grok's subcommands (grok --help 1.0.70), and each one's own, by the words that name it ("" for Grok's). */
const GROK_SUBCOMMANDS: ReadonlyMap<string, readonly string[]> = new Map([
	["", ["agent", "clone", "completions", "dashboard", "doctor", "du", "disk-usage", "export", "help", "inspect", "leader", "login", "logout", "mcp", "memory", "models", "plugin", "sessions", "setup", "trace", "update", "usage", "version", "v", "worker", "worktree", "wrap"]],
	["agent", ["stdio", "headless", "serve", "leader", "help"]],
	["doctor", ["fix", "help"]],
	["leader", ["list", "info", "kill", "worker", "help"]],
	["leader worker", GROK_WORKER],
	["mcp", ["list", "add", "remove", "enable", "disable", "doctor", "help"]],
	["memory", ["clear", "help"]],
	["plugin", ["list", "install", "uninstall", "rm", "remove", "update", "enable", "disable", "details", "validate", "tag", "marketplace", "help"]],
	["plugin marketplace", ["list", "add", "remove", "update", "help"]],
	["sessions", ["list", "search", "delete", "help"]],
	["worker", GROK_WORKER],
	["worktree", ["create", "list", "ls", "show", "rm", "gc", "detach", "salvage", "clean-artifacts", "redirect", "db", "help"]],
]);
/** Every name of Grok's commands, at any depth. */
const GROK_NAMES: ReadonlySet<string> = new Set([...GROK_SUBCOMMANDS.values()].flat());
/**
 * Grok's read-only commands (grok --help 1.0.70), by the words that name them: what they do is print. Not among them:
 * export (writes a file or the clipboard), trace (writes and uploads), doctor (its fix), mcp doctor (starts the
 * servers), the dashboard (opens any session), update and setup (even --check and --json).
 */
const GROK_READS = ["help", "version", "v", "models", "inspect", "completions", "usage", "du", "disk-usage", "mcp list", "plugin list", "plugin details", "plugin validate", "plugin marketplace list", "sessions list", "sessions search", "worktree list", "worktree ls", "worktree show"];
/** The names shell text may not give Grok's program: all but a read-only command's and its group's (mcp, plugin…). */
const GROK_REFUSED: readonly string[] = [...GROK_NAMES].filter((name) => !GROK_READS.some((path) => path.split(" ").includes(name)));
/**
 * The options shell text may not give Grok's program, and why: those that pick a session or name one, --trust, and the
 * read-only commands' options that write (du's --clean and --clean-orphaned ask Grove's daemon to purge; plugin list's
 * --available reads marketplace sources and may sync them).
 */
const GROK_OPTIONS: ReadonlyMap<string, GrokCommand["why"]> = new Map<string, GrokCommand["why"]>([
	...["-r", "--resume", "-c", "--continue", "-s", "--session-id"].map((option): [string, GrokCommand["why"]] => [option, "opens"]),
	["--trust", "trust"],
	...["--clean", "--clean-orphaned", "--available"].map((option): [string, GrokCommand["why"]] => [option, "command"]),
]);
const GROK_OPTION_NAMES = [...GROK_OPTIONS.keys()];
/** A refused name or option of Grok's as a word anywhere in a text: what xargs or parallel may feed Grok's program. */
const GROK_FED = new RegExp(`${PLUMBING_START}(${[...GROK_REFUSED, ...GROK_OPTION_NAMES].map(literal).join("|")})${PLUMBING_END}`);
/** A character of a plain shell word: nothing quoted, escaped or built at run time, and no command's end. */
const SHELL_PLAIN = "[^\\s\"'\\\\$`;|&()<>]";
/**
 * What may stand before Grok's program, from its command's start, where it runs as the command (so a quoted word is
 * its prompt): (, $(, {, !, then, do, else, assignments, env, exec, command, nohup, nice, time and timeout with their
 * options and numbers, and the program's folder; nothing quoted, escaped or built at run time.
 */
const RUNS_AS_COMMAND = new RegExp(`^(?:[\\s!{]|(?:[a-z_][a-z0-9_]*=)?\\$?\\(|(?:[a-z_][a-z0-9_]*=${SHELL_PLAIN}*|then|do|else|env|exec|command|nohup|nice|time|timeout|-${SHELL_PLAIN}*|[0-9][0-9.]*[a-z]?)(?=\\s))*(?:${SHELL_PLAIN}*\\/)?$`);
/**
 * A command's program (sticky), past blank lines (a pipe's next stage may start on the next line) and plain
 * redirections on its own line, when it never runs its arguments, then a blank or its command's end: a bare name (a
 * path may be another program); git's and gh's only with a command that runs none (git -c, rebase -x, grep -O and gh's
 * extensions do, as sed's e command and rg's --pre do; the readings are lower case, so git -C is -c); and Grok's own,
 * whose words this rule reads from the program itself. No assignment may stand before it: one may make the program run
 * another (GIT_EDITOR=sh git commit -e, GIT_PAGER, GH_EDITOR, LESSOPEN), so any loses this.
 */
const READS_ONLY = new RegExp(`\\s*(?:${REDIRECTION.source}[ \\t]*${SHELL_PLAIN}+[ \\t]+)*(?:echo|printf|cat|ls|head|tail|wc|grep|jq|git[ \\t]+(?:commit|log|show|diff|status|add|tag)|gh[ \\t]+(?:pr|issue|release|search|api)|grok(?:-[a-z]+-[a-z0-9_]+)?)(?=[ \\t|;&\\n]|$)`, "y");
/** A word that is one quoted string: Grok's prompt where Grok's program runs as the command and it holds a blank. */
const QUOTED = /^(?:"(?:[^"\\]|\\[^])*"|'[^']*')$/;
/** A parameter expansion or a substitution in a word ($X, ${…}, $(…), `…`; a bare $, or one cut short, too). */
const EXPANSION = /\$(?:\{[^}]*\}?|\([^)]*\)?|[a-z_][a-z0-9_]*|[0-9?#@*!$-])?|`[^`]*`?/g;
/** The same at lastIndex. */
const EXPANSION_AT = new RegExp(EXPANSION.source, "y");

/** A Grok command shell text may not run (grokCommandIn): as the refusal names it, and why (GROK_CLI_REFUSED). */
interface GrokCommand {
	readonly command: string;
	/**
	 * It opens a session by its id or the latest one; it trusts a folder (--trust); it is a command that isn't read-only;
	 * a word built at run time may be any (builtAtRunTime).
	 */
	readonly why: "opens" | "trust" | "command" | "built";
}

/** Whether a character ends a shell word outside quotes: a blank, a command's end, <, >, ), ` or the text's end. */
const wordEnds = (c: string) => blank(c) || COMMAND_ENDS.has(c) || "<>)`".includes(c);

/** Past the shell word at `at`: its quotes and escapes included, to where a word ends (wordEnds). */
function pastWord(form: string, at: number): number {
	let i = at;
	let quote: "'" | '"' | undefined;
	for (; i < form.length; i++) {
		const c = form.charAt(i);
		if (quote !== undefined) {
			if (c === "\\" && quote === '"') i++;
			else if (c === quote) quote = undefined;
		} else if (c === "\\") i++;
		else if (c === "'" || c === '"') quote = c;
		else if (wordEnds(c)) break;
	}
	return Math.max(at + 1, i);
}

/**
 * The words of the command Grok's program runs in a reading, its name ending at `at`, each as written, and where they
 * end: at the command's end (a ;, |, & or newline, but in parentheses or backquotes opened past the program), a
 * substitution's own words among them, a redirection and its file aside. A part built at run time glued to the program
 * (grok$X) is a word of its own, and a word ending at a $( is written $(…). A backquote past the first is written `…`:
 * the first may close a substitution the program runs in (x=`grok --version`), but one past it is a substitution's
 * among Grok's words (grok `cat x`). `closes`: the program surely runs in backquotes, so the first closes them and its
 * command. Undefined when the program's word goes on past its name (grok's, grokfile): no program. An escaped blank
 * ends it, as eval, sh -c, a pipe into sh and ssh read it (grok\ update).
 */
function grokWords(form: string, at: number, closes: boolean): { readonly words: readonly string[]; readonly end: number } | undefined {
	let i = at;
	const words: string[] = [];
	const word = (end: number) => `${form.slice(i, end)}${form.charAt(end) === "(" && form.charAt(end - 1) === "$" ? "(…)" : ""}`;
	// The rest of the program's word: a quote or a bracket closing around it; past a part built at run time or a list's
	// next item (a brace group), failing closed.
	for (; !wordEnds(form.charAt(i)); i++) {
		const c = form.charAt(i);
		if (c === "\\") {
			if (form.charAt(i + 1) === "\n" || blank(form.charAt(i + 1)) || ((ESCAPE_AT.lastIndex = i), ESCAPE_AT.test(form))) break;
			return undefined;
		}
		if (c === "$" || c === ",") {
			const end = pastWord(form, i);
			if (c === "$") words.push(word(end));
			i = end;
			break;
		}
		if (c !== "'" && c !== '"' && c !== "}" && c !== "]") return undefined;
	}
	let nested = 0;
	let ticks = false;
	let ticked = false;
	for (;;) {
		i = skipBlanks(form, i);
		const c = form.charAt(i);
		if (c === "") break;
		REDIRECTION.lastIndex = i;
		if (REDIRECTION.test(form)) {
			i = skipBlanks(form, REDIRECTION.lastIndex);
			if (!wordEnds(form.charAt(i))) i = pastWord(form, i);
			continue;
		}
		if (c === "(" || c === ")") nested = Math.max(0, nested + (c === "(" ? 1 : -1));
		else if (c === "`") {
			if (closes && !ticked) break;
			if (ticked) words.push("`…`");
			ticked = true;
			ticks = !ticks;
		} else if (COMMAND_ENDS.has(c)) {
			if (nested === 0 && !ticks) break;
		} else {
			const end = pastWord(form, i);
			words.push(word(end));
			i = end;
			continue;
		}
		i++;
	}
	return { words, end: i };
}

/** Whether a word is an option of Grok's (a "-", then more). */
const optionWord = (text: string) => text.length > 1 && text.startsWith("-");

/** Which of `names` a word names: itself, or each a glob (a word with *, ? or [) could match; none for no word. */
function namedBy(text: string | undefined, names: readonly string[]): string[] {
	if (text === undefined) return [];
	if (!GLOB.test(text)) return names.includes(text) ? [text] : [];
	const units = globUnits(text, Math.max(...names.map((name) => name.length)));
	return units === undefined ? [] : names.filter((name) => globMatches(units, name));
}

/** Each escape that printf or echo -e turns into a blank (ESCAPE_BEFORE). */
const ESCAPES = new RegExp(ESCAPE_BEFORE, "g");
/**
 * A run of a piece's characters with no ( ) , ; | & < > # but in a bracket expression, kept whole: a "[" that doesn't
 * close before the next "[" is itself, so a piece is read in linear time.
 */
const GROK_PART = /(?:\[[!^]?\]?[^\][]*\]|[^(),;|&<>#])+/g;

/**
 * A word of Grok's as the words it may stand for: quotes and escapes gone, split at the blanks a quoted part holds, and
 * a brace group (from its first brace to its last) and what is built at run time read as a glob's *; a piece built
 * whole at run time is left out (builtAtRunTime judges the word). Split at a parenthesis, a comma, ;, |, &, <, > or #
 * too, which no name of Grok's holds: a quote that closes another's text reads as one that opens, so the word runs on
 * past that text's end (python3 -c "print('grok update')", sh -c 'grok update';true). Not inside a glob's bracket
 * expression, which is one character whatever it holds (up[d#]ate may be update). A word holding an escape that printf
 * or echo -e turns into a blank (ESCAPE_BEFORE) is read again with each one a blank, and the pieces that reading adds
 * count too: piped into sh, printf 'grok update\n' runs grok update (the first reading keeps up\date as update).
 */
function grokPieces(word: string): string[] {
	const bare = word.replace(EXPANSION, "\0");
	const pieces = grokReading(bare);
	const spaced = bare.includes("\\") ? bare.replace(ESCAPES, " ") : bare;
	if (spaced === bare) return pieces;
	const seen = new Set(pieces);
	for (const piece of grokReading(spaced)) {
		if (seen.has(piece)) continue;
		seen.add(piece);
		pieces.push(piece);
	}
	return pieces;
}

/** The pieces of one reading of a word (grokPieces), its expansions already \0. */
function grokReading(bare: string): string[] {
	const pieces: string[] = [];
	for (const piece of bare.replace(/\\([^])|["']/g, "$1").split(/\s+/)) {
		const open = piece.indexOf("{");
		const close = piece.lastIndexOf("}");
		const braced = open !== -1 && close > open && /,|\.\./.test(piece.slice(open, close)) ? `${piece.slice(0, open)}*${piece.slice(close + 1)}` : piece;
		for (const part of braced.match(GROK_PART) ?? []) if (!/^\0*$/.test(part)) pieces.push(part.replace(/\0+/g, "*"));
	}
	return pieces;
}

/**
 * Whether a word of Grok's (grokWords) is built at run time so it may be any of Grok's commands: it holds an expansion
 * or a substitution outside quotes ($C, ${C}, $(…), `…`, $$, dis$X; a glued part is read as a glob too: grokPieces), or
 * in double quotes with no other text but blanks ("$C", "$A $B"). A quoted $(…), ${…} or `…` runs to the word's last ),
 * } or ` (quotes and groups nest inside it), so none of its text counts as other text. $'…' and $"…" are quotes; an
 * escaped backquote is a backquote (it nests one in backquotes).
 */
function builtAtRunTime(word: string): boolean {
	let quoted = false;
	let text = false;
	let double = false;
	for (let i = 0; i < word.length; i++) {
		const c = word.charAt(i);
		if (c === "'" && !double) {
			const close = word.indexOf("'", i + 1);
			const end = close === -1 ? word.length : close;
			text ||= /\S/.test(word.slice(i + 1, end));
			i = end;
		} else if (c === '"') double = !double;
		else if (c === "\\") {
			// An escaped backquote is a substitution's in backquotes (`grok \`cat x\``): read as one.
			if (word.charAt(i + 1) !== "`") text ||= !blank(word.charAt(++i));
		} else if (c === "$" && !double && (word.charAt(i + 1) === "'" || word.charAt(i + 1) === '"')) continue;
		else if (c === "$" || c === "`") {
			if (!double) return true;
			quoted = true;
			const close = c === "`" ? "`" : word.charAt(i + 1) === "(" ? ")" : word.charAt(i + 1) === "{" ? "}" : undefined;
			if (close !== undefined) {
				const end = word.lastIndexOf(close);
				i = end > i ? end : word.length;
			} else {
				EXPANSION_AT.lastIndex = i;
				if (EXPANSION_AT.test(word)) i = EXPANSION_AT.lastIndex - 1;
			}
		} else text ||= !blank(c);
	}
	return quoted && !text;
}

/** What one word of Grok's (grokPieces) names that shell text may not give it, by the name it reads as, if any. */
function refusedPiece(piece: string): { readonly name: string; readonly why: GrokCommand["why"] } | undefined {
	if (!optionWord(piece)) {
		const name = namedBy(piece, GROK_REFUSED)[0];
		return name === undefined ? undefined : { name, why: "command" };
	}
	const option = piece.split("=")[0] as string;
	const name = namedBy(option, GROK_OPTION_NAMES)[0];
	if (name !== undefined) return { name, why: GROK_OPTIONS.get(name) as GrokCommand["why"] };
	// A cluster of short options (-vc): one that picks a session, before a valued one, whose value is the rest.
	if (option.startsWith("--")) return undefined;
	for (const letter of option.slice(1)) {
		if ("rcs".includes(letter)) return { name: `-${letter}`, why: "opens" };
		if ("mpw".includes(letter)) break;
	}
	return undefined;
}

/**
 * Whether Grok's words only ask for a command's help, each of them as written: grok <its commands> --help, or grok <its
 * commands> help <names>. -h doesn't count: the readings are lower case, and mcp add's -H is a header.
 */
function asksHelp(words: readonly string[]): boolean {
	let path = "";
	for (const [at, word] of words.entries()) {
		if (word === "--help") return at === words.length - 1;
		if (GROK_SUBCOMMANDS.get(path)?.includes(word) !== true) return false;
		if (word === "help") return words.slice(at + 1).every((name) => GROK_NAMES.has(name));
		path = `${path} ${word}`.trim();
	}
	return false;
}

/**
 * What Grok's `words` (grokWords) give it that shell text may not (above), or undefined: a command named with the
 * line's words that name Grok's commands, and one a glob could name (what is read as a glob: above) or a word built at
 * run time (builtAtRunTime) as written, when no word names one plainly. `prompts`: Grok's program runs as the command,
 * so a word that is one quoted string holding a blank is its prompt, but one with a substitution or a ${…} in it or a
 * "-" first.
 */
function grokRefused(words: readonly string[], prompts: boolean): GrokCommand | undefined {
	if (asksHelp(words)) return undefined;
	const names: string[] = [];
	let found: ReturnType<typeof refusedPiece>;
	let glob: string | undefined;
	let built: string | undefined;
	for (const word of words) {
		if (builtAtRunTime(word)) built ??= word;
		else if (prompts && QUOTED.test(word) && /\s/.test(word) && !/\$[({]|`/.test(word) && word.charAt(1) !== "-") continue;
		for (const piece of grokPieces(word)) {
			if (GROK_NAMES.has(piece)) names.push(piece);
			const hit = refusedPiece(piece);
			if (hit?.why === "command" && GLOB.test(piece) && !optionWord(piece)) glob ??= word;
			else found ??= hit;
		}
	}
	if (found !== undefined && found.why !== "command") return { command: `grok ${found.name}`, why: found.why };
	const name = found?.name ?? glob ?? built;
	if (name === undefined) return undefined;
	return { command: `grok ${[...names, ...(names.includes(name) ? [] : [name])].join(" ")}`, why: name === built ? "built" : "command" };
}

/**
 * Where a reading's command from `from` only names Grok's program: its program's end when it never runs its arguments
 * (READS_ONLY), nor does any its output is piped into (echo grok update | sh; a stage may start on the next line, so
 * each ends at the first separator past its program), and no tangle (separatorsOf) stands before that pipeline's end;
 * else -1. Reading costs `work`.
 */
function namesOnly(form: string, from: number, separators: readonly number[], tangle: number, work: { left: number }): number {
	let end = -1;
	for (let at = from; ; at++) {
		READS_ONLY.lastIndex = at;
		if (!READS_ONLY.test(form)) return -1;
		const stop = separators[firstFrom(separators, READS_ONLY.lastIndex)] ?? form.length;
		work.left -= stop - at + 1;
		if (tangle < stop || work.left < 0) return -1;
		if (end === -1) end = READS_ONLY.lastIndex;
		if (form.charAt(stop) !== "|" || form.charAt(stop + 1) === "|") return end;
		at = stop;
	}
}

/**
 * The Grok command a reading runs that shell text may not (above), or undefined. `prompts`: the reading keeps the
 * text's quotes, so a quoted prompt is one word. `whole`: the reading is the whole text, not a piece of it
 * (Reading.pieces), so where the program is only named can be told. Each program named is read on its own; past
 * reading four times the text's length in all, the text is refused, so it stays linear.
 */
function grokCommandIn(form: string, prompts: boolean, whole: boolean): GrokCommand | undefined {
	if (!/g\W*r\W*o\W*k/.test(form)) return undefined;
	let separators: number[] | undefined;
	const tangle = { at: Number.POSITIVE_INFINITY };
	let named = false;
	const work = { left: 4 * form.length + 4096 };
	// namesOnly's answer from a command's start, the last one read: the programs named in one command share it.
	let only = { from: -1, end: -1 };
	for (const match of form.matchAll(GROK_RUN)) {
		const name = match[1] as string;
		const start = match.index + match[0].length - name.length;
		separators ??= separatorsOf(form, tangle);
		const from = (separators[firstFrom(separators, start) - 1] ?? -1) + 1;
		if (whole && only.from !== from) only = { from, end: namesOnly(form, from, separators, tangle.at, work) };
		if (only.end !== -1 && only.end <= start) continue;
		// Backquotes the program surely runs in: the text's first tangle, and nothing of one between it and the program.
		const closes = tangle.at < start && form.charAt(tangle.at) === "`" && start - tangle.at <= LOOK_BACK && !/[`#(){]|<</.test(form.slice(tangle.at + 1, start));
		const found = grokWords(form, start + name.length, closes);
		if (found === undefined) continue;
		named = true;
		work.left -= found.end - start;
		if (work.left < 0) return { command: "grok", why: "command" };
		const runs = prompts && /^grok(?:-[a-z]+-[a-z0-9_]+)?$/.test(name) && wordEnds(form.charAt(start + name.length)) && start - from <= LOOK_BACK && RUNS_AS_COMMAND.test(form.slice(from, start));
		const refused = grokRefused(found.words, runs);
		if (refused !== undefined) return refused;
	}
	const fed = named && XARGS.test(form) ? GROK_FED.exec(form)?.[1] : undefined;
	return fed === undefined ? undefined : { command: `grok ${fed}`, why: GROK_OPTIONS.get(fed) ?? "command" };
}

/** The read-only commands of Grok's that run from a session's shell (GROK_READS), as the refusal names them. */
const GROK_CLI_READS_NAMED =
	"grok help, version, models, inspect, completions, usage, du, mcp list, plugin list, details and validate, plugin marketplace list, sessions list and search, worktree list and show, and a command's help (grok <command> --help, grok help <command>)";
/** How each refusal ends: where to run it, and that text naming it is refused too. */
const GROK_RUN_IT = "Run it in your own terminal. Text that names it is refused too, but as the words of a program that never runs them (echo, printf, cat, ls, head, tail, wc, grep, jq, git commit, log, show, diff, status, add or tag, gh pr, issue, release, search or api) with no assignment before it and no substitution, comment, here-document, parenthesis or brace before its end: give git a message that names it from a file (git commit -F).";

/** Why shell text that runs one of them is refused (grokCommandIn), in any session. */
export const GROK_CLI_REFUSED = ({ command, why }: GrokCommand) =>
	why === "opens"
		? `${command} can't run from a session's shell: it opens a Grok session by its id or the latest one, which may be live in another Grok (an agent's among them), and a second Grok writing a live session's record stops Orrery recording that session. ${GROK_RUN_IT}`
		: why === "trust"
			? `${command} can't run from a session's shell: it trusts a folder for good, which changes Grok's own setup (its MCP servers, plugins, trusted folders, sign-in, managed config or saved sessions), which no session's tools may change. ${GROK_RUN_IT}`
			: why === "built"
				? `${command} can't run from a session's shell: a word built at run time may be any of Grok's commands, and only those that read run here (${GROK_CLI_READS_NAMED}). Write the word out, or quote it with other words (a prompt). ${GROK_RUN_IT}`
				: `${command} can't run from a session's shell: of Grok's own commands only those that read run here (${GROK_CLI_READS_NAMED}); the others change Grok's own setup (its MCP servers, plugins, trusted folders, sign-in, managed config, memory or saved sessions) or run Grok sessions outside Orrery's launch, which no session's tools may do. ${GROK_RUN_IT}`;

/** The Grok command shell text runs that it may not (grokCommandOf), as GROK_CLI_REFUSED names it, or undefined. */
export function runsGrokCommand(text: string): GrokCommand | undefined {
	return grokCommandOf(text, readings(text));
}

/**
 * grokCommandIn over shell text `text`, read as `reading`: as written, and with its $'…' decoded; with a brace group,
 * every reading of it (each brace alternative's reads the quotes away, so no prompt is quoted there), the text with
 * each group that is a word of its own read in place as its alternatives (BRACE_WORD: {grok,update} is grok update;
 * no prompt is quoted there either), and its pieces, where a program is never only named (a piece starts anywhere in a
 * command).
 */
export function grokCommandOf(text: string, reading: Reading): GrokCommand | undefined {
	const lower = text.toLowerCase();
	const braced = BRACE_ONE.test(lower);
	const decoded = /\$'[^']*\\/.test(text) ? [text.replace(ANSI_C, (_quoted, body: string) => ansiC(body)).toLowerCase()] : [];
	for (const form of braced ? reading.forms : [lower, ...decoded]) {
		const found = grokCommandIn(form, !braced, true);
		if (found !== undefined) return found;
	}
	const inPlace = lower.replace(BRACE_WORD, (_group, body: string) => body.replaceAll(",", " "));
	const found = inPlace === lower ? undefined : grokCommandIn(inPlace, false, true);
	if (found !== undefined) return found;
	for (const piece of braced ? reading.pieces : []) {
		const found = grokCommandIn(piece, false, false);
		if (found !== undefined) return found;
	}
	return undefined;
}

// ---- Grok Build's folder (spec 2026-10-29-grok-build-design, "Guard"), in every gate ----
//
// Grok 1.0.70 loads and runs much of what is in its folder ($GROK_HOME, else ~/.grok; its manual, 10-hooks.md,
// 16-subagents.md, 07-mcp-servers.md, 18-sandbox.md and 26-config-reference.md), so the folder is kept by default: no
// tool writes in it and no shell text names it, in an agent's session and in one that is no agent's, but its open parts
// (GROK_OPEN), which Grok's own features write to or run from only through calls the guard sees: its memory
// (memory-v2/, which Grok's "forget" edits), its skills (prompts: Grok runs no command written in one) and its
// workflows (whose agents' calls come to the guard), and where its bundled skills keep their files: /learn's runs and
// state (learn/), the background-task skill's logs and watchers (long-running-background-tasks/), plugins' data
// (plugin-data/, pr-babysit's state among it), /implement's notes (implement-memory/, which its helper writes and reads
// back into prompts), the bundled skills themselves (bundled/skills/, whose scripts a call runs), Grok's docs and
// logs, which it writes and loads nothing from, and its session worktrees (worktrees/, the person's checkouts, which
// its model works in as in any project). What it loads is why, and a file a later Grok adds that runs code is
// kept the same way. For example: every hooks/*.json is a hook file (Orrery's hooks/orrery.json among them);
// config.toml holds hooks, MCP servers and the status row (Orrery's entries among them); requirements.toml and
// managed_config.toml hold hooks and a pin that switches every other hook off; disabled-hooks is the /hooks tab's
// switch; trusted_folders.toml is the trust without which a folder holds back the person's own hooks, Orrery's among
// them; installed-plugins/ and plugins/ carry hooks and MCP servers; an agent definition in agents/ carries hooks and
// MCP servers in its front matter, which win over config.toml's by name; the rest of bundled/ loads as Grok's own
// agents (whose hooks it runs) and workflows; lsp.json names the language servers Grok starts, outside the guard, in
// every later session, every agent's among them; and its session records (sessions/) are what Orrery checks typed
// prompts against. A file a tool wrote in any of these could switch Orrery's guard or recording off, run code outside
// the guard, or put words in a session's record. Nor may shell text name the folder itself (a copy, an archive or a cd
// into it reaches all of it), nor name an open part and, in the same text, change folder (cd, pushd, git -C and the
// like; but where the text names the session worktrees alone, which the model works in, one into a worktree: a plain
// path at least worktrees/<repo> deep), hold a ".." path part (but one in the open part's own path that stays in it, as
// a bundled skill names the helper beside it: bundled/skills/<name>/../shared/) or make a link (ln, cp -s, cp -l): a
// relative path read from the open part, or a link made there, could reach the rest. An open part's path in a command
// substitution ($(…) or `…`), or followed by its close, counts as the rest (the shell may make another path of it:
// $(dirname <home>/skills)/hooks); read failing closed, so does one after any substitution's opening ($(, a backquote,
// bash's ${ …; }) or in text whose parentheses don't pair up (a quoted ")" or a case pattern's closes none). Where the
// call runs in the folder (a grok -w session in its worktree), a relative path with a ".." is read from there: refused
// unless it stays in the open part it runs in; where it runs in the folder itself or what it loads, every relative path
// is, as if the text named it (a bare word by the entries there), and a substitution or a ${ is refused there (its path
// may be any); where it runs above or beside the folder, the folder spelt from there (.grok from home, ../.grok beside
// it) is read as its path. Where a link takes an entry out of the folder (a config.toml kept in a dotfiles folder), it
// is kept where it really is too; an open part a link takes to the folder itself, to a folder that holds it, or into
// the rest of it (skills/ linked to hooks/), or a link that leads nowhere, is kept as the rest is. One a link takes out
// of the folder (skills/ kept in a dotfiles folder, as people do) stays open to file tools through the link, and where
// it really is is judged by the other rules, as any path is; shell text, which can't follow the link, may name it there
// only where it really is. File tools may read all of it, but an agent's session reads neither the session records nor
// Grok's login (HOME_SECRETS; a moved folder's by src/agent/guard-paths.ts). Limits: src/agent/guard-paths.ts, Known
// limits.

/** Grok's folders for `home` and `env`: ~/.grok, and the one GROK_HOME names (absolute, as given; realTarget is the caller's). */
export function grokFolders(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
	const folders = new Set([posix.join(home, ".grok")]);
	if (env.GROK_HOME) folders.add(posix.resolve(env.GROK_HOME));
	return [...folders].map((folder) => posix.normalize(folder));
}

/**
 * Grok's folder's open parts (above), each a path below the folder, folded: tools write there as anywhere. Of bundled/
 * only its skills: the rest of it loads as Grok's own agents, whose hooks Grok runs, and workflows (18-sandbox.md,
 * 15-agent-mode.md). implement-memory/ is the bundled implement skill's (its scripts/memory.py), under ~/.grok whatever
 * GROK_HOME says; Grok's manual names it nowhere and nothing loads it. worktrees/ is GROK_CHECKOUTS.
 */
export const GROK_OPEN: readonly string[] = ["memory-v2", "skills", "workflows", "learn", "long-running-background-tasks", "plugin-data", "implement-memory", "bundled/skills", "docs", "logs", "worktrees"];

/**
 * The open part that holds Grok's session worktrees (worktrees/<repo>/<name>: grok -w, grok worktree create, a
 * subagent's or workflow step's worktree isolation; 17-sessions.md, 18-sandbox.md), the person's checkouts, which
 * Grok's model works in as in any project: a folder change into one of them goes through (grokReaches). A checkout's
 * own .grok, .claude and .cursor folders are its project's (Known limits). Grok keeps its worktree state beside it, not
 * in it (its registry, the open sessions list, worktree_pool/), so that stays kept.
 */
const GROK_CHECKOUTS = "worktrees";

/** The open part (but those `shut` names) the parts of a path below one of Grok's folders (folded) are in, or none. */
function grokOpenIn(parts: readonly string[], shut: readonly string[] = []): string | undefined {
	return GROK_OPEN.find((entry) => !shut.includes(entry) && entry.split("/").every((name, at) => parts[at] === name));
}

/** What the Grok rule judges against: Grok's folders, and its entries a link takes elsewhere, folded. */
export interface GrokRule {
	/** Grok's folders, as given and where they really are. */
	readonly own: readonly string[];
	/** Each of `own` under home as shell text may spell it from there ("~", "$HOME", "${HOME}"). */
	readonly spelled: readonly string[];
	/**
	 * Where an entry of Grok's folders but its open parts really is when a link takes it out of the rest (a config.toml
	 * in a dotfiles folder), and each as shell text may spell it from home; none when none is.
	 */
	readonly linked?: readonly string[];
	/**
	 * The open parts (of GROK_OPEN) kept as the rest is in each of Grok's folders: those a link takes to one of Grok's
	 * folders, a folder that holds one, or the rest of one (skills/ linked to hooks/ or to home), and a link that leads
	 * nowhere (one that comes back to itself); none when none is. One a link takes out of Grok's folders stays open to
	 * file tools (away).
	 */
	readonly shut?: readonly string[];
	/**
	 * The open parts (of GROK_OPEN) a link takes out of Grok's folders (skills/ kept in a dotfiles folder): open to file
	 * tools, which follow the link and judge where it leads, but kept from shell text, which can't follow it, as the rest
	 * is (grokPaths); none when none is.
	 */
	readonly away?: readonly string[];
	/**
	 * The names of a folder's entries (the folder as a call gives its cwd), or undefined when it can't be listed: the
	 * caller's (these rules read no files), for a bare word run in Grok's folder itself or in what it loads
	 * (grokNamedFrom). Without it, every bare word there is judged.
	 */
	readonly names?: (folder: string) => readonly string[] | undefined;
}

/** A path as the Grok rule folds one: normalized, lower case, with no "/" at its end (but the root's). */
const grokFold = (path: string) => posix.normalize(path).toLowerCase().replace(/(.)\/+$/, "$1");

/**
 * The rule for `home` and `env`. `real` follows links (realTarget), so a folder reached through one counts, and an open
 * part that is a link is kept when it leads to Grok's folder, to a folder holding it, into the rest of it, or nowhere,
 * and from shell text when it leads out of Grok's folders; `links` names the entries of a folder that are links (the
 * caller's: these rules read no files), so an entry a link takes out of the folder counts where it really is too, and
 * an open part that is a link but is still where it stands once followed leads nowhere. Without them no link is
 * followed. `names` lists a folder (GrokRule.names).
 */
export function grokRule(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), real: (path: string) => string = (path) => path, links: (folder: string) => readonly string[] = () => [], names?: (folder: string) => readonly string[] | undefined): GrokRule {
	const folders = grokFolders(env, home);
	const own = [...new Set(folders.flatMap((path) => [path, real(path)]).map(grokFold))];
	const homes = [home, real(home)];
	// The entries of each folder that are links, listed once; and where each open part of each folder really is.
	const linking = new Map(folders.map((folder) => [folder, links(folder)] as const));
	const reached = GROK_OPEN.map((entry) => ({ entry, places: folders.map((folder) => ({ folder, at: grokFold(real(posix.join(folder, entry))) })) }));
	const shut = reached
		.filter(({ entry, places }) =>
			places.some(({ folder, at }) => {
				const nowhere = (linking.get(folder) ?? []).some((name) => name.toLowerCase() === entry) && within(at, grokFold(posix.join(real(folder), entry)));
				return nowhere || own.some((root) => within(root, at)) || grokKept(at, own);
			}),
		)
		.map(({ entry }) => entry);
	const away = reached.filter(({ entry, places }) => !shut.includes(entry) && places.some(({ at }) => !own.some((root) => within(at, root)))).map(({ entry }) => entry);
	const entries = new Set([...linking].flatMap(([folder, named]) => named.filter((name) => !GROK_OPEN.includes(name.toLowerCase())).map((name) => grokFold(real(posix.join(folder, name))))));
	const linked = [...entries].filter((entry) => !grokKept(entry, own, shut));
	return {
		own,
		spelled: spelledFromHome(own, homes),
		...(linked.length === 0 ? {} : { linked: [...linked, ...spelledFromHome(linked, homes)] }),
		...(shut.length === 0 ? {} : { shut }),
		...(away.length === 0 ? {} : { away }),
		...(names === undefined ? {} : { names }),
	};
}

/** The open parts shell text may not name as open: those kept (GrokRule.shut) and those a link takes away (away). */
const shellShut = (rule: GrokRule): readonly string[] => [...(rule.shut ?? []), ...(rule.away ?? [])];

/** Whether a folded path is one of `own` (Grok's folders) or in one but its open parts (those `shut` names kept). */
function grokKept(folded: string, own: readonly string[], shut?: readonly string[]): boolean {
	return own.some((root) => within(folded, root) && grokOpenIn(folded.slice(posix.normalize(root).replace(/\/+$/, "").length + 1).split("/"), shut) === undefined);
}

/**
 * Whether an absolute path is Grok's folder or in it but its open parts, or in an entry a link takes elsewhere (above):
 * one spelling, folded here.
 */
export function grokLoads(path: string, rule: GrokRule): boolean {
	const folded = posix.normalize(path).toLowerCase();
	return (rule.linked ?? []).some((entry) => posix.isAbsolute(entry) && within(folded, entry)) || grokKept(folded, rule.own, rule.shut);
}

/**
 * Whether a folder (absolute) is in what grokLoads keeps, or holds Grok's folder or an entry a link takes elsewhere:
 * for edits no argument names (an OMP language server's).
 */
export function grokNear(path: string, rule: GrokRule): boolean {
	const folded = posix.normalize(path).toLowerCase();
	return grokLoads(folded, rule) || [...rule.own, ...(rule.linked ?? [])].some((place) => posix.isAbsolute(place) && within(place, folded));
}

/** Why a write there is refused. */
export const GROK_READ_ONLY = (path: string) =>
	`${path} is in Grok's folder, outside the parts its own features write (its memory, skills, workflows, docs, logs and the like), where Grok keeps what it loads and runs (its hooks, settings, plugins and agents): agents may read it, not change it.`;

/** Why shell text naming any of it, or Grok's folder itself, is refused. */
export const GROK_COMMAND =
	"This command names Grok's folder or what Grok loads and runs in it (~/.grok, all but the parts its own features write, such as its memory, skills, workflows, docs and logs: its hooks, settings, plugins and agents among it): agents may read those with file tools, not with commands.";

/** GROK_READ_ONLY and GROK_COMMAND worded for any session (GuardOptions.orreryOnly). */
export const GROK_READ_ONLY_PLAIN = (path: string) =>
	`${path} is in Grok's folder, outside the parts its own features write (its memory, skills, workflows, docs, logs and the like), where Grok keeps what it loads and runs (its hooks, settings, plugins and agents): it may be read, not changed.`;
export const GROK_COMMAND_PLAIN =
	"This command names Grok's folder or what Grok loads and runs in it (~/.grok, all but the parts its own features write, such as its memory, skills, workflows, docs and logs: its hooks, settings, plugins and agents among it): they may be read with file tools, not with commands.";

/** Why shell text naming an open part and changing folder, holding a ".." or making a link is refused (any session). */
export const GROK_REACH =
	"This command names a part of Grok's folder its own features write (~/.grok's memory, skills, workflows and the like) and also changes folder (cd, pushd, git -C and the like), has a .. path part, or makes a link (ln, cp -s, cp -l), any of which could reach the rest of Grok's folder (its hooks, settings, plugins and agents): name each path there in full from Grok's folder, without .., and make no link there.";

/** Why shell text run in Grok's folder with a ".." that leaves the part it runs in is refused (any session). */
export const GROK_CLIMB =
	"This command runs in Grok's folder (~/.grok: a skill's folder, a session worktree or the like) and has a relative path whose .. leads out of the part it runs in, which could reach the rest of Grok's folder (its hooks, settings, plugins and agents): name that path in full, with no .. in it.";

/** $GROK_HOME in shell text (readings are lower case), as a word: whatever the session's environment holds, it is Grok's folder. */
const GROK_HOME_VARIABLE = /\$(?:grok_home(?![a-z0-9_])|\{grok_home[^}\s$]*\})/g;

/** The path after one of Grok's folders in a reading: up to where a shell word, or a list in one, ends. */
const GROK_REST = /[^\s;|&()<>,}:]*/y;

/**
 * The shell's own process number, $$ unescaped: a shell reads it before anything that follows (bash's "$$x" is the
 * number, then x), and it is digits, so it can't lead out of a folder (Grok's background-task skill keys its logs on
 * it).
 */
const SHELL_PID = /(?<!\\)\$\$/g;

/** A path a reading names in Grok's folder (grokPathAfter): where it starts (its folder's spelling) and ends. */
interface GrokPath {
	readonly start: number;
	readonly end: number;
	/** It names the folder itself or any of it but its open parts. */
	readonly kept: boolean;
	/** A ".." in it climbs above the open part it ends in (workflows/../skills): a link there could take it anywhere. */
	readonly climbs: boolean;
	/** The open part (of GROK_OPEN) it ends in; none when it is kept. */
	readonly part?: string;
}

/** Whether a path part is ".." or a glob that could match it (only one that starts with "." can). */
const climbing = (part: string) => part === ".." || (part.startsWith(".") && globCouldName(part, [".."]) !== undefined);

/**
 * The path after one of Grok's folders in a reading, its spelling from `start` to `at`: kept when it names any of the
 * folder but its open parts (GROK_OPEN, but those `shut` names): nothing after it but "/" (the folder itself: a copy,
 * an archive or a cd reaches all of it), or parts, once "." and ".." are walked, in none of them (grokWalk). One that
 * may be in a command substitution (`nested`: inSubstitution), or followed by ")" (a backquote is in the path, which
 * grokWalk reads), is a command's word whose output the shell may make another path of
 * ($(dirname <home>/skills)/hooks): it counts, as a variable after it does.
 */
function grokPathAfter(form: string, start: number, at: number, shut: readonly string[], nested: boolean): GrokPath {
	GROK_REST.lastIndex = at;
	const end = at + (GROK_REST.exec(form)?.[0].length ?? 0);
	if (nested || form.charAt(end) === ")") return { start, end, kept: true, climbs: false };
	return { start, end, ...grokWalk(form.slice(at, end), shut) };
}

/**
 * A path below one of Grok's folders (`rest`, its parts after the folder) walked as the shell walks it: kept when it is
 * the folder itself or in none of its open parts (but those `shut` names; a glob is in none: it could match another). A
 * variable or substitution in it but $$ (SHELL_PID), a ".." that climbs out of the folder, and a glob that could match
 * ".." could come back to the rest: they count.
 */
function grokWalk(rest: string, shut: readonly string[]): Omit<GrokPath, "start" | "end"> {
	const text = rest.replace(SHELL_PID, "0").replace(/["'\\]/g, "");
	const kept = { kept: true, climbs: false };
	if (/[$`]/.test(text)) return kept;
	const parts: string[] = [];
	let low = Number.POSITIVE_INFINITY;
	for (const part of text.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.pop() === undefined) return kept;
			low = Math.min(low, parts.length);
		} else if (climbing(part)) return kept;
		else parts.push(part);
	}
	const open = grokOpenIn(parts, shut);
	return open === undefined ? kept : { kept: false, climbs: low < open.split("/").length, part: open };
}

/** Where a command substitution may open: $( (arithmetic's $(( too), a backquote, bash's ${ …; } and ${| …; } (5.3). */
const SUBSTITUTION_OPENS = /\$\(|`|\$\{[\s|]/;

/**
 * For each of `starts` (places in a reading), whether it may sit in a command substitution, read failing closed: a
 * count can't tell a quoted ")" or a case pattern's from a close, so a substitution's opening anywhere before it (one
 * escaped or quoted too), or a reading whose "(" and ")" differ in number, counts.
 */
function inSubstitution(form: string, starts: readonly number[]): boolean[] {
	const unpaired = form.split("(").length !== form.split(")").length;
	const first = form.search(SUBSTITUTION_OPENS);
	return starts.map((start) => unpaired || (first !== -1 && first < start));
}

/**
 * Each path a reading names in Grok's folder: after $GROK_HOME, or one of `rule`'s folders by its path (not a longer
 * name beside it). Shell text can't follow a link, so an open part a link takes out of Grok's folders is kept from it
 * as the rest is (GrokRule.away): a link to a guarded place would reach it.
 */
function grokPaths(form: string, rule: GrokRule): GrokPath[] {
	const spots: (readonly [number, number])[] = [...form.matchAll(GROK_HOME_VARIABLE)].map((variable) => [variable.index, variable.index + variable[0].length] as const);
	for (const root of [...rule.own, ...rule.spelled]) {
		for (let at = form.indexOf(root); at !== -1; at = form.indexOf(root, at + 1)) {
			if (!NAME_GOES_ON.test(form.charAt(at + root.length))) spots.push([at, at + root.length]);
		}
	}
	if (spots.length === 0) return [];
	const shut = shellShut(rule);
	const nested = inSubstitution(form, spots.map(([start]) => start));
	return spots.map(([start, at], index) => grokPathAfter(form, start, at, shut, nested[index] === true));
}

/**
 * Whether a reading of shell text names Grok's folder itself or any of it but its open parts (grokPaths), or an entry a
 * link takes elsewhere by its path.
 */
export function grokNamed(form: string, rule: GrokRule): boolean {
	return (rule.linked !== undefined && namesFolder(form, rule.linked)) || grokPaths(form, rule).some((path) => path.kept);
}

/** What changes a shell's folder as a word: cd, pushd, and git's options for its folders (readings are lower case). */
const MOVES = /^(?:cd|pushd|--git-dir(?:=.*)?|--work-tree(?:=.*)?)$/;

/**
 * The folder a word in a command of `tool` gives its folder option (FOLDER_OPTIONS): glued to it (with "=" after a long
 * one), or `next` (the word after it) when it is the option alone; undefined when it is no folder option.
 */
function folderValue(tool: string, word: string, next: () => string): string | undefined {
	for (const option of FOLDER_OPTIONS.get(tool) ?? []) {
		if (word === option) return next();
		const glued = option.startsWith("--") ? `${option}=` : option;
		if (word.startsWith(glued)) return word.slice(glued.length);
	}
	return undefined;
}

/** Between two words of a reading, where a command ends: ;, a pipe, &, a parenthesis, a newline or a backquote. */
const COMMAND_GAP = /[;|&()\n`]/;

/**
 * Whether a word of a reading (its quotes read away) is a plain path in Grok's session worktrees (GROK_CHECKOUTS): one
 * of Grok's folders (by its path, from home, or $GROK_HOME), then worktrees/<repo> or below, with nothing after the
 * folder the shell reads otherwise (a variable, substitution, glob, brace, escape, "~" or "..").
 */
function grokCheckout(word: string, rule: GrokRule): boolean {
	const path = word.replace(/["']/g, "");
	return [...rule.own, ...rule.spelled, "$grok_home", "${grok_home}"].some((root) => {
		if (!path.startsWith(`${root}/`)) return false;
		const rest = path.slice(root.length);
		const parts = rest.split("/").filter((part) => part !== "" && part !== ".");
		return [...rest].every((c) => PLAIN.test(c)) && !parts.includes("..") && parts.length >= 2 && grokWalk(rest, shellShut(rule)).part === GROK_CHECKOUTS;
	});
}

/**
 * Whether a reading changes folder anywhere but into one of Grok's session worktrees (grokCheckout), or with `none`
 * (it names another open part) anywhere: cd or pushd with no word, another or a second one (cd, cd -, cd ~, pushd +1,
 * zsh's cd old new), popd with any, or with no pushd before it to undo (a shell that persists keeps an older stack),
 * git's --git-dir or --work-tree, or a tool's folder option (git -C, make -C, npm --prefix …) with any other folder;
 * git's -c with a name=value is its setting (readings are lower case). Words are read bluntly, as grokReaches reads
 * them; a redirection's file, a file descriptor's number before one and a comment are no command's words.
 */
function grokLeavesCheckouts(form: string, rule: GrokRule, none: boolean): boolean {
	const words = [...form.matchAll(WORD)];
	// The first `most` words after words[at] in its command, up to where it ends or a comment starts.
	const after = (at: number, most: number): string[] => {
		const found: string[] = [];
		let end = (words[at]?.index ?? 0) + (words[at]?.[0].length ?? 0);
		for (let next = at + 1; next < words.length && found.length < most; next++) {
			const word = words[next];
			if (word === undefined) break;
			const gap = form.slice(end, word.index);
			end = word.index + word[0].length;
			if (COMMAND_GAP.test(gap) || word[0].startsWith("#")) break;
			const descriptor = /^\d+$/.test(word[0]) && /[<>]/.test(form.charAt(end));
			if (!/[<>]/.test(gap) && !descriptor) found.push(word[0]);
		}
		return found;
	};
	const into = (word: string | undefined) => !none && word !== undefined && grokCheckout(word, rule);
	const tools = new Set<string>();
	let last = 0;
	// The pushes into a worktree earlier in the text a bare popd may undo.
	let pushed = 0;
	for (const [at, match] of words.entries()) {
		const word = match[0].replace(/["']/g, "");
		if (COMMAND_GAP.test(form.slice(last, match.index))) tools.clear();
		last = match.index + match[0].length;
		const name = word.slice(word.lastIndexOf("/") + 1);
		if (word === "cd" || word === "pushd") {
			const given = after(at, 2);
			if (given.length !== 1 || !into(given[0])) return true;
			if (word === "pushd") pushed++;
		} else if (word === "popd") {
			if (after(at, 1).length > 0 || pushed-- === 0) return true;
		} else if (MOVES.test(word)) {
			if (!into(word.includes("=") ? word.slice(word.indexOf("=") + 1) : after(at, 1)[0])) return true;
		} else if (FOLDER_OPTIONS.has(name)) tools.add(name);
		else {
			for (const tool of tools) {
				const folder = folderValue(tool, word, () => after(at, 1)[0] ?? "");
				if (folder !== undefined && !(tool === "git" && folder.includes("=")) && !into(folder)) return true;
			}
		}
	}
	return false;
}

/**
 * Whether a word in a cp command makes it make links: -s or -l (alone or among short options), --symbolic-link or
 * --link (or a GNU abbreviation of either). Readings are lower case, so -S and -L count too.
 */
const copiesAsLink = (word: string) => /^-[a-z]*[sl][a-z]*$/.test(word) || (word.length >= 4 && "--symbolic-link".startsWith(word)) || (word.length >= 3 && "--link".startsWith(word));

/**
 * Whether a reading that names an open part of Grok's folder (and nothing grokNamed refuses) could reach the rest from
 * there: a path in it climbs above the open part it ends in, or the text changes folder (grokLeavesCheckouts: cd,
 * pushd, popd, git's folder options, a tool's own folder option in a command of that tool, FOLDER_OPTIONS: git -C,
 * make -C, npm --prefix …), so a relative path may be read from the open part; or the rest of the text (its words, at
 * blanks, quotes and operators, those paths left out) has a ".." path part (or a glob that could match one) anywhere,
 * or makes a link (ln; cp -s, -l and their long names), which could lead an open part into the rest. Words are read
 * bluntly, as the other shell rules read them: cd, pushd or ln anywhere counts. A ".." in an open part's own path that
 * stays in it (a bundled skill's bundled/skills/<name>/../shared/scripts/host.py) adds nothing a planted link wouldn't:
 * it goes through. When every path it names is in GROK_CHECKOUTS (the session worktrees Grok's model works in), a
 * folder change into one of them goes through and any other is refused: from a worktree a relative path reaches the
 * rest only through a "..", or a link, which stay refused.
 */
export function grokReaches(form: string, rule: GrokRule): boolean {
	const paths = grokPaths(form, rule).sort((a, b) => a.start - b.start);
	if (paths.length === 0) return false;
	if (paths.some((path) => path.climbs)) return true;
	let rest = "";
	let from = 0;
	for (const { start, end } of paths) {
		rest += `${form.slice(from, Math.max(from, start))} `;
		from = Math.max(from, end);
	}
	rest += form.slice(from);
	let copies = false;
	let last = 0;
	for (const match of rest.matchAll(GLOB_WORDS)) {
		const word = match[0];
		// A command ends at ;, a pipe, &, a parenthesis, a newline or a backquote between its words.
		if (COMMAND_GAP.test(rest.slice(last, match.index))) copies = false;
		last = match.index + word.length;
		const name = word.slice(word.lastIndexOf("/") + 1);
		if (name === "ln" || word.split(/[/=:,{}]/).some(climbing) || (copies && copiesAsLink(word))) return true;
		copies ||= name === "cp";
	}
	return grokLeavesCheckouts(form, rule, paths.some((path) => path.part !== GROK_CHECKOUTS));
}

/** $PWD, ${PWD} or ~+ starting a word (readings are lower case): the folder the call runs in, as the shell has it. */
const RUNS_HERE = /^(?:\$pwd(?![a-z0-9_])|\$\{pwd\}|~\+)(?=\/|$)/;

/** The longest name a file may have (NAME_MAX on Linux and macOS): a longer one names no file. */
const NAME_MOST = 255;

/**
 * Whether `judge` refuses a relative path a reading of shell text gives, read as the shell reads it from the call's
 * folder: each word (and each part of one after "=", ":" or ","), $PWD, ${PWD} or ~+ at its start read as "."; one
 * that starts with a single "-" as each value its option letters may glue to it (-vohooks/x: vohooks/x, ohooks/x,
 * hooks/x …), leaving out those between the first and the last whose first part is longer than NAME_MOST (the judges
 * give such a part, a glob one too, the same verdict as the longer suffix that holds it, slice(1)'s); and one with a
 * "/" as written too, one that starts with "-" or "--" among them (cat -- -/x, echo x > --t/x); absolute ones, "~",
 * "$" and a long option with no "/" left out. `written`: an output redirection writes it (>, >>, >|, &>, or >& but to
 * a descriptor's number or -).
 */
function grokWordsFrom(form: string, judge: (path: string, written: boolean) => boolean): boolean {
	let last = 0;
	for (const match of form.matchAll(GLOB_WORDS)) {
		const gap = form.slice(last, match.index).replace(/["']/g, "");
		const written = />\|?\s*$/.test(gap) || (/>&\s*$/.test(gap) && !/^(?:\d+-?|-)$/.test(match[0]));
		last = match.index + match[0].length;
		for (const piece of match[0].split(/[=:,]/)) {
			// A short option's "-" and letters, and where a value glued after them ends its first part.
			const letters = /^-(?!-)[a-z0-9]*/.exec(piece)?.[0].length ?? 0;
			const first = `${piece}/`.indexOf("/");
			// A piece with a "/" is a path as written as well, whatever it starts with.
			const whole = first < piece.length;
			for (let at = whole ? 0 : Math.min(letters, 1); at <= letters; at++) {
				const path = at > 1 && at < letters && first - at > NAME_MOST ? "" : piece.slice(at).replace(RUNS_HERE, ".");
				if (path !== "" && !/^[/~$]/.test(path) && (!path.startsWith("--") || (at === 0 && whole)) && judge(path, written)) return true;
			}
		}
	}
	return false;
}

/** The path below the one of Grok's folders `cwd` (a call's folder, as its hook gives it) is in; undefined in none. */
function grokBelow(rule: GrokRule, cwd: string): string | undefined {
	const here = grokFold(cwd);
	const root = rule.own.find((folder) => within(here, folder));
	return root === undefined ? undefined : here.slice(posix.normalize(root).replace(/\/+$/, "").length);
}

/**
 * Whether a reading of shell text run from `cwd` (the call's own folder, as its hook gives it), when that is in Grok's
 * folder, has a relative path with a ".." that leaves the open part `cwd` is in. Each path grokWordsFrom gives that
 * holds a ".." part (or a glob that could match one, read as "..") is read from `cwd` as grokWalk reads a path the text
 * names: it is refused when it lands in what Grok loads, in the folder itself, in another open part or out of the
 * folder, climbs above its open part on the way, or holds a variable or substitution (it may be anything). One that
 * stays in the open part goes through (cat ../README.md in a session worktree). A cd earlier in the text isn't
 * followed: each word is read from `cwd` (the general limit on a relative path).
 */
export function grokClimbsFrom(form: string, rule: GrokRule, cwd: string): boolean {
	const below = grokBelow(rule, cwd);
	if (below === undefined) return false;
	const shut = shellShut(rule);
	const { part } = grokWalk(below, shut);
	return grokWordsFrom(form, (path) => {
		const parts = path.split("/");
		if (!parts.some(climbing)) return false;
		const walked = grokWalk(`${below}/${parts.map((at) => (climbing(at) ? ".." : at)).join("/")}`, shut);
		return part === undefined || walked.kept || walked.climbs || walked.part !== part;
	});
}

/**
 * Whether a reading of shell text run from `cwd`, when that is Grok's folder itself or in what Grok loads (in none of
 * its open parts), names any of it but its open parts by a relative path with no ".." (grokClimbsFrom reads those), or
 * holds a command substitution or a ${ (its path may be any). Each path grokWordsFrom gives is read from `cwd` as if
 * the text named it there (grokWalk), so its open parts stay open (skills/x from Grok's folder). One with a "/", a "."
 * (a file's name, the folder itself) or a glob, or one an output redirection writes, is judged as a path; a bare word
 * (ls, x, hooks) only when it names an entry there (GrokRule.names; every one when that can't be listed): a word that
 * names nothing there goes through, and one that names an entry is refused even where it is no path (git commit -m
 * "fix hooks").
 */
export function grokNamedFrom(form: string, rule: GrokRule, cwd: string): boolean {
	const below = grokBelow(rule, cwd);
	// In an open part, one a link takes out of Grok's folders too: a path with no ".." stays where that really is.
	if (below === undefined || grokWalk(below, rule.shut ?? []).part !== undefined) return false;
	if (/\$[({]|`/.test(form)) return true;
	const shut = shellShut(rule);
	// The entries there, listed once: null until asked, undefined when they can't be.
	let listed: readonly string[] | null | undefined = null;
	const named = (word: string) => {
		if (listed === null) listed = rule.names?.(cwd)?.map((name) => name.toLowerCase());
		return listed === undefined || listed.includes(word);
	};
	return grokWordsFrom(form, (path, written) => {
		if (path.split("/").some(climbing) || (!written && !/[/.]/.test(path) && !GLOB.test(path) && !named(path))) return false;
		return grokWalk(`${below}/${path}`, shut).kept;
	});
}

/**
 * Each of `forms` (readings of shell text run from `cwd`) that spells one of Grok's folders from there (.grok or
 * ./.grok from home, ../.grok beside it, a moved one's path below `cwd`), with that spelling put as the folder's path,
 * so grokNamed and grokReaches judge it as named: as a word, a part of one after "=", ":" or ",", from $PWD or ~+, or a
 * short option's glued value (-t.grok/hooks), a glob right after it too (.grok*, which the shell may expand to it).
 * Not from a folder in Grok's (grokClimbsFrom and grokNamedFrom read those), nor by another spelling (../u/.grok from
 * home; the readings collapse a/../.grok). A project's own .grok is the project's.
 */
export function grokSpeltFrom(forms: readonly string[], rule: GrokRule, cwd: string): string[] {
	const here = grokFold(cwd);
	const spellings = rule.own
		.filter((folder) => !within(here, folder))
		.map((folder) => {
			const from = posix.relative(here, folder).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return [folder, new RegExp(`(^|[\\s"';|&()<>\`=:,])(-[a-z0-9]*)?(?:(?:\\.|\\$pwd|\\$\\{pwd\\}|~\\+)/+)*${from}(?=[/\\s"';|&()<>\`=:,}*?\\[]|$)`, "g")] as const;
		});
	return forms.flatMap((form) => {
		const spelt = spellings.reduce((text, [folder, spelling]) => text.replace(spelling, (_, edge: string, option = "") => `${edge}${option}${folder}`), form);
		return spelt === form ? [] : [spelt];
	});
}
