# Security policy

This project lets remote clients read and write files and run commands on your
machines. Protect the hub URL and tokens according to their granted scopes.
A token with execution scope can run a shell as the agent OS user.

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
  Optional `machine:<name>` scopes restrict access to named machines; no
  machine scope means all machines for backwards compatibility. Non-owner
  callers see only their own audit rows, job output requires `fabric:exec`, and
  only an all-machine caller with `fabric:exec` receives owner-level audit
  visibility.
- **Agent-side policy** (allowed roots after symlink resolution, read-only
  mode, exec on/off) is enforced on the controlled machine itself. File tools
  always deny the agent state directory, its token file and token-file directory,
  `~/.config/mmf`, and the local hub data directory (`MMF_DATA_DIR`, default
  `~/.local/share/mmf-hub`), even under a broader allowed root. Denials apply
  after realpath resolution, including symlink aliases, and are advertised in
  the agent policy. Startup warns when a root contains these exclusions.
  Exec cannot be confined by roots: a shell can reach anything the agent's OS
  user can. Run the agent as a dedicated user, or with `--no-exec`, if you need
  a harder boundary.
- **Audit**: every call is recorded in the hub's SQLite ledger with principal,
  machine, tool, summarized arguments (long strings hashed, env values
  dropped), state and timing.
- The hub binds to `127.0.0.1` by default. Put TLS in front of it (Tailscale
  Serve/Funnel, Caddy, cloudflared, or OpenAI's tunnel-client). Never expose
  plain HTTP beyond loopback.

## Read scope and local filesystem limits

`fabric:read` permits file listing, metadata, search, and text reads within the
agent's roots, except for the private Machine Fabric paths above. It does not
permit job output, other principals' audit outcomes, writes, or execution.
Machine scopes further restrict which enrolled agents can receive those calls.
Other applications' secrets inside an allowed root are still readable: choose
narrow roots when granting read access. Local hub data paths are excluded even
when this agent connects to a remote hub, so a later co-located hub stays private.

File reads reopen with `O_NOFOLLOW` and compare device/inode identity before
returning descriptor-read content. JS search uses the same checks. Ripgrep's
reported content is discarded; matches are reopened, checked and reread, and
stale/symlink/denied matches are dropped. Ripgrep itself may transiently open a
file during a local race; this is an output boundary, not a sandbox around rg.
Directory enumeration opens and rechecks its directory; Linux also uses its
`/proc/self/fd` anchor. Directory creation walks components under verified
parent descriptors. On non-Linux POSIX hosts this requires `python3` with the
standard-library `os.mkdir(..., dir_fd=...)` operation; missing support fails
closed. No Python package is required. File tools that create missing parent
directories also use this fallback.

These checks reduce replacement races; they are not an OS filesystem sandbox.
They cannot prevent hard links already placed by local users, or make ancestor
renames and policy checks atomic. A local writer can move an already-open
parent after a check; identity rechecks detect stable replacement but cannot
undo a completed side effect. Non-Linux directory enumeration uses path-based
reads bracketed by checks, so transient swap-and-restore races remain a limit.
Do not share writable roots with untrusted local writers; use OS isolation for
that threat model. Executable commands remain unrestricted by file roots.

Consent verification uses asynchronous scrypt in one bounded queue. Failure
budgets are 5 per pending request, 20 per client (IPv6 /64), and 40 globally per
15-minute window; failure delay is charged inside the queue after recording it.
Global exhaustion also limits the owner until that window expires. Reverse
proxies must preserve trusted client addressing; missing forwarded addresses
can still combine clients into one bucket. Registration evicts the oldest
unused clients at capacity and expires unused clients after one hour; pending
requests, codes, and token-bearing clients are protected from eviction.
