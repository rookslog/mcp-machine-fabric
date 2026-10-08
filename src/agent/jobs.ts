import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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
  /** Signal number inferred from a conventional 128+N shell exit code. */
  signal: number | null;
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
  /** @internal Deterministic seams for status-race regression tests. */
  testHooks?: JobManagerTestHooks;
}

export interface JobManagerTestHooks {
  beforeOwnershipProbe?: (context: { jobId: string; jobDir: string; pid: number | null }) => Promise<void> | void;
  commandLine?: (pid: number, fallback: () => Promise<string | null>) => Promise<string | null>;
}

interface JobMeta {
  command: string;
  cwd: string;
  label?: string;
  created_at: string;
  stdin: "null" | "pipe";
}

const execFileAsync = promisify(execFile);
const JOB_ID_PATTERN = /^j_[0-9a-z]+_[0-9a-f]{8}$/;
const POLL_MS = 50;
const DEFAULT_MAX_BYTES = 64_000;
let lastJobTime = 0;

// The command and cwd are data in the environment, never source in this script.
// The job directory is a separate argv item so process ownership can be checked.
const WRAPPER_SOURCE = String.raw`
umask 077
job_dir=$1
printf '%s\n' "$$" > "$job_dir/pid"
cd "$MMF_CWD"
code=$?
if [ "$code" -ne 0 ]; then
  tmp="$job_dir/exit_code.tmp.$$"
  printf '%s\n' "$code" > "$tmp"
  mv "$tmp" "$job_dir/exit_code"
  exit "$code"
fi

if [ "$MMF_STDIN_MODE" = "pipe" ]; then
  exec 3<>"$job_dir/stdin.fifo"
  "$MMF_SHELL" "$MMF_SHELL_FLAG" "$MMF_COMMAND" <&3 >>"$job_dir/output.log" 2>&1
else
  "$MMF_SHELL" "$MMF_SHELL_FLAG" "$MMF_COMMAND" </dev/null >>"$job_dir/output.log" 2>&1
fi

code=$?
tmp="$job_dir/exit_code.tmp.$$"
printf '%s\n' "$code" > "$tmp"
mv "$tmp" "$job_dir/exit_code"
exit "$code"
`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) throw new Error(`invalid job id: ${JSON.stringify(jobId)}`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function parsePid(text: string | null): number | null {
  if (text === null) return null;
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function commandLine(pid: number): Promise<string | null> {
  if (platform() === "linux") {
    try {
      return (await readFile(`/proc/${pid}/cmdline`)).toString("utf8").replaceAll("\0", " ");
    } catch {
      return null;
    }
  }

  if (platform() === "darwin") {
    try {
      const { stdout } = await execFileAsync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
      });
      return stdout;
    } catch {
      return null;
    }
  }

  return null;
}

type Ownership = "owned" | "not-owned" | "unknown";

async function probeWrapperOwnership(
  pid: number,
  jobDir: string,
  readCommandLine: (pid: number) => Promise<string | null> = commandLine,
): Promise<Ownership> {
  if (!processExists(pid)) return "not-owned";
  const line = await readCommandLine(pid);
  if (line !== null) return line.includes(jobDir) ? "owned" : "not-owned";
  return processExists(pid) ? "unknown" : "not-owned";
}

function nextJobId(): { id: string; createdAt: string } {
  const now = Math.max(Date.now(), lastJobTime + 1);
  lastJobTime = now;
  return {
    id: `j_${now.toString(36)}_${randomBytes(4).toString("hex")}`,
    createdAt: new Date(now).toISOString(),
  };
}

