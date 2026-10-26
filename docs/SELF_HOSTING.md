# Self-host MCP Machine Fabric

MCP Machine Fabric has one hub and one agent on each controlled machine. Keep
the hub on a host that stays online. Put TLS in front of the hub. Agents make
outbound WebSocket connections, so controlled machines do not need inbound
ports. A small VPS or an always-on home server can host the hub.

This guide describes release `0.1.0`. Source installations use the revision
that you check out. Record its commit SHA and use the same revision on the hub
and every agent. Node.js 22.13 or later is required outside the container.

## Security checklist

A client token with `fabric:exec` is equivalent to a shell on every connected
machine, within that agent's operating-system permissions.

- [ ] Publish port 8787 only on loopback, and put an authenticated TLS front
  door in front of it. Never expose plain HTTP beyond the host.
- [ ] Set `MMF_PUBLIC_URL` to the final HTTPS URL before you enroll clients.
- [ ] Run each agent as a dedicated OS user when possible.
- [ ] Limit each agent with `--root`, `--read-only`, or `--no-exec`.
- [ ] Grant clients only the `fabric:read`, `fabric:write`, and `fabric:exec`
  scopes that they need.
- [ ] Store device tokens and personal access tokens in files with mode `0600`.
- [ ] Back up the hub database and test the restore procedure.
- [ ] Revoke unused devices and personal access tokens.

## Run the hub with Docker

This path was exercised on Linux during the `0.1.0` packaging check.
Run it from a repository checkout; the Docker and source/systemd sections are
alternative ways to host the same hub.

```bash
git clone https://github.com/rookslog/mcp-machine-fabric.git
cd mcp-machine-fabric
docker build --tag mcp-machine-fabric:0.1.0 .
docker volume create mmf-data
docker run --detach \
  --name mmf-hub \
  --restart unless-stopped \
  --publish 127.0.0.1:8787:8787 \
  --env MMF_PUBLIC_URL=https://hub.example.com \
  --volume mmf-data:/data \
  mcp-machine-fabric:0.1.0
```

The image runs as the non-root `mmf` user. Its health check calls `/healthz`.
The named volume stores `/data/hub.db` and its SQLite support files.

Set the owner passphrase and enroll a machine from inside the container:

```bash
docker exec --interactive --tty mmf-hub node /app/dist/cli.js passphrase
docker exec mmf-hub node /app/dist/cli.js device add laptop
mkdir -p ~/.config/mmf && chmod 700 ~/.config/mmf
umask 077
token_output=$(docker exec mmf-hub node /app/dist/cli.js token create operator)
printf '%s\n' "$token_output"
printf '%s\n' "$token_output" | awk '/^mmf_pat_/ { print; exit }' > ~/.config/mmf/operator.token
unset token_output
chmod 600 ~/.config/mmf/operator.token
```

Each token is printed once. The commands above store the operator PAT in its
final private host file; save the device token privately on the agent host.

## Run the hub with systemd

These commands come from the repository installers. The service installation
was not exercised during the packaging check.

```bash
git clone https://github.com/rookslog/mcp-machine-fabric.git
cd mcp-machine-fabric
./scripts/install-release.sh
./scripts/install-hub.sh --public-url https://hub.example.com
node ~/.local/opt/mcp-machine-fabric/current/dist/cli.js passphrase
mkdir -p ~/.config/mmf && chmod 700 ~/.config/mmf
umask 077
token_output=$(node ~/.local/opt/mcp-machine-fabric/current/dist/cli.js token create operator)
printf '%s\n' "$token_output"
printf '%s\n' "$token_output" | awk '/^mmf_pat_/ { print; exit }' > ~/.config/mmf/operator.token
unset token_output
chmod 600 ~/.config/mmf/operator.token
```

The installer creates a user service and binds the hub to `127.0.0.1:8787`.
The token command prints the PAT once and stores only its `mmf_pat_…` line in
the private file used by the status and live checks below.
Check it with:

```bash
systemctl --user status mmf-hub.service
journalctl --user --unit mmf-hub.service --follow
```

Ask an administrator to enable user lingering if the service must run after
logout:

```bash
loginctl enable-linger "$USER"
```

## Add TLS

The following reverse-proxy examples were not exercised during the packaging
check. Confirm each product's current installation and access-control guidance
before production use.

### Caddy

Keep the hub on loopback and use this site block:

```caddyfile
hub.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Set `MMF_PUBLIC_URL=https://hub.example.com`.

### Tailscale Serve or Funnel

Serve the loopback hub to your tailnet:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Use Funnel only when the hub must be reachable from the public internet and
your tailnet policy permits it:

```bash
tailscale funnel --bg --https=443 http://127.0.0.1:8787
```

Set `MMF_PUBLIC_URL` to the HTTPS name that Tailscale reports.

### cloudflared named tunnel

Create a named tunnel and route a DNS name to it:

