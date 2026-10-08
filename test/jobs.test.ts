import { constants } from "node:fs";
import { access, mkdtemp, mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { JobManager, type JobManagerTestHooks, type JobRecord } from "../src/agent/jobs.js";

const roots = new Set<string>();
const groups = new Set<number>();

async function tempRoot(prefix = "mmf-jobs-"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.add(root);
  return root;
}

async function manager(root: string, options: { loginShell?: boolean; testHooks?: JobManagerTestHooks } = {}): Promise<JobManager> {
  const jobs = new JobManager({ stateDir: path.join(root, "state"), ...options });
  await jobs.init();
  return jobs;
}

async function eventually<T>(fn: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`condition not met within ${timeoutMs}ms; last value: ${JSON.stringify(last!)}`);
}

async function finished(jobs: JobManager, jobId: string, timeoutMs = 5_000): Promise<JobRecord> {
  return eventually(
    () => jobs.get(jobId).then((job) => {
      if (!job) throw new Error(`job ${jobId} disappeared`);
      return job;
    }),
    (job) => job.status !== "running",
    timeoutMs,
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

afterEach(async () => {
  for (const pid of groups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  groups.clear();

  for (const root of roots) {
    const jobs = await manager(root).catch(() => null);
    if (jobs) {
      for (const job of await jobs.list({ status: "running" })) {
        await jobs.cancel(job.job_id, 50).catch(() => undefined);
      }
    }
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("JobManager", () => {
  test("records successful and failing commands with combined stdout and stderr", async () => {
    const root = await tempRoot();
    const jobs = await manager(root);

    const success = await jobs.start({ command: "printf 'out\\n'; printf 'err\\n' >&2", cwd: root });
    expect(success.job_id).toMatch(/^j_[0-9a-z]+_[0-9a-f]{8}$/);
    expect((await jobs.wait(success.job_id, 5_000)).status).toBe("exited");
    const successRead = await jobs.read(success.job_id);
    expect(successRead.output).toContain("out\n");
    expect(successRead.output).toContain("err\n");
    expect(successRead.job.exit_code).toBe(0);

    const failure = await jobs.start({ command: "printf 'bad\\n'; exit 3", cwd: root });
    const failureRecord = await jobs.wait(failure.job_id, 5_000);
    expect(failureRecord.status).toBe("exited");
    expect(failureRecord.exit_code).toBe(3);
    expect((await jobs.read(failure.job_id)).output).toBe("bad\n");
  });

  test("honours cwd, merged env, null stdin, labels, permissions, and newest-first listing", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "work");
    await mkdir(cwd);
    const jobs = await manager(root, { loginShell: false });

    const first = await jobs.start({
      command: "printf '%s\\n%s\\n' \"$PWD\" \"$MMF_TEST_VALUE\"; if read line; then echo unexpected; else echo eof; fi",
      cwd,
      env: { MMF_TEST_VALUE: "from-env" },
      label: "first job",
    });
    const firstDone = await jobs.wait(first.job_id, 5_000);
    expect(firstDone.label).toBe("first job");
    expect((await jobs.read(first.job_id)).output).toBe(`${cwd}\nfrom-env\neof\n`);

    const second = await jobs.start({ command: "exit 0", cwd });
    await jobs.wait(second.job_id, 5_000);
    expect((await jobs.list({ status: "finished", limit: 1 }))[0]?.job_id).toBe(second.job_id);
    expect(await jobs.list({ status: "running" })).toEqual([]);

    const stateDir = path.join(root, "state");
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    for (const file of ["meta.json", "pid", "output.log", "exit_code"]) {
      expect((await stat(path.join(stateDir, first.job_id, file))).mode & 0o777).toBe(0o600);
    }
  });

  test("supports byte-cursor reads, long polling, and timeout waits", async () => {
    const root = await tempRoot();
    const jobs = await manager(root);
    const started = await jobs.start({ command: "printf first; sleep 0.2; printf second; sleep 5", cwd: root });

    const first = await jobs.read(started.job_id, 0, 5, 2_000);
    expect(first.output).toBe("first");
    expect(first.next_cursor).toBe(5);

    const began = Date.now();
    const second = await jobs.read(started.job_id, first.next_cursor, 64, 2_000);
    expect(second.output).toBe("second");
    expect(Date.now() - began).toBeLessThan(1_500);

    const stillRunning = await jobs.wait(started.job_id, 25);
    expect(stillRunning.status).toBe("running");
    expect(jobs.runningCount()).toBe(1);
    await jobs.cancel(started.job_id, 50);
  });

  test("restores a running job after restart and later reads its exit code", async () => {
    const root = await tempRoot();
    const firstManager = await manager(root);
    const started = await firstManager.start({ command: "printf started; sleep 0.4; printf done; exit 3", cwd: root });

    const restarted = await manager(root);
    expect((await restarted.get(started.job_id))?.status).toBe("running");
    expect(restarted.runningCount()).toBe(1);
    const record = await restarted.wait(started.job_id, 5_000);
    expect(record.status).toBe("exited");
    expect(record.exit_code).toBe(3);
    expect((await restarted.read(started.job_id)).output).toBe("starteddone");
  });

  test("marks a job lost when its wrapper vanishes without an exit record", async () => {
    const root = await tempRoot();
    const jobs = await manager(root);
    const started = await jobs.start({ command: "sleep 300", cwd: root });
    expect(started.pid).not.toBeNull();
    groups.add(started.pid!);

    process.kill(started.pid!, "SIGKILL");
    const lost = await eventually(
      () => jobs.get(started.job_id).then((job) => job!),
      (job) => job.status === "lost",
    );
    expect(lost.exit_code).toBeNull();
    await expect(access(path.join(root, "state", started.job_id, "exit_code"), constants.F_OK)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("re-reads an exit marker published after the initial status read before declaring lost", async () => {
    const root = await tempRoot();
    let publishExit = false;
    const jobs = await manager(root, {
      testHooks: {
        beforeOwnershipProbe: async ({ jobDir, pid }) => {
          if (!publishExit) return;
          expect(pid).not.toBeNull();
          const temporary = path.join(jobDir, `exit_code.tmp.${process.pid}`);
          await writeFile(temporary, "23\n", { mode: 0o600 });
          await rename(temporary, path.join(jobDir, "exit_code"));
        },
      },
    });
    const started = await jobs.start({ command: "sleep 300", cwd: root });
    expect(started.pid).not.toBeNull();
    groups.add(started.pid!);

    process.kill(started.pid!, "SIGKILL");
    await eventually(async () => processExists(started.pid!), (alive) => !alive);
    publishExit = true;

    expect(await jobs.get(started.job_id)).toMatchObject({ status: "exited", exit_code: 23 });
  });

  test("keeps the previous running status when ownership probing is inconclusive", async () => {
    const root = await tempRoot();
    let commandLineUnavailable = false;
    const jobs = await manager(root, {
      testHooks: {
        commandLine: (pid, fallback) => (commandLineUnavailable ? Promise.resolve(null) : fallback()),
      },
    });
    const started = await jobs.start({ command: "sleep 300", cwd: root });
    expect(started).toMatchObject({ status: "running", pid: expect.any(Number) });
    groups.add(started.pid!);

    await writeFile(path.join(root, "state", started.job_id, "pid"), `${process.pid}\n`, { mode: 0o600 });
    commandLineUnavailable = true;

    expect((await jobs.get(started.job_id))?.status).toBe("running");
  });

  test("does not preserve a cached lost status when the next ownership probe is inconclusive", async () => {
    const root = await tempRoot();
    let commandLineUnavailable = false;
    const jobs = await manager(root, {
      testHooks: {
        commandLine: (pid, fallback) => (commandLineUnavailable ? Promise.resolve(null) : fallback()),
      },
    });
    const started = await jobs.start({ command: "sleep 300", cwd: root });
    groups.add(started.pid!);

    await writeFile(path.join(root, "state", started.job_id, "pid"), `${process.pid}\n`, { mode: 0o600 });
    expect((await jobs.get(started.job_id))?.status).toBe("lost");

    commandLineUnavailable = true;
    expect((await jobs.get(started.job_id))?.status).toBe("running");
  });

  test("reconciles a cached lost job when an exit marker later appears", async () => {
    const root = await tempRoot();
    const jobs = await manager(root);
    const started = await jobs.start({ command: "sleep 300", cwd: root });
    groups.add(started.pid!);

    process.kill(started.pid!, "SIGKILL");
    await eventually(async () => processExists(started.pid!), (alive) => !alive);
    expect((await jobs.get(started.job_id))?.status).toBe("lost");

    await writeFile(path.join(root, "state", started.job_id, "exit_code"), "31\n", { mode: 0o600 });
    expect(await jobs.get(started.job_id)).toMatchObject({ status: "exited", exit_code: 31 });
  });

  test("cancel terminates the process group including grandchildren", async () => {
    const root = await tempRoot();
    const jobs = await manager(root);
    const started = await jobs.start({
      command: "sleep 300 & a=$!; sleep 301 & b=$!; printf '%s %s\\n' \"$a\" \"$b\"; wait",
      cwd: root,
    });
    const output = await jobs.read(started.job_id, 0, 128, 2_000);
    const childPids = output.output.trim().split(/\s+/).map(Number);
    expect(childPids).toHaveLength(2);
    expect(childPids.every(processExists)).toBe(true);

    const cancelled = await jobs.cancel(started.job_id, 100);
    expect(cancelled.status).toBe("killed");
    for (const pid of childPids) {
      await eventually(async () => processExists(pid), (alive) => !alive);
    }
  });

  test("keeps pipe stdin open across writes and rejects input after completion", async () => {
    const root = await tempRoot();
    const jobs = await manager(root);
    const started = await jobs.start({
      command: "while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; done",
      cwd: root,
      stdin: "pipe",
    });

    await jobs.sendInput(started.job_id, "one\n");
    const first = await jobs.read(started.job_id, 0, 128, 2_000);
    expect(first.output).toBe("got:one\n");
    await jobs.sendInput(started.job_id, "two\n");
    const second = await jobs.read(started.job_id, first.next_cursor, 128, 2_000);
    expect(second.output).toBe("got:two\n");
    expect(second.job.status).toBe("running");
    await jobs.cancel(started.job_id, 50);
    await expect(jobs.sendInput(started.job_id, "late\n")).rejects.toThrow(/finished|running/i);

    const noPipe = await jobs.start({ command: "sleep 5", cwd: root });
    await expect(jobs.sendInput(noPipe.job_id, "nope\n")).rejects.toThrow(/pipe/i);
    await jobs.cancel(noPipe.job_id, 50);
  });

  test("never splits multi-byte UTF-8 output and clamps cursors beyond EOF", async () => {
    const root = await tempRoot();
    const jobs = await manager(root);
    const started = await jobs.start({ command: "printf 'A€B'", cwd: root });
    await jobs.wait(started.job_id, 5_000);

    const first = await jobs.read(started.job_id, 0, 3);
    expect(first).toMatchObject({ output: "A", next_cursor: 1, more_available: true });
    const second = await jobs.read(started.job_id, first.next_cursor, 3);
    expect(second).toMatchObject({ output: "€", next_cursor: 4, more_available: true });
    const beyond = await jobs.read(started.job_id, 999, 10);
    expect(beyond).toMatchObject({ output: "", next_cursor: 5, more_available: false });
  });

  test("passes metacharacter-heavy commands and quote-containing cwd without interpolating either", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "quote's directory");
    await mkdir(cwd);
    const jobs = await manager(root, { loginShell: false });
    const command = [
      "printf '%s\\n' \"literal ' quote\"",
      "printf '%s\\n' \"$(printf substitution)\"",
      "printf '%s\\n' \"`printf backtick`\"",
      "printf '%s\\n' \"$PWD\"",
    ].join("\n");

    const started = await jobs.start({ command, cwd });
    await jobs.wait(started.job_id, 5_000);
    expect((await jobs.read(started.job_id)).output).toBe(`literal ' quote\nsubstitution\nbacktick\n${cwd}\n`);
  });

  test("rejects invalid ids, unknown jobs, and nonexistent working directories", async () => {
    const root = await tempRoot();
    const jobs = await manager(root);
    const missing = "j_abc_01234567";

    await expect(jobs.get("../escape")).rejects.toThrow(/invalid job id/i);
    await expect(jobs.read("../escape")).rejects.toThrow(/invalid job id/i);
    await expect(jobs.wait("../escape", 1)).rejects.toThrow(/invalid job id/i);
    await expect(jobs.sendInput("../escape", "x")).rejects.toThrow(/invalid job id/i);
    await expect(jobs.cancel("../escape")).rejects.toThrow(/invalid job id/i);
    await expect(jobs.get(missing)).resolves.toBeNull();
    await expect(jobs.read(missing)).rejects.toThrow(/not found/i);
    await expect(jobs.wait(missing, 1)).rejects.toThrow(/not found/i);
    await expect(jobs.sendInput(missing, "x")).rejects.toThrow(/not found/i);
    await expect(jobs.cancel(missing)).rejects.toThrow(/not found/i);

    const absent = path.join(root, "does-not-exist");
    await expect(jobs.start({ command: "pwd", cwd: absent })).rejects.toThrow(/working directory|cwd/i);
    expect(await jobs.list()).toEqual([]);
  });

  test("does not trust a live pid whose command line does not name the job directory", async () => {
    const root = await tempRoot();
    const jobs = await manager(root);
    const started = await jobs.start({ command: "sleep 300", cwd: root });
    expect(started.pid).not.toBeNull();
    groups.add(started.pid!);

    const pidFile = path.join(root, "state", started.job_id, "pid");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(pidFile, `${process.pid}\n`, { mode: 0o600 }));
    const reconciled = await manager(root);
    expect((await reconciled.get(started.job_id))?.status).toBe("lost");
  });

  test("returns an already-exited job from cancel without changing its status", async () => {
    const root = await tempRoot();
    const jobs = await manager(root);
    const started = await jobs.start({ command: "exit 0", cwd: root });
    await finished(jobs, started.job_id);
    expect(await jobs.cancel(started.job_id, 0)).toMatchObject({ status: "exited", exit_code: 0 });
  });

  test("prunes only old exited and killed job directories", async () => {
    const root = await tempRoot();
    const jobs = await manager(root);
    const stateDir = path.join(root, "state");

    const oldExited = await jobs.start({ command: "exit 0", cwd: root });
    await finished(jobs, oldExited.job_id);
    const oldKilled = await jobs.start({ command: "sleep 300", cwd: root });
    groups.add(oldKilled.pid!);
    expect((await jobs.cancel(oldKilled.job_id, 0)).status).toBe("killed");
    const recentExited = await jobs.start({ command: "exit 0", cwd: root });
    await finished(jobs, recentExited.job_id);
    const running = await jobs.start({ command: "sleep 300", cwd: root });
    groups.add(running.pid!);
    const lost = await jobs.start({ command: "sleep 300", cwd: root });
    groups.add(lost.pid!);
    process.kill(lost.pid!, "SIGKILL");
    await eventually(async () => processExists(lost.pid!), (alive) => !alive);
    expect((await jobs.get(lost.job_id))?.status).toBe("lost");

    const old = new Date(Date.now() - 60_000);
    await utimes(path.join(stateDir, oldExited.job_id, "exit_code"), old, old);
    await utimes(path.join(stateDir, oldKilled.job_id, "cancelled"), old, old);

    expect(await jobs.prune(30_000)).toBe(2);
    await expect(access(path.join(stateDir, oldExited.job_id))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(stateDir, oldKilled.job_id))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(stateDir, recentExited.job_id))).resolves.toBeUndefined();
    await expect(access(path.join(stateDir, running.job_id))).resolves.toBeUndefined();
    await expect(access(path.join(stateDir, lost.job_id))).resolves.toBeUndefined();
    await expect(jobs.get(oldExited.job_id)).resolves.toBeNull();
  });
});
