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

```bash
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
docker exec mmf-hub node /app/dist/cli.js token create operator
```

Each token is printed once. Move it to its final private file immediately.

## Run the hub with systemd

These commands come from the repository installers. The service installation
was not exercised during the packaging check.

```bash
git clone https://github.com/rookslog/mcp-machine-fabric.git
cd mcp-machine-fabric
./scripts/install-release.sh
./scripts/install-hub.sh --public-url https://hub.example.com
node ~/.local/opt/mcp-machine-fabric/current/dist/cli.js passphrase
```

The installer creates a user service and binds the hub to `127.0.0.1:8787`.
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

Create the device on the hub first:

```bash
node ~/.local/opt/mcp-machine-fabric/current/dist/cli.js device add laptop
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

Check the connection from the hub with a personal access token:

```bash
node ~/.local/opt/mcp-machine-fabric/current/dist/cli.js status \
  --url https://hub.example.com \
  --token-file ~/.config/mmf/operator.token
```

The machine is usable when its row says `READY`.

## Connect MCP clients

These client setup paths are supported by the repository configuration but
were not exercised during the packaging check.

- ChatGPT: In developer mode, create an app or connector with
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

Use SQLite's online backup command for a consistent snapshot:

```bash
mkdir -p backups
sqlite3 ~/.local/share/mmf-hub/hub.db ".backup 'backups/hub-$(date +%F).db'"
```

For Docker, run the same command against `/data/hub.db` from a maintenance
container that mounts `mmf-data`. The backup and restore commands were not
exercised during the packaging check.

Before a restore, stop the hub and copy the current data directory to a safe
location. Restore the selected database as `hub.db`, keep it owned by the hub
user, and then start the hub. Confirm `/readyz`, `mmf status`, enrolled devices,
and recent requests before deleting the pre-restore copy.

## Upgrade and roll back

For a source installation, fetch and check out the intended release. Then run
`./scripts/install-release.sh`. The script creates an immutable release
directory and changes `~/.local/opt/mcp-machine-fabric/current` to point to it.
Restart the hub and agents after the link changes.

Record the old link target before an upgrade:

```bash
readlink ~/.local/opt/mcp-machine-fabric/current
```

To roll back, repoint `current` to that recorded release directory and restart
the services. This rollback path was not exercised during the packaging check.

For Docker, build each release with a unique tag. Stop and replace the hub
container while keeping the `mmf-data` volume. To roll back, recreate the
container with the previous image tag and the same volume. Back up the database
before every upgrade because a future release can change its schema.

After an upgrade or rollback, check `/healthz`, `/readyz`, `mmf status`, and one
read-only MCP call before allowing writes or commands.