```bash
cloudflared tunnel create mmf-hub
cloudflared tunnel route dns mmf-hub hub.example.com
```

Create `~/.cloudflared/config.yml` with the tunnel UUID and credentials path:

```yaml
tunnel: TUNNEL_UUID
credentials-file: /home/USER/.cloudflared/TUNNEL_UUID.json
ingress:
  - hostname: hub.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Then run `cloudflared tunnel run mmf-hub` and set
`MMF_PUBLIC_URL=https://hub.example.com`.

## Install Linux and macOS agents

Create the device on the hub first. Run exactly one form, matching the way the
hub is hosted (skip this if the Docker setup above already added `laptop`):

```bash
# Source/systemd hub:
node ~/.local/opt/mcp-machine-fabric/current/dist/cli.js device add laptop
# Docker hub:
docker exec mmf-hub node /app/dist/cli.js device add laptop
```

On the controlled machine, clone the same release and install it:

```bash
git clone https://github.com/rookslog/mcp-machine-fabric.git
cd mcp-machine-fabric
./scripts/install-release.sh
./scripts/install-agent.sh --hub wss://hub.example.com/agent --root "$HOME"
```

Before installation, check out the same recorded release ref or commit SHA on
the hub and agent. The examples do not assume that a `0.1.0` tag exists.

The last command reads the device token from standard input. On Linux it
installs a systemd user service. On macOS it installs a launchd agent. Add
`--read-only` or `--no-exec` when that is the intended local policy. These
service installations were not exercised during the packaging check; their
dry-run behavior is covered by the repository test suite.

The Docker image can also run an agent by replacing its default `hub` command
with `agent` and its agent arguments. This mode was not exercised during the
packaging check. Disable the image's hub `/healthz` check, mount every allowed
root, supply the device token, and set `MMF_STATE_DIR` to a persistent mounted
directory. The `/data` volume and default health check are hub defaults; they
do not persist or assess an agent.

Check the connection from the hub with the saved personal access token. Run the
source/systemd form or the Docker form, matching the hub deployment:

```bash
# Source/systemd hub:
node ~/.local/opt/mcp-machine-fabric/current/dist/cli.js status \
  --url https://hub.example.com \
  --token-file ~/.config/mmf/operator.token
# Docker hub (passes the current shell's token value as an environment variable):
MMF_TOKEN="$(cat ~/.config/mmf/operator.token)" \
  docker exec --env MMF_TOKEN mmf-hub node /app/dist/cli.js status \
  --url http://127.0.0.1:8787
```

The machine is usable when its row says `READY`.

From the repository checkout on the hub, exercise a real PAT-authenticated MCP
session with the official SDK. This creates a scratch directory inside the
agent's first allowed root, tests file and command operations, and removes it.
It requires an agent with write and exec enabled. Run `npm ci` first when the
Docker route has not already installed checkout dependencies:

```bash
npm ci --no-audit --no-fund
MMF_TOKEN="$(cat ~/.config/mmf/operator.token)" node scripts/live-check.mjs \
  --url https://hub.example.com/mcp --machine laptop
```

For a read-only or no-exec agent, stop after the read-only `status` check. If a
full live check reports that cleanup failed, remove its reported
`.cache/mmf-live-check-*` scratch directory locally on the agent.

## Connect MCP clients

The PAT-authenticated Streamable HTTP path above was exercised with the
official SDK during the release-readiness run. The product-specific ChatGPT,
Claude Code, and Codex registration steps below were not exercised.

- ChatGPT: In ChatGPT Plugins, select **+**, then **Add custom MCP server** with
  `https://hub.example.com/mcp` as the MCP server URL. Use OAuth and approve the
  requested scopes with the owner passphrase.
- Claude Code: Create a PAT with `mmf token create claude-code`, then run
  `claude mcp add --transport http fabric https://hub.example.com/mcp --header "Authorization: Bearer $(cat token)"`.
  Omit the header when your Claude client supports OAuth.
- Codex CLI: Export the PAT as `MMF_TOKEN` and add this block to
  `~/.codex/config.toml`:

  ```toml
  [mcp_servers.fabric]
  url = "https://hub.example.com/mcp"
  bearer_token_env_var = "MMF_TOKEN"
  ```

Grant only the scopes that the client needs: `fabric:read`, `fabric:write`, and
`fabric:exec`.

## Back up and restore

The hub state is the SQLite database `hub.db` in `MMF_DATA_DIR`. The default
source installation uses `~/.local/share/mmf-hub`. The container uses `/data`.

Install the `sqlite3` command-line client, then use its online backup command
for a consistent snapshot:

```bash
umask 077
mkdir -p backups
sqlite3 "${MMF_DATA_DIR:-$HOME/.local/share/mmf-hub}/hub.db" ".backup 'backups/hub-$(date +%F).db'"
```

