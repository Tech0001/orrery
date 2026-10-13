/** Authenticates the HTTP API and routes encrypted memory requests to SQLite Durable Objects. */
import { type Env, failure, NAME } from "./common.ts";
export { LaneObject } from "./lane.ts";
export { IndexObject } from "./index-object.ts";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const supplied = request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
		const encode = new TextEncoder();
		const [expected, actual] = await Promise.all([
			crypto.subtle.digest("SHA-256", encode.encode(env.ORRERY_TOKEN ?? "")),
			crypto.subtle.digest("SHA-256", encode.encode(supplied)),
		]);
		const matches = crypto.subtle.timingSafeEqual(expected, actual);
		if (!env.ORRERY_TOKEN || !supplied || !matches) return failure(401, "auth");
		const url = new URL(request.url);
		let response: Response;
		if (url.pathname === "/v1/check" || (url.pathname === "/v1/lanes" && request.method === "GET")) {
			response = await env.INDEX.get(env.INDEX.idFromName("index")).fetch(request);
		} else {
			const match = /^\/v1\/lanes\/([^/]+)(.*)$/.exec(url.pathname);
			if (!match) return failure(404, "not-found");
			if (!NAME.test(match[1])) return failure(400, "refused");
			// Internal object routes cannot be called through the public Worker.
			if (match[2] === "/entry") return failure(404, "not-found");
			response = await env.LANES.get(env.LANES.idFromName(match[1])).fetch(request);
		}
		const headers = new Headers(response.headers);
		headers.set("Cache-Control", "no-store");
		return new Response(response.body, { status: response.status, headers });
	},
};
