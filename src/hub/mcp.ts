import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolOutcome } from "../shared/protocol.js";
import { AGENT_TOOLS, type AgentToolSpec, type Effect } from "../shared/tools.js";
import type { Registry } from "./registry.js";
import { newRequestId, summarizeArgs, type HubStore, type RequestRow } from "./store.js";

export const SCOPE_FOR_EFFECT: Record<Effect, string> = {
  read: "fabric:read",
  write: "fabric:write",
  exec: "fabric:exec",
};

export interface CallerInfo {
  principal: string;
  scopes: string[];
}

export interface McpContext {
  store: HubStore;
  registry: Registry;
  hubVersion: string;
}

function deadlineFor(tool: string, args: Record<string, unknown>): number {
  const wait = typeof args.wait_seconds === "number" ? args.wait_seconds : tool === "run_command" ? 30 : 0;
  if (tool === "run_command" || tool === "read_job_output") return wait * 1000 + 15_000;
  if (tool === "search_files") return 45_000;
  if (tool === "cancel_job") return 75_000;
  return 30_000;
}

function rowView(r: RequestRow) {
  return {
    request_id: r.request_id,
    machine: r.machine,
    tool: r.tool,
    principal: r.principal,
    state: r.state,
    created_at: new Date(r.created_at).toISOString(),
    finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    duration_ms: r.duration_ms,
    error_code: r.error_code,
    idempotency_key: r.idempotency_key,
    args: JSON.parse(r.args_summary),
  };
}

/**
 * Results carry the human-readable text in BOTH the text content block and
 * `structuredContent.text`: some clients (observed: Claude Code 2026-10) show
 * only structuredContent when it is present, which would hide file contents
 * and command output.
 */
function outcomeResult(outcome: ToolOutcome, meta: Record<string, unknown>, note?: string): CallToolResult {
  if (outcome.ok) {
    const text = note ? `${note}\n${outcome.text}` : outcome.text;
    return {
      content: [{ type: "text", text }],
      structuredContent: { ...meta, ...(outcome.data ?? {}), text },
    };
  }
  const text = `${note ? note + "\n" : ""}Error (${outcome.code}): ${outcome.message}`;
  return {
    isError: true,
    content: [{ type: "text", text }],
    structuredContent: { ...meta, error_code: outcome.code, ...(outcome.data ?? {}), text },
  };
}

function hubError(text: string, meta: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [{ type: "text", text }], structuredContent: { ...meta, text } };
}

const MACHINE_HELP =
  "Target machine name (see list_machines). Each machine runs its own agent; the same tool works on any of them.";

/** Build an MCP server bound to one authenticated caller. Cheap; created per HTTP request. */
export function createMcpServer(ctx: McpContext, caller: CallerInfo): McpServer {
  const server = new McpServer(
    { name: "mcp-machine-fabric", version: ctx.hubVersion },
    {
      instructions:
        "Controls the owner's own computers. Call list_machines first to see which machines are online and ready. " +
        "Every tool takes a `machine` argument. Commands run as durable jobs: if run_command returns a job_id the process is still running — " +
        "poll it with read_job_output instead of re-running it. If a call reports state dispatched_unknown, do NOT blindly retry a mutating call: " +
        "check get_request_status with the request_id first. Pass an idempotency_key on writes/commands you might retry.",
    },
  );

  const machines = ctx.store
    .listDevices()
    .filter((d) => !d.revoked_at)
    .map((d) => d.name);
  const machineSchema =
    machines.length > 0 ? z.enum(machines as [string, ...string[]]).describe(MACHINE_HELP) : z.string().describe(MACHINE_HELP);

  server.registerTool(
    "list_machines",
    {
      title: "List machines",
      description:
        "List enrolled machines with layered health: connected, heartbeat age/RTT, agent version, executor load, local policy (roots, read-only, exec allowed), and a `ready` verdict with the reason when not ready.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const health = ctx.registry.allHealth();
      const lines = health.map((h) => {
        const pol = h.agent ? ` roots=${h.agent.policy.roots.join(",")}${h.agent.policy.read_only ? " READ-ONLY" : ""}${h.agent.policy.allow_exec ? "" : " no-exec"}` : "";
        const where = h.agent ? ` ${h.agent.platform}/${h.agent.arch} host=${h.agent.hostname}` : "";
        return `${h.machine}: ${h.ready ? "READY" : `NOT READY (${h.reason})`}${where}${h.heartbeat_rtt_ms !== null ? ` rtt=${h.heartbeat_rtt_ms}ms` : ""}${pol}`;
      });
      const text = lines.length ? lines.join("\n") : "No machines enrolled. Enroll one with `mmf device add <name>` on the hub.";
      return { content: [{ type: "text", text }], structuredContent: { machines: health as unknown as Record<string, unknown>[], text } };
    },
  );

  server.registerTool(
    "get_request_status",
    {
      title: "Get request status",
      description:
        "Look up any earlier call by request_id: state (completed, failed, dispatched_unknown, …), timing, and the recorded outcome. Use this after a timeout or dropped connection instead of retrying.",
      inputSchema: { request_id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ request_id }) => {
      const row = ctx.store.getRequest(request_id);
      if (!row) return hubError(`No request with id ${request_id}.`, { request_id });
      const view = rowView(row);
      const outcome = row.outcome_json ? (JSON.parse(row.outcome_json) as ToolOutcome) : null;
      const text =
        `${row.request_id} ${row.tool} on ${row.machine}: ${row.state}` +
        (outcome ? `\n${outcome.ok ? outcome.text : `Error (${outcome.code}): ${outcome.message}`}` : "");
      return { content: [{ type: "text", text }], structuredContent: { ...view, outcome, text } };
    },
  );

  server.registerTool(
    "list_recent_requests",
    {
      title: "Recent requests (audit)",
      description: "Audit trail of recent calls across machines: who, what tool, which machine, state, and timing. Arguments are summarized (long content is hashed).",
      inputSchema: {
        machine: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ machine, limit }) => {
      const rows = ctx.store.recentRequests(limit ?? 20, machine).map(rowView);
      const text = rows
        .map((r) => `${r.created_at} ${r.request_id} ${r.machine} ${r.tool} ${r.state}${r.error_code ? ` (${r.error_code})` : ""}`)
        .join("\n");
      const body = text || "No requests recorded.";
      return { content: [{ type: "text", text: body }], structuredContent: { requests: rows, text: body } };
    },
  );

  for (const spec of AGENT_TOOLS) registerAgentTool(server, ctx, caller, spec, machineSchema);
  return server;
}

