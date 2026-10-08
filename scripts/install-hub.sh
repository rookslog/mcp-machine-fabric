#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: install-hub.sh --public-url https://HOST[:PORT] [--port 8787]
       [--prefix DIR] [--platform linux] [--dry-run] [--no-start]
EOF
}

die() {
  printf 'install-hub.sh: %s\n' "$*" >&2
  exit 2
}

write_private() {
  local target=$1
  local temporary="${target}.tmp.$$"
  cat >"$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$target"
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd -- "$script_dir/.." && pwd -P)
public_url=""
port=8787
prefix=${HOME:?HOME is not set}
platform_name=""
dry_run=0
no_start=0

while (( $# > 0 )); do
  case "$1" in
    --public-url)
      (( $# >= 2 )) || die "--public-url requires a value"
      public_url=$2
      shift 2
      ;;
    --port)
      (( $# >= 2 )) || die "--port requires a value"
      port=$2
      shift 2
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

[[ "$public_url" =~ ^https://[^/?#[:space:]]+$ ]] || die "invalid public URL; expected https://HOST[:PORT]"
[[ "$port" =~ ^[0-9]+$ ]] || die "port must be an integer from 1 to 65535"
(( port >= 1 && port <= 65535 )) || die "port must be an integer from 1 to 65535"
[[ -n "$prefix" ]] || die "--prefix must not be empty"

if [[ -z "$platform_name" ]]; then
  case "$(uname -s)" in
    Linux) platform_name=linux ;;
    *) die "the hub installer supports Linux only" ;;
  esac
fi
[[ "$platform_name" == linux ]] || die "the hub installer supports Linux only"

umask 077
config_dir="$prefix/.config/mmf"
unit_dir="$prefix/.config/systemd/user"
install -d -m 0700 "$prefix/.config" "$config_dir" "$prefix/.config/systemd" "$unit_dir"
write_private "$config_dir/hub.env" <<EOF
MMF_PUBLIC_URL=$public_url
MMF_PORT=$port
MMF_HOST=127.0.0.1
EOF
write_private "$unit_dir/mmf-hub.service" <"$repo_root/deploy/systemd/mmf-hub.service"

if (( dry_run == 0 && no_start == 0 )); then
  systemctl --user daemon-reload
  systemctl --user enable --now mmf-hub.service
  user_name=${USER:-$(id -un)}
  linger=$(loginctl show-user "$user_name" -p Linger 2>/dev/null || true)
  if [[ "$linger" != "Linger=yes" ]]; then
    printf 'WARNING: user lingering is not enabled; the hub may stop after logout. Ask an administrator to run: loginctl enable-linger %s\n' "$user_name" >&2
  fi
fi

cat <<EOF
Installed Linux hub service at $unit_dir/mmf-hub.service

Next steps:
  mmf passphrase
  mmf device add MACHINE
  tailscale serve --bg --https=443 http://127.0.0.1:$port
EOF
