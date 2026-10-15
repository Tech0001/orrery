#!/usr/bin/env bash
# Installs or upgrades orrery on this machine (the server). Run as root from a staged, tested copy:
#
#   sudo bash ~/orrery-stage/deploy/install.sh ~/orrery-stage
#
# Idempotent. It never overwrites /etc/orrery/config.toml or the orrery SSH key, never enables an agent
# (systemctl enable --now orrery@<Name>) and never restarts a running one.
set -euo pipefail

src="${1:?usage: install.sh <staged orrery tree>}"
src="$(cd "$src" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "install.sh: run with sudo" >&2; exit 1; }
[ -f "$src/src/cli/main.ts" ] && [ -d "$src/node_modules" ] || {
	echo "install.sh: $src is not a staged orrery tree (run npm ci --ignore-scripts there first)" >&2
	exit 1
}
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' || {
	echo "install.sh: Node >= 22.19 is required" >&2
	exit 1
}
admin="${SUDO_USER:-}"
# This host's LAN address: the source of the default route (hostname -I also lists Docker bridges).
ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
[ -n "$ip" ] || ip="$(hostname -I | awk '{print $1}')"

echo "== packages"
missing=()
command -v tmux >/dev/null || missing+=(tmux)
command -v rsync >/dev/null || missing+=(rsync)
if [ "${#missing[@]}" -gt 0 ]; then apt-get install -y "${missing[@]}"; else echo "tmux and rsync present"; fi

echo "== user orrery"
id orrery >/dev/null 2>&1 || useradd --system --home-dir /var/lib/orrery --create-home --shell /bin/bash orrery
# Root touches only the home directory itself (its parent is root's). Everything inside it is done as orrery, so a
# symlink planted there can never redirect a root write or chown (for example .profile -> /etc/shadow).
[ -L /var/lib/orrery ] && { echo "install.sh: /var/lib/orrery is a symlink; refusing" >&2; exit 1; }
install -d -m 0700 -o orrery -g orrery /var/lib/orrery
as_orrery() { runuser -u orrery -- "$@"; }
as_orrery mkdir -p /var/lib/orrery/ssh /var/lib/orrery/run /var/lib/orrery/.ssh
as_orrery chmod 0700 /var/lib/orrery/ssh /var/lib/orrery/run /var/lib/orrery/.ssh

echo "== code: $src -> /opt/orrery"
install -d -m 0755 /opt/orrery
rsync -a --delete --exclude .git --exclude .superpowers --exclude test --exclude reference "$src/" /opt/orrery/
chown -R root:root /opt/orrery
chmod -R u+rwX,go+rX,go-w /opt/orrery
ln -sfn /opt/orrery/src/cli/main.ts /usr/local/bin/orrery
ln -sfn /opt/orrery/deploy/orrery-attach /usr/local/bin/orrery-attach

echo "== config"
install -d -m 0750 -o root -g orrery /etc/orrery
if [ -f /etc/orrery/config.toml ]; then
	echo "kept /etc/orrery/config.toml"
else
	install -m 0640 -o root -g orrery /opt/orrery/deploy/config.example.toml /etc/orrery/config.toml
	echo "wrote /etc/orrery/config.toml from the example: review it"
fi

# Manual commands (sudo -iu orrery orrery …) get the same secrets as the services.
source_env='set -a; [ -r /etc/orrery/env ] && . /etc/orrery/env; set +a'
as_orrery sh -c 'grep -qxF "$1" /var/lib/orrery/.profile 2>/dev/null || printf "%s\n" "$1" >> /var/lib/orrery/.profile' sh "$source_env" ||
	echo "warning: could not update /var/lib/orrery/.profile; add this line by hand: $source_env"

echo "== keys"
if [ ! -f /var/lib/orrery/ssh/id_ed25519 ]; then
	runuser -u orrery -- ssh-keygen -q -t ed25519 -N "" -C "orrery@$(hostname)" -f /var/lib/orrery/ssh/id_ed25519
	echo "created the orrery tool key"
fi
admin_keys="$(getent passwd "$admin" 2>/dev/null | cut -d: -f6)/.ssh/authorized_keys"
if [ -n "$admin" ] && [ -f "$admin_keys" ] && ! as_orrery test -e /var/lib/orrery/.ssh/authorized_keys; then
	# Read as root, written as orrery.
	as_orrery sh -c 'umask 077; cat > /var/lib/orrery/.ssh/authorized_keys' < "$admin_keys"
	echo "attach access: copied $admin's authorized_keys to orrery ($(grep -c . "$admin_keys") keys:" \
		"$(awk '{print $3}' "$admin_keys" | paste -sd, -)), so 'ssh orrery@$ip' accepts the same keys"
	echo "  (a one-time copy: later changes to $admin's keys do not reach orrery)"
fi

echo "== systemd"
install -m 0644 /opt/orrery/deploy/systemd/orrery@.service /opt/orrery/deploy/systemd/orrery-backup.service \
	/opt/orrery/deploy/systemd/orrery-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now orrery-backup.timer

running="$(systemctl list-units --type=service --state=running --plain --no-legend 'orrery@*' | awk '{print $1}')"
cat <<DONE

orrery is installed. Next steps (docs/deploy.md has the details):
  1. Workstation, once: allow the server's tool key for your account (and enable sshd):
       echo 'from="$ip" $(as_orrery cat /var/lib/orrery/ssh/id_ed25519.pub)' >> ~/.ssh/authorized_keys
  2. sudo -iu orrery orrery trust-host workstation
  3. sudo -iu orrery orrery login openai
  4. sudo systemctl enable --now orrery@Atlas
  5. Attach (terminal): ssh -t orrery@$ip orrery-attach Atlas
DONE
if [ -n "$running" ]; then
	echo
	echo "Running agents keep the old code until restarted: ${running//$'\n'/ }"
fi
