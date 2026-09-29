# Proposal: Open MCP Machine Fabric

**Status:** draft for review  
**Repository:** `/home/rookslog/workspace/projects/mcp-machine-fabric`  
**Date:** 2026-09-29

## 1. Problem

We want an open-source way for MCP-capable AI clients to work on user-owned computers without making the local execution engine dependent on one proprietary hosted relay.

The immediate environment has two relevant machines:

- **DIONYSUS** — always-on Linux host and likely runtime/control-plane candidate.
- **Apollo** — macOS development machine, already reachable from DIONYSUS over the existing private network.

The current Remote Desktop Commander product proves the workflow is useful, but its hosted service is proprietary even though the local tool engine and device agent are open source. The goal is not to copy a SaaS product for its own sake. It is to identify which layers are actually necessary, keep those layers replaceable, and open-source whatever new software we build.

## 2. What is open and what is proprietary today

### Desktop Commander

The public Remote Desktop Commander repository states that:

- the hosted endpoint is `https://mcp.desktopcommander.app/mcp`;
- it uses Streamable HTTP and OAuth 2.0;
- the hosted server relays calls to a paired device;
- the hosted service implementation is **not open source**;
- the local DesktopCommanderMCP server and remote device agent are open source.

Primary sources:

- https://github.com/desktop-commander/remote-desktop-commander
- https://github.com/desktop-commander/remote-desktop-commander/blob/main/SECURITY.md
- https://github.com/desktop-commander/remote-desktop-commander/blob/main/CONTRIBUTING.md
- https://github.com/wonderwhy-er/DesktopCommanderMCP

The local DesktopCommanderMCP repository is MIT licensed. Its remote-device code shows that the current device agent uses Supabase authentication/realtime, device registration, presence, heartbeats, capability flags, token refresh, reconnect logic, and call recovery. A particularly informative implementation file is:

- https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/src/remote-device/remote-channel.ts

Therefore the proprietary component is not the filesystem/shell/process tool engine. The closed component is primarily the hosted MCP/OAuth/device-pairing/session/routing service and its operational infrastructure.

### OpenAI Secure MCP Tunnel

OpenAI separately publishes an Apache-2.0 `tunnel-client` and public wire-protocol documentation. It lets a private MCP server remain behind a firewall while a local client long-polls OpenAI over outbound HTTPS, forwards MCP JSON-RPC locally, and posts responses back.

Primary sources:

- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://github.com/openai/tunnel-client
- https://github.com/openai/tunnel-client/blob/master/docs/README.md
- https://github.com/openai/tunnel-client/blob/master/docs/protocol.md
- https://github.com/openai/tunnel-client/blob/master/docs/deployment/systemd-vm.md
- https://github.com/openai/tunnel-client/blob/master/docs/troubleshooting.md

This provides a useful reference design and an immediate transport option, but the architecture should not make OpenAI's tunnel a required core dependency.

## 3. Architecture decomposition

The system should be decomposed into six layers rather than treated as one "remote desktop" product:

1. **Tool engine / executor**  
   Filesystem, shell, process, search, editing, and other machine-local operations.

2. **Machine agent**  
   Runs next to the executor, advertises capabilities, reports health, and accepts authenticated requests.

3. **Transport**  
   Moves MCP/RPC traffic between a client-facing gateway and a machine agent. Examples: OpenAI Secure MCP Tunnel, direct Streamable HTTP, Tailscale, SSH, or a future relay.

4. **Router / registry**  
   Maps a logical machine identity such as `apollo` or `dionysus` to a currently usable execution path.

5. **Policy / authorization**  
   Determines which client may invoke which tools, against which machine and path/command scopes.

6. **Observability / recovery**  
   Health, audit events, request IDs, timeouts, retries, cancellation, queue state, and recovery after disconnects.

This separation is the central proposed design principle.

## 4. Build-on-upstream versus fork versus rewrite

### Option A — Adapter around DesktopCommanderMCP

Use DesktopCommanderMCP as one executor implementation while building our own machine/router/policy abstractions around it.

**Advantages**
- Reuses mature file/process/search tools.
- MIT-compatible with this repository.
- Lowest initial implementation cost.
- Lets us test the remote-control architecture before reimplementing local tools.

**Risks**
- We may inherit assumptions from DesktopCommander's local API.
- Some remote-device code is tightly coupled to its hosted Supabase architecture.
- Upstream tool semantics may not match our eventual security model.

### Option B — Fork DesktopCommanderMCP

Fork the whole project and replace its remote layer.

**Advantages**
- Fast path to a complete tool surface.
- Easy to patch upstream bugs immediately.

