/** Core memory types, mirroring the Python reference's Message / Part / Node. */

export type Kind = "user" | "talk" | "tool" | "echo" | "note";

export const KINDS: ReadonlySet<string> = new Set<Kind>(["user", "talk", "tool", "echo", "note"]);

export function isKind(value: unknown): value is Kind {
	return typeof value === "string" && KINDS.has(value);
}

export interface Message {
	readonly i: number;
	readonly kind: Kind;
	readonly text: string;
	readonly size: number;
	readonly date: string;
}

export interface NewMessage {
	readonly kind: Kind;
	readonly text: string;
	readonly date?: string;
}

/** The text a summary sees for a message, and the basis of its byte size. */
export function messageSource(message: Pick<Message, "kind" | "text">): string {
	return `${message.kind}: ${message.text}`;
}

/** An aligned power-of-two range of messages: level `l`, index `i`, covering [i·2^l, (i+1)·2^l). */
export class Part {
	readonly l: number;
	readonly i: number;

	constructor(l: number, i: number) {
		this.l = l;
		this.i = i;
	}

	get n(): number {
		return 2 ** this.l;
	}

	get start(): number {
		return this.i * this.n;
	}

	get end(): number {
		return this.start + this.n;
	}

	get address(): string {
		return `${this.start}+${this.n}`;
	}

	get key(): string {
		return `${this.l}:${this.i}`;
	}
}

export function children(part: Part): [Part, Part] {
	return [new Part(part.l - 1, part.i * 2), new Part(part.l - 1, part.i * 2 + 1)];
}

/** Number of bits needed for `n` (Python's int.bit_length) for 0 <= n < 2^31. */
export function bitLength(n: number): number {
	return n <= 0 ? 0 : 32 - Math.clz32(n);
}

export interface Node {
	readonly l: number;
	readonly i: number;
	readonly text: string;
	readonly size: number;
}

export interface TokenUsage {
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
}

export interface UsageRow extends TokenUsage {
	readonly at: string;
	readonly role: "agent" | "compactor";
	readonly model: string;
	readonly ok: boolean;
}

export class StoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StoreError";
	}
}
