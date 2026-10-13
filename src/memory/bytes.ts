/** UTF-8 byte accounting and text helpers shared by the memory port. Sizes are always UTF-8 bytes. */

export function byteSize(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** The longest prefix of `text` within `limit` UTF-8 bytes, never splitting a character. */
export function cutBytes(text: string, limit: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= limit) return text;
	let end = Math.max(0, limit);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

/** The longest suffix of `text` within `limit` UTF-8 bytes, never splitting a character. */
export function tailBytes(text: string, limit: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= limit) return text;
	let start = bytes.length - Math.max(0, limit);
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

export function flatten(text: string): string {
	return text.replaceAll("\r\n", " ").replaceAll("\n", " ").replaceAll("\r", " ");
}

function pad(value: number, width = 2): string {
	return String(value).padStart(width, "0");
}

/** ISO 8601 in the process's local timezone, with its numeric offset (e.g. 2026-01-01T12:00:00.000-07:00). */
export function localIso(date: Date = new Date()): string {
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const abs = Math.abs(offset);
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
		`${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
	);
}

const TIMEZONE_SUFFIX = /(?:[Zz]|[+-]\d{2}:\d{2})$/;

/** Returns `value` unchanged if it is a parseable ISO date carrying a timezone; throws RangeError otherwise. */
export function validDate(value: string): string {
	if (typeof value !== "string" || !TIMEZONE_SUFFIX.test(value) || Number.isNaN(Date.parse(value))) {
		throw new RangeError(`Dates must be ISO 8601 with a timezone: ${String(value)}`);
	}
	return value;
}

/** Port of the Python reference cap_text: keep head and tail around a marker, counting code points. */
export function capText(text: string, limit = 30_000): string {
	const chars = Array.from(text);
	if (chars.length <= limit) return text;
	let keep = limit;
	let marker = "";
	for (;;) {
		marker = `\n... [${chars.length - keep} characters omitted] ...\n`;
		const next = Math.max(0, limit - Array.from(marker).length);
		if (next === keep) break;
		keep = next;
	}
	const head = Math.floor((keep + 1) / 2);
	const tail = Math.floor(keep / 2);
	return chars.slice(0, head).join("") + marker + (tail > 0 ? chars.slice(-tail).join("") : "");
}
