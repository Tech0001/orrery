# Remote agent memory

## Commands

Register a remote with `orrery remote add home --server home:orrery-memory` or
`orrery remote add cloud --cloudflare https://your-worker.example.com`.
Tokens and existing recovery codes are entered at hidden prompts. Without a terminal,
use `--token-file <path>` and, for an existing remote, `--code-file <path>`.
The token file must contain one line (a trailing newline is allowed). A code
file is refused on a remote without a key check; a remote with agents but no
key check needs its original check restored before it can be registered.
Keep the recovery code shown at creation; `orrery remote key <name>` displays
it again with a secret warning. `orrery remote test <name>` checks reachability,
the agent lock, and decryption. It removes its empty `orrery-test` agent, including
one left by an older test, but preserves any memory stored there. The TUI's Add remote dialog shows
a newly created recovery code once in a separate modal; the token stays hidden.

If the remote is already in this machine's config, run `orrery remote add home`
without connection flags to recover its key. Orrery uses the configured endpoint,
asks for a missing Cloudflare token, then verifies the recovery code before saving
the secret here. `--token-file` and `--code-file` also work for this recovery path;
the config stays unchanged. A remote you wrote into the config yourself, before its first
`remote add`, has no key check yet: Orrery refuses it until you confirm it is new with
`orrery remote add home --new`, which creates its key (only while it holds no agents).

To move an existing, closed agent onto a remote:

```sh
orrery agent push Atlas --to home
```

On another machine, register the same remote using its recovery code, then:

```sh
orrery agent pull Atlas --from home
```

Pull needs no folder: the agent opens in any folder with `orrery agent Atlas`. Add
`--folder /absolute/path/to/project` (an absolute path or `~/...`, which must already
exist) to give it a default folder on this machine. Pull copies the agent's portable
settings, its instructions and its newest memory; it refuses an agent already in this
machine's config. If its `reads` names other agents, add those agents here first.
Default folders and project files do not travel with the memory.

`orrery remote agents home [--json]` lists stored agents and holders;
`orrery remote log Atlas [--json]` shows decrypted save headers and recorded
takeovers, including the previous holder. An ordinary close and reopen is not
a takeover.
When a holder's lock has gone stale, `orrery agent takeover Atlas` shows its
machine and last-seen time and asks before taking and releasing it. Scripts
can use `--yes`; it does not override a fresh lock on another machine.

`orrery agent local Atlas` fetches the newest copy and clears the remote setting.
The remote copy stays unless `--delete-remote` is given and deletion confirmed.
If another holder used the remote while confirmation was open, deletion is
refused and both copies stay. The settings page's (C) Memory home uses the same push and local
commands; make an agent local before choosing a different remote.

## Instructions and other machines

An agent's `instructions.md` travels with its memory, sealed the same way (encrypted before upload and bound to the
agent's name), so every machine opens the same agent. It rides in every save and snapshot, and a pull fetches it. Up to
256 KiB travels. A larger file stays on its machine: it is never sent and never replaced, and each check-out says to
shorten it. (Only the first 32 KB reach the model either way.)

Each time an agent is checked out, Orrery settles the file against the copy that travels:

- Only the remote's copy changed: the file gets it, with a notice.
- Only this machine's file changed: the next save sends it.
- Changed on two machines: the remote's copy wins, and this machine's is kept beside it as
  `instructions-unsaved-<time>.md`, with a notice. Nothing is lost.
- Emptied: a blank file is a deliberate clear, and it travels. Another machine that arrives at an empty copy keeps its
  own text aside the same way.
- Deleted: a deleted file does not travel. The remote's copy is restored at the next check-out, with a notice. To take
  the instructions away, empty the file instead.

A machine that has never agreed with the remote takes the remote's copy, and never clears it.

If a machine finds a different or rolled-back history on its remote (another memory under the same name, or a remote
restored from an older backup), it does not replace its local memory. It sets that memory aside as
`memory-before-remote-<time>.sqlite` in the agent's data folder, with a notice, and then uses the remote's copy.

