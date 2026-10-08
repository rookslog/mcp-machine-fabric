# ChatGPT connectivity

Status as of 2026-10-08: the OpenAI tunnel route is prepared and dry-run tested. Creating the OpenAI-hosted tunnel and attaching it to a ChatGPT app remain owner actions. The public HTTPS route is documented but has not been enabled.

## Choose a route

| Route | Hub exposure | ChatGPT authentication | Use when |
|---|---|---|---|
| A. OpenAI Secure MCP Tunnel | No public inbound listener; tunnel-client makes outbound connections | **No authentication** in ChatGPT; tunnel-client injects a local MMF PAT | Preferred for this host |
| B. Tailscale Funnel | Public HTTPS endpoint on port 8443 | Hub OAuth with owner consent | Use only when a public endpoint is acceptable |

Route A is preferred. `tunnel-client` 0.0.9 supports `mcp.extra_headers` and `mcp.discovery_extra_headers`, including `file:` secret references. The setup script stores the raw PAT separately from the complete `Bearer …` header value and references the latter from the profile. The connector must use **No authentication**: tunnel-client applies connector-supplied headers after static headers, so a forwarded `Authorization` header would override the injected PAT.

The tunnel runtime's `CONTROL_PLANE_API_KEY` authenticates tunnel-client to OpenAI. It does not authenticate requests to the MMF hub. An `OPENAI_ADMIN_KEY` is needed only for programmatic tunnel CRUD and is not installed in the service.

## A. OpenAI Secure MCP Tunnel

### Owner prerequisites

1. In [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels), create the tunnel object and copy its `tunnel_…` ID. The installed client requires 32 lowercase letters or digits after `tunnel_`.
2. Ensure the principal behind the existing runtime key has **Tunnels Read + Use** for that tunnel.
3. Associate the tunnel with the intended ChatGPT workspace as well as its Platform organization. An organization-only association does not automatically make it visible in a workspace.
4. Ensure the person creating the ChatGPT plugin has **Tunnels Read + Use** and workspace permission to add a custom MCP server.
5. Do not add an admin key to the long-lived service. This host has no discovered admin key, and the setup does not require one.

### Create the local profile and unit

```bash
cd ~/workspace/projects/mcp-machine-fabric
./scripts/setup-openai-tunnel.sh tunnel_<32-lowercase-characters>
systemctl --user daemon-reload
systemctl --user enable --now mmf-openai-tunnel.service
```

The script:

- targets `http://127.0.0.1:8787/mcp`;
- creates or reuses `~/.config/mmf/pat-openai-tunnel.token`;
- stores the complete header value in `~/.config/mmf/pat-openai-tunnel.authorization`;
- writes both files with mode `0600` and never prints their contents;
- reuses the `EnvironmentFile=` reference from `arxiv-mcp-tunnel.service` for `CONTROL_PLANE_API_KEY` without copying the key;
- parses only the required runtime-key assignment as data for doctor; it does not execute the EnvironmentFile as shell code;
- writes `~/.config/tunnel-client/mmf-hub.yaml` and `~/.config/systemd/user/mmf-openai-tunnel.service`;
- refuses the protected `arxiv-local` profile and refuses to replace pre-existing profile/unit files that lack its management marker;
- refuses health port 8080, which belongs to the unrelated arXiv tunnel;
- validates a temporary candidate bundle before installing it, backs up existing managed files, and restores them if installation fails;
- runs `tunnel-client doctor --profile mmf-hub --explain` against that candidate.

The current hub intentionally has no OAuth metadata because its configured `MMF_PUBLIC_URL` is plain HTTP. Doctor therefore reports `oauth_metadata` as failed even when the profile, runtime key reference, MCP target, local reachability, health listener, and UI checks pass. The script reads doctor’s JSON report and accepts only the sole failure `oauth_metadata` with the exact expected HTTP 404 from the loopback protected-resource URL. A timeout, 5xx, different URL, or additional failed check reported by doctor stops setup. The installed doctor treats a 2xx metadata response as reachable; it does not validate the response body’s OAuth semantics.

### Verify the local runtime

```bash
systemctl --user status mmf-openai-tunnel.service
curl -fsS http://127.0.0.1:8082/healthz
curl -fsS http://127.0.0.1:8082/readyz
journalctl --user -u mmf-openai-tunnel.service -n 100 --no-pager
```

Interpret the checks separately:

- `/healthz` proves that the local daemon is live.
- `/readyz` reports the control-plane, MCP probe, and discovery gates. Record its exact JSON/text; do not infer readiness from `/healthz`.
- `curl -fsS http://127.0.0.1:8787/readyz` checks the hub itself.
- The existing arXiv service should remain active and continue answering on `127.0.0.1:8080`; this setup never restarts or rewrites it.

