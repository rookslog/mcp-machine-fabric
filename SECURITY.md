# Security policy

This project lets remote clients read and write files and run commands on your
machines. Treat a hub URL plus a valid token as equivalent to a shell on every
enrolled machine (within each agent's policy).

## Reporting a vulnerability

Please report privately via GitHub Security Advisories
("Report a vulnerability" on the repository's Security tab). Do not open a
public issue for anything exploitable. We aim to acknowledge within 7 days.

## Security model in brief

- **Agents dial out**; no inbound port is opened on controlled machines.
- **Device tokens** (`mmf_dev_…`) authenticate agents. They are stored hashed
  (SHA-256) on the hub and shown once at enrollment. Revoke with
  `mmf device revoke <name>`.
- **Client access** uses OAuth 2.1 (PKCE S256, dynamic client registration,
  owner-passphrase consent, refresh-token rotation with reuse detection) or
  personal access tokens (`mmf_pat_…`, stored hashed). Scopes:
  `fabric:read`, `fabric:write`, `fabric:exec`, enforced by the hub per call.
- **Agent-side policy** (allowed roots after symlink resolution, read-only
  mode, exec on/off) is enforced on the controlled machine itself.
  Exec cannot be confined by roots: a shell can reach anything the agent's OS
  user can. Run the agent as a dedicated user, or with `--no-exec`, if you need
  a harder boundary.
- **Audit**: every call is recorded in the hub's SQLite ledger with principal,
  machine, tool, summarized arguments (long strings hashed, env values
  dropped), state and timing.
- The hub binds to `127.0.0.1` by default. Put TLS in front of it (Tailscale
  Serve/Funnel, Caddy, cloudflared, or OpenAI's tunnel-client). Never expose
  plain HTTP beyond loopback.
