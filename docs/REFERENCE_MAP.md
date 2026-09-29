# Reference map

This file records the primary repositories, specifications, and operational references that should anchor design decisions. Secondary blog posts should not override these sources.

## Desktop Commander

### Local open-source tool engine

**Repository:** https://github.com/wonderwhy-er/DesktopCommanderMCP  
**License:** MIT  
**Role:** mature local filesystem/shell/process/search MCP implementation; also contains the current remote-device client.

Important areas to inspect before implementation:

- `src/remote-device/remote-channel.ts` — Supabase auth/realtime, presence, heartbeat, capability state, reconnect behavior.
- remote-device setup/auth code — persisted device sessions and pairing.
- configuration and blocked-command handling — current local policy model.
- process/session code — long-running command lifecycle.

Useful issue evidence:

- https://github.com/wonderwhy-er/DesktopCommanderMCP/issues/755 — fresh JWT accepted for auth/device registration but Supabase Realtime channel remains unreachable.
- https://github.com/wonderwhy-er/DesktopCommanderMCP/issues/661 — device reports online/meta calls work while first shell execution fails; persisted session also re-enters auth flow.

These are bug reports, not established root-cause analyses. We should reproduce relevant behavior before treating a proposed cause as fact.

### Hosted Remote Desktop Commander

**Repository/docs:** https://github.com/desktop-commander/remote-desktop-commander  
**Hosted endpoint:** https://mcp.desktopcommander.app/mcp  
**Implementation status:** hosted service proprietary; repo contains manifests/docs/issues.

Important documents:

- README: https://github.com/desktop-commander/remote-desktop-commander/blob/main/README.md
- Security/trust model: https://github.com/desktop-commander/remote-desktop-commander/blob/main/SECURITY.md
- Setup: https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md
- Contributing/open-vs-closed boundary: https://github.com/desktop-commander/remote-desktop-commander/blob/main/CONTRIBUTING.md

Documented hosted responsibilities include the public MCP endpoint, OAuth, device pairing, session handling, account-scoped relay, and device reachability/revocation.

## Model Context Protocol

**Specification repository:** https://github.com/modelcontextprotocol/modelcontextprotocol  
**Documentation:** https://modelcontextprotocol.io/

Design implications to track:

- JSON-RPC request/response semantics.
- MCP lifecycle and capability negotiation.
- stdio versus Streamable HTTP transport.
- HTTP authorization model.
- current specification's move toward explicit request-carried state and identifiers rather than connection-local assumptions.

Do not invent proprietary extensions when a standard MCP primitive will suffice.

## OpenAI Secure MCP Tunnel

**Product guide:** https://developers.openai.com/api/docs/guides/secure-mcp-tunnels  
**Client repository:** https://github.com/openai/tunnel-client  
**License:** Apache-2.0

Important implementation/reference docs:

- docs index: https://github.com/openai/tunnel-client/blob/master/docs/README.md
- architecture: https://github.com/openai/tunnel-client/blob/master/docs/architecture.md
- wire protocol: https://github.com/openai/tunnel-client/blob/master/docs/protocol.md
- OpenAPI contract: https://github.com/openai/tunnel-client/blob/master/docs/openapi.json
- systemd/VM deployment: https://github.com/openai/tunnel-client/blob/master/docs/deployment/systemd-vm.md
- troubleshooting/health: https://github.com/openai/tunnel-client/blob/master/docs/troubleshooting.md

Reference-design features worth borrowing conceptually:

- outbound-only reachability;
- explicit local queue and active-operation limits;
- separate liveness/readiness/component health;
- bounded long polling;
- control-plane and target-server health observed independently;
- wire protocol published separately from implementation.

Current issue evidence to test rather than blindly inherit:

- https://github.com/openai/tunnel-client/issues/41 — ChatGPT developer-mode no-auth discovery/reconnect loop involving `server/discover`.
- https://github.com/openai/tunnel-client/issues/55 — reports of long ChatGPT Web workflows stopping after roughly an hour while local tunnel health remained green.
- issues index: https://github.com/openai/tunnel-client/issues

## Tailscale

**Serve:** https://tailscale.com/docs/features/tailscale-serve  
**Funnel:** https://tailscale.com/docs/features/tailscale-funnel

Use cases:

- **Serve:** private tailnet exposure. Strong candidate for DIONYSUS-to-Apollo service access, not a direct solution for ChatGPT ingress.
- **Funnel:** public internet ingress through Tailscale relay/proxy infrastructure. Potential future HTTP ingress, but application-level auth remains mandatory for machine-control tools.

Our existing SSH/Tailscale reachability should be treated as a useful substrate, not coupled into core MCP semantics.

## Reference-design questions

For each design we evaluate, ask:

1. Where does identity live?
2. Who authenticates whom?
3. What state is durable?
4. What does "online" actually prove?
5. What delivery guarantee applies to mutating calls?
6. How are duplicate requests handled?
7. What happens when a client disconnects but execution continues?
8. Can transport be replaced without changing tool semantics?
9. Can one machine fail without poisoning the whole gateway?
10. Can the owner audit and revoke access locally?