Known limit: a remote rolled back within one history, saved past by another machine and then covered by a new
snapshot, can't be detected yet. The first machine's check-out rebuilds from that snapshot and keeps only its own
unsent rows. Saves it had already sent after the rollback point are gone from its working copy. Detecting it needs each
save to name the one before it, which the storage format does not carry.

Storage names: the remote's internal format keeps the word "lane" (the Worker's `/v1/lanes/…` routes and `LANES`
binding, and the string bound into every sealed file). Nobody types them, and renaming them would strand stored memory.
The server folder or Worker URL you registered stays exactly as you named it.

`orrery remote remove home --yes` removes the local registration and its
credentials only after no configured agent uses it. Save the recovery code
first with `orrery remote key home`: removal deletes this machine's saved
encryption key, and the remote memory needs that code to be read again.

## Limits

- **One machine at a time.** An agent is open on one machine; another machine waits, or takes over once the lock is stale
  (3 minutes without renewal) and you say yes. The machine that lost the agent stops recording and says where it went.
- **Closing the lid mid-turn loses that turn.** Every finished turn is saved right away.
- **No connection at open, no memory.** The session runs without memory and says why. If the connection drops while
  the agent is open, nothing is lost: saves wait on this machine and go up when the remote is back.
- **Each machine's config is its own** after `orrery agent pull`. A summary model chosen with `/compactor` travels with
  the memory, and so do the agent's instructions (below); other settings, such as the tool and default folder, don't.
- **Claude Code and Codex can't ask questions at start.** When an agent's lock is stale on another machine, the session
  opens it read-only and tells you to run `orrery agent takeover <Name>`. `orrery agent` and the TUI ask before they
  start the tool.
- **OMP gives an extension 2 seconds at shutdown.** A final release that takes longer is cut off; the lock then frees
  itself after 3 minutes (this machine retakes it at once; another machine asks first). Check-out in OMP gives up after
  25 seconds and opens without memory.
- **What the remote's host can see:** agent names, file sizes and times. Never memory text, settings or usage: those are
  encrypted before upload.

## A folder on your own server

Orrery can keep an agent's memory in a folder on any server you reach over SSH.
The agent and its working copy run on your current machine. Orrery checks the
agent out when it opens, saves finished turns, and checks it in when it closes.
Only one machine holds an agent at a time.

Add an SSH host to your Orrery configuration, then name a folder on that host:

```toml
[hosts.home]
host = "server.example.internal"
user = "alex"
identity_file = "ssh/id_ed25519"

[remotes.home]
kind = "server"
host = "home"
folder = "orrery-memory"
```

Use an identity file (a relative path starts at `~/.orrery`) whose public key is authorized for that SSH user. Pin the
server's host key with `orrery trust-host home` before using the remote. Orrery
uses its own SSH configuration and known-hosts file; it does not depend on your
personal `~/.ssh/config`. Connections are noninteractive and refuse an untrusted
or changed host key.

A relative folder is relative to the SSH user's home; a leading `~/` also means
that user's home, and an absolute folder works too. The SSH user must be able
to create and write it. Spaces, quotes, dollar
signs, and a leading `-` are supported literally. Use a dedicated folder for
Orrery, on a filesystem with atomic directory creation, rename, and hard links.

The server needs an SSH service, `sh`, and standard command-line tools: `mkdir`,
`mv`, `ln`, `cat`, `date`, `rm`, `printf`, `wc`, `dd`, `cmp`, and `sleep` (with fractional
seconds, as on Linux and macOS). Nothing from Orrery, Node.js, Python, or a
database server needs to be installed there. Orrery sends the shell script with
each operation and transfers file bytes separately from the command.

Orrery encrypts memory, snapshots, and audit entries on your machine before
sending them. The host can see agent names, holder details, file sizes, and
times, but cannot read the memory. Keep the remote's recovery code somewhere
safe: another machine needs it to decrypt this remote.

Locks use the server's clock. After three minutes without a renewal or a
successful save, another machine can take over with confirmation. An old
holder's next write is refused. The short filesystem mutex is separate from
that agent lock; an abandoned operation's claim is recovered after 30 seconds when its
recorded server process is no longer alive. Large transfers do not evict a
live process. A fetch pins the files it needs and releases the mutex before
streaming, so a slow download does not block the holder's saves.

