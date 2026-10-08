#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: install-agent.sh --hub wss://HOST/agent [--token-file FILE | token on stdin]
       [--root DIR]... [--read-only] [--no-exec] [--prefix DIR]
       [--platform linux|darwin] [--dry-run] [--no-start]
EOF
}

die() {
  printf 'install-agent.sh: %s\n' "$*" >&2
  exit 2
}

write_private() {
  local target=$1
  local temporary="${target}.tmp.$$"
  cat >"$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$target"
}

render_template() {
  local template=$1
  local target=$2
  local node_path=$3
  local temporary="${target}.tmp.$$"
  MMF_RENDER_NODE="$node_path" \
    MMF_RENDER_HOME="$prefix" \
    MMF_RENDER_PATH="$PATH" \
    MMF_RENDER_HUB_URL="$hub_url" \
    MMF_RENDER_ROOTS="$roots_value" \
    MMF_RENDER_READ_ONLY="$read_only" \
    MMF_RENDER_NO_EXEC="$no_exec" \
    "$node_path" --input-type=commonjs - "$template" >"$temporary" <<'NODE'
const fs = require("node:fs");
const escapeXml = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");
const values = {
  "@NODE@": process.env.MMF_RENDER_NODE,
  "@HOME@": process.env.MMF_RENDER_HOME,
  "@PATH@": process.env.MMF_RENDER_PATH,
  "@MMF_HUB_URL@": process.env.MMF_RENDER_HUB_URL,
  "@MMF_ROOTS@": process.env.MMF_RENDER_ROOTS,
  "@MMF_READ_ONLY@": process.env.MMF_RENDER_READ_ONLY,
  "@MMF_NO_EXEC@": process.env.MMF_RENDER_NO_EXEC,
};
let output = fs.readFileSync(process.argv[2], "utf8");
for (const [placeholder, raw] of Object.entries(values)) {
  output = output.split(placeholder).join(escapeXml(raw ?? ""));
}
process.stdout.write(output);
NODE
  chmod 0600 "$temporary"
  mv -f "$temporary" "$target"
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd -- "$script_dir/.." && pwd -P)
hub_url=""
token_file=""
prefix=${HOME:?HOME is not set}
platform_name=""
read_only=0
no_exec=0
dry_run=0
no_start=0
roots=()

while (( $# > 0 )); do
  case "$1" in
    --hub)
      (( $# >= 2 )) || die "--hub requires a value"
      hub_url=$2
      shift 2
      ;;
    --token-file)
      (( $# >= 2 )) || die "--token-file requires a value"
      token_file=$2
      shift 2
      ;;
    --root)
      (( $# >= 2 )) || die "--root requires a value"
      roots+=("$2")
      shift 2
      ;;
    --read-only)
      read_only=1
      shift
      ;;
    --no-exec)
      no_exec=1
      shift
      ;;
    --prefix)
      (( $# >= 2 )) || die "--prefix requires a value"
      prefix=$2
      shift 2
      ;;
    --platform)
      (( $# >= 2 )) || die "--platform requires a value"
      platform_name=$2
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --no-start)
      no_start=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$hub_url" ]] || die "--hub is required and must use ws:// or wss:// ending in /agent"
[[ "$hub_url" =~ ^wss?://[^/?#[:space:]]+/agent$ ]] || die "invalid hub URL; expected ws:// or wss:// URL ending in /agent"
if [[ "$hub_url" == ws://* ]] && [[ ! "$hub_url" =~ ^ws://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?/agent$ ]]; then
  printf 'WARNING: ws:// is unencrypted for a non-loopback hub; use wss:// in production.\n' >&2
fi

if [[ -z "$platform_name" ]]; then
  case "$(uname -s)" in
    Linux) platform_name=linux ;;
    Darwin) platform_name=darwin ;;
    *) die "unsupported platform; expected Linux or macOS" ;;
  esac
fi
[[ "$platform_name" == linux || "$platform_name" == darwin ]] || die "--platform must be linux or darwin"
[[ -n "$prefix" ]] || die "--prefix must not be empty"

for root in "${roots[@]}"; do
  [[ "$root" != *:* ]] || die "root paths cannot contain ':' because MMF_ROOTS is colon-separated"
  [[ "$root" != *$'\n'* && "$root" != *$'\r'* ]] || die "root paths cannot contain newlines"
done
roots_value=""
if (( ${#roots[@]} > 0 )); then
  old_ifs=$IFS
  IFS=:
  roots_value="${roots[*]}"
  IFS=$old_ifs
fi

if [[ -n "$token_file" ]]; then
  [[ -r "$token_file" ]] || die "token file is not readable"
  token=$(<"$token_file")
else
  token=$(cat)
fi
[[ "$token" =~ ^mmf_dev_[A-Za-z0-9_-]{20,}$ ]] || die "invalid device token format"

umask 077
config_dir="$prefix/.config/mmf"
install -d -m 0700 "$prefix/.config" "$config_dir"
write_private "$config_dir/agent.token" <<EOF
$token
EOF

if [[ "$platform_name" == linux ]]; then
  unit_dir="$prefix/.config/systemd/user"
  install -d -m 0700 "$prefix/.config/systemd" "$unit_dir"
  write_private "$config_dir/agent.env" <<EOF
MMF_HUB_URL=$hub_url
MMF_ROOTS=$roots_value
MMF_READ_ONLY=$read_only
MMF_NO_EXEC=$no_exec
EOF
  write_private "$unit_dir/mmf-agent.service" <"$repo_root/deploy/systemd/mmf-agent.service"

  if (( dry_run == 0 && no_start == 0 )); then
    systemctl --user daemon-reload
    systemctl --user enable --now mmf-agent.service
    user_name=${USER:-$(id -un)}
    linger=$(loginctl show-user "$user_name" -p Linger 2>/dev/null || true)
    if [[ "$linger" != "Linger=yes" ]]; then
      printf 'WARNING: user lingering is not enabled; the agent may stop after logout. Ask an administrator to run: loginctl enable-linger %s\n' "$user_name" >&2
    fi
  fi

  printf 'Installed Linux agent service at %s\n' "$unit_dir/mmf-agent.service"
else
  node_path=$(command -v node || true)
  [[ "$node_path" == /* ]] || die "node was not found at an absolute path"
  launch_agents="$prefix/Library/LaunchAgents"
  install -d -m 0700 "$prefix/Library" "$prefix/Library/Logs" "$launch_agents"
  plist="$launch_agents/dev.mcp-machine-fabric.agent.plist"
  render_template "$repo_root/deploy/launchd/dev.mcp-machine-fabric.agent.plist" "$plist" "$node_path"

  if (( dry_run == 0 && no_start == 0 )); then
    domain="gui/$(id -u)"
    launchctl bootout "$domain/dev.mcp-machine-fabric.agent" >/dev/null 2>&1 || true
    launchctl bootstrap "$domain" "$plist"
    launchctl kickstart -k "$domain/dev.mcp-machine-fabric.agent"
  fi

  printf 'Installed macOS agent service at %s\n' "$plist"
fi
