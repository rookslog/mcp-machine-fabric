# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Security

- Deny agent state, device-token/config paths and local hub data through every
  file tool, including symlink aliases; advertise exclusions in machine policy.
- Serialize asynchronous consent passphrase checks with IPv6 /64 and global
  failure budgets, keeping the hub event loop responsive during guessing bursts.
- Evict stale/unused OAuth registrations without dropping active consent or
  grants; reject empty/invalid PAT scopes and unknown machine restrictions.
- Harden search, metadata, listing and directory creation against path swaps;
  reread ripgrep matches through checked descriptors. Non-Linux directory
  creation requires Python 3's standard-library descriptor-relative mkdir.
- Return generic hub errors, validate authorization bodies, and render invalid
  scope approvals on the consent page.
- Read interactive owner passphrases without echo and require confirmation.

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
