/** The lane guard on pi's tool calls (spec §9). The path judgment is shared with Claude Code: src/lane/guard-paths.ts. */

export {
	guardOmpToolCall,
	guardToolCall,
	movedAgentDirCredentials,
	ompCredentials,
	type PathGuardOptions as PiGuardOptions,
	piToolPath,
	realTarget,
} from "../lane/guard-paths.ts";
