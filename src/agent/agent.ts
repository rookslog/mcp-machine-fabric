import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import nodePath from "node:path";
import { z } from "zod";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  parseFrame,
  type AgentInfo,
  type AgentToHub,
  type HubToAgent,
  type ToolOutcome,
} from "../shared/protocol.js";
import { AGENT_TOOLS, findAgentTool } from "../shared/tools.js";
import { VERSION } from "../version.js";
import { runFsTool, type FsToolName } from "./fs-tools.js";
import { JobManager, type JobReadResult, type JobRecord } from "./jobs.js";
import { checkExec, checkPath, PolicyError, type Policy } from "./policy.js";
import { ResultCache } from "./result-cache.js";

const FS_TOOLS = new Set<string>([
  "read_file",
  "list_directory",
  "get_file_info",
  "search_files",
  "write_file",
  "edit_file",
  "create_directory",
  "move_path",
]);

export interface AgentOptions {
  /** ws(s)://host[:port]/agent */
  hubUrl: string;
  token: string;
  policy: Policy;
  stateDir: string;
  capacity?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Finished jobs older than this are deleted from disk (default 7 days). */
  jobRetentionMs?: number;
  /** Reconnect backoff bounds (ms). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

const validators = new Map(AGENT_TOOLS.map((t) => [t.name, z.object(t.shape)]));

function fail(code: Extract<ToolOutcome, { ok: false }>["code"], message: string, data?: Record<string, unknown>): ToolOutcome {
  return { ok: false, code, message, ...(data ? { data } : {}) };
}

function jobLine(j: JobRecord): string {
  const age = Math.round((Date.now() - Date.parse(j.created_at)) / 1000);
  return `${j.job_id} ${j.status}${j.exit_code !== null ? ` exit=${j.exit_code}` : ""} age=${age}s ${j.label ? `[${j.label}] ` : ""}${j.command.slice(0, 120)}`;
}

function jobData(j: JobRecord): Record<string, unknown> {
  return { job: j as unknown as Record<string, unknown> };
}

/**
 * Executes tools locally. Separated from the connection so it can be tested
 * and reused (e.g. by a future stdio MCP front end) without a hub.
 */
export class Executor {
  readonly jobs: JobManager;
  active = 0;

  constructor(
    readonly policy: Policy,
    stateDir: string,
    readonly capacity = 16,
  ) {
    this.jobs = new JobManager({ stateDir: nodePath.join(stateDir, "jobs") });
  }

  async init(): Promise<void> {
    await this.jobs.init();
  }

  async execute(tool: string, rawArgs: Record<string, unknown>, onJob?: (jobId: string) => void): Promise<ToolOutcome> {
    const spec = findAgentTool(tool);
    const schema = validators.get(tool);
    if (!spec || !schema) return fail("invalid_arguments", `unknown tool ${tool}`);
    const parsed = schema.safeParse(rawArgs);
    if (!parsed.success) return fail("invalid_arguments", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const args = parsed.data as Record<string, any>;
    if (this.active >= this.capacity) return fail("internal", `agent at capacity (${this.capacity} concurrent calls); retry shortly`);
    this.active++;
    try {
      if (FS_TOOLS.has(tool)) return await runFsTool(this.policy, tool as FsToolName, args);
      return await this.jobTool(tool, args, onJob);
    } catch (err) {
      if (err instanceof PolicyError) return fail("policy_denied", err.message);
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(msg)) return fail("not_found", msg);
      return fail("internal", msg);
    } finally {
      this.active--;
    }
  }

  /** Explicit cwd must be inside the roots; the default is $HOME, or the first root when $HOME is outside them. */
  private async resolveCwd(cwd: unknown): Promise<string> {
    if (typeof cwd === "string" && cwd) return checkPath(this.policy, cwd, "read");
    try {
      return await checkPath(this.policy, homedir(), "read");
    } catch {
      return this.policy.roots[0];
    }
  }

