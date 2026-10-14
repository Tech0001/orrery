/**
 * The Orrery mod (spec 2026-10-08-claude-code-mod): in a lane switched to mod mode (`orrery claude-setup <Lane> --mod`)
 * - prompt.compose adds the lane's memory view as the system-prompt section orrery:memory, fetched once per session
 *   id and again only at a compaction, so the prompt cache holds between compactions;
 * - session.compact answers Claude Code's compactions (/compact, its own threshold, the mod's) with the last turn,
 *   and refreshes the section; no model call. When it cannot, /compact and Claude Code's threshold fall back to Claude
 *   Code's own compaction, and a compaction the mod started is skipped instead (and the mod starts no more, unless
 *   only the last turn was too large to keep: then it tries again after a later turn);
 * - session.measure starts a compaction once the conversation passes the lane's compact_at (interactive sessions);
 * - it shows that it is loaded (sections 11 and 12): a startup band above the prompt until the person's first prompt,
 *   a footer label with the lane and its message count (`Orrery · <Lane> · <N> msgs`), and each compaction's line after
 *   the compaction, where it can be seen (right under the /compact row, or at the next event). The band and the label
 *   read facts of their own, fetched at session start and again after each turn's end; they never change the section.
 * Elsewhere it adds nothing and passes everything on. It reaches Orrery only through `orrery claude-mod view`, run by
 * the plugin's launcher in the session's project root as first read in this process (a shell cd, `/cd` or a worktree
 * move does not change the lane), with the ORRERY_AGENT Claude Code was started with (`orrery agent`), which names the
 * lane in any folder; memory is read read-only, and the classic hooks keep recording.
 */

import type { EngineInterface, Register, SessionCompactResult, Timer } from "claude-code";
import { LOGO } from "./logo.ts";
import {
	bandAsksAgain,
	bandHasLogo,
	bandLines,
	bandShows,
	compactAnswer,
	compactRoute,
	drawsSomewhere,
	type Fallback,
	fallbackLine,
	footerModes,
	laterLine,
	parseViewReply,
	personPrompt,
	SECTION_ID,
	sectionFailedLine,
	shouldCompact,
	skipLine,
	stopLine,
	TURN_WAIT_MS,
	turnRefetches,
	turnReplyShown,
	type ViewReply,
	viewArgs,
	WAIT_MS,
} from "./mod-logic.ts";

/**
 * How long the band waits before asking again (the session's mode not known yet, or orrery did not answer), and how
 * many times it asks after a session start.
 */
const REFETCH_MS = 2_000;
const REFETCHES = 10;
/** Observe asynchronous remote saves and takeovers even while the person is idle. */
const REMOTE_REFRESH_MS = 60_000;

/** What the mod knows about one session (ruling 1: module variables keyed by the session id). */
interface Held {
	readonly session: string;
	readonly reply: ViewReply;
	/** The section in this session's prompt; null adds none. */
	readonly section: string | null;
}

let held: Held | undefined;
let fetching: { readonly session: string; readonly done: Promise<Held> } | undefined;
/**
 * The compaction the mod itself started, while its `$.session.compact()` is in flight: its session, and whether the
 * mod's own hook answered it with a skip (and said why).
 */
let compacting: { readonly session: string; answered: boolean } | undefined;
/** The session in which a mod-started compaction was refused or skipped for a lasting cause (ruling 3). */
let stopped: string | undefined;
/** The session in which the mod said it could not compact for now (a last turn too large), so it says so only once. */
let toldLater: string | undefined;
/**
 * The project root as first read in this process. `$.session.root()` moves with `/cd`, a host's directory change or a
 * worktree move, but the lane whose memory this session carries does not.
 */
let root: string | undefined;
/**
 * The line of the last compaction Orrery handled, not shown yet. The compaction hook only keeps it; what runs after the
 * compaction shows it once: the typed /compact and the mod's own call on the clock's tick after they settle (under
 * Claude Code's row), or the next event.
 */
