# Contributing to Orrery

Issues and pull requests are welcome: bug reports, fixes, docs, tests and features.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Reporting a bug

Open an issue with:

- the Orrery version (`orrery --version`; from a checkout, the commit from `git rev-parse --short HEAD`)
- the coding tool and its version: `orrery tools` lists pi, OMP, Claude Code and Codex
- what you ran, what you expected and what happened
- the error text

Remove keys, tokens, private paths and conversation text first. Never attach memory databases, credential files or
exports.

## Setup

```bash
git clone https://github.com/Tech0001/orrery.git
cd orrery
npm_config_ignore_scripts=true npm ci
npm run check
```

Tests and the typecheck need Node 22.19 or newer. Building the program needs Bun at the version in `.bun-version`
(`npm run install-local` refuses another version). The program carries Bun's runtime, so a change to `.bun-version`
also replaces `scripts/licenses/bun-LICENSE.md` with that Bun tag's `LICENSE.md`. Keep install scripts off for every
npm install in this repo, including `worker/`.

- `npm run check`: typecheck and the full suite on Node.
- `npm run test:binary`: the compiled program, built for this machine.
- `npm run test:bun-suite`: the suite on Bun.
- `npm run test:bun`: the alternate SQLite store check on Bun.
- `npm run demo`: the TUI with fictional agents, in a temporary home.

The tests use synthetic fixtures and scratch data only. Install `uv` to run the Python parity oracle as part of the
suite; without it, those parity cases skip. The reference implementation lives in
[reference/optchat-py](reference/optchat-py).

Tests against the real tools run when their programs are found and skip when they are not. To test a specific
installed program, name it, preferably the executable itself rather than an auto-updating shell wrapper:

```bash
ORRERY_TEST_PI=/path/to/pi npm test -- test/pi/real-pi.test.ts
ORRERY_TEST_OMP=/path/to/omp npm test -- test/omp/real-omp.test.ts
ORRERY_TEST_ORI=/path/to/ori ORRERY_TEST_PI=/path/to/pi ORRERY_TEST_OMP=/path/to/omp \
  npm test -- test/ori/real-ori.test.ts
```

These tests isolate agent homes and use fake model services. `ORRERY_TEST_ORI_STRICT=1` turns the named upstream
Ori/OMP compatibility skip into a failure. [Claude Code testing](docs/claude-code.md#testing) describes the separate
opt-in live script, which makes paid calls. CI runs the suite on Node 22.19 and 24 and on macOS. There the real-pi
tests use the npm pi from the dev dependencies and fail rather than skip (`ORRERY_REQUIRE_PI=1`); CI needs no other
agent binaries and no credentials.

To try a change on your own machine, commit it and run `npm run install-local`. It builds a release from the last
commit and installs it as `<version>-<commit>`, then wires your tools to it. `orrery install --rollback` goes back to the
previous version, and `orrery update --version <X>` returns to release X (plain `orrery update` installs only a newer
release).

## Making a change

- Open an issue first for larger changes, so the approach is agreed before the work: a new tool adapter, a memory
  format change, a new remote storage kind, or anything that changes what is sent to a model.
- Keep each pull request to one focused change.
- Add a test that fails without the change. For a bug fix, start with the failing test.
- `npm run check` must pass. CI runs it on Ubuntu with Node 22.19 and 24, and on macOS.
- Update the README or the guide in `docs/` when users will see the change.
- Tests use synthetic data and scratch homes, never a real `~/.pi`, `~/.claude`, `~/.omp` or Orrery data folder.
  Write fake keys in two pieces (`"sk-" + "proj-…"`) so secret scanners don't flag them.

## Areas that need extra care

- **The store.** Agents hold long histories. Existing memory has to keep opening after an upgrade, so a change to the
  store comes with a test that opens data written the old way.
- **Summaries and the view.** The summary prompts and view selection follow
  [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449). The Python reference in
  `reference/optchat-py` checks them, and their stable prefix keeps prompt caching working
  ([architecture](docs/architecture.md#keeping-the-prompt-prefix-stable)). Changes here need a stated reason, with the
  parity tests updated in the same pull request.
- **Credentials and the guard.** Never log, print or send a key to a model. Credential files stay mode 0600. A guard
  change comes with tests for the bypass it closes. The guard is not a sandbox, and the docs say what it covers.
- **The pi extension.** Code under `src/pi/` imports pi-ai only through entry points pi supplies. A test enforces this
  ([adapters and boundaries](docs/architecture.md#adapters-and-boundaries)).
- **Remote agents.** One machine writes an agent at a time, and memory is encrypted before upload. Storage changes must
  pass the shared contract tests in `test/remote/` ([remote agents](docs/remote.md)).

## Dependencies

A new package needs a clear reason; Node's built-in modules come first. Versions are pinned exactly, without `^` or
`~`. A new or upgraded version should be at least two weeks old, which leaves time for a compromised release to be
caught.

## Style

TypeScript as ES modules, indented with tabs. There is no formatter, so match the surrounding code. Commit messages
have a short summary line, then a body explaining why.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