### Create the ChatGPT app

Keep `mmf-openai-tunnel.service` running during discovery and every later MCP call.

1. Open [ChatGPT Plugins](https://chatgpt.com) and select the plus button.
2. Choose **Add custom MCP server**.
3. Under **Connection**, choose **Tunnel**.
4. Select the tunnel or paste its `tunnel_…` ID.
5. Choose **No authentication**. The local tunnel profile supplies the PAT.
6. Review the risk warning, select **I understand and want to continue**, and create the plugin.
7. Review every discovered read, write, and exec action before enabling it broadly.
8. In a new chat, select the plugin and start with a read-only request such as machine status or a bounded file read.

If the tunnel is absent from the selector, check its ChatGPT-workspace association and the plugin creator’s Tunnels Read + Use permissions before changing local configuration. UI labels can change; the official [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) is controlling.

Observed locally: the script and doctor configuration path work. Not yet verified: a real OpenAI tunnel poll, `/readyz` from the running MMF tunnel daemon, ChatGPT tool discovery, or a ChatGPT-originated MCP call. Those require the owner-created tunnel object.

### Rotate or remove the PAT

Header-file values are resolved at tunnel-client startup. Rotation therefore requires a short MMF-tunnel interruption; replacing files without restarting leaves the old PAT in the running process.

Stop only the MMF tunnel, locate and revoke the token named `openai-tunnel`, remove this tunnel’s two local files, rerun setup, then start and verify it:

```bash
systemctl --user stop mmf-openai-tunnel.service
node ~/.local/opt/mcp-machine-fabric/current/dist/cli.js token list
node ~/.local/opt/mcp-machine-fabric/current/dist/cli.js token revoke <token-id>
rm ~/.config/mmf/pat-openai-tunnel.token ~/.config/mmf/pat-openai-tunnel.authorization
./scripts/setup-openai-tunnel.sh tunnel_<32-lowercase-characters>
systemctl --user daemon-reload
systemctl --user start mmf-openai-tunnel.service
curl -fsS http://127.0.0.1:8082/readyz
```

After rotation, perform an authenticated MCP call through ChatGPT or the intended product surface. `/healthz` and doctor’s HTTP 405 reachability check do not prove the new PAT was accepted.

Rollback is narrow:

```bash
systemctl --user disable --now mmf-openai-tunnel.service
```

Do not disable, restart, edit, or remove `arxiv-mcp-tunnel.service`, its profile, or its environment file.

## B. Public HTTPS with Tailscale Funnel

This route publishes the hub to the public internet. The MCP endpoint and APIs require bearer authentication, but the hub dashboard at `/` is public. Prefer Route A unless this exposure is explicitly intended.

### Owner prerequisites

The tailnet owner/admin must enable HTTPS and Funnel/Serve permissions for the node. Funnel supports HTTPS ports 443, 8443, and 10000; this setup uses 8443.

### Configure the hub and Funnel

1. Set the externally visible URL in `~/.config/mmf/hub.env`:

   ```dotenv
   MMF_PUBLIC_URL=https://dionysus.tail0528f0.ts.net:8443
   ```

2. Set the OAuth owner passphrase if it is not already configured:

   ```bash
   node ~/.local/opt/mcp-machine-fabric/current/dist/cli.js passphrase
   ```

   Enter a passphrase of at least 12 characters on stdin and finish with Ctrl-D. Do not put it on the command line or in `hub.env`.

3. Restart the hub so it advertises the public HTTPS issuer/resource URLs, then enable Funnel:

   ```bash
   systemctl --user restart mmf-hub.service
   tailscale funnel --bg --https=8443 http://127.0.0.1:8787
   ```

### Verify HTTPS and OAuth metadata

```bash
tailscale funnel status
curl -fsS https://dionysus.tail0528f0.ts.net:8443/readyz
curl -fsS https://dionysus.tail0528f0.ts.net:8443/.well-known/oauth-protected-resource/mcp
curl -fsS https://dionysus.tail0528f0.ts.net:8443/.well-known/oauth-authorization-server
```

Check the returned values, not only HTTP status:

- protected-resource `resource` must be `https://dionysus.tail0528f0.ts.net:8443/mcp`;
- `authorization_servers[0]` must use the same public HTTPS origin;
- authorization-server `issuer`, `authorization_endpoint`, `token_endpoint`, and `registration_endpoint` must all be browser-reachable HTTPS URLs on that origin.

In ChatGPT, create a custom MCP app with endpoint `https://dionysus.tail0528f0.ts.net:8443/mcp`, select OAuth, complete the browser consent page with the owner passphrase, scan tools, and test a read-only action first.

This route is not currently verified. Enabling Funnel, changing `MMF_PUBLIC_URL`, restarting the hub, and completing OAuth consent are owner-controlled external-state changes.

Rollback:

```bash
tailscale funnel --bg --https=8443 http://127.0.0.1:8787 off
```

Then restore the prior `MMF_PUBLIC_URL` deliberately and restart `mmf-hub.service`.

## Research evidence

Primary local evidence:

- `tunnel-client help doctor`, `help oauth`, `help quickstart`, `help samples`, and `help troubleshooting`;
- `tunnel-client init --help`, `doctor --help`, `run --help`, and `health --help`;
- materialized `sample_mcp_remote_no_auth` and `sample_mcp_with_dcr` profiles;
- the installed `arxiv-mcp-tunnel.service` unit (read-only);
- current hub source and live loopback probes.

Primary upstream references:

- [tunnel-client configuration](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)
- [tunnel-client repository](https://github.com/openai/tunnel-client)
- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [ChatGPT developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)
- [Tailscale Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel)
- [Tailscale Funnel requirements](https://tailscale.com/kb/1223/funnel)

## Required fake-ID doctor receipt

Command:

```bash
./scripts/setup-openai-tunnel.sh tunnel_0123456789abcdef --dry-run
```

Doctor output, verbatim (no secret values were present):

```text
CHECK config_source            PASS profile: mmf-hub
CHECK profile_load             PASS /tmp/mmf-openai-tunnel.KvEjqO/profiles/mmf-hub.yaml
CHECK tunnel_id                FAIL invalid tunnel ID "tunnel_0123456789abcdef": must match tunnel_<32 lowercase letters or digits>
CHECK tunnels_management_url   PASS https://platform.openai.com/settings/organization/tunnels
CHECK runtime_api_keys_url     PASS https://platform.openai.com/settings/organization/api-keys
CHECK admin_api_keys_url       PASS https://platform.openai.com/settings/organization/admin-keys
CHECK chatgpt_connector_settings_url PASS https://chatgpt.com/#settings/Connectors
CHECK codex_plugin             SKIP Codex detected; Tunnel MCP plugin not installed (run `tunnel-client codex plugin install`)

RESULT fail
FAILED_CHECKS tunnel_id
EXIT_CODE 2

CHECK tunnel_id   FAIL
Why this matters:
  tunnel-client cannot register or poll the control plane without a valid tunnel id.

Evidence:
  - invalid tunnel ID "tunnel_0123456789abcdef": must match tunnel_<32 lowercase letters or digits>

What to do next:
  1. create or inspect the tunnel in https://platform.openai.com/settings/organization/tunnels
  2. run `tunnel-client admin tunnels get <tunnel_id>` if you already know the tunnel id; this read-only lookup works with the runtime key
  3. if you need admin CRUD or discovery, create or inspect an admin key in https://platform.openai.com/settings/organization/admin-keys and then run `tunnel-client admin tunnels create --help` or `tunnel-client admin tunnels list --help`
  4. once you have a tunnel id, create a first profile with `tunnel-client init --sample sample_mcp_with_dcr --profile sample_mcp_with_dcr --tunnel-id tunnel_... --mcp-server-url http://127.0.0.1:3001/mcp`
  5. or set --control-plane.tunnel-id or CONTROL_PLANE_TUNNEL_ID to a tunnel_<32 lowercase hex> value
  6. Create or verify the connector in https://chatgpt.com/#settings/Connectors only while `tunnel-client run --profile mmf-hub` is running. Keep the daemon up for connector discovery and every MCP call from ChatGPT.
  7. for the full first-use flow run `tunnel-client help quickstart`

CHECK codex_plugin   SKIP
Why this matters:
  the optional Codex plugin gives tunnel-client a more discoverable Codex-native control surface.

Evidence:
  - CODEX_HOME: /home/rookslog/.codex
  - expected plugin dir: /home/rookslog/.codex/plugins/cache/debug/tunnel-mcp/local

What to do next:
  1. tunnel-client codex plugin install
```

The intentionally short fake ID prevents doctor from reaching later checks. A second offline doctor run with a 32-character placeholder reached the local hub and reported:

```text
CHECK mcp_target               PASS http://127.0.0.1:8787/mcp
CHECK mcp_server_reachable     PASS HTTP 405 from http://127.0.0.1:8787/mcp
CHECK oauth_metadata           FAIL HTTP 404 from http://127.0.0.1:8787/.well-known/oauth-protected-resource/mcp
```

This corroborates local MCP reachability without contacting the OpenAI control plane. HTTP 405 is expected because the stateless MCP endpoint accepts POST, not GET. It does not establish that a real PAT-authenticated initialize call or a ChatGPT tunnel call succeeds.