let pending: { readonly session: string | undefined; readonly line: string } | undefined;
/** The session whose typed /compact is running: it shows the line itself, so nothing else shows it meanwhile. */
let commanding: string | undefined;
/** Whether the person has sent a prompt in this process: the startup band then shows no more (a /clear included). */
let prompted = false;
/**
 * What the band and the footer label read: the newest answer of `orrery claude-mod view`, from their own fetch at
 * session start (before any prompt, so before the section's own fetch), a display-only refetch while the session's mode
 * is not known, the section's fetch or a compaction's. An error keeps what they had. It never sets `held` or the
 * prompt's section.
 */
let display: ViewReply | undefined;
/** The display-only refetch waiting on the clock, and how many have run since the last session start. */
let refetch: Timer | undefined;
let refetches = 0;
/**
 * The footer count's refetch after a turn's end (section 12): whether one is running, and whether another turn ended
 * meanwhile (it then runs once more when the running one is done, so the count does not stay a turn behind).
 */
let turnFetching = false;
let turnAgain = false;
let remoteRefresh: Timer | undefined;
let factsGeneration = 0;

/** The pinned project root (read once, the first answer kept). */
async function projectRoot($: EngineInterface): Promise<string> {
	if (root === undefined) {
		const read = await $.session.root();
		root ??= read;
	}
	return root;
}

/**
 * ORRERY_AGENT and ORRERY_AGENT_TOKEN as Claude Code's own environment has them (`orrery agent` sets them), read at each
 * view call. The names are string literals, as Claude Code's review of a mod's calls requires. A token is passed as it
 * is, an empty one too, so orrery refuses a malformed one here as Claude Code's hooks do. A Claude Code without $.env
 * answers nothing here, and the view call still inherits the environment.
 */
async function agentFromEnv($: EngineInterface): Promise<{ readonly name: string; readonly token?: string } | undefined> {
	try {
		const name = await $.env.get("ORRERY_AGENT");
		if (typeof name !== "string" || name.trim() === "") return undefined;
		const token = await $.env.get("ORRERY_AGENT_TOKEN");
		return { name: name.trim(), ...(typeof token === "string" ? { token } : {}) };
	} catch {
		return undefined;
	}
}

async function runView($: EngineInterface, session: string, waitMs?: number, spoolOnly = false): Promise<ViewReply> {
	try {
		// The pinned project root, not the working folder: the Bash tool's cd moves the latter, never the lane.
		const cwd = await projectRoot($);
		const run = await $.process.run(viewArgs($.plugin.root, cwd, session, waitMs, spoolOnly, await agentFromEnv($)), { cwd, timeoutMs: (waitMs ?? 0) + 15_000 });
		return parseViewReply(run);
	} catch (error) {
		return { kind: "error", text: `orrery did not answer: ${String(error)}` };
	}
}

/** Asks for the band and the footer label to be drawn again (their facts changed). */
function redraw($: EngineInterface): void {
	try {
		$.ui.invalidate("ui.render");
	} catch {
		// A session that draws nothing (headless): nothing to redraw.
	}
}

/** This session's facts, fetched once per session id (a /clear brings a new id). */
async function current($: EngineInterface): Promise<Held> {
	const session = await $.session.id();
	if (held?.session === session) return held;
	if (fetching?.session !== session) {
		const done = runView($, session).then((reply) => {
			if (reply.kind === "error") $.ui.log(sectionFailedLine(reply.text));
			const next: Held = { session, reply, section: reply.kind === "lane" && reply.mode === "mod" ? reply.section : null };
			// A late answer for a session that is no longer the one being fetched does not take the current one's place.
			if (fetching?.session === session) {
				held = next;
				showFacts($, reply);
			}
			return next;
		});
		fetching = { session, done };
	}
	return fetching.done;
}

/** Keeps a compaction's line until what runs after the compaction shows it. */
function keep(session: string | undefined, line: string): void {
	pending = { session, line };
}

/** The kept line for `session`, taken (a line kept for another session is dropped). */
function take(session: string): string | undefined {
	const kept = pending;
	pending = undefined;
	return kept !== undefined && (kept.session === undefined || kept.session === session) ? kept.line : undefined;
}

