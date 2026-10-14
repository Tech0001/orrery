# AGENTS.md

How to change Orrery with a coding agent.

- Build and test: `npm run check` (typecheck and the full suite on Node), `npm run test:binary` (the compiled binary),
  `npm run test:bun-suite` (the suite on Bun). Needs Node 22.19+ and the Bun version in `.bun-version`.
- Try a change on your machine: commit it, then `npm run install-local`. It builds a release from the last commit and
  installs it as `<version>-<commit>`. `orrery install --rollback` goes back; `orrery update` returns to the latest release.
- Many changes need no code: models, memory sizes, when compaction happens and each lane's tool are settings in
  `~/.orrery/config.toml` (see docs/).
- Do not weaken the credential guard (`src/lane/guard*.ts`, `src/pi/guard.ts`, `src/claude/guard.ts`) or the handling of
  logins and keys (`src/lane/credentials.ts`, `src/lane/summary-sources.ts`) without saying so in the pull request.
- Code that pi or OMP loads imports runtime values only from `@earendil-works/pi-ai/compat` and
  `@earendil-works/pi-ai/providers/all` among pi's packages (`test/pi/pi-entry-points.test.ts` checks it).
- Public repository: commits, tests and docs carry no personal paths, hostnames, IP addresses or keys. Fake keys in tests
  are written in two pieces (`"sk-" + "proj-…"`) so scanners do not flag them.
