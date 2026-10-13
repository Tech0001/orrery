/**
 * npm run install-local [-- --yes | --keep-dev | --rollback | --list]: installs this checkout's last commit into
 * <home>/app and points the orrery command, the backup service, pi, OMP and Claude Code at app/current (spec
 * 2026-10-13-orrery-home-and-install §5). --yes answers yes to every question; --keep-dev keeps dev packages.
 */

import { createInterface } from "node:readline/promises";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { install, listVersions, rollback, versionLines } from "../src/install/install.ts";
import { wire } from "../src/install/wire.ts";

const { values } = parseArgs({
	options: {
		rollback: { type: "boolean" },
		list: { type: "boolean" },
		yes: { type: "boolean" },
		"keep-dev": { type: "boolean" },
	},
});
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const say = (line: string) => process.stdout.write(`${line}\n`);
// npm run puts the checkout's node_modules/.bin first on PATH, and its dev pi would pass for an installed pi.
const env: NodeJS.ProcessEnv = {
	...process.env,
	PATH: (process.env.PATH ?? "").split(delimiter).filter((dir) => !/[\\/]node_modules[\\/]\.bin$|[\\/]node-gyp-bin$/.test(dir)).join(delimiter),
};

/** y/N on the terminal; --yes answers yes, and with no terminal the answer is no. */
async function confirm(what: string): Promise<boolean> {
	if (values.yes === true) return true;
	if (process.stdin.isTTY !== true) {
		say(`Skipped (no terminal to ask; rerun with --yes): ${what}`);
		return false;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await rl.question(`${what} (y/N) `)).trim());
	} finally {
		rl.close();
	}
}

async function main(): Promise<void> {
	if (values.list === true) {
		for (const line of versionLines(listVersions(env))) say(line);
		return;
	}
	if (values.rollback === true) {
		const { from, to } = rollback(env);
		say(`Switched back from ${from} to ${to}. Running lanes keep their version until they restart.`);
		return;
	}
	const result = install({ checkout, env, ...(values["keep-dev"] === true ? { omitDev: false } : {}), log: say });
	for (const line of await wire(env, { confirm })) say(line);
	if (result.removed.length > 0) say(`Removed old versions: ${result.removed.join(", ")}`);
	say(`Installed ${result.version}. Running lanes keep their version until they restart.`);
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	},
);
