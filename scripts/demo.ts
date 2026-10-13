/** Parent owns the temporary home; the child gets an isolated environment and the terminal. */
import { spawn } from "node:child_process";
import { demoEnvironment, withDemoHome } from "../src/demo.ts";

// Bootstrap code is passed directly to Node, never a shell. Command-line arguments cannot select child mode.
const start = `
import { createDemo, demoDeps } from ${JSON.stringify(new URL("../src/demo.ts", import.meta.url).href)};
import { runTui } from ${JSON.stringify(new URL("../src/tui/run.ts", import.meta.url).href)};
const demo = createDemo(process.env.HOME);
process.exitCode = await runTui(demo.configPath, {
	createDeps: ({ tui, quit }) => demoDeps(demo, { rows: () => tui.terminal.rows, quit, requestRender: () => tui.requestRender() }),
	notice: "Demo · fictional data and prices · browse lanes and Usage · q to quit",
});
`;
process.exitCode = await withDemoHome(async (home) => {
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", start], {
		cwd: home, env: demoEnvironment(home), stdio: "inherit",
	});
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
	for (const signal of signals) process.on(signal, forward);
	try {
		return await new Promise<number>((done, fail) => {
			child.once("error", fail);
			child.once("close", (code, signal) => done(code ?? (signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143)));
		});
	} finally {
		for (const signal of signals) process.off(signal, forward);
	}
});
