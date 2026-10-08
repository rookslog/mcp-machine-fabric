import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const smokeOptions = (env: NodeJS.ProcessEnv = process.env) => ({
  cwd: process.cwd(),
  env: { ...env, NO_COLOR: "1" },
  maxBuffer: 1024 * 1024,
  timeout: 120_000,
});

async function expectSmokeFailure(env: NodeJS.ProcessEnv): Promise<string> {
  try {
    await execFileAsync("bash", ["scripts/pack-smoke.sh"], smokeOptions(env));
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    return `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`;
  }
  throw new Error("pack smoke unexpectedly succeeded");
}

test(
  "the packed CLI installs and controls a real agent",
  async () => {
    const { stdout } = await execFileAsync("bash", ["scripts/pack-smoke.sh"], smokeOptions());

    expect(stdout).toContain("pack-ok");
    expect(stdout).toContain("PACK_SMOKE_OK");
  },
  120_000,
);

test(
  "fails offline instead of fetching dependencies during the test",
  async () => {
    const emptyCache = await mkdtemp(nodePath.join(tmpdir(), "mmf-empty-npm-cache-"));
    try {
      const output = await expectSmokeFailure({ ...process.env, npm_config_cache: emptyCache });
      expect(output).toMatch(/ENOTCACHED|cache miss|offline mode/i);
      expect(output).not.toContain("PACK_SMOKE_OK");
    } finally {
      await rm(emptyCache, { recursive: true });
    }
  },
  120_000,
);

test(
  "exits nonzero when terminated after the hub starts",
  async () => {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; sent: boolean; stdout: string }>((resolve, reject) => {
      const child = spawn("bash", ["scripts/pack-smoke.sh"], {
        cwd: process.cwd(),
        env: { ...process.env, MMF_PACK_SMOKE_TRACE: "1", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let sent = false;
      let stdout = "";
      const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!sent && chunk.includes("PACK_SMOKE_HUB_READY")) {
          sent = true;
          child.kill("SIGTERM");
        }
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal, sent, stdout });
      });
    });

    expect(result.sent).toBe(true);
    expect(result.code).not.toBe(0);
    const workDir = result.stdout.match(/^PACK_SMOKE_WORK_DIR=(.+)$/m)?.[1];
    const hubPid = Number(result.stdout.match(/^PACK_SMOKE_HUB_PID=(\d+)$/m)?.[1]);
    expect(workDir).toBeTruthy();
    expect(hubPid).toBeGreaterThan(0);
    if (!workDir || !hubPid) throw new Error(`missing cleanup trace:\n${result.stdout}`);
    await expect(access(workDir)).rejects.toThrow();
    expect(() => process.kill(hubPid, 0)).toThrow();
  },
  120_000,
);

test(
  "rejects a remote command that prints the marker but exits nonzero",
  async () => {
    const output = await expectSmokeFailure({ ...process.env, MMF_PACK_SMOKE_COMMAND: "echo pack-ok; exit 7" });
    expect(output).not.toContain("PACK_SMOKE_OK");
  },
  120_000,
);

test(
  "cancels a remote command that is still running",
  async () => {
    const probeDir = await mkdtemp(nodePath.join(tmpdir(), "mmf-running-job-"));
    const pidFile = nodePath.join(probeDir, "sleep.pid");
    let sleepPid = 0;
    try {
      const command = `echo pack-ok; sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait`;
      const output = await expectSmokeFailure({
        ...process.env,
        MMF_PACK_SMOKE_COMMAND: command,
        MMF_PACK_SMOKE_WAIT_SECONDS: "0.1",
      });
      expect(output).not.toContain("PACK_SMOKE_OK");
      sleepPid = Number((await readFile(pidFile, "utf8")).trim());
      expect(sleepPid).toBeGreaterThan(0);
      expect(() => process.kill(sleepPid, 0)).toThrow();
    } finally {
      if (sleepPid > 0) {
        try {
          process.kill(sleepPid, "SIGKILL");
        } catch {}
      }
      await rm(probeDir, { recursive: true });
    }
  },
  120_000,
);
