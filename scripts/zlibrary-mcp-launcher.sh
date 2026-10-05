#!/usr/bin/env bash
set -euo pipefail
umask 077

SECRETS_FILE="${ZLIBRARY_MCP_SECRETS_FILE:-$HOME/.config/zlibrary-mcp/secrets.env}"
SERVER_ROOT="${ZLIBRARY_MCP_SERVER_ROOT:-$HOME/mcp-servers/zlibrary-mcp}"
DATA_ROOT="${ZLIBRARY_MCP_DATA_ROOT:-$HOME/.local/share/zlibrary-mcp}"

if [[ ! -r "$SECRETS_FILE" ]]; then
  echo "zlibrary-mcp launcher: secrets file is not readable: $SECRETS_FILE" >&2
  exit 1
fi

if [[ ! -f "$SERVER_ROOT/dist/index.js" ]]; then
  echo "zlibrary-mcp launcher: built server not found: $SERVER_ROOT/dist/index.js" >&2
  exit 1
fi

install -d -m 0700 "$DATA_ROOT" "$DATA_ROOT/downloads" "$DATA_ROOT/processed_rag_output" "$DATA_ROOT/logs"

# The existing secrets file is user-owned and mode 0600. Source it only into
# the child process environment; never copy its values into tunnel profiles.
set -a
# shellcheck disable=SC1090
source "$SECRETS_FILE"
set +a

# Keep relative output paths deterministic until zlibrary-mcp gains a bounded
# artifact-root setting (tracked upstream).
cd "$DATA_ROOT"
exec node "$SERVER_ROOT/dist/index.js"
