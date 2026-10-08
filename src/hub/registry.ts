import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  parseFrame,
  type AgentInfo,
  type AgentToHub,
  type ExecutorHealth,
  type HubToAgent,
  type ToolOutcome,
} from "../shared/protocol.js";
import type { HubStore } from "./store.js";

export interface MachineHealth {
  machine: string;
  /** Overall: usable for tool calls right now. */
  ready: boolean;
  /** Short reason when not ready. */
  reason: string | null;
  enrolled: boolean;
  connected: boolean;
  /** Last heartbeat round-trip in ms, or null. */
  heartbeat_rtt_ms: number | null;
  heartbeat_age_ms: number | null;
  connected_since: string | null;
  last_seen: string | null;
  agent: AgentInfo | null;
  executor: ExecutorHealth | null;
  in_flight: number;
}

export type CallResult =
  | { state: "completed" | "failed"; outcome: ToolOutcome; duration_ms: number }
  | { state: "not_dispatched"; reason: string }
  | { state: "dispatched_unknown"; reason: string };

interface Pending {
  resolve: (r: CallResult) => void;
  timer: NodeJS.Timeout;
  accepted: boolean;
}

class AgentConnection {
  info: AgentInfo | null = null;
  executor: ExecutorHealth | null = null;
  connectedAt = Date.now();
  lastPongAt = Date.now();
  rttMs: number | null = null;
  pending = new Map<string, Pending>();
  private pingSentAt = new Map<string, number>();

  constructor(
    readonly machine: string,
    readonly deviceId: string,
    readonly ws: WebSocket,
  ) {}