/** Shows the kept line for `session` in the transcript, once. */
function show($: EngineInterface, session: string): void {
	const line = take(session);
	if (line !== undefined) $.ui.log(line);
}

/**
 * Logs `lines` (the absent ones left out) in order on the clock's next tick: after a compaction, Claude Code draws it
 * once the call that ran it has settled, over any line logged before. Display only: a timer never starts a compaction.
 */
function logSoon($: EngineInterface, lines: readonly (string | undefined)[]): void {
	const shown = lines.filter((line): line is string => line !== undefined);
	if (shown.length > 0) $.clock.after(0, () => shown.forEach((line) => $.ui.log(line)));
}

/**
 * At the next event after a compaction no one else shows the line of (Claude Code's own threshold): shows it. Never
 * while a /compact or the mod's own compaction is running (they show their own), and it never throws.
 */
async function flush($: EngineInterface): Promise<void> {
	if (pending === undefined || compacting !== undefined || commanding !== undefined) return;
	try {
		show($, await $.session.id());
	} catch {
		// The line is lost from the screen; nothing else depends on it.
	}
}

/**
 * Skips a compaction the mod started and cannot answer, rather than handing it to Claude Code's own summarizer. A
 * lasting cause stops the mod starting more in this session; one that passes (a last turn too large) is said once, and
 * the mod tries again after a later turn. The line is kept for the mod's call to show when it resolves.
 */
function skipOwn(session: string, cause: Pick<Fallback, "why" | "lasting">): { skip: string } {
	if (compacting?.session === session) compacting.answered = true;
	if (!cause.lasting) {
		const line = laterLine(cause.why);
		if (toldLater !== session) {
			toldLater = session;
			keep(session, line);
		}
		return { skip: line };
	}
	stopped = session;
	const line = skipLine(cause.why);
	keep(session, line);
	return { skip: line };
}

/**
 * Claude Code's own compaction, run in Orrery's place: the line saying why is kept once it is done, so that nothing
 * running inside it (its summarizer composes a prompt) shows the line, and only when it stood, not skipped.
 */
async function ownWay(own: Promise<SessionCompactResult>, session: string | undefined, line: string): Promise<SessionCompactResult> {
	const done = await own;
	if (done.skip === undefined) keep(session, line);
	return done;
}

/** Hands the band and the footer label a newer answer (an error keeps what they had), and draws them. */
function showFacts($: EngineInterface, reply: ViewReply): void {
	if (reply.kind === "error" && display !== undefined) return;
	display = reply;
	redraw($);
	refreshRemoteLater($);
}

/** Poll only remote footer facts. Share the turn fetch so slow commands never overlap or touch the prompt section. */
function refreshRemoteLater($: EngineInterface): void {
	if (display?.kind !== "lane" || display.mode !== "mod" || display.remote === undefined || display.remote.state === "lost") {
		remoteRefresh?.cancel();
		remoteRefresh = undefined;
		return;
	}
	if (remoteRefresh !== undefined) return;
	const generation = factsGeneration;
	remoteRefresh = $.clock.after(REMOTE_REFRESH_MS, () => {
		remoteRefresh = undefined;
		if (generation === factsGeneration) refetchAfterTurn($);
	});
}

/**
 * While the band still waits to learn its facts after the answer `reply` (orrery did not answer, or the session's mode
 * file was not written yet) and the person has sent no prompt, asks again in a while: for the band only, never for the
 * prompt's section, and never to start a compaction.
 */
function refetchLater($: EngineInterface, session: string, reply: ViewReply): void {
	if (prompted || refetch !== undefined || refetches >= REFETCHES || !bandAsksAgain(reply)) return;
	refetch = $.clock.after(REFETCH_MS, () => {
		refetch = undefined;
		refetches += 1;
		void runView($, session).then((next) => {
			showFacts($, next);
			refetchLater($, session, next);
		});
	});
}