**Risks**
- Large maintenance burden.
- Makes our architecture inherit upstream structure by default.
- Harder to distinguish our control-plane concerns from their local-tool concerns.
- Encourages solving the wrong problem: maintaining a fork rather than defining a clean boundary.

### Option C — New local executor

Implement a minimal MCP tool engine ourselves.

**Advantages**
- Clean security and lifecycle semantics.
- No accidental dependence on upstream design choices.
- Small auditable surface if deliberately constrained.

**Risks**
- Reimplements substantial mature functionality.
- More early work before we learn whether the new architecture is valuable.

### Option D — Clone the proprietary hosted relay

Build our own public OAuth/device-pairing/multi-user SaaS first.

**Advantages**
- Maximum independence.

**Risks**
- Solves multi-tenant product problems we do not currently have.
- Requires public authentication, device enrollment, abuse prevention, uptime, billing/quotas if generalized, and more extensive operational security.
- Delays learning about the actual two-machine use case.

## 5. Initial recommendation

**Do not fork DesktopCommanderMCP wholesale and do not clone the proprietary relay first.**

Start with Option A:

- treat DesktopCommanderMCP as a replaceable executor adapter;
- define our own machine, transport, policy, health, and request-lifecycle interfaces;
- run the first gateway on DIONYSUS;
- use the existing private path to Apollo;
- make OpenAI Secure MCP Tunnel one transport adapter, not the architecture;
- preserve a path to direct Streamable HTTP or another relay later.

If the adapter boundary proves awkward, move selectively toward Option C rather than automatically taking ownership of a large fork.

## 6. Candidate reference architecture

```text
                    MCP-capable clients
                           |
                  +--------+--------+
                  |                 |
          OpenAI tunnel       Streamable HTTP
          (optional)          (future/optional)
                  |                 |
                  +--------+--------+
                           |
                    MCP gateway/router
                      on DIONYSUS
                           |
              +------------+------------+
              |                         |
       local executor              machine adapter
        DIONYSUS                         |
                                         |
                                private network
                                         |
                                      Apollo
                                         |
                                  local executor
```

The gateway should expose logical machine selection without requiring clients to understand transport details.

Example conceptual tool shape:

```json
{
  "machine": "apollo",
  "operation": "read_file",
  "arguments": {
    "path": "/Users/rookslog/Development/..."
  }
}
```

This schema is illustrative only; we should first test whether machine selection belongs in every tool, in namespaces, or in separate server instances.

## 7. Why DIONYSUS is the leading host candidate

DIONYSUS is currently the better candidate runtime host because it is:

- normally always on;
- Linux, making `systemd` supervision straightforward;
- already the machine with `/home/rookslog/workspace/projects`;
- already privately connected to Apollo;
- better suited to persistent daemon responsibilities than a frequently sleeping laptop.

Apollo remains a good development/control seat. Remote Desktop Commander can drive Apollo, Apollo can SSH to DIONYSUS, and future direct Remote Desktop Commander access to DIONYSUS can be restored without changing the repository location.

This is operationally convenient but should remain an ADR, not an architectural invariant. The software should run on either host.

## 8. Design requirements derived from current failures

See `docs/DESIGN_GAPS.md` for the evidence register. The most important requirements are:

1. **Layered health, not one boolean "online".**  
   Distinguish agent process alive, transport connected, authenticated, executor responsive, and tool-specific capability readiness.

2. **Transport-independent machine identity.**  
   A device should remain `apollo` even if its path changes from Tailscale to tunnel to direct HTTP.

3. **Durable request identity and explicit delivery semantics.**  
   Retries must not accidentally duplicate mutating tool calls. Every request needs an ID and a documented at-most-once / at-least-once / resumable policy.

4. **Explicit long-running operation model.**  
   Process launch and process polling should survive client turn limits and transport reconnects.

5. **Auth rotation must not masquerade as machine failure.**  
   Authentication, transport, and executor failures need different states and recovery paths.

6. **Backpressure and bounded queues.**  
   Do not infer readiness from a healthy polling loop if the local executor is saturated.

7. **Least privilege by construction.**  
   Path scopes, command policy, host scopes, and optional read-only modes should be first-class rather than only a global blocklist.

8. **Local auditability.**  
   The owner should be able to answer: who invoked what, on which machine, under which policy, what changed, and whether the operation completed.

9. **No central SaaS requirement.**  
   A single-user deployment should work with an outbound tunnel or private network and no multi-tenant relay.

10. **Graceful degradation.**  
    Losing Apollo should not make DIONYSUS unusable; losing a tunnel should not kill local MCP service.

## 9. Transport options to evaluate

### OpenAI Secure MCP Tunnel

Good for private ChatGPT/Codex access without an inbound port. It is outbound-only and has an open client/protocol. It is OpenAI-specific at the control-plane layer.

