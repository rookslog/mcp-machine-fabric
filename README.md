# MCP Machine Fabric

Self-hosted, open-source remote machine control for MCP clients. Run one **hub**
on a host you own, run an **agent** on every machine you want to control, and
point ChatGPT, Claude, Codex, or any MCP client at the hub. No proprietary
relay, no quota, no inbound ports on your machines.

```text
 ChatGPT · Claude · Codex · Cursor …          (MCP over Streamable HTTP, OAuth 2.1 or PAT)
                    │
          TLS front door of your choice: Tailscale Serve/Funnel, Caddy,
          cloudflared, or OpenAI Secure MCP Tunnel
                    │
               ┌────▼─────┐   SQLite: devices, OAuth, request ledger / audit
               │   hub    │   /mcp  /agent  /api/status  dashboard
               └────▲─────┘
        outbound WebSocket (device token), heartbeats, recovery
        ┌───────────┼───────────────┐
   ┌────┴────┐ ┌────┴────┐     ┌────┴────┐
   │ agent   │ │ agent   │ ... │ agent   │   policy enforced locally:
   │ linux   │ │ macOS   │     │ any     │   roots, read-only, exec on/off
   └─────────┘ └─────────┘     └─────────┘   durable jobs on local disk
```

**Status: 0.1.0, early but working.** See [docs/STATUS.md](docs/STATUS.md) for
exactly what has been verified, on which machines, and what has not.

## Why

Remote MCP control is most useful exactly when things go wrong: the laptop
slept, the connection dropped mid-command, the client timed out on a long
build. This project is designed around those cases:

| Problem | What the fabric does |
| --- | --- |
| "Online" that isn't | `list_machines` reports layered health: enrolled, connected, heartbeat age and RTT, executor load, local policy, and a `ready` verdict with the reason when not ready. |
| Losing a process when the call or connection ends | Every command is a **durable job**: detached, output on disk, exit code recorded. `run_command` returns a `job_id` if the command outlives the wait; agent restarts, hub restarts and disconnects don't kill it. |
| "Did it run?" after a timeout | Every call has a `request_id` in a ledger (`not_dispatched`, `dispatched`, `accepted`, `completed`, `failed`, `dispatched_unknown`). Agents keep a result cache; after a reconnect the hub recovers the real outcome. `get_request_status` answers the question. |
| Duplicate side effects on retry | Mutating calls are never retried automatically. Pass `idempotency_key` and a retry returns the recorded result instead of running again. |
| Writes landing on stale content | `write_file` takes `expected_sha256`; `edit_file` requires an exact match count. Rewrites are atomic. |
| Auditability | Who (OAuth client / token), what, where, when, outcome — with long arguments hashed, env values dropped. |
| Vendor dependence | MIT, self-hosted, standard MCP + OAuth. Works with any MCP client that supports remote servers. |

## Tools

All machine tools take a `machine` argument.

| Tool | Effect | Notes |
| --- | --- | --- |
| `list_machines` | read | layered health per machine |
| `read_file`, `list_directory`, `get_file_info`, `search_files` | read | ripgrep when available, bounded output |
| `write_file`, `edit_file`, `create_directory`, `move_path` | write | atomic, conflict-checked |
| `run_command` | exec | waits up to `wait_seconds`, then hands back a `job_id` |
| `start_job`, `read_job_output`, `list_jobs`, `send_job_input`, `cancel_job` | exec/read | durable jobs with byte cursors and stdin |
| `get_request_status`, `list_recent_requests` | read | delivery state and audit trail |

Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`) so clients like ChatGPT can ask for confirmation on writes.

## Quick start

Requires Node.js ≥ 22.13 on the hub and on each agent machine.

```bash
git clone https://github.com/rookslog/mcp-machine-fabric && cd mcp-machine-fabric
./scripts/install-release.sh            # builds into ~/.local/opt/mcp-machine-fabric/current
alias mmf="node ~/.local/opt/mcp-machine-fabric/current/dist/cli.js"
```

### 1. Hub

```bash
mmf passphrase                           # owner passphrase for OAuth consent (stdin)
MMF_PUBLIC_URL=https://hub.example.ts.net mmf hub --port 8787
```

The hub listens on `127.0.0.1` only. Put TLS in front of it, e.g. on a tailnet:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8787
# public (needs Funnel enabled in your tailnet policy):
tailscale funnel --bg --https=8443 http://127.0.0.1:8787
```

