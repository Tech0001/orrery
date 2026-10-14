import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		setupFiles: ["test/setup-env.ts"],
		// Shared CI runners are slower and run files in parallel; a hang still fails, just later.
		testTimeout: process.env.CI ? 60_000 : 20_000,
	},
});