### Direct public Streamable HTTP

Most interoperable MCP shape, but requires us to operate a public HTTPS/auth boundary safely.

Relevant MCP specification:
- https://modelcontextprotocol.io/
- https://github.com/modelcontextprotocol/modelcontextprotocol

### Tailscale Serve

Useful inside the tailnet for machine-to-machine communication, but does not itself make a service reachable by ChatGPT on the public internet.

- https://tailscale.com/docs/features/tailscale-serve

### Tailscale Funnel

Can expose a local service publicly through Tailscale relay infrastructure.

- https://tailscale.com/docs/features/tailscale-funnel

This is an alternative public ingress mechanism, but exposing a machine-control MCP endpoint publicly still requires strong application-layer authorization and careful threat modeling.

### Self-hosted relay

A future option if we need stable multi-client/multi-host rendezvous independent of any provider. It should be considered only after the private single-user architecture is working.

## 10. Proposed repository boundaries

A future implementation could evolve toward:

```text
packages/
  core/               request IDs, capabilities, host model, policy interfaces
  gateway/            MCP-facing router
  executor-dc/        adapter to DesktopCommanderMCP
  executor-native/    optional minimal native executor
  transport-openai/   Secure MCP Tunnel integration/config
  transport-http/     direct Streamable HTTP
  transport-tailscale/
  agent/              optional remote host agent

docs/
  adr/
  threat-model/
  experiments/
  references/
```

This directory layout is intentionally **not created yet**. We should approve the conceptual boundaries before scaffolding implementation packages.

## 11. Open-source strategy

- Initial repository license: MIT.
- Keep original project code independent of proprietary Desktop Commander server code.
- If DesktopCommanderMCP code is copied rather than consumed as a dependency, preserve its MIT copyright/license notices.
- OpenAI `tunnel-client` is Apache-2.0; prefer invoking or integrating with it as a dependency/process rather than copying code unless necessary.
- Document every third-party component and license in a future `THIRD_PARTY_NOTICES.md`.
- Avoid reverse-engineering undocumented proprietary server internals when an open protocol or independently designed abstraction suffices.

## 12. Proposed phases and gates

### Phase 0 — evidence and interface design

Current phase.

Deliverables:
- proposal;
- reference map;
- design-gap register;
- threat-model questions;
- small ADR set.

**Gate:** approve boundaries before implementation.

### Phase 1 — local two-executor spike

Prove that one gateway process can address:
- DIONYSUS locally;
- Apollo over the private network;
- without public exposure.

No permanent daemon and no write operations beyond a controlled test fixture.

**Gate:** verify machine identity, failure isolation, cancellation, and audit semantics.

### Phase 2 — private ChatGPT/Codex transport

Attach the gateway through OpenAI Secure MCP Tunnel.

**Gate:** establish actual ChatGPT product permissions, session behavior, and long-running-call limits rather than assuming parity with Remote Desktop Commander.

### Phase 3 — durable service

Add:
- systemd unit on DIONYSUS;
- explicit secrets handling;
- structured audit log;
- health/readiness endpoints;
- bounded queues and process recovery.

### Phase 4 — portability

Test another client-facing path:
- direct Streamable HTTP,
- another MCP client,
- or an alternate tunnel/relay.

This phase tests whether the core really is transport-independent.

### Phase 5 — optional public/open relay

Only if there is a demonstrated need for arbitrary off-network clients or broader distribution.

## 13. Questions for review before implementation

1. Is DIONYSUS the canonical gateway host, or merely the first deployment target?
2. Should machine selection be one gateway with a `machine` parameter, per-machine tool namespaces, or separate MCP servers?
3. Should DesktopCommanderMCP be a subprocess dependency, library dependency, or reference implementation only?
4. Do we need shell execution at all in v0, or can the first spike use read-only filesystem/process metadata?
5. What is the desired authorization model: user-level, client-level, machine-level, path-level, command-level?
6. Which operations require explicit human confirmation?
7. Should audit logs contain arguments/results, hashes, metadata only, or configurable redaction?
8. Do we want MIT long term, or Apache-2.0 before implementation/contributors?
9. Is supporting non-OpenAI MCP clients a day-one constraint or simply an architectural non-regression requirement?
10. What constitutes success relative to Remote Desktop Commander: feature parity, greater reliability, self-hostability, stronger policy, or all four?

## 14. Current recommendation in one sentence

Build an open, transport-independent **machine-control MCP gateway** on DIONYSUS that initially reuses DesktopCommanderMCP as a replaceable executor and uses existing private networking for Apollo; treat OpenAI Secure MCP Tunnel as one optional ingress path, and postpone any public multi-tenant relay until a real requirement justifies it.
