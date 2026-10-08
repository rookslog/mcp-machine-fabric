/**
 * Hub <-> agent wire protocol (JSON text frames over one WebSocket).
 *
 * The agent always dials out to the hub, so machines behind NAT, laptops that
 * sleep, and hosts without inbound ports all work the same way. Identity comes
 * from the device token the hub issued, never from anything the agent claims.
 *
 * Delivery model for a tool call:
 *   hub  -> agent  call    {request_id, tool, args, deadline_ms}
 *   agent -> hub   accepted {request_id}             (agent durably recorded it)
 *   agent -> hub   result  {request_id, outcome}     (agent also keeps it in its result cache)
 * If the socket drops between `call` and `result`, the hub marks the request
 * `dispatched_unknown`; on reconnect it sends `recover` with those ids and the
 * agent answers from its result cache (`completed`/`failed`), or reports
 * `running` (still executing) or `unknown` (never saw it). Mutating calls are
 * never re-sent automatically.
 */

export const PROTOCOL_VERSION = 1;

export type ToolErrorCode =
  | "invalid_arguments"
  | "not_found"
  | "permission_denied"
  | "policy_denied"
  | "conflict"
  | "timeout"
  | "too_large"
  | "internal";

export interface ToolSuccess {
  ok: true;
  /** Human/LLM-readable text. */
  text: string;
  /** Machine-readable payload; mirrored into MCP structuredContent. */
  data?: Record<string, unknown>;
}

export interface ToolFailure {
  ok: false;
  code: ToolErrorCode;
  message: string;
  data?: Record<string, unknown>;
}

export type ToolOutcome = ToolSuccess | ToolFailure;

export interface AgentInfo {
  agent_version: string;
  protocol_version: number;
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Tool names this agent can execute. */
  tools: string[];
  /** Summary of local policy so clients can see scope without probing. */
  policy: { read_only: boolean; roots: string[]; allow_exec: boolean };
  /** Agent wall-clock start (ISO), used to detect agent restarts. */
  started_at: string;
}

export type AgentToHub =
  | { type: "hello"; info: AgentInfo }
  | { type: "accepted"; request_id: string }
  | { type: "result"; request_id: string; outcome: ToolOutcome; duration_ms: number }
  | { type: "recovered"; request_id: string; state: "completed" | "failed" | "running" | "unknown"; outcome?: ToolOutcome }
  | { type: "health"; executor: ExecutorHealth }
  | { type: "pong"; nonce: string };

export type HubToAgent =
  | { type: "welcome"; machine: string; hub_version: string; protocol_version: number }
  | { type: "call"; request_id: string; tool: string; args: Record<string, unknown>; deadline_ms: number }
  | { type: "recover"; request_ids: string[] }
  | { type: "ping"; nonce: string }
  | { type: "error"; code: string; message: string };

export interface ExecutorHealth {
  /** Calls currently executing on the agent. */
  active_calls: number;
  /** Max concurrent calls the agent will accept before rejecting. */
  capacity: number;
  /** Durable jobs currently running. */
  running_jobs: number;
  /** ms the event loop took to answer the last self-check. */
  loop_lag_ms: number;
}

export function parseFrame<T>(raw: unknown): T | null {
  try {
    const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    const v = JSON.parse(text);
    if (v && typeof v === "object" && typeof v.type === "string") return v as T;
    return null;
  } catch {
    return null;
  }
}
