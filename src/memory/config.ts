/** Memory tuning, defaulting to the OptChat spec constants. */

export interface MemoryConfig {
	readonly nodeBytes: number;
	readonly viewBytes: number;
	readonly jobs: number;
	readonly tries: number;
	readonly retrySeconds: number;
	readonly toolCap: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
	nodeBytes: 512,
	viewBytes: 128_000,
	jobs: 8,
	tries: 5,
	retrySeconds: 10,
	toolCap: 30_000,
};

export function memoryConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
	const config: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG, ...overrides };
	for (const name of ["nodeBytes", "viewBytes", "jobs", "tries", "toolCap"] as const) {
		if (!Number.isInteger(config[name]) || config[name] < 1) throw new RangeError(`${name} must be a positive integer`);
	}
	if (config.nodeBytes < 64 || config.toolCap < 128) throw new RangeError("nodeBytes must be >= 64 and toolCap >= 128");
	if (!Number.isFinite(config.retrySeconds) || config.retrySeconds <= 0) {
		throw new RangeError("retrySeconds must be a positive number");
	}
	return config;
}
