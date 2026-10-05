# Z-Library → ChatGPT Secure MCP Tunnel deployment plan

Status: implementation bootstrap prepared; OpenAI-hosted tunnel creation / ChatGPT app attachment remains the external control-plane step.

## Goal

Make `zlibrary-mcp` a routine ChatGPT research capability while keeping the server, credentials, downloads, and processed texts private on DIONYSUS.

Target path:

```text
ChatGPT
  ↓ custom MCP app
OpenAI Secure MCP Tunnel
  ↓ outbound-only tunnel
DIONYSUS: tunnel-client
  ↓ stdio
zlibrary-mcp
  ↓
Z-Library / LibGen + DIONYSUS research artifact store
```

Remote Desktop Commander remains the administrative and write-capable fallback.

## Why a dedicated tunnel first

Do not put a general-purpose gateway/router in the data path yet.

A dedicated tunnel gives us:

- the smallest failure domain;
- no public inbound port;
- no additional HTTP/SSE bridge;
- independent restart/health state from the working arXiv tunnel;
- clean evidence about ChatGPT permissions and tool behaviour;
- an easy rollback: disable one user service.

`mcp-machine-fabric` should initially manage lifecycle, policy, audit, and deployment templates. It can later become a true multiplexing gateway if several MCP servers make that worthwhile.

## Existing DIONYSUS evidence

- `tunnel-client` is installed.
- An arXiv profile has been healthy on loopback port 8080 since September 24.
- User lingering is enabled, so user systemd services survive logout.
- `zlibrary-mcp` is built at `~/mcp-servers/zlibrary-mcp/dist/index.js`.
- Z-Library credentials already live in `~/.config/zlibrary-mcp/secrets.env` with mode 0600.
- Port 8081 is reserved by this plan for the Z-Library tunnel health/admin surface.

## Local artifact semantics

Until zlibrary-mcp implements a bounded artifact-root setting, the launcher fixes its working directory to:

`~/.local/share/zlibrary-mcp`

so current relative defaults land predictably at:

- `~/.local/share/zlibrary-mcp/downloads/`
- `~/.local/share/zlibrary-mcp/processed_rag_output/`

This is a compatibility measure, not the final security boundary. Upstream issue #204 tracks proper path containment.

## Credential boundaries

Three credential classes must stay separate:

1. **Z-Library credentials** — remain only in `~/.config/zlibrary-mcp/secrets.env`.
2. **OpenAI tunnel runtime key** — read by `tunnel-client`; never passed to zlibrary-mcp.
3. **OpenAI admin key** — only needed to create/manage tunnel objects programmatically; do not install it in the long-lived service.

The current host has a runtime key for the arXiv tunnel but no discovered `OPENAI_ADMIN_KEY`, so tunnel CRUD is the expected human/control-plane step unless an admin key is deliberately provisioned.

## Bootstrap

After creating a new OpenAI-hosted tunnel and obtaining its `tunnel_...` ID:

```bash
cd ~/workspace/projects/mcp-machine-fabric
./scripts/bootstrap-zlibrary-tunnel.sh tunnel_...
systemctl --user daemon-reload
systemctl --user enable --now zlibrary-mcp-tunnel.service
curl -fsS http://127.0.0.1:8081/readyz
```

Then in ChatGPT developer mode:

1. Create a custom app.
2. Choose **Tunnel** as the connection.
3. Select the new tunnel or paste its ID.
4. Review discovered tools and annotations.
5. Test read/fetch tools first.

## Product-permission split

Current ChatGPT Pro custom-MCP support is read/fetch-oriented. Consequently:

### Direct ChatGPT path

Prefer:

- search;
- metadata;
- quota/history inspection;
- full-text search where supported;
- a future bounded research-fetch/cache surface.

### Administrative/write path

Use Remote Desktop Commander for now for:

- arbitrary local export;
- filesystem placement;
- server upgrades/configuration;
- repair/debugging.

Issue #206 proposes a research-fetch/cache API so ChatGPT can obtain a stable document handle and bounded excerpts without exposing arbitrary filesystem writes.

## Validation gates

### Gate A — local launcher

- launches from a clean shell;
- lists all MCP tools;
- authenticated read operation succeeds;
- relative download/RAG paths resolve under the stable data root;
- no credential values appear in stdout/logs.

### Gate B — tunnel runtime

- `tunnel-client doctor` passes with the runtime key loaded;
- `/healthz` returns live;
- `/readyz` returns ready;
- tunnel polling is healthy;
- arXiv tunnel on 8080 remains untouched.

### Gate C — ChatGPT discovery

- the custom app discovers the expected Z-Library tools;
- tool names/descriptions/annotations are correct;
- a search request selects the intended tool;
- unsupported write calls are not misrepresented as read-only.

### Gate D — research ergonomics

Evaluate whether returning host paths is sufficient. If not, implement the bounded cache/handle API from issue #206 before introducing a general gateway.

## Failure and rollback

Rollback is local and narrow:

```bash
systemctl --user disable --now zlibrary-mcp-tunnel.service
```

Removing the profile or tunnel object can be a separate explicit action. The existing arXiv tunnel is not modified.

## Longer-term manager

After Z-Library is proven end-to-end, add a small registry to `mcp-machine-fabric` describing:

- MCP server name;
- local command/URL;
- tunnel profile;
- health port;
- secret-source references;
- artifact root;
- read/write capability classification;
- desired systemd unit state.

The manager should generate/validate profiles and units. It should **not** become a mandatory proxy unless we need cross-server routing, shared policy enforcement, or unified audit semantics.
