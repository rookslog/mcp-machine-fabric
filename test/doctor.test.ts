import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runDoctor, type DoctorCheck, type DoctorResult } from "../src/doctor.js";
import { makeHarness, type Harness } from "./helpers.js";

const harnesses = new Set<Harness>();

afterEach(async () => {
  await Promise.all([...harnesses].map((harness) => harness.cleanup()));
  harnesses.clear();
});

interface DoctorHarnessOptions {
  mutate?: (harness: Harness) => void;
  roots?: string;
  rootDirectories?: (home: string) => string[];
}

async function doctorHarness(machine: string, options: DoctorHarnessOptions = {}): Promise<{
  harness: Harness;
  lines: string[];
  result: DoctorResult;
  token: string;
}> {
  const harness = await makeHarness([]);
  harnesses.add(harness);
  const { token } = harness.store.addDevice(machine);
  options.mutate?.(harness);

  const tokenFile = path.join(harness.dir, `${machine}.token`);
  const root = path.join(harness.dir, "root");
  const stateDir = path.join(harness.dir, "state");
  await Promise.all([
    mkdir(root),
    mkdir(stateDir),
    ...(options.rootDirectories?.(harness.dir) ?? []).map((directory) => mkdir(directory)),
    writeFile(tokenFile, `${token}\n`, { mode: 0o600 }),
  ]);
  await chmod(tokenFile, 0o600);

  const lines: string[] = [];
  const result = await runDoctor(
    {
      hubUrl: `ws://127.0.0.1:${harness.port}/agent`,
      tokenFile,
      env: { ...process.env, MMF_ROOTS: options.roots ?? root, MMF_STATE_DIR: stateDir },
      homeDir: harness.dir,
      platform: process.platform,
      timeoutMs: 2_000,
    },
    (line) => lines.push(line),
  );
  return { harness, lines, result, token };
}

function check(result: DoctorResult, id: string): DoctorCheck {
  const found = result.checks.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing doctor check: ${id}`);
  return found;
}

describe("runDoctor", () => {
  test("reports a real hub handshake and the enrolled machine name", async () => {
    const { lines, result } = await doctorHarness("doctor-good");

    expect(result.exitCode).toBe(0);
    expect(check(result, "tcp")).toMatchObject({ status: "PASS" });
    expect(check(result, "websocket")).toMatchObject({ status: "PASS", message: expect.stringContaining("doctor-good") });
    expect(check(result, "websocket_effect")).toMatchObject({ status: "WARN" });
    expect(lines.every((line) => /^(PASS|WARN|FAIL) .+ — fix: .+/.test(line))).toBe(true);
  });

  test("reports a revoked device token as an authentication failure", async () => {
    const { lines, result } = await doctorHarness("doctor-revoked", {
      mutate: (harness) => harness.store.revokeDevice("doctor-revoked"),
    });

    expect(result.exitCode).toBe(1);
    expect(check(result, "websocket")).toMatchObject({
      status: "FAIL",
      message: expect.stringContaining("token revoked or wrong hub"),
    });
    expect(lines.some((line) => line.includes("FAIL hub WebSocket: token revoked or wrong hub"))).toBe(true);
  });

  test("rejects a hub URL whose path is not the agent endpoint", async () => {
    const { harness, result } = await doctorHarness("doctor-wrong-url");
    const lines: string[] = [];
    const wrong = await runDoctor(
      {
        hubUrl: `ws://127.0.0.1:${harness.port}/not-agent`,
        tokenFile: path.join(harness.dir, "doctor-wrong-url.token"),
        env: {
          ...process.env,
          MMF_ROOTS: path.join(harness.dir, "root"),
          MMF_STATE_DIR: path.join(harness.dir, "state"),
        },
        homeDir: harness.dir,
        platform: process.platform,
        timeoutMs: 2_000,
      },
      (line) => lines.push(line),
    );

    expect(result.exitCode).toBe(0);
    expect(wrong.exitCode).toBe(1);
    expect(check(wrong, "hub_url")).toMatchObject({ status: "FAIL" });
    expect(lines.some((line) => line.includes("ending in /agent"))).toBe(true);
  });

  test("checks the same tilde-expanded and default roots that the agent uses", async () => {
    const homeRoot = "agent-root";
    const { harness, result } = await doctorHarness("doctor-roots", {
      roots: `~/${homeRoot}`,
      rootDirectories: (home) => [path.join(home, homeRoot)],
    });

    expect(check(result, "policy_roots")).toMatchObject({ status: "PASS" });

    const emptyRoots = await runDoctor(
      {
        hubUrl: `ws://127.0.0.1:${harness.port}/agent`,
        tokenFile: path.join(harness.dir, "doctor-roots.token"),
        env: { ...process.env, MMF_ROOTS: ":", MMF_STATE_DIR: path.join(harness.dir, "state") },
        homeDir: harness.dir,
        platform: process.platform,
        timeoutMs: 2_000,
      },
      () => undefined,
    );
    expect(check(emptyRoots, "policy_roots")).toMatchObject({ status: "PASS", message: harness.dir });
  });
});
