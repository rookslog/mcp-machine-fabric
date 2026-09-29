# MCP Machine Fabric

**Status:** proposal/scaffold only — no production implementation yet.

MCP Machine Fabric is a working repository for evaluating an entirely open-source control plane that lets MCP-capable AI clients reach user-owned computers without coupling machine-control tools to one proprietary hosted relay.

The initial deployment target under evaluation is **DIONYSUS** (always-on Linux) as a private MCP gateway/control host, with **Apollo** reachable over the existing private network. This is a hypothesis, not an adopted architecture.

## What this repository is for

- Separate the open local execution engine from remote transport, identity, routing, and policy.
- Decide whether to reuse, adapt, fork, or replace pieces of DesktopCommanderMCP.
- Compare OpenAI Secure MCP Tunnel, public Streamable HTTP, Tailscale-based paths, and a future self-hosted relay.
- Turn current upstream failure modes into explicit reliability and security requirements.
- Keep any code we develop here open source.

## What this repository is not

- A fork of DesktopCommanderMCP.
- A clone of Desktop Commander's proprietary SaaS.
- A production remote shell.
- Authorization to expose DIONYSUS or Apollo publicly.
- A commitment to OpenAI-specific transport.

## Start here

1. [PROPOSAL.md](PROPOSAL.md) — architecture options, recommendation, phases, and decision gates.
2. [docs/REFERENCE_MAP.md](docs/REFERENCE_MAP.md) — primary repos, specifications, and reference designs.
3. [docs/DESIGN_GAPS.md](docs/DESIGN_GAPS.md) — observed upstream bugs and broader design requirements.
4. [docs/adr/0001-repository-scope.md](docs/adr/0001-repository-scope.md) — first provisional architecture decision.

## Current location

The repository is intentionally initialized on:

```
/home/rookslog/workspace/projects/mcp-machine-fabric
```

Development can be driven from Apollo through the existing private SSH/Tailscale path while DIONYSUS remains the candidate runtime host.

## Licensing

The repository is MIT licensed for now to keep the initial work maximally reusable and compatible with the MIT-licensed DesktopCommanderMCP. If implementation begins, we should re-evaluate MIT versus Apache-2.0 before accepting external contributions, especially if patent terms or copied upstream components become material.

See [LICENSE](LICENSE).
