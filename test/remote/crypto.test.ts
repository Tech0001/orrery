import { createDecipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import { codeToKey, createKey, keyMatches, keyToCode, seal, sealCheck, unseal } from "../../src/remote/crypto.ts";

const text = (s: string) => new TextEncoder().encode(s);

describe("remote encryption", () => {
	it("uses the literal v1 associated data with AES-256-GCM", () => {
		const key = new Uint8Array(32).fill(7);
		const sealed = seal(key, "Atlas", "save", 7, text("known plaintext"));
		const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 13));
		decipher.setAAD(Buffer.from("orrery/v1/Atlas/save/7"));
		decipher.setAuthTag(sealed.subarray(-16));
		expect(Buffer.concat([decipher.update(sealed.subarray(13, -16)), decipher.final()]).toString()).toBe("known plaintext");
	});

	it.each([0, 16, 24, 31, 33])("reports a %i-byte key as corrupt", (length) => {
		const key = new Uint8Array(length);
		const valid = seal(createKey(), "Atlas", "save", 7, text("hello"));
		for (const operation of [() => keyToCode(key), () => seal(key, "Atlas", "save", 7, text("hello")), () => unseal(key, "Atlas", "save", 7, valid), () => sealCheck(key), () => keyMatches(key, valid)]) {
			expect(operation).toThrow(expect.objectContaining({ kind: "corrupt" }));
		}
	});

	it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("reports invalid save number %s as corrupt", (n) => {
		const key = createKey();
		const sealed = seal(key, "Atlas", "save", 0, text("hello"));
		expect(() => seal(key, "Atlas", "save", n, text("hello"))).toThrow(expect.objectContaining({ kind: "corrupt" }));
		expect(() => unseal(key, "Atlas", "save", n, sealed)).toThrow(expect.objectContaining({ kind: "corrupt" }));
	});

	it("round-trips and binds a file to its lane, kind and number", () => {
		const key = createKey();
		const sealed = seal(key, "Atlas", "save", 7, text("hello"));
		expect(new TextDecoder().decode(unseal(key, "Atlas", "save", 7, sealed))).toBe("hello");
		for (const [lane, kind, n] of [["Birch", "save", 7], ["Atlas", "log", 7], ["Atlas", "save", 8]] as const) {
			expect(() => unseal(key, lane, kind, n, sealed)).toThrow(expect.objectContaining({ kind: "corrupt" }));
		}
	});

	it("rejects a flipped byte and the wrong key", () => {
		const key = createKey();
		const sealed = seal(key, "Atlas", "save", 1, text("hello"));
		const flipped = sealed.slice();
		flipped[20] ^= 1;
		expect(() => unseal(key, "Atlas", "save", 1, flipped)).toThrow(expect.objectContaining({ kind: "corrupt" }));
		expect(() => unseal(createKey(), "Atlas", "save", 1, sealed)).toThrow(expect.objectContaining({ kind: "corrupt" }));
	});

	it("never repeats a nonce for the same plaintext", () => {
		const key = createKey();
		expect(seal(key, "Atlas", "save", 1, text("x"))).not.toEqual(seal(key, "Atlas", "save", 1, text("x")));
	});

	it("turns a key into a 43-character code and back, tolerating spaces", () => {
		const key = createKey();
		const code = keyToCode(key);
		expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(codeToKey(` ${code}\n`)).toEqual(key);
		expect(() => codeToKey("short")).toThrow(/not valid/);
	});

	it("verifies a recovery code against the remote's check", () => {
		const key = createKey();
		const check = sealCheck(key);
		expect(keyMatches(key, check)).toBe(true);
		expect(keyMatches(createKey(), check)).toBe(false);
	});

	it("round-trips empty and binary files through Uint8Array slices", () => {
		const key = createKey();
		for (const plain of [new Uint8Array(), new Uint8Array([0, 255, 128, 1])]) {
			const sealed = seal(key, "Atlas", "snapshot", 0, plain);
			expect(sealed.byteLength).toBe(plain.byteLength + 29);
			const padded = new Uint8Array(sealed.length + 10);
			padded.set(sealed, 5);
			expect([...unseal(key, "Atlas", "snapshot", 0, padded.subarray(5, -5))]).toEqual([...plain]);
		}
	});

	it("rejects truncated envelopes, unknown versions, and nonce or tag changes", () => {
		const key = createKey();
		const sealed = seal(key, "Atlas", "save", 1, text("hello"));
		for (const length of [0, 1, 12, 28, sealed.length - 1]) {
			expect(() => unseal(key, "Atlas", "save", 1, sealed.subarray(0, length))).toThrow(expect.objectContaining({ kind: "corrupt" }));
		}
		for (const index of [0, 1, sealed.length - 1]) {
			const changed = sealed.slice();
			changed[index] ^= 1;
			expect(() => unseal(key, "Atlas", "save", 1, changed)).toThrow(expect.objectContaining({ kind: "corrupt" }));
		}
	});

	it("refuses noncanonical recovery codes and checks carrying the wrong known value", () => {
		const code = keyToCode(new Uint8Array(32));
		for (const invalid of [`${code}=`, `${code}!`, `${code.slice(0, -1)}B`, code.slice(1)]) {
			expect(() => codeToKey(invalid)).toThrow(/not valid/);
		}
		const key = createKey();
		expect(keyMatches(key, seal(key, "-", "check", 0, text("other value")))).toBe(false);
		expect(keyMatches(key, new Uint8Array())).toBe(false);
	});
});