  private async jobTool(tool: string, a: Record<string, any>, onJob?: (jobId: string) => void): Promise<ToolOutcome> {
    switch (tool) {
      case "run_command": {
        checkExec(this.policy);
        const cwd = await this.resolveCwd(a.cwd);
        const job = await this.jobs.start({ command: a.command, cwd, env: a.env, label: "run_command" });
        onJob?.(job.job_id);
        const waitMs = Math.round((a.wait_seconds ?? 30) * 1000);
        const done = await this.jobs.wait(job.job_id, waitMs);
        const limit = 100_000;
        const start = Math.max(0, done.output_bytes - limit);
        const r = await this.jobs.read(job.job_id, start, limit);
        const clipped = start > 0 ? `[… first ${start} bytes omitted; read_job_output with cursor 0 for all]\n` : "";
        if (r.job.status === "running") {
          return {
            ok: true,
            text: `Still running after ${waitMs / 1000}s as job ${job.job_id} (not killed). Continue with read_job_output(job_id="${job.job_id}", cursor=${r.next_cursor}).\n${clipped}${r.output}`,
            data: { job_id: job.job_id, status: "running", exit_code: null, next_cursor: r.next_cursor, output_bytes: r.job.output_bytes },
          };
        }
        return {
          ok: true,
          text: `[${r.job.status}${r.job.exit_code !== null ? `, exit code ${r.job.exit_code}` : ""}; job ${job.job_id}]\n${clipped}${r.output}`,
          data: { job_id: job.job_id, status: r.job.status, exit_code: r.job.exit_code, next_cursor: r.next_cursor, output_bytes: r.job.output_bytes },
        };
      }
      case "start_job": {
        checkExec(this.policy);
        const cwd = await this.resolveCwd(a.cwd);
        const job = await this.jobs.start({ command: a.command, cwd, env: a.env, label: a.label, stdin: "pipe" });
        onJob?.(job.job_id);
        return { ok: true, text: `Started job ${job.job_id} (pid ${job.pid}). Read output with read_job_output.`, data: jobData(job) };
      }
      case "read_job_output": {
        const r: JobReadResult = await this.jobs.read(a.job_id, a.cursor ?? 0, a.max_bytes ?? 64_000, Math.round((a.wait_seconds ?? 0) * 1000));
        const status = `[${r.job.status}${r.job.exit_code !== null ? `, exit code ${r.job.exit_code}` : ""}; next cursor ${r.next_cursor}${r.more_available ? "; more output available" : ""}]`;
        return { ok: true, text: `${status}\n${r.output}`, data: { ...jobData(r.job), next_cursor: r.next_cursor, more_available: r.more_available } };
      }
      case "list_jobs": {
        const jobs = await this.jobs.list({ status: a.status ?? "all", limit: a.limit ?? 50 });
        return { ok: true, text: jobs.length ? jobs.map(jobLine).join("\n") : "No jobs.", data: { jobs: jobs as unknown as Record<string, unknown>[] } };
      }
      case "send_job_input": {
        checkExec(this.policy);
        await this.jobs.sendInput(a.job_id, a.input);
        return { ok: true, text: `Sent ${Buffer.byteLength(a.input)} bytes to job ${a.job_id}.` };
      }
      case "cancel_job": {
        checkExec(this.policy);
        const j = await this.jobs.cancel(a.job_id, Math.round((a.grace_seconds ?? 5) * 1000));
        return { ok: true, text: `Job ${a.job_id}: ${j.status}`, data: jobData(j) };
      }
      default:
        return fail("invalid_arguments", `unknown tool ${tool}`);
    }
  }
}

/** Outbound connection to the hub with reconnect, heartbeat replies, and recovery. */
export class Agent {
  readonly executor: Executor;
  private cache: ResultCache;
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private loopLag = 0;
  readonly startedAt = new Date().toISOString();
  private stateId: string | undefined;
  machine: string | null = null;
  /** Request ids received by this process and not yet finished (set synchronously on receipt). */
  private received = new Set<string>();
  private connectedResolvers: Array<() => void> = [];

