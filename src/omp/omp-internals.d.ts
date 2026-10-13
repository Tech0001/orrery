/** OMP's config registry, served by OMP at runtime and never installed here: only what src/omp/settings.ts uses. */
declare module "@oh-my-pi/pi-coding-agent/config/registry" {
	export function lookup(id: string): { get(scope: object): unknown; override(scope: object, value: unknown): void } | undefined;
}
