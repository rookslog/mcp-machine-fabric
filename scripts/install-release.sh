#!/usr/bin/env bash
# Build this checkout and install it as an immutable release under
# ~/.local/opt/mcp-machine-fabric/<version>-<sha>, then point `current` at it.
# Running services pick it up on restart; roll back by re-pointing `current`.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
sha=$(git rev-parse --short HEAD 2>/dev/null || echo nogit)
dirty=$(git status --porcelain 2>/dev/null | grep -q . && echo "-dirty" || true)
base="$HOME/.local/opt/mcp-machine-fabric"
dest="$base/$version-$sha$dirty"
npm ci --no-audit --no-fund >/dev/null
npm run build >/dev/null
rm -rf "$dest.tmp" && mkdir -p "$dest.tmp"
cp -R dist package.json package-lock.json "$dest.tmp/"
(cd "$dest.tmp" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
rm -rf "$dest" && mv "$dest.tmp" "$dest"
ln -sfn "$dest" "$base/current.tmp" && mv -fT "$base/current.tmp" "$base/current" 2>/dev/null || { rm -f "$base/current"; mv "$base/current.tmp" "$base/current"; }
echo "installed $dest -> $base/current"
