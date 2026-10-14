/** Page 2, Logins (spec §3.2): saved logins and remotes. A new remote's recovery code is shown once in its setup modal. */

import { readOnlyConfigText } from "../../agent/config-edit.ts";
import type { RemoteRow } from "../../agent/overview.ts";
import type { RemoteOptions } from "../../cli/remote.ts";
import type { ModelChoice } from "../../agent/config.ts";
import type { LoginRow } from "../../agent/logins.ts";
import type { SummarySources } from "../../agent/summary-sources.ts";
import { GROUP_TITLES, listModels } from "../../agent/summary-sources.ts";
import type { App, Page } from "../app.ts";
import { ConfirmModal, InputModal, MessageModal, hardWrap, SecretModal, SelectModal } from "../dialogs.ts";
import { explainFailure } from "../../agent/source-labels.ts";
import { signInInteraction } from "../signin.ts";
import { type Column, fit, renderTable } from "../table.ts";

const COLUMNS: readonly Column[] = [
	{ title: "Login", width: 26 },
	{ title: "State", width: 15 },
	{ title: "Used by", width: 24, grow: true },
	{ title: "Note", width: 30, drop: 1 },
];

interface State {
	rows: LoginRow[];
	sources?: SummarySources;
	loading?: Promise<void>;
}
const states = new WeakMap<App, State>();
const state = (app: App): State => {
	let s = states.get(app);
	if (s === undefined) {
		s = { rows: [] };
		states.set(app, s);
	}
	return s;
};

function visible(app: App): LoginRow[] {
	const words = app.filterText().toLowerCase().split(/\s+/).filter(Boolean);
	return state(app).rows.filter((r) => words.every((w) => `${GROUP_TITLES[r.group]} ${r.label} ${r.agents.join(" ")}`.toLowerCase().includes(w)));
}

function note(app: App, row: LoginRow): string {
	if (row.group === "local") {
		const env = app.config?.providers.find((p) => p.id === row.provider)?.apiKeyEnv;
		return env === undefined ? "no key" : `key from $${env}`;
	}
	return row.note ?? "";
}

/** Reloads the rows in the background (a refresh never waits on it). */
function load(app: App): void {
	const s = state(app);
	const config = app.config;
	if (s.loading !== undefined || config === undefined) return;
	s.loading = (async () => {
		s.sources = await app.deps.sources(config);
		s.rows = await app.deps.loginRows(s.sources, app.agents);
	})()
		.catch((error: unknown) => app.say(error instanceof Error ? error.message : String(error), "error"))
		.finally(() => {
			s.loading = undefined;
			app.deps.requestRender();
		});
}

async function sourcesFor(app: App): Promise<SummarySources> {
	const s = state(app);
	if (s.sources === undefined && app.config !== undefined) s.sources = await app.deps.sources(app.config);
	if (s.sources === undefined) throw new Error("The config has a problem; see the Agents page.");
	return s.sources;
}

function add(app: App, row: LoginRow): void {
	if (row.group === "local") {
		app.say("A local server needs no login; its key, if any, comes from api_key_env in the config.");
		return;
	}
	app.run(row.group === "signin" ? "Signing in" : `Adding the ${row.label} key`, async () => {
		const sources = await sourcesFor(app);
		if (row.group === "signin") {
			const { interaction, close } = signInInteraction(app, row.label);
			try {
				await app.deps.signIn(sources, interaction, row.name);
			} catch (error) {
				throw new Error(explainFailure(row.provider, error instanceof Error ? error.message : String(error)));
			} finally {
				close();
			}
			return `Signed in to ${row.label}.`;
		}
		const key = await app.host.open(new SecretModal(`${row.label} API key (paste it; it is not shown):`));
		if (key === undefined) return undefined;
		return `Saved the ${await app.deps.saveKey(sources, row.name, key, (text) => { void app.host.open(new MessageModal("OpenRouter", text)); })} key.`;
	});
}

function test(app: App, row: LoginRow): void {
	app.run(`Testing ${row.label}`, async () => {
		const sources = await sourcesFor(app);
		const agent = app.agents.find((l) => row.agents.includes(l.name));
		let choice: ModelChoice | undefined;
		if (agent !== undefined) {
			const slash = agent.summaryModel.ref.indexOf("/");
			const { thinking } = agent.summaryModel;
			choice = { provider: agent.summaryModel.ref.slice(0, slash), modelId: agent.summaryModel.ref.slice(slash + 1), thinking: thinking === "?" ? "low" : thinking };
		} else {
			const models = listModels(sources, row.provider);
			const id = await app.host.open(new SelectModal(`No agent uses ${row.label}. Test it with which model?`, models.map((m) => m.id)));
			if (id === undefined) return undefined;
			choice = { provider: row.provider, modelId: id, thinking: "low" };
		}
		const result = await app.deps.testChoice(sources, choice);
		if (!result.ok) throw new Error(`Doesn't work: ${result.reason}.`);
		return `Works: ${choice.provider}/${choice.modelId} answered.`;
	});
}

function remove(app: App, row: LoginRow): void {
	if (row.group === "local") {
		app.say("A local server has no login to remove; change it in the config.");
		return;
	}
	app.run(`Removing ${row.label}`, async () => {
		const what = row.group === "signin" ? "the ChatGPT sign-in" : `the ${row.label} key`;
		const users =
			row.agents.length === 0
				? ""
				: `\n${hardWrap(`${row.agents.join(", ")} summarize with it.`, 56).join("\n")}\nTheir summaries will fail until you switch them (M on the Agents page).`;
		if (!(await app.host.open(new ConfirmModal(`Remove ${what}?${users}`)))) return undefined;
		const sources = await sourcesFor(app);
		return app.deps.removeLogin(sources, row.group === "signin" ? { signin: row.name } : { key: row.name });
	});
}

