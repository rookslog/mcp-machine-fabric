/**
 * Durable jobs: every shell command the agent runs is a job whose lifetime is
 * independent of the agent process, the hub connection, and the MCP call.
 *
 * CONTRACT (implemented by the jobs slice; see test/jobs.test.ts):
 *
 * Layout: <stateDir>/<job_id>/
 *   meta.json     JobMeta written at start (command, cwd, label, created_at, stdin mode)
 *   pid           wrapper pid (process-group leader), written by the wrapper itself
 *   output.log    combined stdout+stderr, append-only
 *   exit_code     written atomically (tmp+rename) by the wrapper when the command exits
 *   cancelled     marker written by cancel() before signalling
 *   stdin.fifo    only when stdin === "pipe"
 *
 * The command runs under a small /bin/sh wrapper spawned with detached:true and
 * stdio ignored/unref'd, so killing or restarting the agent never kills the job.
 * The wrapper runs `<shell> -lc <command>` in <cwd>, redirects output to
 * output.log, stdin from /dev/null (default) or the fifo (held open read-write
 * so the job does not see EOF between writes), and records the exit code.
 *
 * Status derivation (also used on init() after an agent restart):
 *   exit_code present            -> "exited" (exit_code parsed; 128+N => signal N noted)
 *   cancelled marker, no exit    -> "killed" once the process group is gone
 *   pid alive and is our wrapper -> "running"
 *   otherwise                    -> "lost" (wrapper vanished without recording an exit)
 */

export type JobStatus = "running" | "exited" | "killed" | "lost";

export interface StartJobOptions {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  label?: string;
  stdin?: "null" | "pipe";
}

export interface JobRecord {
  job_id: string;
  command: string;
  cwd: string;
  label?: string;
  pid: number | null;
  status: JobStatus;
  exit_code: number | null;
  created_at: string;
  ended_at: string | null;
  output_bytes: number;
  stdin: "null" | "pipe";
}

export interface JobReadResult {
  job: JobRecord;
  output: string;
  /** Byte offset to pass as `cursor` next time. */
  next_cursor: number;
  /** True when output was cut at max_bytes and more is already available. */
  more_available: boolean;
}

export interface JobManagerOptions {
  stateDir: string;
  /** Shell used for commands; default $SHELL or /bin/bash (/bin/zsh on darwin). */
  shell?: string;
  /** Use a login shell (-lc) so PATH matches an interactive session. Default true. */
  loginShell?: boolean;
}

export declare class JobManager {
  constructor(opts: JobManagerOptions);
  /** Create stateDir (0700) and reconcile any jobs from a previous agent run. */
  init(): Promise<void>;
  start(opts: StartJobOptions): Promise<JobRecord>;
  get(jobId: string): Promise<JobRecord | null>;
  list(filter?: { status?: "running" | "finished" | "all"; limit?: number }): Promise<JobRecord[]>;
  /** Read output from byte cursor; if waitMs>0, wait until new output or exit (or timeout). */
  read(jobId: string, cursor?: number, maxBytes?: number, waitMs?: number): Promise<JobReadResult>;
  /** Wait until the job is no longer running or waitMs elapses; returns the current record. */
  wait(jobId: string, waitMs: number): Promise<JobRecord>;
  sendInput(jobId: string, input: string): Promise<void>;
  cancel(jobId: string, graceMs?: number): Promise<JobRecord>;
  runningCount(): number;
}