function registerAgentTool(server: McpServer, ctx: McpContext, caller: CallerInfo, spec: AgentToolSpec, machineSchema: z.ZodTypeAny) {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: { machine: machineSchema, ...spec.shape },
      annotations: {
        readOnlyHint: spec.effect === "read",
        destructiveHint: spec.destructive,
        idempotentHint: spec.idempotent,
        openWorldHint: false,
      },
    },
    async (rawArgs: Record<string, unknown>) => {
      const { machine, idempotency_key, ...args } = rawArgs as { machine: string; idempotency_key?: string } & Record<string, unknown>;
      const requestId = newRequestId();
      const base = { request_id: requestId, machine, tool: spec.name };
      const needed = SCOPE_FOR_EFFECT[spec.effect];

      const record = (state: "not_dispatched" | "dispatched", key: string | null) =>
        ctx.store.createRequest({
          request_id: requestId,
          machine,
          tool: spec.name,
          effect: spec.effect,
          principal: caller.principal,
          idempotency_key: key,
          args_summary: summarizeArgs(args),
          state,
        });

      if (!caller.scopes.includes(needed)) {
        record("not_dispatched", null);
        ctx.store.finish(requestId, { ok: false, code: "policy_denied", message: `missing scope ${needed}` }, false);
        return hubError(
          `This connection was not granted ${needed}; ${spec.name} is not allowed. Re-authorize the connector with that scope if you need it.`,
          { ...base, state: "not_dispatched", error_code: "policy_denied" },
        );
      }

      const key = typeof idempotency_key === "string" ? idempotency_key : null;
      if (key) {
        const prev = ctx.store.findIdempotent(caller.principal, machine, spec.name, key);
        if (prev) return replay(prev);
      }

      try {
        record("dispatched", key);
      } catch (err) {
        // Unique-index race: a concurrent call with the same key won.
        if (key) {
          const prev = ctx.store.findIdempotent(caller.principal, machine, spec.name, key);
          if (prev) return replay(prev);
        }
        throw err;
      }

      const result = await ctx.registry.call(machine, requestId, spec.name, args, deadlineFor(spec.name, args));
      switch (result.state) {
        case "completed":
        case "failed":
          ctx.store.finish(requestId, result.outcome, key !== null);
          return outcomeResult(result.outcome, { ...base, state: result.state, duration_ms: result.duration_ms });
        case "not_dispatched": {
          ctx.store.finish(requestId, { ok: false, code: "internal", message: result.reason }, false);
          ctx.store.setState(requestId, "not_dispatched", "unavailable");
          const h = ctx.registry.health(machine);
          return hubError(
            `Not executed: ${machine} is unavailable (${result.reason}; health: ${h.reason ?? "ok"}${h.last_seen ? `, last seen ${h.last_seen}` : ""}). Nothing ran, so it is safe to retry once the machine is ready.`,
            { ...base, state: "not_dispatched", health: h as unknown as Record<string, unknown> },
          );
        }
        case "dispatched_unknown":
          return hubError(
            `Outcome unknown (request ${requestId}): ${result.reason}. The ${spec.effect === "read" ? "read" : "operation"} may have run. ` +
              `Call get_request_status with this request_id before retrying${spec.effect === "read" ? "" : " — do not repeat a mutating call blindly"}.`,
            { ...base, state: "dispatched_unknown" },
          );
      }
    },
  );

  function replay(prev: RequestRow): CallToolResult {
    const meta = { request_id: prev.request_id, machine: prev.machine, tool: prev.tool, state: prev.state, replayed: true };
    if ((prev.state === "completed" || prev.state === "failed") && prev.outcome_json) {
      return outcomeResult(JSON.parse(prev.outcome_json), meta, `[idempotent replay of ${prev.request_id}; not executed again]`);
    }
    return hubError(
      `A call with this idempotency_key already exists (${prev.request_id}, state ${prev.state}); it was not executed again. Use get_request_status to follow it.`,
      meta,
    );
  }
}
