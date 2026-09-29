# Design gaps and reliability requirements

**Status:** evidence register / hypothesis generator, not a bug-fix plan.

The point of this document is to distinguish observed symptoms from architectural lessons. Upstream issue reports are evidence that a boundary deserves attention; they are not proof that our preferred redesign is correct.

## 1. Reachability is not a boolean

### Evidence

DesktopCommanderMCP issue #755 reports a device that can authenticate and register but cannot establish the Supabase Realtime channel. Issue #661 reports a device that appears online and answers meta operations before a real `start_process` fails.

Sources:
- https://github.com/wonderwhy-er/DesktopCommanderMCP/issues/755
- https://github.com/wonderwhy-er/DesktopCommanderMCP/issues/661

### Requirement

Represent health as independent dimensions:

```text
agent_process
transport
authentication
router_registration
executor
capability/tool readiness
queue saturation
```

A machine should be "usable for tool X" only when the relevant dimensions are proven.

## 2. Transport coupling creates avoidable failure domains

### Evidence

Desktop Commander's open remote-device implementation contains explicit Supabase-specific token refresh, presence, heartbeat, reconnect, capability-withdrawal, and recovery behavior.

Reference:
- https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/src/remote-device/remote-channel.ts

### Requirement

Define a narrow transport interface. Machine/executor semantics should not depend on Supabase, OpenAI Tunnel, Tailscale, WebSocket, or HTTP-specific state.

## 3. Authentication recovery must be independent of execution recovery

### Evidence

Issue #661 describes persisted-session reauthorization behavior. The remote-channel implementation also contains substantial logic for token rotation and sign-out recovery.

### Requirement

Track:
- credential validity;
- control-plane session;
- transport connection;
- local executor session;

as distinct state machines. A token refresh should not reset long-running local work unless policy explicitly requires it.

## 4. Long-lived work cannot equal one network request

### Evidence

OpenAI tunnel issue #55 reports workflows where ChatGPT stopped issuing commands while local tunnel health remained green. OpenAI's tunnel docs separately expose queue depth, active-operation age, concurrency, and response-delivery health.

Sources:
- https://github.com/openai/tunnel-client/issues/55
- https://github.com/openai/tunnel-client/blob/master/docs/troubleshooting.md

### Requirement

Long-running work should have stable operation IDs:

```text
start operation -> operation_id
inspect operation -> state/output cursor
cancel operation -> explicit cancellation
recover client -> resume by operation_id
```

The local operation lifetime must not be identical to one ChatGPT turn or one HTTP request.

## 5. Delivery semantics for writes must be explicit

### Problem

If a transport times out after dispatch but before the result is acknowledged, automatic retry can duplicate a mutating operation.

### Requirement

Each invocation needs:
- globally unique request ID;
- operation classification (read-only / idempotent / mutating);
- deduplication window or durable request ledger where appropriate;
- explicit retry policy;
- result state distinguishable as `not_dispatched`, `dispatched_unknown`, `completed`, `failed`, `cancelled`.

Never silently retry an arbitrary shell/file mutation merely because the network path failed.

## 6. Queue health must be visible

### Evidence

OpenAI tunnel-client documents separate maximum active MCP requests, local queued commands, dispatcher-held work, and control-plane prefetch/backpressure.

Sources:
- https://github.com/openai/tunnel-client/blob/master/docs/configuration.md
- https://github.com/openai/tunnel-client/blob/master/docs/troubleshooting.md

### Requirement

Expose at minimum:
- queue depth;
- active operations;
- oldest active age;
- capacity;
- rejected/backpressured count;
- target executor latency;
- response-delivery failures.

## 7. Discovery/version compatibility needs an explicit boundary

### Evidence

OpenAI tunnel issue #41 documents a ChatGPT developer-mode path sending `server/discover` to a target that does not implement it, producing a reconnect loop before tool invocation.

Source:
- https://github.com/openai/tunnel-client/issues/41

### Requirement

The client-facing gateway should own compatibility/adaptation. A transport adapter should not force non-standard discovery assumptions into the executor interface.

## 8. Policy must be stronger than a global command blocklist

### Current observation

Desktop Commander supports allowed-directory configuration and blocked shell commands. That is useful but coarse for a multi-machine autonomous control plane.

### Requirement

Policy should be able to express:

```text
principal/client
machine
tool
path scope
command class
read/write/execute
interactive approval requirement
time/lease
environment/secrets access
```

Default-deny profiles should be possible without disabling the whole server.

## 9. Audit should be local-first and privacy-aware

### Requirement

Every invocation should have structured metadata:
- request/operation ID;
- principal/client;
- machine;
- tool;
- policy decision;
- start/end timestamps;
- outcome;
- mutation indicator;
- optional redacted argument/result hashes.

Content logging must be configurable. Observability should not require sending file contents or command output to a third-party analytics service.

## 10. Machine identity should survive route changes

### Requirement

`apollo` should remain the same logical target whether reached by:
- direct local agent;
- SSH over Tailscale;
- Tailscale service;
- OpenAI tunnel;
- future self-hosted relay.

Identity belongs above transport.

## 11. Failure isolation

A failed Apollo transport must not make DIONYSUS local tools unavailable. A failed OpenAI tunnel must not stop local/private MCP use. A saturated executor must not falsely mark the gateway itself unhealthy.

This argues for separate readiness per component and per route.

## 12. Open questions to test experimentally

- Does DesktopCommanderMCP have a sufficiently stable programmatic boundary to use as an executor without forking?
- Is stdio subprocess supervision adequate, or is a local Streamable HTTP adapter cleaner?
- How should process/session identifiers map across an executor restart?
- Does ChatGPT developer-mode custom MCP currently expose the write/execute surface we need on this account?
- Is SSH an acceptable first Apollo transport, or should the first spike install a tiny host agent?
- What confirmation semantics can the client surface actually enforce?
- Which audit data should be durable versus ephemeral?
