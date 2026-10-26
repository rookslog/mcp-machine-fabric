# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Fixed

- Isolate OpenAI tunnel setup tests from host health port 8082 and the live MCP
  endpoint; an occupied health port must still fail preflight and preserve files.
- Run tunnel setup tests with deterministic doctor stubs by default, with
  `MMF_TUNNEL_CLIENT_REAL=1` adding an installed-client pass and
  `TUNNEL_CLIENT_BIN` selecting a separate executable. Retain both 0.0.9's narrow
  OAuth-404 exception and 0.0.16's native acceptance of absent OAuth metadata.
- Exercise production EnvironmentFile parsing as data and record every rollback
  restoration attempt, including those after an injected restoration failure.

### Documentation

- State the minimum tunnel-client version (0.0.9), locally qualified versions
  (0.0.9 and 0.0.16), and owner steps for a conflicting health port.

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

### Documentation

- Exercised the source and Docker self-hosting paths in an isolated environment
  and added the missing PAT-storage, status, and official-SDK live-check steps.
- Clarified the OpenAI tunnel runtime-key file and removed host-specific checkout
  assumptions while keeping external tunnel and ChatGPT actions explicitly
  unexercised.
