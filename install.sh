#!/bin/sh
# Installs Orrery from a GitHub release (https://github.com/Tech0001/orrery):
#   curl -fsSL https://github.com/Tech0001/orrery/releases/latest/download/install.sh | sh
# ORRERY_VERSION=0.6.1 installs that release instead of the latest. The script downloads this machine's archive and
# SHA256SUMS, checks the archive against SHA256SUMS, unpacks it in a temporary folder, and runs its
# `orrery install --from`, which installs it into ~/.orrery and asks before connecting pi, OMP and Claude Code.
set -eu

releases="${ORRERY_RELEASES_URL:-https://github.com/Tech0001/orrery/releases}"
fail() {
	printf 'orrery install: %s\n' "$*" >&2
	exit 1
}

case "$(uname -s)" in
	Linux) os=linux ;;
	Darwin) os=darwin ;;
	MINGW* | MSYS* | CYGWIN* | Windows*) fail "Windows is not supported directly; install Orrery inside WSL" ;;
	*) fail "$(uname -s) is not supported (Linux and macOS are)" ;;
esac
case "$(uname -m)" in
	x86_64 | amd64) arch=x64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) fail "$(uname -m) processors are not supported (x64 and arm64 are)" ;;
esac
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
	fail "Linux with musl (for example Alpine) is not supported yet"
fi
# An Apple Silicon Mac running this shell under Rosetta still gets the arm64 build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
	arch=arm64
fi

for tool in curl tar; do
	command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed"
done
if command -v sha256sum >/dev/null 2>&1; then
	sum() { sha256sum "$1"; }
elif command -v shasum >/dev/null 2>&1; then
	sum() { shasum -a 256 "$1"; }
else
	fail "sha256sum or shasum is needed to check the download"
fi

if [ -n "${ORRERY_VERSION:-}" ]; then
	version="${ORRERY_VERSION#v}"
	case "$version" in
		'' | *[!0-9.]* | .* | *. | *..*) fail "ORRERY_VERSION must look like 0.6.1" ;;
	esac
	major="${version%%.*}"
	rest="${version#*.}"
	minor="${rest%%.*}"
	if [ "$major" -eq 0 ] && [ "$minor" -lt 6 ]; then fail "no release before 0.6.0 exists"; fi
	base="$releases/download/v$version"
else
	base="$releases/latest/download"
fi
# HTTPS only, unless ORRERY_RELEASES_URL points somewhere else on purpose (a mirror, or a test).
proto='=https'
[ -n "${ORRERY_RELEASES_URL:-}" ] && proto='=https,http,file'

asset="orrery-$os-$arch.tar.gz"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/orrery-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Downloading %s...\n' "$asset"
curl -fsSL --proto "$proto" -o "$tmp/$asset" "$base/$asset" || fail "could not download $base/$asset"
curl -fsSL --proto "$proto" -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "could not download $base/SHA256SUMS"

expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "SHA256SUMS has no line for $asset"
actual="$(cd "$tmp" && sum "$asset" | awk '{ print $1 }')"
[ "$expected" = "$actual" ] || fail "$asset does not match SHA256SUMS (expected $expected, got $actual); nothing was installed"

mkdir "$tmp/unpacked"
tar -xzf "$tmp/$asset" -C "$tmp/unpacked"
set -- "$tmp"/unpacked/orrery-*
[ "$#" -eq 1 ] && [ -x "$1/bin/orrery" ] || fail "$asset does not hold one Orrery release"
"$1/bin/orrery" install --from "$1"