The remote keeps three snapshots and the saves after the oldest retained
snapshot. It also retains the newest save for retrying a save whose reply was
lost. Audit entries are never pruned. Removing an agent's remote copy leaves a
tiny fencing counter so a delayed write cannot affect a new agent of the same
name.

Lock and save calls time out after 15 seconds. Snapshot uploads and memory
fetches allow an additional second per MiB; the server announces download size
before sending the file frames. A network failure leaves the working copy on
your machine, with pending saves retried by the agent's session. If the remote
cannot be reached when an agent opens, that session runs without its memory.

## Your own Cloudflare Worker

Deploy the Worker in this repository to your own Cloudflare account. Orrery stores encrypted memory there; the Worker never receives your recovery code or encryption key. Cloudflare can see agent names, file sizes and times.

This one still needs a checkout of the Orrery repository: the Worker is deployed from its `worker/` folder, and the release does not carry it. Clone the repository, then:

```sh
cd worker
npm install --ignore-scripts
export PATH="$PWD/node_modules/.bin:$PATH"
wrangler login
wrangler secret put ORRERY_TOKEN
wrangler deploy
```

Run `wrangler login` yourself to authorize your account. For `ORRERY_TOKEN`, use a long random password from your password manager, keep a copy there, and paste it at Wrangler's hidden prompt. Do not put it in `wrangler.toml` or a command argument. `wrangler deploy` prints your Worker's HTTPS URL. You can change the Worker name in `worker/wrangler.toml` before deploying.

Then, on each machine:

```sh
orrery remote add cloud --cloudflare https://orrery-memory.YOUR-ACCOUNT.workers.dev
```

Orrery asks for the access token. On the first machine it creates an encryption key and shows a recovery code; keep that code safe. Other machines need the same token and recovery code. Orrery keeps them in its private `~/.orrery/remotes.json`, not in `config.toml`. An agent can be held by one machine at a time.

The Tools page reports Wrangler's location and version, checking both PATH and this repository's `worker/node_modules/.bin`. Deployment and sign-in remain commands you run yourself.

### Free-plan limits

Checked 2026-10-12: Durable Objects on the Free plan include **100,000 requests/day**, **5 million rows read/day**, **100,000 rows written/day**, and **5 GB stored across the account**. The Worker also has its own request allowance. A save writes multiple rows, index operations make additional requests, and deleting old files counts as writes. An open agent renews its lock about 1,440 times per day; saves, readers and snapshots add to that. See [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

At a daily limit Orrery reports `remote cloud is over Cloudflare's daily free limit until 00:00 UTC`. The working copy stays on this machine and pending saves can retry; opening an agent while its remote is unreachable runs without memory. Daily allowances reset at midnight UTC. The Free plan includes its SQLite allowance; paid-plan SQLite storage is billed according to Cloudflare's current pricing.

Files are split into 1 MiB database values, below the [2 MB SQLite row limit](https://developers.cloudflare.com/durable-objects/platform/limits/). Snapshot uploads and fetches allow 15 seconds plus one second per MiB. A snapshot becomes readable only after all its parts arrive. The newest three snapshots and all saves after the oldest kept snapshot remain available; audit log entries remain until the agent is deleted.

### Local checks

Install the Worker tools as above, then run from the repository root:

```sh
npm test -- test/remote/cloudflare.test.ts test/remote/cloudflare-worker.test.ts
npm --prefix worker run typecheck
```

These tests run the real local Cloudflare runtime and SQLite Durable Objects with temporary data and a test token; they never deploy or access your Cloudflare account. Integration tests report a named skip when `worker/node_modules` is absent; HTTP error tests still run. No install scripts are needed. For interactive development, put `ORRERY_TOKEN` in an untracked `worker/.dev.vars` file and run `npm --prefix worker run dev`. The deployed configuration uses the normal three-minute stale-lock interval; `ORRERY_STALE_MS` is a local-test override and should not be set in production.

