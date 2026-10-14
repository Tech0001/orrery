import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformAsset } from "../../src/install/update.ts";

/** Local release servers and archives for the update and install.sh tests; a file calls `cleanupFakes` in afterEach. */
export const servers: Server[] = [];
const dirs: string[] = [];

export function cleanupFakes(): void {
	for (const s of servers.splice(0)) {
		s.closeAllConnections();
		s.close();
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function scratch(prefix = "orrery-update-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/**
 * A server for <base>/latest (302 to <base>/tag/v<latest>), <base>/latest/download/<asset> (the latest's file), and
 * <base>/download/v<x>/<asset>; `stall` never answers downloads.
 */
export async function releasesServer(latest: string, files: Record<string, Buffer>, options: { stall?: boolean; slow?: number; query?: boolean } = {}): Promise<{ base: string; server: Server; hits: string[] }> {
	const hits: string[] = [];
	const server = createServer((req, res) => {
		hits.push(req.url ?? "");
		if (req.url === "/releases/latest") return void res.writeHead(302, { location: `/releases/tag/v${latest}${options.query ? "?x=1#frag" : ""}` }).end();
		const m = /^\/releases\/download\/v([^/]+)\/([^/]+)$/.exec(req.url ?? "");
		const l = /^\/releases\/latest\/download\/([^/]+)$/.exec(req.url ?? "");
		if ((m || l) && options.stall) return; // never answers
		const body = m ? files[`${m[1]}/${m[2]}`] : l ? files[`${latest}/${l[1]}`] : undefined;
		if (body === undefined) return void res.writeHead(404).end();
		if (options.slow !== undefined && m?.[2] === platformAsset()) {
			// a steady trickle: a chunk every `slow` ms, so the whole takes longer than the idle limit
			res.writeHead(200, { "content-length": String(body.length) });
			const size = Math.ceil(body.length / 6);
			let at = 0;
			const timer = setInterval(() => {
				res.write(body.subarray(at, at + size));
				at += size;
				if (at >= body.length) {
					clearInterval(timer);
					res.end();
				}
			}, options.slow);
			res.on("close", () => clearInterval(timer));
			return;
		}
		res.writeHead(200).end(body);
	});
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`, server, hits };
}

export const PLATFORM = platformAsset().replace(/^orrery-|\.tar\.gz$/g, "");

/** A tar.gz holding orrery-<v>-<platform>/ with VERSION and a bin/orrery script, and its SHA256SUMS line. */
export function fakeArchive(version: string, script = `#!/bin/sh\necho "orrery ${version}"\n`, held = version, platform = PLATFORM): { archive: Buffer; sums: Buffer } {
	const dir = scratch("orrery-archive-");
	const top = `orrery-${version}-${platform}`;
	mkdirSync(join(dir, top, "bin"), { recursive: true });
	writeFileSync(join(dir, top, "VERSION"), `${held}\n`);
	if (script !== "") writeFileSync(join(dir, top, "bin", "orrery"), script, { mode: 0o755 });
	execFileSync("tar", ["-czf", join(dir, "a.tar.gz"), "-C", dir, top]);
	const archive = readFileSync(join(dir, "a.tar.gz"));
	return { archive, sums: Buffer.from(`${createHash("sha256").update(archive).digest("hex")}  orrery-${platform}.tar.gz\n`) };
}

/** The server's files for one release: <version>/<asset> for the archive and SHA256SUMS. */
export function release(version: string, script?: string, held?: string, platform = PLATFORM): Record<string, Buffer> {
	const { archive, sums } = fakeArchive(version, script, held, platform);
	return { [`${version}/orrery-${platform}.tar.gz`]: archive, [`${version}/SHA256SUMS`]: sums };
}
