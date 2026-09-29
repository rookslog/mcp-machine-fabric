# ADR 0001: Repository scope and initial host

**Status:** Proposed  
**Date:** 2026-09-29

## Context

We want to evaluate an open-source replacement/extension path for remote machine control through MCP without prematurely committing to a fork of DesktopCommanderMCP or to a clone of Remote Desktop Commander's proprietary hosted service.

DIONYSUS is normally always on, runs Linux, has an established projects workspace at `/home/rookslog/workspace/projects`, and is privately reachable from Apollo.

## Decision

1. Initialize the proposal repository on DIONYSUS at:
   `/home/rookslog/workspace/projects/mcp-machine-fabric`.
2. Use Apollo/Remote Desktop Commander as the current control path while DIONYSUS's direct Remote Desktop Commander device is offline.
3. Keep the repository proposal-only until the architecture review is accepted.
4. Treat DesktopCommanderMCP as a candidate replaceable executor dependency, not as the automatic codebase to fork.
5. Treat OpenAI Secure MCP Tunnel as a candidate ingress transport, not as a mandatory core dependency.
6. Require the eventual core abstractions to support more than one transport.

## Consequences

- Repository placement favors the likely runtime host but does not require DIONYSUS forever.
- No production service, public endpoint, daemon, secret, or device agent is created by this ADR.
- The next implementation step, if approved, should be a bounded experiment rather than a feature-complete remote service.
