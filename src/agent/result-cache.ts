import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import type { ToolOutcome } from "../shared/protocol.js";

export interface CachedResult {
  request_id: string;
  tool: string;
  state: "running" | "completed" | "failed";
  /** Agent run (started_at) that accepted the request; detects restarts. */
  agent_run: string;
  started_at: string;
  finished_at?: string;
  outcome?: ToolOutcome;
  job_id?: string;
}

const ID_RE = /^r_[a-z0-9]+_[a-f0-9]+$/;

/**
 * On-disk record of every call the agent accepted, so the hub can learn the
 * outcome of a call whose result was lost in transit (hub restart, network
 * drop). Written before the agent acknowledges a call, updated on completion.
 */
export class ResultCache {
  private mutations = new Map<string, Promise<void>>();

  constructor(
    private dir: string,
    private agentRun: string,
    private retentionMs = 24 * 3600 * 1000,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.prune();
  }

  private file(id: string): string {
    if (!ID_RE.test(id)) throw new Error("invalid request id");
    return nodePath.join(this.dir, `${id}.json`);
  }

  private async write(rec: CachedResult): Promise<void> {
    const f = this.file(rec.request_id);
    const tmp = `${f}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(rec), { mode: 0o600 });
    await rename(tmp, f);
  }

  private async mutate(requestId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.mutations.get(requestId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.mutations.set(requestId, current);
    try {
      await current;
    } finally {
      if (this.mutations.get(requestId) === current) this.mutations.delete(requestId);
    }
  }

  async begin(requestId: string, tool: string): Promise<void> {
    await this.mutate(requestId, async () => {
      await this.write({ request_id: requestId, tool, state: "running", agent_run: this.agentRun, started_at: new Date().toISOString() });
    });
  }

  async noteJob(requestId: string, jobId: string): Promise<void> {
    await this.mutate(requestId, async () => {
      const rec = await this.get(requestId);
      if (rec && rec.state === "running") await this.write({ ...rec, job_id: jobId });
    });
  }

  async finish(requestId: string, tool: string, outcome: ToolOutcome): Promise<void> {
    await this.mutate(requestId, async () => {
      const prev = await this.get(requestId);
      await this.write({
        request_id: requestId,
        tool,
        state: outcome.ok ? "completed" : "failed",
        agent_run: this.agentRun,
        started_at: prev?.started_at ?? new Date().toISOString(),
        finished_at: new Date().toISOString(),
        outcome,
        job_id: prev?.job_id,
      });
    });
  }

  async get(requestId: string): Promise<CachedResult | null> {
    if (!ID_RE.test(requestId)) return null;
    try {
      return JSON.parse(await readFile(this.file(requestId), "utf8")) as CachedResult;
    } catch {
      return null;
    }
  }

  /** True when this record was started by an earlier agent process that is gone. */
  isOrphaned(rec: CachedResult): boolean {
    return rec.state === "running" && rec.agent_run !== this.agentRun;
  }

  async prune(): Promise<number> {
    let n = 0;
    const cutoff = Date.now() - this.retentionMs;
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const f = nodePath.join(this.dir, name);
      try {
        if ((await stat(f)).mtimeMs < cutoff) {
          await unlink(f);
          n++;
        }
      } catch {
        /* raced with another prune */
      }
    }
    return n;
  }
}
