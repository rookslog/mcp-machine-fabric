# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Fixed

- Release installs preserve existing directories, verify complete candidate
  contents before reuse, identify dirty source contents in release names, and
  print the previous `current` target. Unique staging and an installer lock
  protect failed and concurrent installs; symlink changes support Linux and
  stock macOS bash 3.2 without GNU `mv` flags.

### Documentation

- Exercised source SQLite backup/restore after graceful and crash stops, and
  source release upgrade/rollback, with a real isolated hub and agent on Linux.
  Added executable restore/rollback commands, WAL sidecar handling, private
  backup permissions, and automated procedure tests with explicit missing-CLI
  skips. Service-manager, Docker restore, macOS runtime and schema-change
  rollback remain outside this exercise.

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
