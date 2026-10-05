#!/usr/bin/env bash
set -euo pipefail

PROFILE="zlibrary-local"
HEALTH_ADDR="127.0.0.1:8081"
RUNTIME_ENV="${OPENAI_TUNNEL_RUNTIME_ENV:-$HOME/.config/tunnel-client/arxiv-local.env}"
LAUNCHER="${ZLIBRARY_TUNNEL_LAUNCHER:-$HOME/workspace/projects/mcp-machine-fabric/scripts/zlibrary-mcp-launcher.sh}"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/zlibrary-mcp-tunnel.service"

usage() {
  cat <<'EOF'
Usage: bootstrap-zlibrary-tunnel.sh TUNNEL_ID

Creates/refreshes a zlibrary-local OpenAI Secure MCP Tunnel profile and a
durable user systemd service. It does not create the OpenAI-hosted tunnel;
TUNNEL_ID must already exist and be associated with the intended ChatGPT
workspace / Platform organization.

Environment overrides:
  OPENAI_TUNNEL_RUNTIME_ENV  File containing CONTROL_PLANE_API_KEY
  ZLIBRARY_TUNNEL_LAUNCHER  Absolute launcher path
EOF
}

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

TUNNEL_ID="$1"
if [[ ! "$TUNNEL_ID" =~ ^tunnel_[A-Za-z0-9]+$ ]]; then
  echo "Invalid tunnel id format" >&2
  exit 2
fi

command -v tunnel-client >/dev/null
[[ -x "$LAUNCHER" ]] || { echo "Launcher is not executable: $LAUNCHER" >&2; exit 1; }
[[ -r "$RUNTIME_ENV" ]] || { echo "Runtime environment is not readable: $RUNTIME_ENV" >&2; exit 1; }

install -d -m 0700 "$HOME/.config/tunnel-client" "$UNIT_DIR"

tunnel-client init   --sample sample_mcp_stdio_local   --profile "$PROFILE"   --force   --tunnel-id "$TUNNEL_ID"   --health-listen-addr "$HEALTH_ADDR"   --mcp-command "$LAUNCHER"

cat >"$UNIT_PATH" <<EOF
[Unit]
Description=OpenAI Secure MCP Tunnel for zlibrary-mcp
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
EnvironmentFile=$RUNTIME_ENV
ExecStart=$HOME/.local/bin/tunnel-client run --profile $PROFILE
Restart=always
RestartSec=5s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
chmod 0600 "$UNIT_PATH"

set -a
# shellcheck disable=SC1090
source "$RUNTIME_ENV"
set +a

tunnel-client doctor --profile "$PROFILE" --explain

echo
echo "Profile and unit are ready."
echo "Next:"
echo "  systemctl --user daemon-reload"
echo "  systemctl --user enable --now zlibrary-mcp-tunnel.service"
echo "  curl -fsS http://127.0.0.1:8081/readyz"
echo
echo "ChatGPT: create a developer-mode app, choose Tunnel, and select/paste:"
echo "  $TUNNEL_ID"
