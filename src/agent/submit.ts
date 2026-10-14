/**
 * Starts every idle run from a fresh context (spec §5.3). One pi commit appends a reset, stores the rendered view,
 * places the input and starts the generation; a busy agent gets the input as a steer instead. This replicates pi's
 * idle admission and run start with public exports, verified against pi-durable 1.0.4; pi.live.run is not a
 * documented contract, so test/agent/submit.test.ts pins the behavior.
 */

import type { Context } from "@earendil-works/chord";
import {
	type Conversation,
	GenerationTask,
	type Harness,
	InboxDoc,
	LiveDoc,
	ResetEntry,
	type Submission,
	type SubmissionId,
	UserEntry,
} from "@earendil-works/pi-durable";
import { AgentViewDoc } from "./extension.ts";

export type SubmitMode = "run" | "steer" | "existing";

export interface SubmitResult {
	readonly mode: SubmitMode;
	readonly submission: Submission;
}

export interface SubmitDeps {
	readonly harness: Harness;
	readonly conversation: Conversation;
	readonly context: Context;
	/** Drain the projector, wait for summaries, render the view. Resolves undefined if `signal` cancels the wait. */
	renderView(signal?: AbortSignal): Promise<string | undefined>;
}

async function isIdle(deps: SubmitDeps): Promise<boolean> {
	const live = await deps.harness.snapshot(LiveDoc, deps.conversation.id, deps.context);
	const inbox = await deps.harness.snapshot(InboxDoc, deps.conversation.id, deps.context);
	return live?.run === undefined && (inbox?.items.length ?? 0) === 0;
}

export async function agentSubmit(
	deps: SubmitDeps,
	content: string,
	requestId: string,
	signal?: AbortSignal,
): Promise<SubmitResult | undefined> {
	const { conversation, context } = deps;
	let view: string | undefined;
	for (let attempt = 0; attempt < 3; attempt++) {
		if (view === undefined && (await isIdle(deps))) {
			view = await deps.renderView(signal);
			if (view === undefined) return undefined;
		}
		const viewText = view;
		const outcome = await conversation.commit(
			async (tx): Promise<{ mode: SubmitMode | "retry" | "inbox"; id?: SubmissionId }> => {
				const existing = await tx.submissionByRequest(conversation.id, requestId); // table reads before writes
				if (existing !== undefined) return { mode: "existing", id: existing.id };
				const live = await tx.doc(LiveDoc, conversation.id);
				const inbox = await tx.doc(InboxDoc, conversation.id);
				// A failed run leaves queued items in the inbox with no run to place them; pi's own admission recovers.
				if (live.run === undefined && inbox.items.length > 0) return { mode: "inbox" };
				if (live.run !== undefined) {
					const queued = await tx.createSubmission({ conversationId: conversation.id, requestId, type: "input", status: "queued" });
					inbox.items.push({ id: queued.id, mode: "steer", content });
					return { mode: "steer", id: queued.id };
				}
				if (viewText === undefined) return { mode: "retry" };
				await tx.appendEntry(ResetEntry, conversation.id, { head: "self" });
				const doc = await tx.doc(AgentViewDoc, conversation.id);
				doc.text = viewText;
				doc.run += 1;
				const user = await tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content, timestamp: Date.now() }] });
				const placed = await tx.createSubmission({
					conversationId: conversation.id,
					requestId,
					type: "input",
					status: "placed",
					entry: user.id,
				});
				const taskId = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId: conversation.id });
				live.run = { taskId, inputs: [placed.id] };
				return { mode: "run", id: placed.id };
			},
			context,
		);
		if (outcome.mode === "inbox") {
			// Idle with leftover queued items: pi places them and this input at a final boundary and starts the run in
			// the same context (spec §5.3: a pending steer continues without a reset).
			const submission = await conversation.submit({ type: "input", content, requestId, whenBusy: "steer" }, context);
			deps.harness.resume();
			return { mode: "run", submission };
		}
		if (outcome.mode === "retry" || outcome.id === undefined) continue;
		deps.harness.resume();
		const submission = await deps.harness.submission(outcome.id, context);
		if (submission === undefined) throw new Error(`Submission ${outcome.id} disappeared`);
		return { mode: outcome.mode, submission };
	}
	throw new Error("The agent kept switching between busy and idle; send the message again");
}