  constructor(private opts: AgentOptions) {
    this.executor = new Executor(opts.policy, opts.stateDir, opts.capacity);
    this.cache = new ResultCache(nodePath.join(opts.stateDir, "results"), this.startedAt);
    this.backoff = opts.minBackoffMs ?? 1000;
  }

  private log(msg: string, extra?: Record<string, unknown>) {
    this.opts.log?.(msg, extra);
  }

  info(): AgentInfo {
    return {
      agent_version: VERSION,
      protocol_version: PROTOCOL_VERSION,
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
      tools: AGENT_TOOLS.map((t) => t.name),
      policy: { read_only: this.opts.policy.read_only, roots: this.opts.policy.roots, allow_exec: this.opts.policy.allow_exec },
      started_at: this.startedAt,
      state_id: this.stateId,
    };
  }

  async start(): Promise<void> {
    await mkdir(this.opts.stateDir, { recursive: true, mode: 0o700 });
    const idFile = nodePath.join(this.opts.stateDir, "state_id");
    this.stateId = (await readFile(idFile, "utf8").catch(() => "")).trim() || undefined;
    if (!this.stateId) {
      this.stateId = `s_${randomBytes(8).toString("hex")}`;
      await writeFile(idFile, this.stateId + "\n", { mode: 0o600, flag: "wx" }).catch(async () => {
        this.stateId = (await readFile(idFile, "utf8")).trim();
      });
    }
    await this.executor.init();
    await this.cache.init();
    const retention = this.opts.jobRetentionMs ?? 7 * 24 * 3600 * 1000;
    const prune = async () => {
      try {
        const n = await this.executor.jobs.prune(retention);
        if (n > 0) this.log("pruned finished jobs", { count: n });
        await this.cache.prune();
      } catch (err) {
        this.log("prune failed", { error: String(err) });
      }
    };
    await prune();
    this.pruneTimer = setInterval(() => void prune(), 6 * 3600 * 1000);
    this.pruneTimer.unref();
    this.connect();
    this.healthTimer = setInterval(() => {
      const t0 = Date.now();
      setImmediate(() => {
        this.loopLag = Date.now() - t0;
      });
      this.sendHealth();
    }, 10_000);
    this.healthTimer.unref();
  }

  /** Resolves once the hub has welcomed this agent. */
  waitConnected(): Promise<void> {
    if (this.machine && this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((r) => this.connectedResolvers.push(r));
  }

  private send(msg: AgentToHub): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private sendHealth(): void {
    this.send({
      type: "health",
      executor: {
        active_calls: this.executor.active,
        capacity: this.executor.capacity,
        running_jobs: this.executor.jobs.runningCount(),
        loop_lag_ms: this.loopLag,
      },
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.hubUrl, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
      handshakeTimeout: 15_000,
      maxPayload: 64 * 1024 * 1024,
    });
    this.ws = ws;
    let authFailed = false;

    ws.on("unexpected-response", (_req, res) => {
      authFailed = res.statusCode === 401;
      this.log("hub refused connection", { status: res.statusCode });
      ws.terminate();
    });
    ws.on("open", () => {
      this.backoff = this.opts.minBackoffMs ?? 1000;
      this.send({ type: "hello", info: this.info() });
      this.sendHealth();
    });
    ws.on("message", (raw) => void this.onMessage(raw));
    ws.on("error", (err) => this.log("hub connection error", { error: String(err) }));
    ws.on("close", (code, reason) => {
      if (this.ws === ws) this.ws = null;
      this.machine = null;
      if (this.stopped) return;
      const delay = authFailed || code === 4001 ? Math.max(60_000, this.backoff) : this.backoff;
      this.log("disconnected from hub; will reconnect", { code, reason: reason.toString(), retry_in_ms: delay });
      this.reconnectTimer = setTimeout(() => this.connect(), delay + Math.floor(Math.random() * 250));
      this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 30_000);
    });
  }

