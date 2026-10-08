# ADR 0002: Self-hosted hub with outbound agents and a native durable executor

**Status:** Accepted (supersedes the "proposal-only" clause of ADR 0001 §3)
**Date:** 2026-10-08
**Decider:** lead engineer under the owner's delegation brief of 2026-10-08

## Context

The owner wants to stop depending on Desktop Commander's proprietary hosted
relay (`mcp.desktopcommander.app`) and its quota while keeping the workflow:
ChatGPT and other MCP clients operating files and processes on DIONYSUS
(always-on Linux) and Apollo (macOS laptop). The frictions to fix are
reachability that lies, losing access mid-operation, uncertain completion and
retries, long-running work that dies with a request, and no audit trail.

Options weighed (PROPOSAL.md §4): adapt DesktopCommanderMCP as an executor,
fork it, write a native executor, or clone the hosted relay.

Evidence gathered on 2026-10-08:

- DesktopCommanderMCP's remote agent is built around Supabase auth/realtime
  (`src/remote-device/remote-channel.ts`); its process sessions live inside the
  server process, so they die with it. Those are exactly the failure domains we
  want to remove, so wrapping it would import them.
- The tool surface the workflow actually needs (read/write/edit/list/search
  files, run commands, long-running processes) is small enough to implement and
  test directly, with semantics we control (atomic writes, conflict detection,
  durable jobs).
- An OpenAI Secure MCP Tunnel already runs on DIONYSUS (arXiv), so ChatGPT
  reachability through a tunnel is proven on this account. `tunnel-client` can
  front an HTTP MCP server that exposes OAuth discovery metadata.
- Tailscale connects both machines; Funnel is **not** enabled for the tailnet
  (no funnel node capability on DIONYSUS).

## Decision

1. **One hub, many outbound agents.** The hub (on DIONYSUS by default, any host
   in principle) is the only thing MCP clients talk to. Every machine runs an
   agent that *dials out* to the hub over a WebSocket, authenticated by a
   per-device token the hub issued. Machine identity is the enrolled device
   name, independent of transport or IP. This works behind NAT, on sleeping
   laptops, and on other people's hosts without inbound ports.
2. **Native executor, not a DesktopCommanderMCP wrapper or fork.** File tools
   and process tools are implemented in this repo. DesktopCommanderMCP remains a
   reference and could be added later as an optional executor; nothing here
   copies its code.
3. **Every command is a durable job.** Commands run under a detached wrapper
   that writes output and exit status to disk. A command that outlives the MCP
   call returns a `job_id`; restarting the agent, the hub, or the connection
   never kills it.
4. **Explicit delivery semantics.** Every call gets a request id recorded in a
   SQLite ledger with states `not_dispatched → dispatched → accepted →
   completed | failed`, or `dispatched_unknown` when the result could not be
   confirmed. Mutating calls are never retried automatically. Agents keep a
   result cache so the hub can recover lost outcomes after reconnecting.
   Clients may pass `idempotency_key` to make retries safe.
5. **Standard MCP ingress.** The hub serves stateless Streamable HTTP at `/mcp`
   with an embedded OAuth 2.1 authorization server (PKCE, dynamic client
   registration, owner-passphrase consent, scopes `fabric:read|write|exec`) plus
   personal access tokens for CLI clients. Any reverse proxy or tunnel can front
   it: Tailscale Serve (private), Funnel/Cloudflare/Caddy (public), or OpenAI
   Secure MCP Tunnel (ChatGPT without inbound exposure).
6. **Policy is enforced on the agent**, so a misconfigured hub cannot widen it:
   allowed roots (symlink-resolved) for file tools, read-only mode, exec on/off.
   Scopes are enforced at the hub per client.
7. **TypeScript on Node ≥ 22.13**, `node:sqlite` for storage (no native build
   step), official MCP SDK, `ws`. MIT license retained.

## Consequences

- We own the executor's correctness; it is covered by real-process tests.
- The hub is a single point of control. It holds no file content beyond
  summarized audit metadata and outcomes needed for idempotent replay.
- Public reachability for ChatGPT needs one owner action outside this repo:
  enable Tailscale Funnel for the node, or create an OpenAI tunnel ID and run
  `tunnel-client` against the hub. Both are documented; neither is required
  for private clients on the tailnet.
- Exec is all-or-nothing per machine: roots cannot sandbox a shell. This is
  stated in the tool descriptions and docs rather than implied away.
