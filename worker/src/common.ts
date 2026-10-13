/** Shared Worker bindings, input checks and binary helpers; memory bytes remain opaque. */
export interface Env {
	LANES: DurableObjectNamespace;
	INDEX: DurableObjectNamespace;
	ORRERY_TOKEN: string;
	/** Local runtime tests only; omit in deployed configuration. */
	ORRERY_STALE_MS?: string;
}
export const CHUNK_BYTES = 1024 * 1024;
export const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export class Problem extends Error {
	readonly status: number;
	readonly kind: string;
	constructor(status: number, kind: string) { super(kind); this.status = status; this.kind = kind; }
}
export const empty = () => new Response(null, { status: 204 });
export const failure = (status: number, kind: string) => Response.json({ error: kind }, { status });
export function number(value: unknown, min = 0): number {
	if (typeof value === "string" && /^-?\d+$/.test(value)) value = Number(value);
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new Problem(400, "refused");
	return value;
}
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const value: unknown = await request.json();
		if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch { /* malformed input */ }
	throw new Problem(400, "refused");
}
export const same = (a: ArrayBuffer, b: ArrayBuffer) => a.byteLength === b.byteLength && new Uint8Array(a).every((value, i) => value === new Uint8Array(b)[i]);
export function base64(bytes: ArrayBuffer): string {
	let text = "";
	for (const value of new Uint8Array(bytes)) text += String.fromCharCode(value);
	return btoa(text);
}
export function unbase64(text: string | null): ArrayBuffer {
	if (text === null || text.length > 90_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Problem(400, "refused");
	return Uint8Array.from(atob(text), (value) => value.charCodeAt(0)).buffer;
}
export async function protect(run: () => Promise<Response>): Promise<Response> {
	try { return await run(); } catch (error) {
		if (error instanceof Problem) return failure(error.status, error.kind);
		throw error; // Preserve platform failures (including quota errors).
	}
}