/** The same background cache as the Agents page; neither polling nor painting waits on the network. */
function remotes(app: App): readonly RemoteRow[] {
	if (app.config === undefined) return [];
	const rows = app.deps.remotes?.(app.config) ?? [...app.config.remotes.values()].map((r) => ({ name: r.name, kind: r.kind }));
	const words = app.filterText().toLowerCase().split(/\s+/).filter(Boolean);
	return rows.filter((r) => words.every((w) => `${r.name} ${r.kind}`.toLowerCase().includes(w)));
}

/** R or the Add remote row: public settings through normal inputs, secrets only through hidden dialogs. */
function addRemote(app: App): void {
	const config = app.config;
	if (config === undefined) return;
	if (!app.deps.configWritable()) { app.say(readOnlyConfigText(app.deps.configPath), "error"); return; }
	if (app.deps.addRemote === undefined) { app.say("Remote setup is unavailable here.", "error"); return; }
	app.run("Adding remote", async () => {
		const name = await app.host.open(new InputModal("Remote name (letters, digits, - and _):"));
		if (!name) return undefined;
		const kind = await app.host.open(new SelectModal("Remote kind:", ["server", "cloudflare"]));
		if (kind === undefined) return undefined;
		let options: RemoteOptions;
		if (kind === "server") {
			const hosts = [...config.hosts.values()].filter((host) => host.kind === "ssh").map((host) => host.name);
			if (hosts.length === 0) throw new Error("Add an SSH host to [hosts] in config.toml first.");
			const host = await app.host.open(new SelectModal("SSH host:", hosts));
			if (host === undefined) return undefined;
			const folder = await app.host.open(new InputModal("Remote folder (relative to SSH home, or absolute):"));
			if (!folder) return undefined;
			options = { server: `${host}:${folder}` };
		} else {
			const url = await app.host.open(new InputModal("Worker URL (https):"));
			if (!url) return undefined;
			options = { cloudflare: url };
		}
		const added = await app.deps.addRemote!(name, options, { secret: (message) => app.host.open(new SecretModal(message)) });
		if (added.recoveryCode !== undefined) await app.host.open(new MessageModal(`Recovery code for ${added.name}`, `${added.recoveryCode}\n\nKeep this recovery code somewhere safe. Another machine needs it to read this remote.`));
		return `Added remote ${added.name}.`;
	});
}

export const loginsPage: Page = {
	id: "logins",
	title: "Logins",
	hints: "A add or replace · T test · D remove · R add remote",
	refresh(app) { remotes(app); load(app); },
	count: (app) => visible(app).length + ((app.config?.remotes.size ?? 0) > 0 ? remotes(app).length + 1 : 0),
	render(app, width, height) {
		const rows = visible(app);
		const remoteRows = remotes(app);
		const { theme } = app.deps;
		const withRemotes = (app.config?.remotes.size ?? 0) > 0;
		const remoteHeight = withRemotes ? Math.min(remoteRows.length + 3, Math.max(3, Math.floor(height / 2))) : 1;
		const loginHeight = Math.max(1, height - remoteHeight - 1);
		const cells = rows.map((r) => [`${GROUP_TITLES[r.group]} · ${r.label}`, r.state, r.agents.length === 0 ? "—" : r.agents.join(", "), note(app, r)]);
		const withNote = cells.some((c) => c[3] !== "");
		const logins = state(app).rows.length === 0
			? [fit(state(app).loading !== undefined ? "Reading logins…" : "No logins listed.", width)]
			: renderTable(withNote ? COLUMNS : COLUMNS.slice(0, 3), cells, width, {
				selected: app.sel() < rows.length ? app.sel() : -1, height: loginHeight, theme,
				rowStyle: (i) => rows[i].state === "unusable" ? theme.red : (rows[i].state === "not saved" || rows[i].state === "not signed in") ? theme.dim : undefined,
			});
		if (!withRemotes) return [...logins, "", fit("No remotes — orrery remote add", width)];
		const remoteCells = [...remoteRows.map((r) => [r.name, r.kind, r.reachable === undefined ? "…" : r.reachable ? "✓" : "✗"]), ["Add remote", "", ""]];
		return [...logins, "", theme.bold(fit("Remotes", width)), ...renderTable(
			[{ title: "Remote", width: 26, grow: true }, { title: "Kind", width: 12 }, { title: "Reachable", width: 10 }],
			remoteCells, width, { selected: app.sel() - rows.length, height: remoteHeight - 1, theme },
		)];
	},
	enter(app) {
		if (app.sel() === visible(app).length + remotes(app).length) addRemote(app);
	},
	key(app, data) {
		const k = data.toLowerCase();
		if (k === "r") { addRemote(app); return true; }
		const row = visible(app)[app.sel()];
		if (row === undefined) {
			if (k === "a" && app.sel() === visible(app).length + remotes(app).length) { addRemote(app); return true; }
			return false;
		}
		if (k === "a") add(app, row);
		else if (k === "t") test(app, row);
		else if (k === "d") remove(app, row);
		else return false;
		return true;
	},
};
