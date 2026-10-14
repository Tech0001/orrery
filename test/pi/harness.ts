/** A real pi session (pi's SDK) with faux models and the given extensions. Mirrors pi's own runtime tests. */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { FauxProviderRegistration, FauxResponseFactory, FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionFactory,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { FileCredentialStore } from "../../src/lane/credentials.ts";

/** The agent's model. */
export const FAUX = { provider: "orrery-faux", model: "faux-1" } as const;
/** The summary model, with its own response queue: summaries never take the agent's scripted replies. */
export const FAUX_SUMMARY = { provider: "orrery-faux-summary", model: "faux-1" } as const;

export interface Notice {
	readonly message: string;
	readonly type?: "info" | "warning" | "error";
}

export interface PiRun {
	/** The current session; it follows the runtime across a fork, resume or new session. */
	readonly session: AgentSessionRuntime["session"];
	readonly runtime: AgentSessionRuntime;
	/** Every ctx.ui.notify, in order, across session replacements. */
	readonly notices: readonly Notice[];
	/** The footer status an extension set under `key` (ctx.ui.setStatus), if any. */
	status(key: string): string | undefined;
	/**
	 * The agent's scripted replies. A step that calls bash with a command naming the home ("~", "$HOME", "${HOME}") is
	 * refused here, before any of them runs (homeInCommand): pi's bash runs it for real, under this process's HOME. A
	 * test that means it says so with `allowHome`, and only in a suite whose HOME is a scratch folder (isolatedHome).
	 */
	setResponses(steps: FauxResponseStep[], options?: { allowHome?: boolean }): void;
	setSummaryResponses(steps: FauxResponseStep[]): void;
	tool(name: string): { execute(id: string, params: unknown): Promise<{ content: { type: string; text?: string }[] }> } | undefined;
	dispose(): Promise<void>;
}

/**
 * The session to start: a copy of the session file `forkFrom` (as `pi --fork <file>` does), else the saved session with
 * `id`, else a new session (with `id` if given).
 */
function sessionFor(cwd: string, sessionDir: string, id: string | undefined, forkFrom: string | undefined): SessionManager {
	if (forkFrom !== undefined) return SessionManager.forkFrom(forkFrom, cwd, sessionDir, id === undefined ? undefined : { id });
	const saved = id === undefined ? undefined : SessionManager.findById(cwd, id, sessionDir);
	if (saved !== undefined) return SessionManager.open(saved, sessionDir);
	return SessionManager.create(cwd, sessionDir, id === undefined ? undefined : { id });
}

/** A UI that records notify and setStatus, and does nothing else (pi's own no-op UI, plus the recording). */
function recordingUi(notices: Notice[], statuses: Map<string, string>): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message, type) => notices.push(type === undefined ? { message } : { message, type }),
		onTerminalInput: () => () => {},
		setStatus: (key, text) => (text === undefined ? statuses.delete(key) : statuses.set(key, text)),
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		// pi's theme singleton is not exported from the package; nothing here draws.
		theme: undefined as unknown as Theme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "No themes in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

/** A scripted reply as a message (the other kind of step makes one). */
type AssistantMessage = Exclude<FauxResponseStep, FauxResponseFactory>;

/** A bash command that names the home: "~" anywhere, "$HOME" or "${HOME…}". */
const NAMES_HOME = /~|\$\{?HOME/;

/** The bash command in a scripted reply that names the home (NAMES_HOME), if any: the tripwire of setResponses. */
export function homeInCommand(message: AssistantMessage): string | undefined {
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const command = block.arguments.command;
		if ((block.name === "bash" || typeof command === "string") && NAMES_HOME.test(String(command))) return String(command);
	}
	return undefined;
}

/** `steps` with the tripwire on each: a message is checked now, a factory's result when it is made. */
function tripwired(steps: FauxResponseStep[]): FauxResponseStep[] {
	const check = (message: AssistantMessage): AssistantMessage => {
		const command = homeInCommand(message);
		if (command !== undefined) throw new Error(`test harness: a scripted bash command names the home, which pi's bash would run for real: ${JSON.stringify(command)}. Keep to scratch paths, or pass { allowHome: true } in a suite with isolatedHome().`);
		return message;
	};
	return steps.map((step) => (typeof step === "function" ? async (...args: Parameters<FauxResponseFactory>) => check(await step(...args)) : check(step)));
}

function fauxProvider(names: { provider: string; model: string }, modelRuntime: ModelRuntime): FauxProviderRegistration {
	const faux = registerFauxProvider({ provider: names.provider, models: [{ id: names.model }] });
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [{ id: model.id, name: model.name, api: model.api, reasoning: model.reasoning, input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens, baseUrl: model.baseUrl }],
	});
	return faux;
}

/**
 * `setSummaryResponses` overrides where the run's summary responses go: orrery summarizes through its own registry
 * (test/pi/world.ts), not pi's. Without it they go to the summary faux in pi's registry.
 */
export async function startPi(options: {
	cwd: string;
	agentDir: string;
	extensions: ExtensionFactory[];
	sessionId?: string;
	forkFrom?: string;
	setSummaryResponses?: (steps: FauxResponseStep[]) => void;
}): Promise<PiRun> {
	mkdirSync(options.agentDir, { recursive: true });
	const credentialsPath = join(options.agentDir, "credentials.json");
	const key = { type: "api_key", key: "faux" };
	writeFileSync(credentialsPath, JSON.stringify({ [FAUX.provider]: key, [FAUX_SUMMARY.provider]: key }), { mode: 0o600 });
	const modelRuntime = await ModelRuntime.create({ credentials: new FileCredentialStore(credentialsPath), modelsPath: join(options.agentDir, "models.json") });
	const faux = fauxProvider(FAUX, modelRuntime);
	const summaryFaux = fauxProvider(FAUX_SUMMARY, modelRuntime);
	const model = faux.getModel();
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			agentDir: options.agentDir,
			modelRuntime,
			cwd,
			resourceLoaderOptions: { extensionFactories: options.extensions, noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })), services, diagnostics: services.diagnostics };
	};
	const sessionManager = sessionFor(options.cwd, join(options.agentDir, "sessions"), options.sessionId, options.forkFrom);
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: options.cwd, agentDir: options.agentDir, sessionManager });
	const notices: Notice[] = [];
	const statuses = new Map<string, string>();
	const uiContext = recordingUi(notices, statuses);
	// Like pi's rpc mode: a UI is bound, and a replacement session (fork, resume, new) gets its extensions bound too.
	runtime.setRebindSession(async (session) => session.bindExtensions({ uiContext, mode: "rpc" }));
	await runtime.session.bindExtensions({ uiContext, mode: "rpc" });
	return {
		get session() {
			return runtime.session;
		},
		runtime,
		notices,
		status: (key) => statuses.get(key),
		setResponses: (steps, options = {}) => faux.setResponses(options.allowHome ? steps : tripwired(steps)),
		setSummaryResponses: (steps) => (options.setSummaryResponses === undefined ? summaryFaux.setResponses(steps) : options.setSummaryResponses(steps)),
		tool: (name) => runtime.session.agent.state.tools.find((tool: { name: string }) => tool.name === name) as never,
		dispose: async () => {
			await runtime.dispose();
			faux.unregister();
			summaryFaux.unregister();
		},
	};
}