/**
 * The band's and the footer label's facts for a session start, fetched without holding the start: they are drawn when
 * they land. Each start has its own refetches (a pending one of an earlier start is dropped).
 */
async function startFacts($: EngineInterface): Promise<void> {
	const generation = ++factsGeneration;
	remoteRefresh?.cancel();
	remoteRefresh = undefined;
	try {
		refetch?.cancel();
	} catch {
		// A timer already gone: nothing to cancel.
	}
	refetch = undefined;
	refetches = 0;
	try {
		const session = await $.session.id();
		const reply = await runView($, session);
		if (generation !== factsGeneration) return;
		showFacts($, reply);
		refetchLater($, session, reply);
	} catch {
		// No session id here: the band has nothing to show.
	}
}

/**
 * After a turn of the main loop ends, the footer's facts asked for again (section 12), once this session's holder has
 * taken the turn's events in: `claude-mod view` waits a few seconds at most for the session's spool alone. Display only,
 * as the band's refetch: never `held` or the section, never a compaction, and never awaited by the turn. At most one
 * runs at a time; a turn that ends meanwhile gets one more run after it. Nothing runs while the session draws nowhere
 * (`claude -p`, the SDK with no client attached). Only a mod-mode lane's answer is shown: anything else (an error,
 * orrery briefly not there, the lane switched out of mod mode) keeps the label, its count and the later refetches.
 */
function refetchAfterTurn($: EngineInterface): void {
	// Every turn refresh starts a new idle minute, including a failed refresh.
	remoteRefresh?.cancel();
	remoteRefresh = undefined;
	if (turnFetching) {
		turnAgain = true;
		return;
	}
	turnFetching = true;
	void (async () => {
		try {
			do {
				turnAgain = false;
				const generation = factsGeneration;
				if (!drawsSomewhere(await $.session.surfaces())) break;
				const session = await $.session.id();
				const reply = await runView($, session, TURN_WAIT_MS, true);
				if (generation === factsGeneration && turnReplyShown(reply)) showFacts($, reply);
			} while (turnAgain);
		} catch {
			// No session id here: the label keeps what it had.
		} finally {
			turnFetching = false;
			refreshRemoteLater($);
		}
	})();
}

