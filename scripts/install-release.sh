#!/usr/bin/env bash
# Build this checkout as an immutable release; services pick it up on restart.
# Compatible with stock macOS bash 3.2 and Linux.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
sha=$(git rev-parse --short HEAD)
source_hash=$(node scripts/release-state.mjs source)
dirty=""
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  dirty="-dirty-$source_hash"
fi
base="$HOME/.local/opt/mcp-machine-fabric"
dest="$base/$version-$sha$dirty"
mkdir -p "$base"
# Serialize publication and current changes. A stale lock fails closed; remove
# it manually only after confirming no installer is running.
lock="$base/.install-lock"
mkdir "$lock" 2>/dev/null || { echo 'install-release.sh: another installer or stale .install-lock exists' >&2; exit 1; }
stage=""
link_tmp=""
cleanup() {
  [[ -z "$stage" ]] || rm -rf "$stage"
  [[ -z "$link_tmp" ]] || rm -f "$link_tmp"
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -L "$base/current" ]]; then
  printf 'previous current: %s\n' "$(readlink "$base/current")"
elif [[ -e "$base/current" ]]; then
  echo 'install-release.sh: current exists and is not a symlink; left untouched' >&2
  exit 1
else
  echo 'previous current: (none)'
fi
npm ci --no-audit --no-fund >/dev/null
npm run build >/dev/null
stage=$(mktemp -d "$base/.stage.XXXXXX")
cp -R dist package.json package-lock.json "$stage/"
(cd "$stage" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
[[ "$(node scripts/release-state.mjs source)" == "$source_hash" ]] || { echo 'install-release.sh: source changed during build; not publishing' >&2; exit 1; }
# Compare every file, mode and symlink before reusing an existing directory.
# No existing release (including old installers' .tmp directories) is removed.
node scripts/release-state.mjs install "$stage" "$dest"
link_tmp=$(mktemp "$base/.current.XXXXXX")
rm -f "$link_tmp"
ln -s "$dest" "$link_tmp"
node scripts/release-state.mjs switch "$link_tmp" "$base/current"
echo "installed $dest -> $base/current"
