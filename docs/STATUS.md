# Status and evidence

Living record of what is verified, how, and what is not. Update it in the same
change as anything it describes.

_Last updated: 2026-10-08 (initial build night)._

## Deployment (owner's machines)

| Component | Where | How it runs | Config |
| --- | --- | --- | --- |
| hub | DIONYSUS | user unit `mmf-hub.service` (linger on) | `~/.config/mmf/hub.env`: `MMF_PUBLIC_URL=http://<node>.<tailnet>.ts.net:8787`, listens on `127.0.0.1` and its tailnet IP, port 8787 |
| agent `dionysus` | DIONYSUS | user unit `mmf-agent.service`, `KillMode=process` | roots `/home/rookslog`, exec on, hub via loopback |
| agent `apollo` | Apollo (macOS) | LaunchAgent `dev.mcp-machine-fabric.agent` | roots `/Users/rookslog`, exec on, hub via tailnet |

Releases are immutable directories under `~/.local/opt/mcp-machine-fabric/`
with a `current` symlink (`scripts/install-release.sh`). Roll back by pointing
`current` at an older release and restarting the services.

Secrets on DIONYSUS, all mode 0600 in `~/.config/mmf/`: owner passphrase,
device tokens, personal access tokens (`pat-*.token`). Apollo holds its device
token and two PATs in `~/.config/mmf/`. Nothing secret is in the repository.

**Not yet public.** Tailscale Serve/Funnel are disabled on the tailnet
(`tailscale serve` answers "Serve is not enabled on your tailnet"), so the hub
is reachable only on the tailnet over plain HTTP (inside WireGuard). Because
OAuth requires an HTTPS issuer, the deployed hub runs **PAT-only** until it
gets an HTTPS public URL. See [CHATGPT.md](CHATGPT.md) for the owner steps.

## Verified behaviour

Automated (`npm test`; macOS arm64 Node 26 locally, Linux x64 Node 22 on
DIONYSUS, GitHub Actions ubuntu/macOS): durable jobs, file tools and policy,
OAuth server, OAuth end-to-end through the real hub with the SDK's OAuth
client, installers (also under stock macOS bash 3.2), OpenAI-tunnel setup
(dry-run), npm tarball smoke, and a hub+agent end-to-end suite (real HTTP, real
WebSockets, real processes, MCP SDK client), a seeded chaos suite for the
delivery guarantees (20 seeds, all invariants held), delivery edge cases, and security regressions. 144 passed / 1 skipped locally at 2acdf53 (CI green, run 37808028366); 140 passed / 1 skipped locally
(macOS) at commit e8d3821; GitHub Actions green on ubuntu + macOS × Node 22 +
24 plus gitleaks for that commit. Deployed release: `0.1.0-e8d3821` on both
machines; live check 20/20 after deploy; `mmf doctor` passes on both hosts
(one expected WARN on Apollo: plain `ws://` over the tailnet).

Live, on the deployed services (2026-10-08, from Apollo unless noted):

| Check | Result | Evidence |
| --- | --- | --- |
| `scripts/live-check.mjs` against both machines | first run 16/20 (2 check-script bugs, 1 real gap: search/list results missing from text — fixed); after redeploy **20/20** | live-check output |
| Jobs survive agent **and** hub restart | a 25 s job on each machine; hub + both agents restarted mid-job (systemd restart; `launchctl kickstart -k`); both reported `exited`, exit 0, full output | `read_job_output` results |
| Real client: Claude Code (headless, PAT header) | list, run, write, read, durable job polling; **found** Claude Code shows only `structuredContent` → fixed by mirroring text; re-test quotes command output, file content and search hits | request ids `r_muzjqa31…`, `r_muzjqf5u…` |
| Real client: Codex CLI on DIONYSUS (`bearer_token_env_var`) | list_machines, `run_command` on apollo (`sw_vers` → 27.2), read_file | request ids `r_muzk0ao5…`, `r_muzk0b3i…` |
| OAuth over the public internet | isolated throwaway hub behind a Cloudflare quick tunnel (scratch root, `--no-exec`, torn down after): 401 discovery → DCR → PKCE → owner consent → tokens → tool calls; refresh rotation; refresh **reuse rejected**; read-only grant blocks write/exec at the hub; wrong passphrase issues no code | `scripts/oauth-live-check.mjs` output |
| macOS installer live | `scripts/install-agent.sh` reinstalled the Apollo agent; **found** a launchd bootout/bootstrap race ("5: Input/output error") → fixed and re-run successfully | launchd log |
| Docker image (hub) | built and smoke-tested on DIONYSUS by a worker: health, enrollment, host agent READY, `run_command` through the container; cleaned up | packaging slice report |
| Warm command latency through the hub | ~0.1 s DIONYSUS, ~0.33 s Apollo; first command after the Apollo agent started took 7.9 s (cold; cause unchecked) | probe timings |

Bugs found by tests/reviews and fixed during the build: a cross-vendor
review (Codex) found that a stale `recovered: running` frame could reopen a
finished request, that any enrolled agent could finalize another machine's
request, that malformed agent frames were dereferenced unchecked, that `/mcp`
parsed bodies before auth, and an uncapped negative `limit` — all fixed with
regression tests (`test/review-findings.test.ts`). On macOS a zombie-only
process group answers `kill(-pgid)` with EPERM, which made `cancel_job` throw —
fixed. OAuth
`verifyAccessToken` reported the hub URL instead of the token's stored
resource (a token minted for another resource was accepted); revoked devices
stayed connected until reconnect; `read_file` had no response-size cap;
installer arrays broke under bash 3.2.

## Not verified / known gaps

- **ChatGPT itself has not connected yet.** Every protocol step it needs is
  verified with the SDK client over public HTTPS, but creating the ChatGPT app
  is an owner UI step and needs either an OpenAI tunnel ID (preferred, see
  [CHATGPT.md](CHATGPT.md)) or Tailscale Funnel enabled for the node.
- Job status flakiness on macOS (`lost` instead of `exited`) had two real
  causes (status-derivation race; `ps` errors treated as "not ours"), both fixed
  with deterministic tests; 8/8 jobs runs passed under concurrent full-suite
  load afterwards.
- An independent Claude security review of the auth surface found two HIGH
  issues (any authenticated token could read other principals' command output
  via the audit tools/API; the consent page could issue a zero-scope token)
  plus a consent-lockout DoS, an `/authorize` open redirect, phishing-friendly
  consent defaults and unbounded OAuth storage. All fixed with regression tests
  (`test/security-regressions.test.ts`), together with machine-scoped grants
  (`machine:<name>` scopes on the consent page and `mmf token create
  --machines`). The fixes were reviewed by the implementing worker's own
  reviewer, not re-reviewed by the original reviewer.
- Hub is a single process with SQLite; no HA. Restart recovery is tested.
- ChatGPT's own tool-call timeout is unknown; `run_command` waits 30 s by
  default and hands back a `job_id` for anything longer.