  send(msg: HubToAgent): boolean {
    if (this.ws.readyState !== this.ws.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  ping(): void {
    const nonce = randomBytes(4).toString("hex");
    this.pingSentAt.set(nonce, Date.now());
    if (this.pingSentAt.size > 10) this.pingSentAt.delete(this.pingSentAt.keys().next().value!);
    this.send({ type: "ping", nonce });
  }

  pong(nonce: string): void {
    const sent = this.pingSentAt.get(nonce);
    this.lastPongAt = Date.now();
    if (sent) {
      this.rttMs = Date.now() - sent;
      this.pingSentAt.delete(nonce);
    }
  }
}

export interface RegistryOptions {
  heartbeatIntervalMs?: number;
  /** A connection with no pong for this long is considered dead and closed. */
  heartbeatTimeoutMs?: number;
  hubVersion: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Tracks live agent connections and routes calls to them. Machine identity is
 * the enrolled device name; a new connection for the same device replaces the
 * old one (the agent reconnected), and in-flight calls on the old socket become
 * `dispatched_unknown` rather than being retried.
 */
export class Registry {
  private conns = new Map<string, AgentConnection>();
  private heartbeat: NodeJS.Timeout;
  private readonly hbTimeout: number;

  constructor(
    private store: HubStore,
    private opts: RegistryOptions,
  ) {
    const interval = opts.heartbeatIntervalMs ?? 10_000;
    this.hbTimeout = opts.heartbeatTimeoutMs ?? 35_000;
    this.heartbeat = setInterval(() => this.tick(), interval);
    this.heartbeat.unref();
  }

  private log(msg: string, extra?: Record<string, unknown>) {
    this.opts.log?.(msg, extra);
  }

  private tick(): void {
    const now = Date.now();
    for (const c of this.conns.values()) {
      // Revocation may happen in another process (the CLI); enforce it here.
      if (!this.store.isDeviceActive(c.deviceId)) {
        this.log("device revoked; disconnecting", { machine: c.machine });
        c.ws.close(4001, "device revoked");
        continue;
      }
      if (now - c.lastPongAt > this.hbTimeout) {
        this.log("agent heartbeat timeout; closing", { machine: c.machine });
        c.ws.terminate();
        continue;
      }
      c.ping();
    }
  }

  /** Attach an authenticated agent socket. */
  attach(machine: string, deviceId: string, ws: WebSocket): void {
    const prev = this.conns.get(machine);
    if (prev) {
      this.log("replacing existing connection", { machine });
      this.detach(prev, "replaced by a newer connection from the same device");
      prev.ws.close(4000, "replaced");
    }
    const conn = new AgentConnection(machine, deviceId, ws);
    this.conns.set(machine, conn);
    this.store.touchDevice(deviceId);

    ws.on("message", (raw) => {
      try {
        this.onMessage(conn, raw);
      } catch (err) {
        // A misbehaving agent must not take the hub down.
        this.log("error handling agent frame", { machine, error: String(err) });
      }
    });
    ws.on("close", () => {
      if (this.conns.get(machine) === conn) this.conns.delete(machine);
      this.detach(conn, "agent connection closed");
      this.log("agent disconnected", { machine });
    });
    ws.on("error", (err) => this.log("agent socket error", { machine, error: String(err) }));
    conn.send({ type: "welcome", machine, hub_version: this.opts.hubVersion, protocol_version: PROTOCOL_VERSION });
    conn.ping();
  }

  private detach(conn: AgentConnection, reason: string): void {
    for (const [id, p] of conn.pending) {
      clearTimeout(p.timer);
      this.store.setState(id, "dispatched_unknown");
      p.resolve({ state: "dispatched_unknown", reason });
    }
    conn.pending.clear();
  }

  private onMessage(conn: AgentConnection, raw: unknown): void {
    const msg = parseFrame<AgentToHub>(raw);
    if (!msg) return;
    switch (msg.type) {
      case "hello": {
        conn.info = msg.info;
        this.log("agent hello", { machine: conn.machine, version: msg.info.agent_version, host: msg.info.hostname });
        this.recover(conn);
        break;
      }
      case "pong":
        conn.pong(msg.nonce);
        this.store.touchDevice(conn.deviceId);
        break;
      case "health":
        conn.executor = msg.executor;
        break;
      case "accepted": {
        const p = conn.pending.get(msg.request_id); // pending is per-connection, so only this machine's calls match
        if (p) {
          p.accepted = true;
          this.store.setState(msg.request_id, "accepted");
        }
        break;
      }
      case "result": {
        const p = conn.pending.get(msg.request_id);
        if (p) {
          clearTimeout(p.timer);
          conn.pending.delete(msg.request_id);
          p.resolve({ state: msg.outcome.ok ? "completed" : "failed", outcome: msg.outcome, duration_ms: msg.duration_ms });
        } else {
          // Late result for a call the hub already gave up on: record it so
          // get_request_status can report the true outcome.
          this.recordLate(conn, msg.request_id, msg.outcome);
        }
        break;
      }
      case "recovered": {
        if ((msg.state === "completed" || msg.state === "failed") && msg.outcome) {
          this.recordLate(conn, msg.request_id, msg.outcome);
        } else if (msg.state === "running") {
          const row = this.store.getRequest(msg.request_id);
          // Only an unresolved request of this machine may move back to accepted.
          if (row && row.machine === conn.machine && (row.state === "dispatched" || row.state === "dispatched_unknown")) {
            this.store.setState(msg.request_id, "accepted");
          }
        }
        else if (msg.state === "unknown") {
          // The agent records every call durably before acknowledging or
          // executing it, and guards in-flight receipt in memory, so "unknown"
          // from the owning machine attests the call never ran. Only requests
          // that were never acknowledged qualify; an acknowledged call whose
          // record is gone (pruned/wiped) stays truthfully unknown, and only the
          // state directory the call was dispatched to can vouch (two agents
          // sharing a token but not a state dir cannot speak for each other).
          const row = this.store.getRequest(msg.request_id);
          const route = this.store.routeOf(msg.request_id);
          const sameState = !!route && route === conn.info?.state_id;
          if (row && row.machine === conn.machine && sameState && (row.state === "dispatched" || row.state === "dispatched_unknown")) {
            this.store.markNeverReceived(msg.request_id);
            this.log("request never reached the agent; marked not_dispatched", { request_id: msg.request_id });
          }
        }
        break;
      }
    }
  }

  private recordLate(conn: AgentConnection, requestId: string, outcome: ToolOutcome): void {
    const row = this.store.getRequest(requestId);
    if (!row || row.state === "completed" || row.state === "failed" || row.state === "not_dispatched") return;
    if (row.machine !== conn.machine) {
      this.log("ignored result for another machine's request", { machine: conn.machine, request_id: requestId });
      return;
    }
    this.store.finish(requestId, outcome, row.idempotency_key !== null);
    this.log("recorded late/recovered result", { request_id: requestId, ok: outcome.ok });
  }

  private recover(conn: AgentConnection): void {
    const rows = this.store.unknownRequestsFor(conn.machine).filter((r) => !conn.pending.has(r.request_id));
    if (rows.length === 0) return;
    conn.send({ type: "recover", request_ids: rows.map((r) => r.request_id) });
  }

  /**
   * Dispatch a call. Never retries: if the outcome cannot be confirmed the
   * caller gets `dispatched_unknown` and the request id to query later.
   */
  call(machine: string, requestId: string, tool: string, args: Record<string, unknown>, deadlineMs: number): Promise<CallResult> {
    const conn = this.conns.get(machine);
    if (!conn || !conn.info) {
      return Promise.resolve({ state: "not_dispatched", reason: conn ? "agent connected but has not completed its handshake" : "machine is not connected" });
    }
    return new Promise<CallResult>((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(requestId);
        this.store.setState(requestId, "dispatched_unknown");
        resolve({
          state: "dispatched_unknown",
          reason: `no result within ${Math.round(deadlineMs / 1000)}s; the call may still complete — query get_request_status`,
        });
      }, deadlineMs);
      conn.pending.set(requestId, { resolve, timer, accepted: false });
      const sent = conn.send({ type: "call", request_id: requestId, tool, args, deadline_ms: deadlineMs });
      if (!sent) {
        clearTimeout(timer);
        conn.pending.delete(requestId);
        resolve({ state: "not_dispatched", reason: "agent socket is not open" });
        return;
      }
      this.store.setState(requestId, "dispatched");
      if (conn.info?.state_id) this.store.recordRoute(requestId, conn.info.state_id);
    });
  }

  isConnected(machine: string): boolean {
    return !!this.conns.get(machine)?.info;
  }

  health(machine: string): MachineHealth {
    const device = this.store.listDevices().find((d) => d.name === machine && !d.revoked_at);
    const c = this.conns.get(machine);
    const now = Date.now();
    const base: MachineHealth = {
      machine,
      ready: false,
      reason: null,
      enrolled: !!device,
      connected: !!c,
      heartbeat_rtt_ms: c?.rttMs ?? null,
      heartbeat_age_ms: c ? now - c.lastPongAt : null,
      connected_since: c ? new Date(c.connectedAt).toISOString() : null,
      last_seen: device?.last_seen_at ? new Date(device.last_seen_at).toISOString() : null,
      agent: c?.info ?? null,
      executor: c?.executor ?? null,
      in_flight: c?.pending.size ?? 0,
    };
    if (!device) base.reason = "not enrolled";
    else if (!c) base.reason = "agent not connected";
    else if (!c.info) base.reason = "handshake incomplete";
    else if (now - c.lastPongAt > 25_000) base.reason = "heartbeat stale";
    else if (c.executor && c.executor.active_calls >= c.executor.capacity) base.reason = "executor at capacity";
    base.ready = base.reason === null;
    return base;
  }

  allHealth(): MachineHealth[] {
    const names = new Set(this.store.listDevices().filter((d) => !d.revoked_at).map((d) => d.name));
    for (const m of this.conns.keys()) names.add(m);
    return [...names].sort().map((m) => this.health(m));
  }

  /** Disconnect a machine (e.g. after its device token was revoked). */
  disconnect(machine: string, reason: string): void {
    const c = this.conns.get(machine);
    if (c) c.ws.close(4001, reason.slice(0, 100));
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const c of this.conns.values()) c.ws.close(1001, "hub shutting down");
  }
}
