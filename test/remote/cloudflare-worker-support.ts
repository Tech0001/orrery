/** Runs the real Worker and SQLite Durable Objects using the Worker's optional dev tools. */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const workerRoot = fileURLToPath(new URL("../../worker/", import.meta.url));
export const hasWorkerTools = existsSync(`${workerRoot}node_modules/miniflare`);
const bundles = new Map<boolean, Promise<string>>();

export async function startLocalWorker(staleMs = 180_000, options: { failIndexDelete?: boolean } = {}) {
	const require = createRequire(`${workerRoot}package.json`);
	const fault = options.failIndexDelete === true;
	let bundle = bundles.get(fault);
	if (!bundle) {
		bundle = (async () => {
			const { build } = await import(pathToFileURL(require.resolve("esbuild")).href);
			const entry = JSON.stringify(`${workerRoot}src/index.ts`);
			const source = fault ? `export { default, LaneObject } from ${entry};
import { IndexObject as OriginalIndex } from ${entry};
export class IndexObject extends OriginalIndex {
 failed = false;
 async fetch(request) {
  const response = await super.fetch(request);
  if (request.method === "DELETE" && !this.failed) { this.failed = true; return new Response("lost index reply", { status: 503 }); }
  return response;
 }
}` : `export { default, LaneObject, IndexObject } from ${entry};`;
			const result = await build({ stdin: { contents: source, resolveDir: workerRoot }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
			return result.outputFiles[0].text as string;
		})();
		bundles.set(fault, bundle);
	}
	const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(require.resolve("miniflare")).href);
	const mf = new Miniflare(convertV4MiniflareOptions({
		modules: true, script: await bundle, compatibilityDate: "2026-09-27",
		bindings: { ORRERY_TOKEN: "test-token", ORRERY_STALE_MS: String(staleMs) },
		durableObjects: { LANES: { className: "LaneObject", useSQLite: true }, INDEX: { className: "IndexObject", useSQLite: true } },
	}));
	await mf.ready;
	const url = "http://worker.test";
	const request = (path: string, init: RequestInit = {}) => mf.dispatchFetch(`${url}${path}`, { ...init, headers: { Authorization: "Bearer test-token", ...init.headers } }) as Promise<Response>;
	return { url, request, fetch: ((input, init) => mf.dispatchFetch(input, init)) as typeof fetch, stop: () => mf.dispose() as Promise<void> };
}
