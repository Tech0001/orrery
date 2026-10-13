#!/usr/bin/env bash
# Nightly: snapshot every lane's memory, then mirror the backups to a configured host.
# A systemd user service may not have node on its PATH, and orrery needs it.
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
set -euo pipefail
home="${ORRERY_HOME:-$HOME/.orrery}"
backups="$home/backups"
settings="$home/backup.env"
# rsync --delete from a missing or empty folder would wipe the remote copy, so refuse.
require_backups() {
	if [ ! -d "$backups" ] || [ -z "$(ls -A "$backups")" ]; then
		echo "orrery-backup: $backups is missing or empty; not syncing" >&2
		return 1
	fi
}

orrery backup
require_backups

if [ ! -f "$settings" ]; then
	echo "orrery-backup: backup.env is missing; create $settings (see docs/deploy.md)" >&2
	exit 1
fi
# This is the user's own shell configuration, never a file in the checkout.
source "$settings"
for name in BACKUP_HOST BACKUP_USER BACKUP_IDENTITY_FILE; do
	if [ -z "${!name:-}" ]; then
		echo "orrery-backup: set $name in backup.env" >&2
		exit 1
	fi
done
rsync -a --delete -e "ssh -i \"$BACKUP_IDENTITY_FILE\" -o IdentitiesOnly=yes -o BatchMode=yes" \
	"$backups/" "$BACKUP_USER@$BACKUP_HOST:orrery-workstation-backups/"
