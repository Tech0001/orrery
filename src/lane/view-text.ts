/**
 * The memory section an agent reads (spec §4 "The view file"): how memory works, then the view. It comes in four
 * forms. pi appends it to the system prompt on every run; OMP gets pi's form with one more intro line naming
 * memory_search. Claude Code loads it once per session from
 * <workspace>/.orrery/view.md, which CLAUDE.md imports. There the view sits in a fenced block: Claude Code evaluates
 * no `@path` import inside a code block, and summaries quote such paths. The Orrery mod ("claude-mod") puts it in
 * Claude Code's system prompt, unfenced (a system-prompt section evaluates no import), and refreshes it at each
 * compaction.
 */

import { type MemoryView, VIEW_DOC } from "../memory/index.ts";

/** The agent holding a lane. */
export type Agent = "pi" | "omp" | "claude-code" | "claude-mod";

const PI_INTRO = `You keep no memory between turns. Each turn starts with the view below, followed by the user's new
message. Tool calls and their results are not kept in memory, only your replies, so say in your reply what you did and
learned that will matter later.`;

/** OMP: pi's intro, and the search tool's name there (OMP folds a tool named search into its own grep). */
const OMP_INTRO = `${PI_INTRO}
zoom, date and memory_search are the Orrery memory tools; where this section says search, call memory_search.`;

const CLAUDE_INTRO = `Earlier sessions reach you only through the view below, as it was when this session started; this
session's own messages you also see directly. Memory keeps the user's messages and your final reply of each turn, not
tool calls, their results or your other text, so say in your final reply what you did and learned that will matter
later. zoom, date and search are the Orrery memory tools.`;

const CLAUDE_MOD_INTRO = `Earlier conversation reaches you only through the view below. It is refreshed when this session starts and each
time the conversation is compacted; what was said since then you see directly. Memory keeps the user's messages
and your final reply of each turn, not tool calls, their results or your other text, so say in your final reply what
you did and learned that will matter later. zoom, date and search are the Orrery memory tools
(\`mcp__plugin_orrery_orrery__zoom\`, \`…__date\`, \`…__search\`); if they are not listed, load them with ToolSearch.`;

const RULES = `${VIEW_DOC}

search(query) finds messages anywhere in the full log by keywords (all must appear) or /regex/, newest first, even when
no summary mentions them; then read them with zoom(id, 1) or date(id).

A summary keeps conclusions, not the reasoning behind them. Before you rely on, repeat or change a past decision, open
the original messages with zoom or search and use their reasoning; never reconstruct it from a summary.

Memory is a dated record of what was said, not the current state of code, files or systems. When newer and older
messages disagree, the newer wins. For anything about current state, check the source (files, git, the running system)
before relying on memory; when memory and the source disagree, the source wins: say so in your reply, so the correction
becomes the newest word in memory.`;

/** The memory section for `agent`: how memory works, then the view (fenced for the Claude Code file, plain for the rest). */
export function memorySection(view: MemoryView, agent: Agent = "pi"): string {
	if (agent === "pi") return `# Memory\n\n${PI_INTRO}\n\n${RULES}\n\n${view.render()}`;
	if (agent === "omp") return `# Memory\n\n${OMP_INTRO}\n\n${RULES}\n\n${view.render()}`;
	if (agent === "claude-mod") return `# Memory\n\n${CLAUDE_MOD_INTRO}\n\n${RULES}\n\n${view.render()}`;
	return `# Memory\n\n${CLAUDE_INTRO}\n\n${RULES}\n\n${fenced(view.render())}`;
}

/** `text` in a fenced code block whose fence is longer than any backtick run inside, so nothing inside can close it. */
export function fenced(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}text\n${text}\n${fence}`;
}
