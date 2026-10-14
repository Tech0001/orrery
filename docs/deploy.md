# Running Orrery on an always-on machine

Most users run a lane inside [pi](pi.md), [OMP](omp.md) or [Claude Code](claude-code.md) on their workstation.
An always-on Linux host can instead run the older `orrery run` runtime. Each lane has a systemd unit and a private
tmux server, while its file and shell tools can execute on a workstation over SSH. The extension and service
must never write the same lane at the same time.

## Server layout

| Path or unit | Purpose |
|---|---|
| `/opt/orrery` | Root-owned application checkout |
| `/etc/orrery/config.toml` | Lane and host settings, mode 0640 |
| `/var/lib/orrery` | Memory, durable sessions, credentials, SSH keys and backups |
| `orrery@<Lane>.service` | One lane in a private `tmux -L orrery-<Lane>` server |
| `orrery-backup.timer` | Nightly local snapshots at 01:30 |

Stage a tested checkout on the server. It needs Node ≥ 22.19, npm and its locked dependencies:

```bash
cd ~/orrery-stage
npm_config_ignore_scripts=true npm ci
npm run check
sudo bash deploy/install.sh "$PWD"
```

The installer targets a Debian-style host with systemd. It installs missing tmux/rsync packages, creates the
`orrery` system user, installs code and service files, and enables the backup timer. It creates an example config
and tool SSH key only when they do not exist. It copies the invoking user's authorized keys once for attach access.
It does not start or restart lanes. Review the script before running it on your host.

Edit `/etc/orrery/config.toml` using [the server example](../deploy/config.example.toml). Choose your workstation's
DNS name, account, absolute workspace paths and models. Put provider secrets in `/etc/orrery/env`, with owner
`root:orrery` and mode 0640. The service and `orrery` login shell read it; secrets do not belong in the checkout.

Authorize the generated `/var/lib/orrery/ssh/id_ed25519.pub` on the workstation. Restrict the authorized key to your
server's source address if appropriate. Then trust the workstation's host key and sign in for summaries:

```bash
sudo -iu orrery orrery trust-host workstation
sudo -iu orrery orrery login openai
# Or: sudo -iu orrery orrery login openrouter --manual
```

## Run and attach

```bash
sudo systemctl enable --now orrery@Atlas
ssh -t orrery@server.example.internal orrery-attach Atlas
sudo -iu orrery orrery status
sudo systemctl stop orrery@Atlas
```

Ctrl-b d detaches. The lane keeps running. `/model provider/id [thinking]` changes the agent model;
`/compactor provider/id [thinking]` changes summaries. Both choices survive restarts; `reset` uses config again.

`deploy/orrery-lane` restarts an exited runtime with a delay from 2 to 60 seconds. A run lasting five minutes resets
the delay. The durable runtime resumes interrupted work. The stop helper signals the lane before closing tmux.
After upgrading code, restart a lane explicitly with `sudo systemctl restart orrery@Atlas`.

History import is a separate, reviewed step. On the machine holding the source history, run
`orrery import Atlas --dry-run`, inspect the report and preview, and transfer only that reviewed preview to the
server. With the lane closed, run `orrery import Atlas --commit <preview.jsonl>` and `orrery compact Atlas`.
The [pi guide](pi.md#imports-and-builds) describes selecting individual history files.

## Workstation backups

`orrery backup` snapshots all configured lanes and keeps fourteen days by default. The optional workstation timer
also mirrors those snapshots over SSH. Its destination settings live in `~/.orrery/backup.env`, outside the checkout:

```bash
mkdir -p ~/.orrery
install -m 600 deploy/workstation/backup.env.example ~/.orrery/backup.env
# Edit backup.env: BACKUP_HOST, BACKUP_USER, BACKUP_IDENTITY_FILE.
```

The env file contains shell assignments, so quote paths containing spaces. Use an SSH identity authorized for the
backup account. Check the host key interactively before enabling unattended backups. The remote destination is
`orrery-workstation-backups/` under that account's home. `rsync --delete` makes it a mirror of local retention.
The script takes the local snapshot first, then checks `backup.env` just before copying. A missing or incomplete
env file fails the copy with a plain message and a nonzero exit; the local snapshot remains. A failed snapshot
or empty local backup folder also stops the copy.

Copy `deploy/workstation/orrery-backup.service` and `.timer` into `~/.config/systemd/user/`. The service's
`ExecStart` is the installed script, `~/.orrery/app/current/deploy/workstation/backup.sh`, which
the installer puts in place.
Then run `systemctl --user daemon-reload`, `systemctl --user enable --now orrery-backup.timer`, and
`systemctl --user start orrery-backup.service` once to verify it. Check failures with
`journalctl --user -u orrery-backup.service`.

After an upgrade (`orrery update`), the timer keeps working: its service names `app/current`, which points at
the new version.

## Restore

Snapshots contain `memory.sqlite`, `memory.jsonl` and, for durable-runtime lanes, `session.sqlite`. Workstation
backups are under `~/.orrery/backups/<date>/<Lane>/`; server backups use `/var/lib/orrery/backups/`.
Keep remote backups and exports private: they contain conversation content.

Close the lane in every tool before restoring:

```bash
orrery restore Atlas --from 2026-10-01
# Or use an absolute backup directory with --from.
```

Restore refuses while a lane writer is running. It removes old WAL/SHM sidecars and status before copying snapshots,
so a crashed writer's pending journal cannot be replayed onto an older database. Restart the lane after verifying
its restored state.
