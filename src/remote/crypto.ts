/** Authenticated encryption of remote files and printable recovery codes for their shared key. */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { RemoteError } from "./types.ts";

export type FileKind = "save" | "log" | "snapshot" | "check";
const VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function createKey(): Uint8Array {
	return randomBytes(KEY_BYTES);
}

function validateKey(key: Uint8Array): void {
	if (key.byteLength !== KEY_BYTES) throw new RemoteError("corrupt", "that recovery code is not valid");
}

export function keyToCode(key: Uint8Array): string {
	validateKey(key);
	return Buffer.from(key).toString("base64url");
}

export function codeToKey(code: string): Uint8Array {
	const trimmed = code.trim();
	const key = Buffer.from(trimmed, "base64url");
	// Buffer decoding is permissive; require canonical base64url, including the otherwise unused final bits.
	if (!/^[A-Za-z0-9_-]{43}$/.test(trimmed) || key.byteLength !== KEY_BYTES || keyToCode(key) !== trimmed) {
		throw new RemoteError("corrupt", "that recovery code is not valid");
	}
	return key;
}

function associatedData(lane: string, kind: FileKind, n: number): Uint8Array {
	if (!Number.isSafeInteger(n) || n < 0) throw new RemoteError("corrupt", "that remote file number is not valid");
	return Buffer.from(`orrery/v1/${lane}/${kind}/${n}`);
}

export function seal(key: Uint8Array, lane: string, kind: FileKind, n: number, plain: Uint8Array): Uint8Array {
	validateKey(key);
	const aad = associatedData(lane, kind, n);
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(aad);
	return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export function unseal(key: Uint8Array, lane: string, kind: FileKind, n: number, sealed: Uint8Array): Uint8Array {
	try {
		validateKey(key);
		if (sealed.byteLength < 1 + NONCE_BYTES + TAG_BYTES || sealed[0] !== VERSION) throw new Error("Invalid envelope");
		const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 1 + NONCE_BYTES), { authTagLength: TAG_BYTES });
		decipher.setAAD(associatedData(lane, kind, n));
		decipher.setAuthTag(sealed.subarray(-TAG_BYTES));
		return Buffer.concat([decipher.update(sealed.subarray(1 + NONCE_BYTES, -TAG_BYTES)), decipher.final()]);
	} catch {
		throw new RemoteError("corrupt", "a file from the remote could not be decrypted");
	}
}

export const CHECK_PLAIN: Uint8Array = Buffer.from("orrery remote key check v1");

export function sealCheck(key: Uint8Array): Uint8Array {
	return seal(key, "-", "check", 0, CHECK_PLAIN);
}

export function keyMatches(key: Uint8Array, check: Uint8Array): boolean {
	validateKey(key);
	try {
		const plain = unseal(key, "-", "check", 0, check);
		return plain.byteLength === CHECK_PLAIN.byteLength && timingSafeEqual(plain, CHECK_PLAIN);
	} catch {
		return false;
	}
}
