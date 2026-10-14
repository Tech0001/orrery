import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { homeInCommand } from "./harness.ts";
import { cleanup, isolatedHome, pi, world } from "./world.ts";

afterEach(cleanup);
// A real pi starts here: should the tripwire miss, its bash runs under a scratch home.
isolatedHome();

describe("the harness's home tripwire", () => {
	it("refuses a scripted bash command that names ~, $HOME or ${HOME}; scratch paths and allowHome pass", async () => {
		const { root, config } = world();
		const run = await pi(root, join(root, "agent-Atlas"), config);
		const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })]);
		for (const command of ["ls ~/notes", "cat $HOME/notes.txt", "ls ${HOME}/notes"]) {
			expect(homeInCommand(bash(command)), command).toBe(command);
			expect(() => run.setResponses([bash(command), fauxAssistantMessage("done")]), command).toThrow(/names the home/);
			expect(() => run.setResponses([bash(command)], { allowHome: true }), command).not.toThrow();
		}
		const scratch = `ls ${join(root, "agent-Atlas")}`;
		expect(homeInCommand(bash(scratch))).toBeUndefined();
		expect(() => run.setResponses([bash(scratch), fauxAssistantMessage("done")])).not.toThrow();
	});
});
