#!/usr/bin/env bash
set -euo pipefail

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/mmf-pack-smoke.XXXXXX")
hub_pid=""
agent_pid=""
if [[ ${MMF_PACK_SMOKE_TRACE:-0} == 1 ]]; then
  echo "PACK_SMOKE_WORK_DIR=$work_dir"
fi

cleanup() {
  rc=$1
  trap - EXIT INT TERM
  if [[ -n "$agent_pid" ]]; then
    kill "$agent_pid" 2>/dev/null || true
    wait "$agent_pid" 2>/dev/null || true
  fi
  if [[ -n "$hub_pid" ]]; then
    kill "$hub_pid" 2>/dev/null || true
    wait "$hub_pid" 2>/dev/null || true
  fi
  if [[ $rc -ne 0 ]]; then
    [[ ! -f "$work_dir/hub.log" ]] || { echo "--- hub log ---" >&2; sed -n '1,200p' "$work_dir/hub.log" >&2; }
    [[ ! -f "$work_dir/agent.log" ]] || { echo "--- agent log ---" >&2; sed -n '1,200p' "$work_dir/agent.log" >&2; }
  fi
  rm -rf -- "$work_dir"
  exit "$rc"
}
trap 'cleanup $?' EXIT
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

cd "$repo_root"
npm run build
[[ $(sed -n '1p' dist/cli.js) == "#!/usr/bin/env node" ]]
[[ -x dist/cli.js ]]

pack_json=$(npm pack --json --pack-destination "$work_dir")
tarball_name=$(printf '%s' "$pack_json" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const result = JSON.parse(input);
  if (!result[0]?.filename) process.exit(1);
  process.stdout.write(result[0].filename);
});
')
tarball="$work_dir/$tarball_name"
contents=$(tar -tzf "$tarball")
for required in package/package.json package/README.md package/LICENSE package/dist/cli.js; do
  grep -Fxq "$required" <<<"$contents"
done
if grep -Eq '^package/(src|test)/|\.js\.map$' <<<"$contents"; then
  echo "package contains source, tests, or source maps" >&2
  exit 1
fi

install_dir="$work_dir/install"
npm install --prefix "$install_dir" --omit=dev --no-audit --no-fund --offline "$tarball"
mmf="$install_dir/node_modules/.bin/mmf"
package_dir="$install_dir/node_modules/mcp-machine-fabric"
version=$(node -p "require('./package.json').version")
[[ $("$mmf" version) == "$version" ]]
[[ $(cd "$install_dir" && npx --no-install mmf version) == "$version" ]]

port=$(node -e '
const server = require("node:net").createServer();
server.listen(0, "127.0.0.1", () => {
  console.log(server.address().port);
  server.close();
});
')
base_url="http://127.0.0.1:$port"
data_dir="$work_dir/data"
root_dir="$work_dir/root"
state_dir="$work_dir/state"
mkdir -p "$data_dir" "$root_dir" "$state_dir"

MMF_DATA_DIR="$data_dir" MMF_HOST=127.0.0.1 MMF_PUBLIC_URL="$base_url" \
  "$mmf" hub --port "$port" >"$work_dir/hub.log" 2>&1 &
hub_pid=$!
if [[ ${MMF_PACK_SMOKE_TRACE:-0} == 1 ]]; then
  echo "PACK_SMOKE_HUB_PID=$hub_pid"
fi

MMF_SMOKE_URL="$base_url/healthz" node --input-type=module -e '
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch(process.env.MMF_SMOKE_URL);
    if (response.ok) process.exit(0);
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}
throw new Error("hub did not become healthy");
'
echo "PACK_SMOKE_HUB_READY"

device_output=$(MMF_DATA_DIR="$data_dir" MMF_PUBLIC_URL="$base_url" "$mmf" device add smoke)
device_token=$(printf '%s\n' "$device_output" | sed -n 's/.*\(mmf_dev_[A-Za-z0-9_-]*\).*/\1/p' | sed -n '1p')
[[ -n "$device_token" ]]
token_output=$(MMF_DATA_DIR="$data_dir" MMF_PUBLIC_URL="$base_url" "$mmf" token create smoke)
personal_token=$(printf '%s\n' "$token_output" | sed -n 's/.*\(mmf_pat_[A-Za-z0-9_-]*\).*/\1/p' | sed -n '1p')
[[ -n "$personal_token" ]]
token_file="$work_dir/personal.token"
printf '%s\n' "$personal_token" >"$token_file"
chmod 600 "$token_file"

MMF_AGENT_TOKEN="$device_token" "$mmf" agent \
  --hub "ws://127.0.0.1:$port/agent" \
  --root "$root_dir" \
  --state-dir "$state_dir" >"$work_dir/agent.log" 2>&1 &
agent_pid=$!

status_output=""
for _ in $(seq 1 100); do
  status_output=$("$mmf" status --url "$base_url" --token-file "$token_file" 2>/dev/null || true)
  if grep -Eq '^smoke +READY' <<<"$status_output"; then
    break
  fi
  sleep 0.1
done
grep -Eq '^smoke +READY' <<<"$status_output"

(
  cd "$package_dir"
  MMF_SMOKE_URL="$base_url/mcp" \
    MMF_SMOKE_TOKEN="$personal_token" \
    MMF_PACK_SMOKE_COMMAND="${MMF_PACK_SMOKE_COMMAND:-echo pack-ok}" \
    node --input-type=module -e '
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "mmf-pack-smoke", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MMF_SMOKE_URL), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.MMF_SMOKE_TOKEN}` } },
}));
try {
  const result = await client.callTool({
    name: "run_command",
    arguments: {
      machine: "smoke",
      command: process.env.MMF_PACK_SMOKE_COMMAND,
      wait_seconds: Number(process.env.MMF_PACK_SMOKE_WAIT_SECONDS ?? "30"),
    },
  });
  const output = result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
  if (result.structuredContent?.status === "running") {
    const jobId = result.structuredContent?.job_id;
    if (typeof jobId !== "string") throw new Error("running command did not return a job id");
    const cancelled = await client.callTool({
      name: "cancel_job",
      arguments: { machine: "smoke", job_id: jobId, grace_seconds: 0 },
    });
    const cancellationStatus = cancelled.structuredContent?.status;
    if (cancelled.isError || !["killed", "exited"].includes(cancellationStatus)) {
      throw new Error(`failed to cancel running smoke job: ${JSON.stringify(cancelled.structuredContent)}`);
    }
  }
  const completed = result.structuredContent?.status === "exited" && result.structuredContent?.exit_code === 0;
  if (result.isError || !completed || !output.includes("pack-ok")) {
    throw new Error(output || `run_command did not exit successfully: ${JSON.stringify(result.structuredContent)}`);
  }
  console.log("pack-ok");
} finally {
  await client.close();
}
'
)

echo "PACK_SMOKE_OK"
