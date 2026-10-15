# Orrery memory Worker

A Worker and two SQLite-backed Durable Object classes store encrypted agent files, locks, the agent directory and a key check. The encryption key stays with Orrery.

For installation, deployment, credentials and free-plan limits, see [Your own Cloudflare Worker](../docs/remote.md#your-own-cloudflare-worker).

Install with `npm install --ignore-scripts`. `npm run dev` runs locally; `npm run typecheck` checks the Worker using the repository's TypeScript installation. The root remote tests bundle with Wrangler's installed esbuild and use its Miniflare runtime. Neither tests nor Orrery deploy this Worker.

The v1 fetch manifest retains `snapshot: { n, parts }`, `saves: [n, …]` and `newestSave`. It also supplies optional `bytes` (total transfer size) and `saveParts` (save number to part count) so clients can scale download deadlines and fetch saves larger than one SQLite value. Each snapshot also carries a `generation` which the client supplies when reading parts. A changed generation or a pruned file causes a new manifest fetch, bounded to three attempts; mixed snapshot versions are never returned. Snapshot uploads use zero-based `part` and `parts` query arguments. Writes recheck the lock after reading the request body. Unfinished snapshots stay private until their final part commits, and a new lock discards unfinished uploads.