  private async onMessage(raw: unknown): Promise<void> {
    const msg = parseFrame<HubToAgent>(raw);
    if (!msg) return;
    switch (msg.type) {
      case "welcome":
        this.machine = msg.machine;
        this.log("connected to hub", { machine: msg.machine, hub_version: msg.hub_version });
        for (const r of this.connectedResolvers.splice(0)) r();
        break;
      case "ping":
        this.send({ type: "pong", nonce: msg.nonce });
        break;
      case "call":
        // Mark receipt before any await so a concurrent `recover` can never
        // report "unknown" for a call this process is about to execute.
        this.received.add(msg.request_id);
        try {
          await this.handleCall(msg.request_id, msg.tool, msg.args);
        } finally {
          this.received.delete(msg.request_id);
        }
        break;
      case "recover":
        for (const id of msg.request_ids) await this.handleRecover(id);
        break;
      case "error":
        this.log("hub error", { code: msg.code, message: msg.message });
        break;
    }
  }

  private async handleCall(requestId: string, tool: string, args: Record<string, unknown>): Promise<void> {
    const existing = await this.cache.get(requestId);
    if (existing) {
      // Duplicate delivery: never execute twice.
      if (existing.state !== "running" && existing.outcome) {
        this.send({ type: "result", request_id: requestId, outcome: existing.outcome, duration_ms: 0 });
      } else {
        this.send({ type: "accepted", request_id: requestId });
      }
      return;
    }
    const t0 = Date.now();
    try {
      await this.cache.begin(requestId, tool);
    } catch (err) {
      this.send({ type: "result", request_id: requestId, outcome: fail("internal", `cannot record request: ${String(err)}`), duration_ms: 0 });
      return;
    }
    this.send({ type: "accepted", request_id: requestId });
    const outcome = await this.executor.execute(tool, args, (jobId) => void this.cache.noteJob(requestId, jobId));
    await this.cache.finish(requestId, tool, outcome).catch((err) => this.log("result cache write failed", { error: String(err) }));
    this.send({ type: "result", request_id: requestId, outcome, duration_ms: Date.now() - t0 });
  }

  private async handleRecover(requestId: string): Promise<void> {
    if (this.received.has(requestId)) {
      this.send({ type: "recovered", request_id: requestId, state: "running" });
      return;
    }
    const rec = await this.cache.get(requestId);
    if (!rec) {
      // Attested: this agent never durably recorded the call, and it records
      // before executing anything, so the call never ran here.
      this.send({ type: "recovered", request_id: requestId, state: "unknown" });
    } else if (rec.state === "running" && !this.cache.isOrphaned(rec)) {
      this.send({ type: "recovered", request_id: requestId, state: "running" });
    } else if (rec.state === "running") {
      // The agent restarted mid-call. Report what we know honestly.
      const outcome: ToolOutcome = fail(
        "internal",
        `agent restarted while this call was executing; outcome unknown${rec.job_id ? `. Its process continues as job ${rec.job_id} — inspect it with read_job_output` : ""}`,
        rec.job_id ? { job_id: rec.job_id } : undefined,
      );
      await this.cache.finish(requestId, rec.tool, outcome);
      this.send({ type: "recovered", request_id: requestId, state: "failed", outcome });
    } else {
      this.send({ type: "recovered", request_id: requestId, state: rec.state, outcome: rec.outcome });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    const ws = this.ws;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((r) => {
        ws.once("close", () => r());
        ws.close(1000, "agent stopping");
        setTimeout(r, 2000).unref();
      });
    }
  }

  /** Test hook: drop the connection abruptly (simulates network loss). */
  dropConnection(): void {
    this.ws?.terminate();
  }
}
