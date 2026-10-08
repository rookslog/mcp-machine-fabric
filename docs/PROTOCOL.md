# Hub ↔ agent protocol and delivery semantics

Source of truth: [`src/shared/protocol.ts`](../src/shared/protocol.ts). This
document explains the *why*.

## Transport

One WebSocket per agent, dialed by the agent to `wss://<hub>/agent` with
`Authorization: Bearer mmf_dev_…`. The hub maps the token (stored as SHA-256)
to an enrolled device name; that name is the machine's identity. A second
connection with the same token replaces the first.

Frames are JSON text messages with a `type` field.

| Direction | Frame | Purpose |
| --- | --- | --- |
| hub → agent | `welcome {machine, hub_version, protocol_version}` | handshake reply |
| agent → hub | `hello {info}` | version, platform, tool list, local policy summary |
| hub → agent | `ping {nonce}` / agent → hub `pong {nonce}` | heartbeat every 10 s; RTT and age feed health |
| agent → hub | `health {executor}` | active calls, capacity, running jobs, event-loop lag |
| hub → agent | `call {request_id, tool, args, deadline_ms}` | execute a tool |
| agent → hub | `accepted {request_id}` | the agent durably recorded the call (before executing) |
| agent → hub | `result {request_id, outcome, duration_ms}` | final outcome |
| hub → agent | `recover {request_ids}` | after (re)connect: what happened to these? |
| agent → hub | `recovered {request_id, state, outcome?}` | `completed`/`failed` with outcome, `running`, or `unknown` |

## Request lifecycle

```text
          scope/offline                 send ok            agent ack
 (new) ───────────────► not_dispatched   (new) ─────► dispatched ─────► accepted
                                                        │                 │
                              socket lost / deadline    │                 │ result
                                                        ▼                 ▼
                                               dispatched_unknown ─► completed | failed
                                                     (recover / late result)
```

Rules:

1. **At-most-once dispatch.** The hub sends a `call` once. It never re-sends a
   call on reconnect; it only *asks* (`recover`).
2. **Agent-side dedupe.** The agent writes `results/<request_id>.json` before
   acking and refuses to execute an id it has already seen (it replays the
   stored outcome or re-acks).
3. **Truthful unknowns.** If the socket drops or the hub's deadline passes, the
   client is told `dispatched_unknown` with the request id. Nothing is
   guessed. When the agent reconnects the hub asks for those ids and records
   the true outcome; a result that arrives late on a live socket is also
   recorded. If the agent itself restarted mid-call, it reports `failed` with
   an explanation and, for commands, the `job_id` that is still running.
4. **Hub restart.** On start the hub marks every `dispatched`/`accepted`
   request as `dispatched_unknown`, then recovers them as agents reconnect.
5. **Attested non-receipt.** The agent records a call durably before acking or
   executing it, and marks receipt in memory before its first `await`. So when
   the owning agent answers `recover` with `unknown` for a call it never
   acknowledged, the call provably never ran: the hub marks it
   `not_dispatched` (`error_code: never_received`). An acknowledged call whose
   record has since vanished (pruned after 24 h, state dir wiped) stays
   `dispatched_unknown`.
6. **Idempotency keys** are scoped to (principal, machine, tool, key). A repeat
   returns the recorded outcome (`replayed: true`) or, if the first call is
   still unresolved, its state — never a second execution. A request that ended
   `not_dispatched` releases its key, so retrying with the same key dispatches
   a fresh request (the earlier row stays in the audit trail).

These rules are exercised by `test/chaos.test.ts`: a seeded workload of 60
keyed mutations across two agents with hub restarts, agent restarts, dropped
connections and a full outage, asserting no duplicate side effects, outcomes
that match side effects, nothing reported `not_dispatched` having run, and every
request terminal after recovery (`CHAOS_SEED=<n>` reproduces a schedule).

## Durable jobs

Commands run under a `/bin/sh` wrapper spawned detached in its own process
group; command and cwd are passed as environment data, never interpolated
into shell source. Per job, `<state>/jobs/<job_id>/` holds `meta.json`, `pid`,
`output.log` (append-only, read by byte cursor), `exit_code` (written
atomically), a `cancelled` marker, and an optional `stdin.fifo`.

Status after any restart is derived from disk: `exit_code` → `exited`;
`cancelled` and process gone → `killed`; pid alive *and* its command line
references this job directory (pid-reuse guard) → `running`; otherwise `lost`.

Service managers must not reap jobs when the agent restarts: the systemd unit
uses `KillMode=process`, the launchd plist `AbandonProcessGroup`.