export const register: Register = (on) => {
	// The band's and the footer label's facts, before the first prompt (display only: the section keeps its own fetch).
	// Not awaited: a slow or stalled orrery never holds the session's start.
	on("session.start", async ($, e, next) => {
		const result = await next(e);
		if (e.isInteractive) void startFacts($);
		return result;
	}).catch(($, e, next) => next(e));

	on("prompt.compose", async ($, e, next) => {
		const result = await next(e);
		const { section } = await current($);
		await flush($);
		if (section === null) return result;
		return { sections: [...result.sections.filter((s) => s.id !== SECTION_ID), { id: SECTION_ID, text: section, scope: "session" as const }] };
	}).catch(($, e, next) => next(e));

	on("prompt.submit", async ($, e, next) => {
		if (!prompted && personPrompt(e.origin.kind)) {
			prompted = true;
			refetch?.cancel();
			refetch = undefined;
			redraw($);
		}
		await flush($);
		return next(e);
	}).catch(($, e, next) => next(e));

	on("session.compact", async ($, e, next) => {
		const known = await current($);
		const route = compactRoute(e.trigger, e.agentId, known.reply);
		if (route === "pass") return next(e);
		if (route === "skip") return { skip: "Orrery answers this lane's compactions itself" };
		const reply = await runView($, known.session, WAIT_MS);
		const answer = compactAnswer(e.messages, reply, known.reply);
		if (answer.kind === "pass") return next(e);
		if (answer.kind === "fallback") {
			if (compacting?.session === known.session) return skipOwn(known.session, answer);
			return ownWay(next(e), known.session, answer.line);
		}
		keep(known.session, answer.line);
		held = { session: known.session, reply, section: answer.section };
		showFacts($, reply);
		// A fresh toolUses list per row: Claude Code's SessionMessage type wants a mutable one (a turn still in progress keeps
		// its handles; a finished one goes back built).
		return { messages: answer.messages.map((row) => ({ ...row, toolUses: [...row.toolUses] })) };
	}).catch(($, e, next) => {
		if (next.called) return next(e);
		if (compacting !== undefined) return skipOwn(compacting.session, { why: "the hook failed", lasting: true });
		if (e.trigger === "precompute") return next(e);
		return ownWay(next(e), held?.session, fallbackLine("the hook failed"));
	});

	// A typed /compact. Claude Code 2.1.296 draws its "Compacted" row after the command's hooks settle, over any line
	// logged before, and drops a command.run answer for /compact; nor does that row reach a render hook. So the line
	// is logged on the clock's next tick once the command has run, right under the row (display only: a timer never
	// starts a compaction). A compaction Orrery had nothing to do with leaves nothing to show.
	on("command.run", { command: "compact" }, async ($, e, next) => {
		await flush($);
		const session = await $.session.id();
		commanding = session;
		try {
			return await next(e);
		} finally {
			commanding = undefined;
			logSoon($, [take(session)]);
		}
	}).catch(($, e, next) => next(e));

	// The footer's count after each turn of the main loop ends (section 12): asked for once the turn is over, not awaited.
	// Claude Code (2.1.296) runs the Stop hooks before the turn completes, so the classic one has spooled the final reply.
	on("turn.complete", async ($, e, next) => {
		const result = await next(e);
		if (turnRefetches(e.agentId, display)) refetchAfterTurn($);
		return result;
	}).catch(($, e, next) => next(e));

	on("session.measure", async ($, e, next) => {
		const result = await next(e);
		await flush($);
		// Only a measurement where the context moved: the cost or a rate limit moving says nothing about its size.
		if (!e.changed.includes("context")) return result;
		const session = await $.session.id();
		if (compacting !== undefined || stopped === session || held?.session !== session || !shouldCompact(e.context.tokens, held.reply)) return result;
		const own = { session, answered: false };
		compacting = own;
		try {
			const done = await $.session.compact();
			// The line the mod's own hook kept for this compaction, now that it is done. A skip the mod's own hook answered
			// has already said why (and stopped the session when the cause lasts).
			const kept = take(session);
			const refused = done.skip !== undefined && !own.answered;
			if (refused) stopped = session;
			logSoon($, [kept, refused ? stopLine(done.skip) : undefined]);
		} catch (error) {
			stopped = session;
			logSoon($, [take(session), stopLine(String(error))]);
		} finally {
			compacting = undefined;
		}
		return result;
	}).catch(($, e, next) => next(e));

	// The startup band above the prompt (section 11): the logo with the lane and its state beside it, until the person's
	// first prompt in this process; it yields to a survey, and without room for the logo shows the two lines alone.
	on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
		const lines = bandLines(display);
		if (lines === undefined || !bandShows(lines, { prompted, hasSurvey: e.props.hasSurvey })) return next(e);
		const { Box, Text } = $.ui.resolve(e);
		const words = [Text({ bold: true, children: lines[0] }), Text({ dimColor: true, children: lines[1] })];
		if (!bandHasLogo(e.surface, e.props.bodyColumns, e.props.maxRows)) return Box({ flexDirection: "column", children: words });
		const logo = LOGO.map((row) => Text({ children: row.map((s) => (s.color === undefined ? s.text : Text({ color: s.color, children: s.text }))) }));
		return Box({
			flexDirection: "row",
			children: [Box({ flexDirection: "column", flexShrink: 0, children: logo }), Box({ flexDirection: "column", justifyContent: "center", marginLeft: 2, flexShrink: 1, children: words })],
		});
	}).catch(($, e, next) => next(e));

	// The footer label: `Orrery · <Lane> · <N> msgs` among the mode labels at the right of the prompt footer, for the
	// whole session.
	on("ui.render", { component: "SessionMode" }, ($, e, next) => {
		const modes = footerModes(e.props.modes, display);
		return modes === undefined ? next(e) : next({ ...e, props: { ...e.props, modes: [...modes] } });
	}).catch(($, e, next) => next(e));
};
