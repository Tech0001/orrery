# Contributing to Orrery

Issues and pull requests are welcome: bug reports, fixes, docs, tests and features.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Reporting a bug

Open an issue with:

- the Orrery commit (`git rev-parse --short HEAD`) and Node version (`node --version`)
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

Orrery needs Node 22.19 or newer. Keep install scripts off for every npm install in this repo, including `worker/`.
The README's [Development](README.md#development) section covers the Bun store check, the Python parity oracle and the
real pi, OMP and Ori tests.

To try a change in your real lanes, commit it and run `npm run install-local`. It installs the last commit into
`~/.orrery/app`; `orrery install --rollback` undoes it.

## Making a change

- Open an issue first for larger changes, so the approach is agreed before the work: a new tool adapter, a memory
  format change, a new remote storage kind, or anything that changes what is sent to a model.
- Keep each pull request to one focused change.
- Add a test that fails without the change. For a bug fix, start with the failing test.
- `npm run check` must pass. CI runs it on Ubuntu with Node 22.19 and 24.
- Update the README or the guide in `docs/` when users will see the change.
- Tests use synthetic data and scratch homes, never a real `~/.pi`, `~/.claude`, `~/.omp` or Orrery data folder.
  Write fake keys in two pieces (`"sk-" + "proj-…"`) so secret scanners don't flag them.

## Areas that need extra care

- **The store.** Lanes hold long histories. Existing memory has to keep opening after an upgrade, so a change to the
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
- **Remote lanes.** One machine writes a lane at a time, and memory is encrypted before upload. Storage changes must
  pass the shared contract tests in `test/remote/` ([remote lanes](docs/remote.md)).

## Dependencies

A new package needs a clear reason; Node's built-in modules come first. Versions are pinned exactly, without `^` or
`~`. A new or upgraded version should be at least two weeks old, which leaves time for a compromised release to be
caught.

## Style

TypeScript as ES modules, indented with tabs. There is no formatter, so match the surrounding code. Commit messages
have a short summary line, then a body explaining why.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
