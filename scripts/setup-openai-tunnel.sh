#!/usr/bin/env bash
set -euo pipefail

PROFILE="mmf-hub"
HEALTH_ADDR="127.0.0.1:8082"
DRY_RUN=0
TUNNEL_ID=""

usage() {
  cat <<'EOF'
Usage: setup-openai-tunnel.sh TUNNEL_ID [--profile mmf-hub] [--health 127.0.0.1:8082] [--dry-run]

Creates an OpenAI Secure MCP Tunnel profile for the local MCP Machine Fabric
hub at http://127.0.0.1:8787/mcp. The OpenAI-hosted tunnel object and runtime
API key must already exist.

--dry-run writes an isolated profile and systemd-unit preview under a temporary
directory. It never creates a real MMF PAT and never writes under ~/.config.

Environment overrides:
  TUNNEL_CLIENT_BIN             tunnel-client executable
  OPENAI_TUNNEL_RUNTIME_ENV     existing EnvironmentFile containing CONTROL_PLANE_API_KEY
  ARXIV_TUNNEL_UNIT             existing arxiv-mcp-tunnel.service used to discover that file
  MMF_CLI                       installed MCP Machine Fabric CLI entrypoint
  MMF_TUNNEL_MCP_URL            alternate loopback HTTP /mcp URL (default: http://127.0.0.1:8787/mcp)
EOF
}

die_usage() {
  echo "$1" >&2
  usage >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || die_usage "--profile requires a value"
      PROFILE="$2"
      shift 2
      ;;
    --health)
      [[ $# -ge 2 ]] || die_usage "--health requires a value"
      HEALTH_ADDR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      die_usage "Unknown option: $1"
      ;;
    *)
      [[ -z "$TUNNEL_ID" ]] || die_usage "Exactly one TUNNEL_ID is required"
      TUNNEL_ID="$1"
      shift
      ;;
  esac
done

[[ -n "$TUNNEL_ID" ]] || die_usage "TUNNEL_ID is required"
[[ "$TUNNEL_ID" =~ ^tunnel_[a-z0-9]+$ ]] || die_usage "Invalid tunnel id format"
if [[ "$DRY_RUN" -eq 0 && ! "$TUNNEL_ID" =~ ^tunnel_[a-z0-9]{32}$ ]]; then
  die_usage "Invalid tunnel id: tunnel-client 0.0.9 requires tunnel_ followed by 32 lowercase letters or digits"
fi
[[ "$PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die_usage "Invalid profile name"
[[ "$PROFILE" != "arxiv-local" ]] || die_usage "Profile arxiv-local is reserved for the unrelated arXiv tunnel"
[[ "$HEALTH_ADDR" =~ ^127\.0\.0\.1:([0-9]{1,5})$ ]] || die_usage "Health address must be 127.0.0.1:PORT"
HEALTH_PORT="${BASH_REMATCH[1]}"
(( HEALTH_PORT >= 1 && HEALTH_PORT <= 65535 )) || die_usage "Health port must be between 1 and 65535"
if [[ "$HEALTH_PORT" -eq 8080 ]]; then
  die_usage "Health port 8080 belongs to the unrelated arXiv tunnel; choose another port"
fi

MCP_URL="${MMF_TUNNEL_MCP_URL:-http://127.0.0.1:8787/mcp}"
if ! node -e '
  const url = new URL(process.argv[1]);
  const valid = url.protocol === "http:" && url.hostname === "127.0.0.1" &&
    /^\d+$/.test(url.port) && url.pathname === "/mcp" && !url.search && !url.hash &&
    !url.username && !url.password;
  process.exit(valid ? 0 : 1);
' "$MCP_URL" 2>/dev/null; then
  die_usage "MMF_TUNNEL_MCP_URL must be an http://127.0.0.1:PORT/mcp loopback URL"
fi
EXPECTED_OAUTH_URL="$(node -e '
  const url = new URL(process.argv[1]);
  process.stdout.write(new URL(`/.well-known/oauth-protected-resource${url.pathname}`, url).href);
' "$MCP_URL")"

if [[ -n "${TUNNEL_CLIENT_BIN:-}" ]]; then
  TUNNEL_CLIENT="$TUNNEL_CLIENT_BIN"
else
  TUNNEL_CLIENT="$(command -v tunnel-client || true)"
fi
[[ -n "$TUNNEL_CLIENT" && -x "$TUNNEL_CLIENT" ]] || { echo "tunnel-client is not executable or not on PATH" >&2; exit 1; }

ARXIV_UNIT="${ARXIV_TUNNEL_UNIT:-$HOME/.config/systemd/user/arxiv-mcp-tunnel.service}"
RUNTIME_ENV="${OPENAI_TUNNEL_RUNTIME_ENV:-}"
if [[ -z "$RUNTIME_ENV" ]]; then
  [[ -r "$ARXIV_UNIT" ]] || { echo "Cannot read the arXiv tunnel unit: $ARXIV_UNIT" >&2; exit 1; }
  RUNTIME_ENV="$(awk -F= '/^EnvironmentFile=/ { value=substr($0, index($0, "=")+1); sub(/^-/, "", value); gsub(/^"|"$/, "", value); print value; exit }' "$ARXIV_UNIT")"
  [[ -n "$RUNTIME_ENV" ]] || { echo "No EnvironmentFile found in $ARXIV_UNIT" >&2; exit 1; }
fi

for value in "$RUNTIME_ENV" "$TUNNEL_CLIENT" "$HOME"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || { echo "Paths may not contain newlines" >&2; exit 1; }
done

umask 077
MANAGED_MARKER="# Managed by setup-openai-tunnel.sh"
WORK_DIR=""
RECOVERY_DIR=""
NEW_TOKEN_ID=""
TOKEN_CREATED=0
SETUP_COMMITTED=0
INSTALL_IN_PROGRESS=0
PRESERVE_RECOVERY=0

cleanup() {
  local status=$?
  if [[ "$status" -ne 0 && "$INSTALL_IN_PROGRESS" -eq 1 ]]; then
    rollback_install
  fi
  if [[ "$status" -ne 0 && "$TOKEN_CREATED" -eq 1 && "$SETUP_COMMITTED" -eq 0 ]]; then
    revoke_new_token
  fi
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" && "$DRY_RUN" -eq 0 ]]; then
    rm -r -- "$WORK_DIR"
  fi
  if [[ -n "$RECOVERY_DIR" && -d "$RECOVERY_DIR" && "$PRESERVE_RECOVERY" -eq 0 ]]; then
    rm -r -- "$RECOVERY_DIR"
  fi
}
trap cleanup EXIT

revoke_new_token() {
  if [[ "$TOKEN_CREATED" -eq 1 ]]; then
    if [[ -z "$NEW_TOKEN_ID" ]]; then
      echo "WARNING: setup failed after creating a PAT but its token id could not be parsed; locate and revoke the openai-tunnel token manually" >&2
    elif ! node "$MMF_CLI_PATH" token revoke "$NEW_TOKEN_ID" >/dev/null 2>&1; then
      echo "WARNING: setup failed and the newly created PAT could not be revoked; revoke token id $NEW_TOKEN_ID manually" >&2
    fi
    TOKEN_CREATED=0
  fi
}

rollback_install() {
  local index
  local failures=()
  INSTALL_IN_PROGRESS=0
  for index in "${!DESTINATIONS[@]}"; do
    if [[ "${EXISTED[$index]}" -eq 1 ]]; then
      if ! "$INSTALL_BIN" -m 0600 "$BACKUP_DIR/$index" "${DESTINATIONS[$index]}"; then
        failures+=("${DESTINATIONS[$index]}")
      fi
    elif ! rm -f -- "${DESTINATIONS[$index]}"; then
      failures+=("${DESTINATIONS[$index]}")
    fi
  done
  if [[ "${#failures[@]}" -eq 0 ]]; then
    echo "Installation failed; prior managed files were restored" >&2
  else
    PRESERVE_RECOVERY=1
    echo "Installation failed and recovery was incomplete for:" >&2
    printf '  %s\n' "${failures[@]}" >&2
    echo "Recovery files preserved at: $BACKUP_DIR" >&2
  fi
  revoke_new_token
}

load_runtime_key_as_data() {
  local line value="" found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    case "$line" in
      CONTROL_PLANE_API_KEY=*)
        value="${line#*=}"
        found=$((found + 1))
        ;;
    esac
  done < "$RUNTIME_ENV"
  [[ "$found" -eq 1 && -n "$value" ]] || { echo "EnvironmentFile must contain exactly one non-empty CONTROL_PLANE_API_KEY assignment" >&2; return 1; }
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || { echo "CONTROL_PLANE_API_KEY has an unsupported value" >&2; return 1; }
  export CONTROL_PLANE_API_KEY="$value"
  unset value
}

ensure_owned_or_absent() {
  local file="$1"
  if [[ -e "$file" ]] && ! grep -Fqx "$MANAGED_MARKER" "$file"; then
    echo "Refusing to overwrite unowned file: $file" >&2
    return 1
  fi
}

yaml_quote() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\$\$}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

systemd_env_path_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value// /\\x20}"
  value="${value//$'\t'/\\t}"
  value="${value//\"/\\x22}"
  value="${value//\'/\\x27}"
  value="${value//\$/\\x24}"
  value="${value//%/%%}"
  printf '%s' "$value"
}

write_private() {
  local destination="$1" content="$2" temporary
  temporary="$(mktemp "${destination}.tmp.XXXXXX")"
  printf '%s\n' "$content" > "$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$destination"
}

render_profile() {
  local destination="$1" authorization_file="$2" temporary
  temporary="$(mktemp "${destination}.tmp.XXXXXX")"
  cat > "$temporary" <<EOF
$MANAGED_MARKER
config_version: 1
control_plane:
  base_url: "https://api.openai.com"
  tunnel_id: $(yaml_quote "$TUNNEL_ID")
  api_key: "env:CONTROL_PLANE_API_KEY"
health:
  listen_addr: $(yaml_quote "$HEALTH_ADDR")
admin_ui:
  open_browser: false
log:
  level: info
  format: json
mcp:
  server_urls:
    - channel: main
      url: $(yaml_quote "$MCP_URL")
  extra_headers:
    Authorization: $(yaml_quote "file:$authorization_file")
  discovery_extra_headers:
    Authorization: $(yaml_quote "file:$authorization_file")
EOF
  chmod 0600 "$temporary"
  mv -f "$temporary" "$destination"
}

render_unit() {
  local destination="$1" profile_dir="$2" temporary
  temporary="$(mktemp "${destination}.tmp.XXXXXX")"
  cat > "$temporary" <<EOF
$MANAGED_MARKER
[Unit]
Description=OpenAI Secure MCP Tunnel for MCP Machine Fabric
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
EnvironmentFile=$(systemd_env_path_escape "$RUNTIME_ENV")
ExecStart=$(systemd_quote "$TUNNEL_CLIENT") run --profile $(systemd_quote "$PROFILE") --profile-dir $(systemd_quote "$profile_dir")
Restart=always
RestartSec=5s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
  chmod 0600 "$temporary"
  mv -f "$temporary" "$destination"
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mmf-openai-tunnel.XXXXXX")"
  WORK_DIR="$ARTIFACT_DIR"
  CANDIDATE_PROFILE_DIR="$ARTIFACT_DIR/profiles"
  CANDIDATE_UNIT="$ARTIFACT_DIR/mmf-openai-tunnel.service"
  CANDIDATE_PAT="$ARTIFACT_DIR/pat-openai-tunnel.token"
  CANDIDATE_AUTH="$ARTIFACT_DIR/pat-openai-tunnel.authorization"
  FINAL_PROFILE_DIR="$CANDIDATE_PROFILE_DIR"
  FINAL_UNIT="$CANDIDATE_UNIT"
  FINAL_PAT="$CANDIDATE_PAT"
  FINAL_AUTH="$CANDIDATE_AUTH"
  mkdir -p "$CANDIDATE_PROFILE_DIR"
  PAT="mmf_pat_dry_run_0123456789abcdef"
  export CONTROL_PLANE_API_KEY="dry-run-control-plane-key"
else
  [[ -r "$RUNTIME_ENV" ]] || { echo "Runtime EnvironmentFile is not readable: $RUNTIME_ENV" >&2; exit 1; }
  load_runtime_key_as_data
  INSTALL_BIN="${MMF_TUNNEL_INSTALL_BIN:-$(command -v install || true)}"
  [[ -n "$INSTALL_BIN" && -x "$INSTALL_BIN" ]] || { echo "install is not executable or not on PATH" >&2; exit 1; }

  FINAL_PROFILE_DIR="$HOME/.config/tunnel-client"
  FINAL_UNIT_DIR="$HOME/.config/systemd/user"
  FINAL_UNIT="$FINAL_UNIT_DIR/mmf-openai-tunnel.service"
  FINAL_PAT_DIR="$HOME/.config/mmf"
  FINAL_PAT="$FINAL_PAT_DIR/pat-openai-tunnel.token"
  FINAL_AUTH="$FINAL_PAT_DIR/pat-openai-tunnel.authorization"
  FINAL_PROFILE="$FINAL_PROFILE_DIR/$PROFILE.yaml"
  ensure_owned_or_absent "$FINAL_PROFILE"
  ensure_owned_or_absent "$FINAL_UNIT"

  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mmf-openai-tunnel-candidate.XXXXXX")"
  CANDIDATE_PROFILE_DIR="$WORK_DIR/profiles"
  CANDIDATE_UNIT="$WORK_DIR/mmf-openai-tunnel.service"
  CANDIDATE_PAT="$WORK_DIR/pat-openai-tunnel.token"
  CANDIDATE_AUTH="$WORK_DIR/pat-openai-tunnel.authorization"
  mkdir -p "$CANDIDATE_PROFILE_DIR"

  if [[ -f "$FINAL_PAT" ]]; then
    PAT="$(tr -d '\r\n' < "$FINAL_PAT")"
  else
    MMF_CLI_PATH="${MMF_CLI:-$HOME/.local/opt/mcp-machine-fabric/current/dist/cli.js}"
    [[ -r "$MMF_CLI_PATH" ]] || { echo "Installed MMF CLI is not readable: $MMF_CLI_PATH" >&2; exit 1; }
    TOKEN_OUTPUT="$(node "$MMF_CLI_PATH" token create openai-tunnel)"
    NEW_TOKEN_ID="$(printf '%s\n' "$TOKEN_OUTPUT" | sed -n 's/^Created token \([^ ]*\) .*/\1/p' | head -n 1)"
    PAT="$(printf '%s\n' "$TOKEN_OUTPUT" | awk '/^mmf_pat_[A-Za-z0-9_-]+$/ { print; exit }')"
    unset TOKEN_OUTPUT
    TOKEN_CREATED=1
  fi
fi

[[ "$PAT" =~ ^mmf_pat_[A-Za-z0-9_-]+$ ]] || { revoke_new_token; echo "PAT file or token-create output did not contain a valid mmf_pat_ token" >&2; exit 1; }
write_private "$CANDIDATE_PAT" "$PAT"
write_private "$CANDIDATE_AUTH" "Bearer $PAT"
unset PAT

CANDIDATE_PROFILE="$CANDIDATE_PROFILE_DIR/$PROFILE.yaml"
render_profile "$CANDIDATE_PROFILE" "$CANDIDATE_AUTH"
render_unit "$CANDIDATE_UNIT" "$FINAL_PROFILE_DIR"

DOCTOR_LOG="$(mktemp "${TMPDIR:-/tmp}/mmf-openai-tunnel-doctor.XXXXXX")"
set +e
"$TUNNEL_CLIENT" doctor --profile "$PROFILE" --profile-dir "$CANDIDATE_PROFILE_DIR" --explain 2>&1 | tee "$DOCTOR_LOG"
DOCTOR_STATUS="${PIPESTATUS[0]}"
set -e

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry-run doctor exit code: $DOCTOR_STATUS"
elif [[ "$DOCTOR_STATUS" -ne 0 ]]; then
  DOCTOR_JSON="$(mktemp "${TMPDIR:-/tmp}/mmf-openai-tunnel-doctor-json.XXXXXX")"
  set +e
  "$TUNNEL_CLIENT" doctor --profile "$PROFILE" --profile-dir "$CANDIDATE_PROFILE_DIR" --json > "$DOCTOR_JSON" 2>/dev/null
  JSON_STATUS=$?
  set -e
  if [[ "$JSON_STATUS" -eq 2 ]] && node - "$DOCTOR_JSON" "$EXPECTED_OAUTH_URL" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const checks = new Map(report.checks.map((check) => [check.id, check]));
const oauth = checks.get("oauth_metadata");
const reachable = checks.get("mcp_server_reachable");
const expected =
  report.result === "fail" &&
  JSON.stringify(report.failed_checks) === JSON.stringify(["oauth_metadata"]) &&
  reachable?.status === "PASS" &&
  oauth?.status === "FAIL" &&
  oauth?.summary === `HTTP 404 from ${process.argv[3]}` &&
  Array.isArray(oauth?.evidence) &&
  oauth.evidence.includes("HTTP 404");
process.exit(expected ? 0 : 1);
NODE
  then
    echo "WARNING: doctor found only the expected HTTP 404 OAuth-metadata absence. This profile intentionally uses static PAT injection and ChatGPT no-auth mode." >&2
  else
    rm -f "$DOCTOR_LOG" "$DOCTOR_JSON"
    revoke_new_token
    exit "$DOCTOR_STATUS"
  fi
  rm -f "$DOCTOR_JSON"
fi
rm -f "$DOCTOR_LOG"

if [[ "$DRY_RUN" -eq 0 ]]; then
  INSTALL_PROFILE="$WORK_DIR/install-profile.yaml"
  render_profile "$INSTALL_PROFILE" "$FINAL_AUTH"
  RECOVERY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mmf-openai-tunnel-recovery.XXXXXX")"
  BACKUP_DIR="$RECOVERY_DIR/backups"
  mkdir -p "$BACKUP_DIR"
  SOURCES=("$CANDIDATE_PAT" "$CANDIDATE_AUTH" "$INSTALL_PROFILE" "$CANDIDATE_UNIT")
  DESTINATIONS=("$FINAL_PAT" "$FINAL_AUTH" "$FINAL_PROFILE" "$FINAL_UNIT")
  EXISTED=()
  for index in "${!DESTINATIONS[@]}"; do
    if [[ -e "${DESTINATIONS[$index]}" ]]; then
      cp -p "${DESTINATIONS[$index]}" "$BACKUP_DIR/$index"
      EXISTED[$index]=1
    else
      EXISTED[$index]=0
    fi
  done

  mkdir -p "$FINAL_PROFILE_DIR" "$FINAL_UNIT_DIR" "$FINAL_PAT_DIR"
  chmod 0700 "$FINAL_PROFILE_DIR" "$FINAL_UNIT_DIR" "$FINAL_PAT_DIR"
  INSTALL_IN_PROGRESS=1
  INSTALL_STATUS=0
  for index in "${!DESTINATIONS[@]}"; do
    if ! "$INSTALL_BIN" -m 0600 "${SOURCES[$index]}" "${DESTINATIONS[$index]}"; then
      INSTALL_STATUS=1
      break
    fi
  done
  if [[ "$INSTALL_STATUS" -ne 0 ]]; then
    rollback_install
    exit 1
  fi
  INSTALL_IN_PROGRESS=0
  SETUP_COMMITTED=1
  rm -r -- "$RECOVERY_DIR"
  RECOVERY_DIR=""
fi

echo
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry-run artifact directory: $ARTIFACT_DIR"
  echo "No systemd directory, service state, installed profile, real MMF PAT, or runtime EnvironmentFile was changed or read."
else
  echo "Profile: $FINAL_PROFILE"
  echo "Unit: $FINAL_UNIT"
  echo "Next:"
  echo "  systemctl --user daemon-reload"
  echo "  systemctl --user enable --now mmf-openai-tunnel.service"
  echo "  curl -fsS http://$HEALTH_ADDR/healthz"
  echo "  curl -fsS http://$HEALTH_ADDR/readyz"
fi

echo
echo "ChatGPT setup:"
echo "  1. Open ChatGPT Plugins, select +, then Add custom MCP server."
echo "  2. Choose Tunnel under Connection."
echo "  3. Select or paste tunnel id: $TUNNEL_ID"
echo "  4. Choose No authentication. tunnel-client injects the local MMF PAT."
echo "  5. Review the risk warning, continue, create the plugin, and test it in a new chat."