For Docker, run the same command against `/data/hub.db` from a maintenance
container that mounts `mmf-data`. The `sqlite3` CLI is a prerequisite; if it
is missing, install it through your OS package manager before proceeding.
The automated SQLite cases skip explicitly when this CLI is unavailable.

The source backup/restore commands were exercised on Linux with a temporary
HOME, a source-installed hub and agent, and SQLite CLI 3.36.0. Both graceful
and crash-stop restores recovered the snapshot's devices, PATs and request
rows; a PAT created after backup was rejected after restore. The Docker
maintenance-container path remains unexercised.

Before a restore, stop the hub and agents, and close other database clients.
For a systemd hub, use `systemctl --user stop mmf-hub.service`; stop agents
with their own service managers. Keep them stopped for the commands below.
Run as the hub user, with `MMF_DATA_DIR` set if you use a nondefault directory.
Set the shell variable `backup` to the selected backup's absolute path first.
Keep backups outside the live data directory.

```bash
(
set -eu
: "${backup:?set backup to the selected absolute backup path}"
umask 077
data="${MMF_DATA_DIR:-$HOME/.local/share/mmf-hub}"
pre_restore=$(mktemp -d "${data}.pre-restore.XXXXXX")
cp -a "$data/." "$pre_restore/"
# WAL/SHM belong to the old database, never to the restored snapshot.
rm -f "$data/hub.db" "$data/hub.db-wal" "$data/hub.db-shm"
cp "$backup" "$data/hub.db"
chmod 600 "$data/hub.db"
printf 'Pre-restore data retained at %s\n' "$pre_restore"
)
```

The subshell stops on errors, including a failed pre-restore copy, before
removing the original database.

The hub uses SQLite WAL mode. A graceful shutdown normally removes `-wal`
and `-shm`; a crash can leave both. Preserve the whole stopped data directory
first, then remove the old database and both sidecars before copying the
snapshot. Never delete sidecars while the hub or another database client is
using them. If the copy fails, keep services stopped and recover from the
pre-restore directory.

Start the hub and agents. Confirm `/healthz`, `/readyz`, `mmf status`, enrolled
devices, personal access tokens and recent requests before deleting the
pre-restore copy. Tokens created after the snapshot should no longer
authenticate. Device `last_seen` values and the request ledger will advance
again when agents reconnect and checks run. A snapshot stores token hashes,
not the original secrets: retain the backed-up devices' and clients' private
token files separately. Restrict access to the backup and pre-restore copy.

## Upgrade and roll back

For a source installation, fetch and check out the intended release. Then run
`./scripts/install-release.sh`. The script creates an immutable release
directory and changes `~/.local/opt/mcp-machine-fabric/current` to point to it.
It prints `previous current:` before building. Clean releases use
`<version>-<sha>`; dirty builds append `-dirty-<source-content-sha256>`, including
tracked and untracked nonignored source contents and modes. A reinstall builds
a candidate and compares all installed files, modes and symlinks (including
dependencies). It reuses a matching directory without replacing it, or fails
without modifying a differing release. An existing `current` must be a symlink.
Failed builds leave existing releases and `current` untouched. Do not edit
release directories; choose another commit if a candidate differs. If an
interrupted installer leaves `.install-lock`, confirm no installer is running
before removing that empty lock directory.

Restart the hub and agents after the link changes. Releases include code and
dependencies, not hub data, agent state or private configuration.

Record the old link target before an upgrade:

```bash
previous=$(readlink ~/.local/opt/mcp-machine-fabric/current)
printf 'Previous release: %s\n' "$previous"
```

To roll back, stop the hub and agents first. Set `previous` to that recorded
release directory if you are using a new shell, then repoint `current`:

```bash
(
set -eu
: "${previous:?set previous to the recorded release directory}"
test -d "$previous"
ln -sfn "$previous" "$HOME/.local/opt/mcp-machine-fabric/current"
)
```

Restart the hub and agents using their service managers. Repoint each
machine's own link when agents are on separate hosts. Back up the database
before upgrading: a code rollback does not undo schema or data changes. If
the previous release cannot read the upgraded database, keep services stopped
and use a compatible pre-upgrade snapshot via the restore procedure above.

The source X → Y → X release sequence was exercised on Linux in an isolated
HOME, including reinstalling X while its hub and agent ran, then restarting
both processes after upgrade and rollback. `/healthz`, `/readyz`, `mmf status`
and a PAT-authenticated `read_file` MCP call passed after each restart. This
exercise did not activate systemd/launchd units, run on macOS, or test a schema
change; those boundaries are separate from the source-process checks.

For Docker, build each release with a unique tag. Stop and replace the hub
container while keeping the `mmf-data` volume. To roll back, recreate the
container with the previous image tag and the same volume. Back up the database
before every upgrade because a future release can change its schema.

After an upgrade or rollback, check `/healthz`, `/readyz`, `mmf status`, and one
read-only MCP call before allowing writes or commands.