A user systemd unit is in [deploy/systemd/mmf-hub.service](deploy/systemd/mmf-hub.service)
(`scripts/install-hub.sh` installs it); a [Dockerfile](Dockerfile) is provided too.
Check health any time with `MMF_TOKEN=… mmf status --url https://<hub>`.

### 2. Agents

On the hub host:

```bash
mmf device add laptop                    # prints a device token once
```

On the machine to control, the easiest path is the installer (systemd on Linux,
launchd on macOS; it stores the token with mode 0600):

```bash
echo '<device token>' | ./scripts/install-agent.sh --hub wss://hub.example.ts.net:8443/agent --root ~
```

Or run it in the foreground:

```bash
mmf agent --hub wss://hub.example.ts.net:8443/agent --token-file ~/.config/mmf/agent.token \
          --root ~ [--read-only] [--no-exec]
```

Service templates: [systemd](deploy/systemd/mmf-agent.service) (note
`KillMode=process`, which keeps jobs alive across agent restarts) and
[launchd](deploy/launchd/dev.mcp-machine-fabric.agent.plist).

### 3. Clients

- **ChatGPT** (developer mode → Create app/connector): MCP server URL
  `https://<hub>/mcp`, authentication OAuth. ChatGPT registers itself, you
  approve it on the hub's consent page with the owner passphrase and choose
  scopes. Alternatively connect through an OpenAI Secure MCP Tunnel
  (`tunnel-client init --mcp-server-url http://127.0.0.1:8787/mcp`).
- **Claude Code**: `claude mcp add --transport http fabric https://<hub>/mcp --header "Authorization: Bearer $(cat token)"`
  with a token from `mmf token create claude-code`, or omit the header to use OAuth.
- **Codex CLI**: in `~/.codex/config.toml`:
  ```toml
  [mcp_servers.fabric]
  url = "https://<hub>/mcp"
  bearer_token_env_var = "MMF_TOKEN"
  ```

## Security

Read [SECURITY.md](SECURITY.md). In short: a hub URL plus a token with
`fabric:exec` is a shell on every enrolled machine, within each agent's local
policy. Fabric scopes are enforced at the hub; optional `machine:<name>` scopes
restrict a connector or PAT to named machines, while no machine scope preserves
access to all machines. Audit rows are principal-scoped unless an all-machine
`fabric:exec` caller performs owner-level review, and job output requires
`fabric:exec`. Roots/read-only/no-exec are enforced on the agent.

## More docs

- [docs/CHATGPT.md](docs/CHATGPT.md) — connecting ChatGPT (OpenAI Secure MCP Tunnel or public HTTPS)
- [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) — hosting your own hub (systemd or Docker), TLS, backups, upgrades
- [docs/STATUS.md](docs/STATUS.md) — what is verified and what is not

## Design

- [ADR 0002](docs/adr/0002-hub-and-outbound-agents.md) — architecture decision
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — hub ↔ agent protocol and delivery semantics
- [PROPOSAL.md](PROPOSAL.md), [docs/DESIGN_GAPS.md](docs/DESIGN_GAPS.md) — the original analysis

## Relation to Desktop Commander

[DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) is an
excellent local MCP server; its remote mode relays through a proprietary hosted
service. This project is an independent implementation (no code copied) of the
remote-control use case, built to be self-hosted. It is not affiliated with or
endorsed by Desktop Commander.

## License

MIT