function sendSignal(target: number, signal: NodeJS.Signals): void {
  try {
    process.kill(target, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export class JobManager {
  readonly #stateDir: string;
  readonly #shell: string;
  readonly #loginShell: boolean;
  readonly #testHooks: JobManagerTestHooks | undefined;
  readonly #cache = new Map<string, JobRecord>();

  constructor(opts: JobManagerOptions) {
    this.#stateDir = path.resolve(opts.stateDir);
    this.#shell = opts.shell ?? process.env.SHELL ?? (platform() === "darwin" ? "/bin/zsh" : "/bin/bash");
    this.#loginShell = opts.loginShell ?? true;
    this.#testHooks = opts.testHooks;
  }

  /** Create stateDir (0700) and reconcile any jobs from a previous agent run. */
  async init(): Promise<void> {
    await mkdir(this.#stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.#stateDir, 0o700);
    this.#cache.clear();
    for (const entry of await readdir(this.#stateDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
      const record = await this.get(entry.name);
      if (record) this.#cache.set(entry.name, record);
    }
  }

  async start(opts: StartJobOptions): Promise<JobRecord> {
    let cwdInfo;
    try {
      cwdInfo = await stat(opts.cwd);
    } catch (error) {
      if (isMissing(error)) throw new Error(`working directory (cwd) does not exist: ${opts.cwd}`);
      throw error;
    }
    if (!cwdInfo.isDirectory()) throw new Error(`working directory (cwd) is not a directory: ${opts.cwd}`);

    const { id, createdAt } = nextJobId();
    const jobDir = this.#jobDir(id);
    const stdin = opts.stdin ?? "null";
    const meta: JobMeta = {
      command: opts.command,
      cwd: opts.cwd,
      ...(opts.label === undefined ? {} : { label: opts.label }),
      created_at: createdAt,
      stdin,
    };

    await mkdir(jobDir, { mode: 0o700 });
    await writeFile(path.join(jobDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    await writeFile(path.join(jobDir, "output.log"), "", { mode: 0o600 });
    if (stdin === "pipe") {
      const fifo = path.join(jobDir, "stdin.fifo");
      await execFileAsync("mkfifo", [fifo]);
      await chmod(fifo, 0o600);
    }

    const child = spawn("/bin/sh", ["-c", WRAPPER_SOURCE, "mmf-job-wrapper", jobDir], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ...opts.env,
        MMF_COMMAND: opts.command,
        MMF_CWD: opts.cwd,
        MMF_SHELL: this.#shell,
        MMF_SHELL_FLAG: this.#loginShell ? "-lc" : "-c",
        MMF_STDIN_MODE: stdin,
      },
    });
    child.unref();

    const deadline = Date.now() + 2_000;
    let pid: number | null = null;
    do {
      pid = parsePid(await readOptional(path.join(jobDir, "pid")));
      if (pid !== null) break;
      await delay(10);
    } while (Date.now() < deadline);
    if (pid === null) throw new Error(`job wrapper failed to record its pid for ${id}`);

    const record = await this.#record(id, meta);
    this.#cache.set(id, record);
    return record;
  }

  async get(jobId: string): Promise<JobRecord | null> {
    assertJobId(jobId);
    const metaText = await readOptional(path.join(this.#jobDir(jobId), "meta.json"));
    if (metaText === null) {
      this.#cache.delete(jobId);
      return null;
    }
    const meta = JSON.parse(metaText) as JobMeta;
    const record = await this.#record(jobId, meta);
    this.#cache.set(jobId, record);
    return record;
  }

  async list(filter: { status?: "running" | "finished" | "all"; limit?: number } = {}): Promise<JobRecord[]> {
    if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 0)) {
      throw new Error("limit must be a non-negative integer");
    }
    const records: JobRecord[] = [];
    for (const entry of await readdir(this.#stateDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
      const record = await this.get(entry.name);
      if (record) records.push(record);
    }
    records.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.job_id.localeCompare(a.job_id));
    const status = filter.status ?? "all";
    const selected = records.filter((record) => {
      if (status === "running") return record.status === "running";
      if (status === "finished") return record.status !== "running";
      return true;
    });
    return filter.limit === undefined ? selected : selected.slice(0, filter.limit);
  }

  /** Delete exited or killed job directories whose terminal marker is older than the threshold. */
  async prune(olderThanMs: number): Promise<number> {
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) throw new Error("olderThanMs must be non-negative");
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;

    for (const entry of await readdir(this.#stateDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
      const record = await this.get(entry.name);
      if (!record || (record.status !== "exited" && record.status !== "killed") || record.ended_at === null) continue;
      const endedAt = Date.parse(record.ended_at);
      if (!Number.isFinite(endedAt) || endedAt >= cutoff) continue;
      await rm(this.#jobDir(entry.name), { recursive: true, force: true });
      this.#cache.delete(entry.name);
      removed += 1;
    }

    return removed;
  }

  /** Read output from byte cursor; if waitMs>0, wait until new output or exit (or timeout). */
  async read(jobId: string, cursor = 0, maxBytes = DEFAULT_MAX_BYTES, waitMs = 0): Promise<JobReadResult> {
    assertJobId(jobId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("cursor must be a non-negative integer");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer");
    if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error("waitMs must be non-negative");

    let job = await this.#require(jobId);
    let size = await this.#outputSize(jobId);
    if (cursor > size) return { job, output: "", next_cursor: size, more_available: false };

    const deadline = Date.now() + waitMs;
    while (waitMs > 0 && size <= cursor && job.status === "running" && Date.now() < deadline) {
      await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
      job = await this.#require(jobId);
      size = await this.#outputSize(jobId);
    }

    const outputFile = await open(path.join(this.#jobDir(jobId), "output.log"), "r");
    let bytes: Buffer;
    try {
      size = (await outputFile.stat()).size;
      if (cursor > size) return { job, output: "", next_cursor: size, more_available: false };
      const length = Math.min(size - cursor, maxBytes);
      bytes = Buffer.alloc(length);
      const { bytesRead } = await outputFile.read(bytes, 0, length, cursor);
      bytes = bytes.subarray(0, bytesRead);
    } finally {
      await outputFile.close();
    }

    let start = 0;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
    let end = bytes.length;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let output = "";
    while (end >= start) {
      try {
        output = decoder.decode(bytes.subarray(start, end));
        break;
      } catch {
        end -= 1;
      }
    }

    job = await this.#require(jobId);
    const nextCursor = cursor + end;
    return { job, output, next_cursor: nextCursor, more_available: nextCursor < size };
  }

  /** Wait until the job is no longer running or waitMs elapses; returns the current record. */
  async wait(jobId: string, waitMs: number): Promise<JobRecord> {
    assertJobId(jobId);
    if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error("waitMs must be non-negative");
    const deadline = Date.now() + waitMs;
    let record = await this.#require(jobId);
    while (record.status === "running" && Date.now() < deadline) {
      await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
      record = await this.#require(jobId);
    }
    return record;
  }

  async sendInput(jobId: string, input: string): Promise<void> {
    assertJobId(jobId);
    const record = await this.#require(jobId);
    if (record.stdin !== "pipe") throw new Error(`job ${jobId} does not have pipe stdin`);
    if (record.status !== "running") throw new Error(`job ${jobId} is finished (${record.status}); input requires a running job`);

    const fifo = await open(path.join(this.#jobDir(jobId), "stdin.fifo"), constants.O_WRONLY | constants.O_NONBLOCK);
    try {
      await fifo.writeFile(input);
    } finally {
      await fifo.close();
    }
  }

  async cancel(jobId: string, graceMs = 5_000): Promise<JobRecord> {
    assertJobId(jobId);
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error("graceMs must be non-negative");
    let record = await this.#require(jobId);
    if (record.status !== "running") return record;

    const jobDir = this.#jobDir(jobId);
    await writeFile(path.join(jobDir, "cancelled"), `${new Date().toISOString()}\n`, { mode: 0o600 });
    const pid = record.pid;
    if (pid !== null && (await this.#probeOwnership(pid, jobDir)) === "owned") {
      sendSignal(-pid, "SIGTERM");
      const deadline = Date.now() + graceMs;
      while (processGroupExists(pid) && Date.now() < deadline) await delay(POLL_MS);
      if (processGroupExists(pid)) sendSignal(-pid, "SIGKILL");
    }

    const settleDeadline = Date.now() + 2_000;
    do {
      record = await this.#require(jobId);
      if (record.status !== "running") return record;
      await delay(25);
    } while (Date.now() < settleDeadline);
    return this.#require(jobId);
  }

  runningCount(): number {
    let count = 0;
    for (const record of this.#cache.values()) if (record.status === "running") count += 1;
    return count;
  }

  #jobDir(jobId: string): string {
    return path.join(this.#stateDir, jobId);
  }

  #probeOwnership(pid: number, jobDir: string): Promise<Ownership> {
    const hook = this.#testHooks?.commandLine;
    return probeWrapperOwnership(pid, jobDir, hook ? (target) => hook(target, () => commandLine(target)) : commandLine);
  }

  async #require(jobId: string): Promise<JobRecord> {
    const record = await this.get(jobId);
    if (!record) throw new Error(`job ${jobId} not found`);
    return record;
  }

  async #outputSize(jobId: string): Promise<number> {
    try {
      return (await stat(path.join(this.#jobDir(jobId), "output.log"))).size;
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
  }

  async #record(jobId: string, meta: JobMeta): Promise<JobRecord> {
    const jobDir = this.#jobDir(jobId);
    const previous = this.#cache.get(jobId);
    const pid = parsePid(await readOptional(path.join(jobDir, "pid")));
    const exitPath = path.join(jobDir, "exit_code");
    const cancelledPath = path.join(jobDir, "cancelled");
    let exitText = await readOptional(exitPath);
    let cancelled = await readOptional(cancelledPath);
    let status: JobStatus;
    let exitCode: number | null = null;
    let endedAt: string | null = null;

    if (exitText === null) await this.#testHooks?.beforeOwnershipProbe?.({ jobId, jobDir, pid });
    const ownership: Ownership = exitText === null && pid !== null ? await this.#probeOwnership(pid, jobDir) : "not-owned";
    if (exitText === null && ownership !== "owned") {
      // Ownership checks are slower than file reads (and invoke ps on macOS).
      // The wrapper can publish exit_code and disappear between those two
      // observations, so refresh terminal markers before declaring it lost.
      exitText = await readOptional(exitPath);
      cancelled = await readOptional(cancelledPath);
    }

    if (exitText !== null) {
      const parsed = Number.parseInt(exitText.trim(), 10);
      exitCode = Number.isSafeInteger(parsed) ? parsed : null;
      status = "exited";
      endedAt = (await stat(exitPath)).mtime.toISOString();
    } else if (ownership === "owned") {
      status = "running";
    } else if (ownership === "unknown") {
      status = previous?.status === undefined || previous.status === "lost" ? "running" : previous.status;
      exitCode = previous?.exit_code ?? null;
      endedAt = previous?.ended_at ?? null;
    } else if (cancelled !== null) {
      status = "killed";
      endedAt = (await stat(cancelledPath)).mtime.toISOString();
    } else {
      status = "lost";
      const pidStat = await stat(path.join(jobDir, "pid")).catch(() => null);
      endedAt = pidStat?.mtime.toISOString() ?? meta.created_at;
    }

    return {
      job_id: jobId,
      command: meta.command,
      cwd: meta.cwd,
      ...(meta.label === undefined ? {} : { label: meta.label }),
      pid,
      status,
      exit_code: exitCode,
      signal: exitCode !== null && exitCode > 128 ? exitCode - 128 : null,
      created_at: meta.created_at,
      ended_at: endedAt,
      output_bytes: await this.#outputSize(jobId),
      stdin: meta.stdin,
    };
  }
}
