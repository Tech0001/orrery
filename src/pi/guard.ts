/** The agent guard on pi's tool calls (spec §9). The path judgment is shared with Claude Code: src/agent/guard-paths.ts. */

export {
	guardOmpToolCall,
	guardToolCall,
	agentViews,
	movedAgentDirCredentials,
	ompCredentials,
	type PathGuardOptions as PiGuardOptions,
	piToolPath,
	realTarget,
} from "../agent/guard-paths.ts";
