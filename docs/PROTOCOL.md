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
| agent → hub | `recovered {request_id, state, outcome?, retained_since?}` | `completed`/`failed` with outcome, `running`, or `unknown` with a retained-history horizon |

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
   recorded. Every result and recovery state is bound to the recorded machine
   and state directory; mismatched or absent routes are rejected and logged.
   Terminal ledger rows (`completed`, `failed`, `not_dispatched`) cannot reopen.
   A recovered terminal outcome also settles any pending caller and clears its
   timer. If the agent itself restarted mid-call, it reports `failed` with
   an explanation and, for commands, the `job_id` that is still running.
4. **Hub restart.** On start the hub marks every `dispatched`/`accepted`
   request as `dispatched_unknown`, then recovers them as agents reconnect.
5. **Attested non-receipt.** The agent records a call before acking or
   executing it, and synchronously claims the request id before its first
   `await`. Duplicate frames wait for that claim and re-ack/replay; they never
   execute a second handler. Every `recovered/unknown` includes
   `retained_since`, an ISO UTC timestamp from the persistent result-cache
   horizon. The hub accepts `never_received` only for a `dispatched` or
   `dispatched_unknown` row whose durable `acked_at` is null, whose dispatch
   time is at or after that horizon, and whose machine and recorded `state_id`
   match the connection. Older agents with no horizon cannot attest non-receipt.
   Otherwise uncertainty and the idempotency key remain. Acknowledgement
   history survives disconnects and hub restarts; cache expiry cannot erase it.

   An agent exclusively owns its state directory using atomic creation of
   `agent.lock` (PID plus an open descriptor). Startup refuses another owner,
   including another instance in the same process or a directory alias. Stop
   closes the socket and drains outstanding handlers before releasing the lock.
   This exclusion is enforced by the agent, not by the hub's token-replacement
   behavior. To avoid a check/unlink race on Linux and macOS without native
   modules, stale locks are **not automatically removed**. After a crash, an
   operator must stop all agents using that directory, confirm its recorded PID
   is gone, and remove only that directory's `agent.lock` before restarting.

   The horizon is persisted before expired completed/failed receipts are
   removed; running receipts are retained. It starts at state-directory creation
   for a fresh cache, or conservatively at initialization for an older cache
   with no horizon. Normally pruning advances it to the cutoff; backdated file
   mtimes can advance it further, beyond the discarded receipt's start time.
   Unreadable/corrupt history is an error, never evidence of non-receipt.
   Hub and agent timestamps assume comparable wall clocks; clock skew and
   filesystem rollback are not covered by this protocol's local tests.

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
A separate expired-cache schedule drops both ack and result and checks that the
original key remains reserved after cache expiry and hub/agent restart. The
`test/lane-delivery-*.test.ts` and `test/delivery-contract.test.ts` regressions
cover retention, exclusive ownership, state binding, duplicates and terminal
monotonicity. These checks exercise API/filesystem ordering, not fsync or
power-loss durability.

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
