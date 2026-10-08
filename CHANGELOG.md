# Changelog

All notable changes to this project are documented in this file.

## 0.1.0 - 2026-10-08

### Added

- A self-hosted MCP hub with OAuth 2.1, personal access tokens, scoped access,
  request auditing, and a status dashboard.
- Outbound Linux and macOS agents with local root, read-only, and command
  execution policies.
- Remote file tools, durable commands and jobs, request-status recovery, and
  idempotent mutation handling.
- Linux systemd and macOS launchd installers, deployment templates, live
  checks, and end-to-end coverage for hub, agent, OAuth, and installer paths.
- npm tarball packaging, a non-root Docker image, and a self-hosting guide.

### Security

- Device tokens and personal access tokens are stored as hashes by the hub.
- OAuth uses PKCE S256, explicit owner consent, refresh-token rotation, and
  refresh-token reuse detection.
- Agent policy is enforced on the controlled machine, including resolved path
  boundaries and optional write or execution denial.
