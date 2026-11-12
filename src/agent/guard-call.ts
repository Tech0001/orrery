/** The agent guard's pre-check on a tool call (spec §6): the shared rules (src/agent/guard-rules.ts) and Grok's (src/grok/guard-rules.ts). */

import { homedir } from "node:os";
import { posix } from "node:path";
import { GROK_CLI_REFUSED, GROK_CLIMB, GROK_COMMAND, GROK_COMMAND_PLAIN, GROK_READ_ONLY, GROK_READ_ONLY_PLAIN, GROK_REACH, grokClimbsFrom, grokCommandOf, grokFolders, type GrokRule, grokLoads, grokNamed, grokNamedFrom, grokReaches, grokRule, grokSpeltFrom } from "../grok/guard-rules.ts";
import { AGENT_REFUSED, APP_READ_ONLY, APP_READ_ONLY_PLAIN, CONFIG_READ_ONLY, CONFIG_READ_ONLY_PLAIN, configSpellings, flagged, type GuardOptions, namesFolder, newTextIn, OPENCODE_COMMAND, OPENCODE_NAMED, OPENCODE_READ_ONLY, openCodeLoads, openCodeRule, openCodeSkillRefusal, ORRERY_COMMAND_REFUSED, ORRERY_COMMAND_REFUSED_PLAIN, orreryAppNamed, orreryCommandIn, orreryConfigNamed, pathProtected, PLAIN_REFUSED, PLUMBING_REFUSED, PROTECTED_BY, PROTECTED_FILE, protectedIn, type Protection, protection, readings, runsPlumbing, secretIn, secretPath, sensitive, SKILL_SHELL, SKILLS_NAMED, skillShellRead, TRANSCRIPT_COMMAND, TRANSCRIPT_COMMAND_PLAIN, TRANSCRIPT_READ_ONLY, TRANSCRIPT_READ_ONLY_PLAIN, transcriptPath, transcriptRule, transcriptsNamed, type ViewRules, viewRules, within } from "./guard-rules.ts";

/** What checkToolCall judges against: the guard's options, and Grok's folder rule. */
export interface CallOptions extends GuardOptions {
	/**
	 * Grok Build's folder but its open parts (grokRule, GROK_OPEN: its hooks, settings, plugins, agents and session
	 * records among the rest), which no tool writes and no shell text names, in every session; default: from this
	 * process's environment and the guard's home.
	 */
	readonly grok?: GrokRule;
}

/**
 * A cheap pre-filter on the raw arguments; the authoritative file check is checkResolvedPath. `views`: viewRules;
 * `config`: configSpellings; `protect`: protection, with the built-in home secrets, "~" from the OS's home by default.
 * In a session that is no agent's (GuardOptions.orreryOnly) only Orrery's own rules apply.
 */
