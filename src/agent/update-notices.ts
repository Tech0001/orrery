/**
 * The update notices a pi, OMP or Claude Code session shows its user (spec 2026-10-15-update-notices): a newer release
 * from the cached daily check, and an Orrery updated under the running session. Read at once from files, with no
 * request: the session refreshes the cache elsewhere (refreshUpdateCache). They reach the user only, never the model.
 * Imports nothing a pi or OMP extension may not load.
 */

import { availableRelease, cachedUpdate, installedVersion, needsRestart } from "../install/update.ts";
import { safeText } from "./source-labels.ts";

export interface UpdateNotice {
	/** What the notice is about ("updated:0.6.1", "available:0.6.2"): a session says each key once. */
	readonly key: string;
	readonly text: string;
}

/**
 * The notices for a session running `running` (its Orrery's version, or undefined when unknown) at `now`: Orrery was
 * updated under it (the installed `app/current` is another build; no network, so even with checks off), and, with checks
 * on (`enabled`), a release newer than the installed version (the cached answer, however old).
 */
export function updateNotices(env: NodeJS.ProcessEnv, now: number, options: { enabled: boolean; running: string | undefined }): UpdateNotice[] {
	const notices: UpdateNotice[] = [];
	const installed = installedVersion(env);
	if (installed !== undefined && needsRestart(options.running, installed)) {
		notices.push({ key: `updated:${installed}`, text: `Orrery was updated to ${safeText(installed)}; restart this session to use it.` });
	}
	if (options.enabled) {
		const latest = availableRelease(env, cachedUpdate(env, now).latest, options.running);
		if (latest !== undefined) notices.push({ key: `available:${latest}`, text: `Orrery ${latest} is available. Run \`orrery update\`, then restart this session.` });
	}
	return notices;
}
