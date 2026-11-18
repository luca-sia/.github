#!/usr/bin/env bash
# Installs the pinned secret and code scanners (gitleaks, Semgrep CE) into DIR/bin for CI and the nightly box.
# gitleaks and uv come from GitHub releases with a pinned checksum; Semgrep is installed by uv, so the host
# needs no pip or venv package.
# Usage: scripts/install-scan-tools.sh DIR [gitleaks|semgrep]   (default both; then put DIR/bin on PATH)
set -euo pipefail
dir="${1:?usage: install-scan-tools.sh DIR [gitleaks|semgrep]}"
which="${2:-all}"
mkdir -p "$dir/bin"
gitleaks_version=8.30.1
uv_version=0.13.9
semgrep_version=1.185.0

# fetch URL SHA256 MEMBER DEST: download a tarball, check it, install one member.
fetch() {
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/pkg.tgz" "$1"
  echo "$2  $tmp/pkg.tgz" | shasum -a 256 -c - >/dev/null
  tar -xzf "$tmp/pkg.tgz" -C "$tmp"
  install -m 755 "$(find "$tmp" -name "$3" -type f | head -n 1)" "$4"
  rm -rf "$tmp"
}

platform="$(uname -s)-$(uname -m)"

if [ "$which" != semgrep ] && ! "$dir/bin/gitleaks" version 2>/dev/null | grep -qx "$gitleaks_version"; then
  case "$platform" in
    Linux-x86_64) asset=linux_x64; sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
    Linux-aarch64 | Linux-arm64) asset=linux_arm64; sum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
    Darwin-arm64) asset=darwin_arm64; sum=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
    *) echo "no pinned gitleaks for $platform" >&2; exit 1 ;;
  esac
  fetch "https://github.com/gitleaks/gitleaks/releases/download/v$gitleaks_version/gitleaks_${gitleaks_version}_${asset}.tar.gz" "$sum" gitleaks "$dir/bin/gitleaks"
fi

if [ "$which" != gitleaks ] && ! "$dir/venv/bin/semgrep" --version 2>/dev/null | grep -qx "$semgrep_version"; then
  case "$platform" in
    Linux-x86_64) asset=x86_64-unknown-linux-gnu; sum=a7fbaff2b9a271d85c1bdb540941090fd1ce011797b4abeb48e4dcd39c2471d5 ;;
    Linux-aarch64 | Linux-arm64) asset=aarch64-unknown-linux-gnu; sum=0797542018e541a9288855df555c8077eed06f7a47d206362030480e8ecc9f3d ;;
    Darwin-arm64) asset=aarch64-apple-darwin; sum=5aeca67f2283f75235de40d0bd9c0a5bbc5fce23b6d48b3bf9fa1b2db08382ca ;;
    *) echo "no pinned uv for $platform" >&2; exit 1 ;;
  esac
  fetch "https://github.com/astral-sh/uv/releases/download/$uv_version/uv-$asset.tar.gz" "$sum" uv "$dir/bin/uv"
  rm -rf "$dir/venv"
  "$dir/bin/uv" venv --quiet "$dir/venv"
  # Hash locked: scan/semgrep-requirements.txt (uv pip compile --universal --generate-hashes).
  "$dir/bin/uv" pip install --quiet --require-hashes --python "$dir/venv/bin/python" -r "$(dirname "$0")/semgrep-requirements.txt"
fi
[ "$which" = gitleaks ] || ln -sf "$dir/venv/bin/semgrep" "$dir/bin/semgrep"
