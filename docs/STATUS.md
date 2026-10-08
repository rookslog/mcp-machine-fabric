# Status and evidence

Living record of what is verified, how, and what is not. Update it in the same
change as anything it describes.

_Last updated: 2026-10-08 (initial build night)._

## Deployment (owner's machines)

| Component | Where | How it runs | Config |
| --- | --- | --- | --- |
| hub | DIONYSUS | user unit `mmf-hub.service` (linger on) | `~/.config/mmf/hub.env`: `MMF_PUBLIC_URL=http://dionysus.tail0528f0.ts.net:8787`, listens on `127.0.0.1` and the tailnet IP `100.93.212.44`, port 8787 |
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

Automated (`npm test`, macOS arm64 Node 26 and Linux x64 Node 22): unit and
integration suites for durable jobs, file tools and policy, OAuth server,
installers, and a hub+agent end-to-end suite (real HTTP, real WebSockets, real
processes, MCP SDK client). Counts are in each commit's CI run.

Live, on the deployed services (2026-10-08, from Apollo unless noted):

| Check | Result | Evidence |
| --- | --- | --- |
| `scripts/live-check.mjs` against both machines | 16/20 on first run; the 4 failures were 2 check-script bugs and 1 real gap (search/list results missing from text), fixed in `c1c3…`/fs text commit | session log |
| Jobs survive agent **and** hub restart | a 25 s job on each machine, hub + both agents restarted mid-job (systemd restart; `launchctl kickstart -k`); both reported `exited`, exit 0, full output | `read_job_output` results |
| Real client: Claude Code (headless, PAT header) | list, run, write, read, durable job polling all work; **found** that Claude Code shows only `structuredContent` → fixed by mirroring text; re-test shows outputs | request ids `r_muzjqa31…`, `r_muzjqf5u…` |
| Real client: Codex CLI on DIONYSUS (PAT via `bearer_token_env_var`) | list_machines, `run_command` on apollo (`sw_vers` → 27.2), read_file | request ids `r_muzk0ao5…`, `r_muzk0b3i…` |
| OAuth over the public internet | isolated test hub behind a Cloudflare quick tunnel (scratch root, `--no-exec`, torn down after): 401 discovery → DCR → PKCE → owner consent → tokens → tool calls; refresh rotation; refresh **reuse rejected**; read-only grant blocks write/exec at the hub; wrong passphrase issues no code | `scripts/oauth-live-check.mjs` output |
| Warm command latency through the hub | ~0.1 s DIONYSUS, ~0.33 s Apollo; first command after Apollo agent start took 7.9 s (cold; cause unchecked) | probe timings |

## Not verified / known gaps

- **ChatGPT itself has not connected yet.** Every protocol step it needs is
  verified with the SDK client over public HTTPS, but creating the ChatGPT app
  is an owner UI step and needs a durable public URL or an OpenAI tunnel ID.
- Two `test/jobs.test.ts` cases are intermittently flaky on macOS under full
  parallel load (under investigation).
- Hub is a single process with SQLite; no HA. Tested restart recovery only.
- `run_command` deadlines: ChatGPT's own tool-call timeout is unknown; the
  default wait is 30 s so long commands hand back a `job_id` early.