export function checkToolCall(
	call: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> },
	options: CallOptions,
	views: ViewRules = viewRules(options),
	config: readonly string[] = configSpellings(options),
	protect: Protection = protection(options.protect),
): string | undefined {
	const agent = options.orreryOnly !== true;
	let rule = options.openCode;
	const openCode = () => (rule ??= openCodeRule(process.env, (options as { readonly home?: string }).home ?? homedir()));
	let records = options.transcripts;
	const transcripts = () => (records ??= transcriptRule(grokFolders, process.env, (options as { readonly home?: string }).home ?? homedir()));
	let folder = options.grok;
	const grok = () => (folder ??= grokRule(process.env, (options as { readonly home?: string }).home ?? homedir()));
	const command = call.arguments.command;
	if (call.name === "bash" && typeof command === "string") {
		// Shell text's readings, made once: sensitive by flagged's rules for shell text and the built-in home secrets spelt
		// from home, then the [guard] protect entries (an agent's: Orrery's own names alone in a session that is no agent's).
		const reading = readings(command, protect.reach);
		if (flagged(reading, views.command, true, config, true, agent) || (agent && secretIn(reading, protect))) return "This command touches sensitive files (keys, credentials or Orrery's private data).";
		const entry = agent ? protectedIn(reading, protect) : undefined;
		if (entry !== undefined) return `This command touches ${entry}, ${PROTECTED_BY}.`;
		if (reading.forms.some(runsPlumbing) || reading.pieces.some(runsPlumbing)) return PLUMBING_REFUSED;
		// The readings made above, once for every rule.
		const inReading = (test: (form: string) => boolean) => reading.forms.some(test) || reading.pieces.some(test);
		if (agent) {
			const own = [...openCode().own, ...(openCode().spelled ?? [])];
			if (inReading((form) => OPENCODE_NAMED.test(form) || namesFolder(form, own))) return OPENCODE_COMMAND;
			if (inReading((form) => SKILLS_NAMED.test(form)) && !(options.shellReadsSkills === true && skillShellRead(command) !== undefined)) return SKILL_SHELL;
		}
		// Last, so a command refused before keeps its reason: Orrery's commands that change memory or settings (in a
		// session that is no agent's, every one the CLI refuses it: PLAIN_REFUSED_COMMANDS), the tools' session records,
		// and Grok's folder but its open parts, or the folder itself, in every session, by its path or by its relative
		// spelling from the call's cwd (as the hook gives it); and, where the call runs in Grok's folder, a ".." that leaves
		// the open part it runs in, and, where that is the folder itself or what it loads, any path from there but into an
		// open part.
		const orrery = orreryCommandIn(reading, agent ? AGENT_REFUSED : PLAIN_REFUSED);
		if (orrery !== undefined) return agent ? ORRERY_COMMAND_REFUSED(orrery) : ORRERY_COMMAND_REFUSED_PLAIN(orrery);
		const grokCommand = grokCommandOf(command, reading);
		if (grokCommand !== undefined) return GROK_CLI_REFUSED(grokCommand);
		if (transcriptsNamed(command, reading, protect.reach, transcripts())) return agent ? TRANSCRIPT_COMMAND : TRANSCRIPT_COMMAND_PLAIN;
		if (inReading((form) => grokNamed(form, grok()))) return agent ? GROK_COMMAND : GROK_COMMAND_PLAIN;
		if (inReading((form) => grokReaches(form, grok()))) return GROK_REACH;
		const cwd = options.cwd;
		if (cwd !== undefined && posix.isAbsolute(cwd)) {
			const spelt = grokSpeltFrom([...reading.forms, ...reading.pieces], grok(), cwd);
			if (spelt.some((form) => grokNamed(form, grok()))) return agent ? GROK_COMMAND : GROK_COMMAND_PLAIN;
			if (spelt.some((form) => grokReaches(form, grok()))) return GROK_REACH;
			if (inReading((form) => grokClimbsFrom(form, grok(), cwd))) return GROK_CLIMB;
			if (inReading((form) => grokNamedFrom(form, grok(), cwd))) return agent ? GROK_COMMAND : GROK_COMMAND_PLAIN;
		}
	}
	const raw = call.arguments.path;
	if (typeof raw !== "string") return undefined;
	const path = posix.normalize(posix.isAbsolute(raw) ? raw : posix.join(options.cwd ?? options.folder, raw));
	const named = views.path(path);
	if (sensitive(raw, named, !agent) || sensitive(path, named, !agent) || (agent && (secretPath(raw, protect) || secretPath(path, protect)))) return `${path} is a sensitive file (keys, credentials or Orrery's private data).`;
	if (agent && (pathProtected(raw, protect) !== undefined || pathProtected(path, protect) !== undefined)) return PROTECTED_FILE(path);
	const writes = call.name === "write" || call.name === "edit";
	if (writes && (orreryConfigNamed(path) || config.includes(path.toLowerCase()))) return agent ? CONFIG_READ_ONLY(path) : CONFIG_READ_ONLY_PLAIN(path);
	if (writes && orreryAppNamed(path)) return agent ? APP_READ_ONLY(path) : APP_READ_ONLY_PLAIN(path);
	if (writes && grokLoads(path, grok())) return agent ? GROK_READ_ONLY(path) : GROK_READ_ONLY_PLAIN(path);
	// A session that is no agent's: its writes go anywhere but those, and the session records.
	if (!agent) return writes && transcriptPath(path, transcripts()) ? TRANSCRIPT_READ_ONLY_PLAIN(path) : undefined;
	if (writes && openCodeLoads(path, openCode())) return OPENCODE_READ_ONLY(path);
	// A whole write to a skill is judged here; an edit, which needs the file's text, by the caller that can read it.
	const written = newTextIn(call.name, call.arguments);
	const skill = writes && written !== undefined && "whole" in written ? openCodeSkillRefusal(path, path, written, undefined) : undefined;
	if (skill !== undefined) return skill;
	if (writes && ![options.folder, ...options.allowedRoots].some((root) => within(path, root))) {
		return `${path} is outside this agent's folder and allowed roots.`;
	}
	if (writes && transcriptPath(path, transcripts())) return TRANSCRIPT_READ_ONLY(path);
	return undefined;
}
