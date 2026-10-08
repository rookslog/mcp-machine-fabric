import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { expect, test } from "vitest";
import { ResultCache } from "../src/agent/result-cache.js";
import { call, makeHarness, waitFor } from "./helpers.js";

const DEFAULT_SEED = 0x5eedc0de;
const MUTATION_COUNT = 60;
const CONCURRENCY = 6;
const TERMINAL_STATES = new Set(["completed", "failed", "not_dispatched"]);

type CallResult = Awaited<ReturnType<typeof call>>;
type MutationTool = "run_command" | "write_file";

interface Mutation {
  key: string;
  machine: "alpha" | "beta";
  tool: MutationTool;
  marker: string;
  args: Record<string, unknown>;
}

interface Observation {
  attempts: number;
  requestIds: Set<string>;
  toldNotDispatched: boolean;
  lastText: string;
  transportErrors: number;
}

function seedValue(raw: string | undefined): number {
  if (!raw) return DEFAULT_SEED;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric >>> 0;
  let hash = 2166136261;
  for (const char of raw) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out after " + timeoutMs + "ms")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function markerLines(file: string): Promise<string[]> {
  try {
    return (await readFile(file, "utf8")).split("\n").filter((line) => line.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function completedOutcomeMismatch(
  mutation: Mutation,
  outcome: Record<string, any> | null,
  stateDir: string,
): Promise<string | null> {
  if (!outcome?.ok) return "recorded outcome was not successful";
  const data = outcome.data as Record<string, unknown> | undefined;
  if (mutation.tool === "write_file") {
    const content = await readFile(mutation.marker);
    const expectedBytes = Buffer.byteLength(mutation.key + "\n");
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (
      data?.path !== mutation.marker ||
      data.bytes_written !== expectedBytes ||
      data.sha256 !== actualHash
    ) {
      return (
        "write outcome metadata mismatch; expected path=" +
        mutation.marker +
        ", bytes=" +
        expectedBytes +
        ", sha256=" +
        actualHash +
        "; data=" +
        JSON.stringify(data)
      );
    }
    return null;
  }

  const jobId = typeof data?.job_id === "string" ? data.job_id : "";
  if (
    !/^j_[a-z0-9]+_[a-f0-9]+$/.test(jobId) ||
    data?.status !== "exited" ||
    data.exit_code !== 0
  ) {
    return "command outcome did not record an exited zero-status job; data=" + JSON.stringify(data);
  }
  try {
    const meta = JSON.parse(
      await readFile(nodePath.join(stateDir, "jobs", jobId, "meta.json"), "utf8"),
    ) as Record<string, unknown>;
    if (
      meta.command !== mutation.args.command ||
      meta.cwd !== mutation.args.cwd
    ) {
      return (
        "command job metadata did not match the issued operation; meta=" +
        JSON.stringify(meta)
      );
    }
  } catch (error) {
    return "command job metadata was unreadable: " + String(error);
  }
  return null;
}

test("result cache serializes job annotation with completion", async () => {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "mmf-cache-race-"));
  try {
    const cache = new ResultCache(dir, "agent-run-a");
    const requestId = "r_a_000000000001";
    await cache.init();
    await cache.begin(requestId, "run_command");

    await Promise.all([
      cache.noteJob(requestId, "j_a_deadbeef"),
      cache.finish(requestId, "run_command", { ok: true, text: "done" }),
    ]);

    expect(await cache.get(requestId)).toMatchObject({
      state: "completed",
      job_id: "j_a_deadbeef",
      outcome: { ok: true, text: "done" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("final recovery terminalizes a request absent from the agent cache", async () => {
  const h = await makeHarness(["alpha"]);
  try {
    await h.startAgent("alpha");
    const sentinelMarker = nodePath.join(h.agents.alpha.root, "sentinel.txt");
    const firstClient = await h.client();
    const sentinel = await call(firstClient, "write_file", {
      machine: "alpha",
      path: sentinelMarker,
      content: "sentinel\n",
      mode: "append",
      idempotency_key: "chaos-minimized-sentinel",
    });
    await firstClient.close();
    const sentinelId = sentinel.structuredContent?.request_id as string;
    expect(sentinel.structuredContent?.state).toBe("completed");
    h.store.setState(sentinelId, "dispatched_unknown");

    const requestId = "r_a_000000000002";
    const key = "chaos-minimized-unknown";
    const marker = nodePath.join(h.agents.alpha.root, "unknown.txt");
    h.store.createRequest({
      request_id: requestId,
      machine: "alpha",
      tool: "write_file",
      effect: "write",
      principal: "test:owner",
      idempotency_key: key,
      args_summary: JSON.stringify({
        path: marker,
        content: "should-run-on-safe-retry\n",
        mode: "append",
      }),
      state: "dispatched_unknown",
    });

    await h.restartHub();
    await waitFor(async () => h.hub.registry.isConnected("alpha"), 6_000, 25);
    await waitFor(
      async () => h.store.getRequest(sentinelId)?.state === "completed",
      3_000,
      25,
    );

    const client = await h.client();
    await call(client, "write_file", {
      machine: "alpha",
      path: marker,
      content: "should-run-on-safe-retry\n",
      mode: "append",
      idempotency_key: key,
    });
    await client.close();

    await waitFor(
      async () => {
        const row = h.store.getRequest(requestId);
        return row && TERMINAL_STATES.has(row.state) ? row : false;
      },
      1_000,
      25,
    ).catch(() => null);
    expect((await markerLines(marker)).length).toBeLessThanOrEqual(1);
    const recovered = h.store.getRequest(requestId);
    expect(
      recovered && TERMINAL_STATES.has(recovered.state),
      "sentinel recovery completed, but the cache-absent request stayed " +
        recovered?.state +
        " after same-key retry",
    ).toBe(true);
  } finally {
    await h.cleanup();
  }
});

test(
  "seeded chaos preserves delivery invariants across real hub and agent failures",
  async () => {
    const seed = seedValue(process.env.CHAOS_SEED);
    const workloadRandom = mulberry32(seed ^ 0xa5a5a5a5);
    const faultRandom = mulberry32(seed ^ 0x5a5a5a5a);
    const h = await makeHarness(["alpha", "beta"]);
    const observations = new Map<string, Observation>();
    const invariantFailures = {
      no_duplicate_side_effects: [] as string[],
      all_requests_terminal: [] as string[],
      completed_matches_side_effect: [] as string[],
      not_dispatched_has_no_side_effect: [] as string[],
    };
    const harnessFailures: string[] = [];
    const faultLog: string[] = [];
    let retries = 0;
    let readCalls = 0;
    let readRetries = 0;
    const deferredReads: Array<{
      machine: "alpha" | "beta";
      path: string;
    }> = [];

    const observation = (key: string): Observation => {
      let value = observations.get(key);
      if (!value) {
        value = {
          attempts: 0,
          requestIds: new Set(),
          toldNotDispatched: false,
          lastText: "",
          transportErrors: 0,
        };
        observations.set(key, value);
      }
      return value;
    };

    const invoke = async (name: string, args: Record<string, unknown>): Promise<CallResult> => {
      const client = await withTimeout(h.client(), 3_000, "MCP client connect");
      try {
        return await withTimeout(call(client, name, args), 5_000, name);
      } finally {
        await client.close().catch(() => {});
      }
    };

    const recordResult = (mutation: Mutation, result: CallResult): string | null => {
      const seen = observation(mutation.key);
      const state = typeof result.structuredContent?.state === "string" ? result.structuredContent.state : null;
      const requestId =
        typeof result.structuredContent?.request_id === "string" ? result.structuredContent.request_id : null;
      if (requestId) seen.requestIds.add(requestId);
      if (state === "not_dispatched") seen.toldNotDispatched = true;
      seen.lastText = result.content.map((part) => part.text ?? "").join("\n");
      return state;
    };

    const invokeMutation = async (mutation: Mutation): Promise<CallResult> => {
      const seen = observation(mutation.key);
      seen.attempts++;
      return invoke(mutation.tool, {
        machine: mutation.machine,
        ...mutation.args,
        idempotency_key: mutation.key,
      });
    };

    const pollStatus = async (mutation: Mutation, requestId: string, timeoutMs: number): Promise<string | null> => {
      const end = Date.now() + timeoutMs;
      let lastState: string | null = null;
      while (Date.now() < end) {
        try {
          const result = await invoke("get_request_status", { request_id: requestId });
          lastState =
            typeof result.structuredContent?.state === "string" ? result.structuredContent.state : null;
          observation(mutation.key).lastText = result.content.map((part) => part.text ?? "").join("\n");
          if (lastState && TERMINAL_STATES.has(lastState)) {
            return lastState;
          }
        } catch {
          retries++;
        }
        await delay(75);
      }
      return lastState;
    };

    const waitConnected = async (machine: "alpha" | "beta"): Promise<void> => {
      await waitFor(async () => h.hub.registry.isConnected(machine), 6_000, 25);
    };

    const executeCarefully = async (mutation: Mutation): Promise<void> => {
      const seen = observation(mutation.key);
      for (let attempt = 0; attempt < 5; attempt++) {
        let result: CallResult;
        try {
          result = await invokeMutation(mutation);
        } catch {
          seen.transportErrors++;
          retries++;
          await delay(75 + ((attempt * 17) % 75));
          continue;
        }

        const state = recordResult(mutation, result);
        const requestId = [...seen.requestIds].at(-1);
        if (state === "completed" || state === "failed") return;
        if (state === "not_dispatched") {
          const lines = await markerLines(mutation.marker);
          if (lines.length !== 0) {
            invariantFailures.not_dispatched_has_no_side_effect.push(
              mutation.key +
                " produced " +
                JSON.stringify(lines) +
                " before its not_dispatched retry",
            );
          }
          if (attempt === 0) {
            await waitConnected(mutation.machine);
            retries++;
            continue;
          }
          return;
        }
        if (requestId) {
          const recovered = await pollStatus(mutation, requestId, 2_500);
          if (recovered && TERMINAL_STATES.has(recovered)) return;
          return;
        }
        retries++;
        await delay(100);
      }
    };

    const interleavedRead = async (
      machine: "alpha" | "beta",
      path: string,
    ): Promise<void> => {
      readCalls++;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await invoke("read_file", { machine, path });
          if (!result.isError) return;
          const state =
            typeof result.structuredContent?.state === "string"
              ? result.structuredContent.state
              : null;
          if (state === "not_dispatched") {
            await waitConnected(machine);
          } else {
            const requestId =
              typeof result.structuredContent?.request_id === "string"
                ? result.structuredContent.request_id
                : null;
            if (requestId) {
              const end = Date.now() + 1_500;
              while (Date.now() < end) {
                const status = await invoke("get_request_status", {
                  request_id: requestId,
                });
                const recovered =
                  typeof status.structuredContent?.state === "string"
                    ? status.structuredContent.state
                    : null;
                if (recovered && TERMINAL_STATES.has(recovered)) return;
                await delay(75);
              }
            }
          }
        } catch {
          // A hub restart can invalidate the transport; rebuild and retry.
        }
        readRetries++;
        await delay(50);
      }
      deferredReads.push({ machine, path });
    };

    try {
      await Promise.all([h.startAgent("alpha"), h.startAgent("beta")]);
      await Promise.all([
        mkdir(nodePath.join(h.agents.alpha.root, "markers"), { recursive: true }),
        mkdir(nodePath.join(h.agents.beta.root, "markers"), { recursive: true }),
      ]);
      const readProbes = {
        alpha: nodePath.join(h.agents.alpha.root, "read-probe.txt"),
        beta: nodePath.join(h.agents.beta.root, "read-probe.txt"),
      };
      await Promise.all([
        writeFile(readProbes.alpha, "alpha probe\n"),
        writeFile(readProbes.beta, "beta probe\n"),
      ]);

      const prefix = "chaos-" + seed.toString(16).padStart(8, "0") + "-";
      const mutations: Mutation[] = [];
      for (let index = 0; index < MUTATION_COUNT - 1; index++) {
        const machine = workloadRandom() < 0.5 ? "alpha" : "beta";
        const key = prefix + index.toString().padStart(3, "0");
        const marker = nodePath.join(h.agents[machine].root, "markers", key + ".txt");
        if (index % 2 === 0) {
          const sleepMs = Math.floor(workloadRandom() * 801);
          mutations.push({
            key,
            machine,
            tool: "run_command",
            marker,
            args: {
              command:
                "printf '%s\\n' \"$CHAOS_KEY\" >> \"$CHAOS_MARKER\"; node -e 'setTimeout(() => {}, Number(process.env.CHAOS_SLEEP_MS))'",
              cwd: h.agents[machine].root,
              wait_seconds: 2,
              env: {
                CHAOS_KEY: key,
                CHAOS_MARKER: marker,
                CHAOS_SLEEP_MS: String(sleepMs),
              },
            },
          });
        } else {
          mutations.push({
            key,
            machine,
            tool: "write_file",
            marker,
            args: { path: marker, content: key + "\n", mode: "append" },
          });
        }
      }

      const outageMutation: Mutation = {
        key: prefix + "outage",
        machine: "alpha",
        tool: "write_file",
        marker: nodePath.join(h.agents.alpha.root, "markers", prefix + "outage.txt"),
        args: {
          path: nodePath.join(h.agents.alpha.root, "markers", prefix + "outage.txt"),
          content: prefix + "outage\n",
          mode: "append",
        },
      };
      const allMutations = [...mutations, outageMutation];

      let nextMutation = 0;
      let stopScheduling = false;
      const schedulingDeadline = Date.now() + 40_000;
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        try {
          for (;;) {
            if (stopScheduling) return;
            if (Date.now() > schedulingDeadline) {
              throw new Error("workload scheduling exceeded 40 seconds");
            }
            const index = nextMutation++;
            const mutation = mutations[index];
            if (!mutation) return;
            await executeCarefully(mutation);
            if (index % 5 === 0) {
              await interleavedRead(mutation.machine, readProbes[mutation.machine]);
            }
          }
        } catch (error) {
          stopScheduling = true;
          throw error;
        }
      });

      const actions = shuffle(
        ["drop-alpha", "drop-beta", "restart-alpha", "restart-beta", "hub-restart-1", "hub-restart-2"],
        faultRandom,
      );
      actions.splice(3, 0, "full-outage");

      const faults = (async () => {
        try {
          for (const action of actions) {
            if (stopScheduling) return;
            if (Date.now() > schedulingDeadline) {
              throw new Error("fault scheduling exceeded 40 seconds");
            }
            await delay(60 + Math.floor(faultRandom() * 140));
            if (action === "drop-alpha" || action === "drop-beta") {
              const machine = action.endsWith("alpha") ? "alpha" : "beta";
              h.agents[machine].agent.dropConnection();
              faultLog.push(action);
              await delay(175);
              await waitConnected(machine);
            } else if (action === "restart-alpha" || action === "restart-beta") {
              const machine = action.endsWith("alpha") ? "alpha" : "beta";
              await h.agents[machine].agent.stop();
              await waitFor(async () => !h.hub.registry.isConnected(machine), 3_000, 20);
              await h.startAgent(machine);
              faultLog.push(action);
            } else if (action.startsWith("hub-restart")) {
              await h.restartHub();
              await Promise.all([waitConnected("alpha"), waitConnected("beta")]);
              faultLog.push(action);
            } else {
              await Promise.all([h.agents.alpha.agent.stop(), h.agents.beta.agent.stop()]);
              await waitFor(
                async () => !h.hub.registry.isConnected("alpha") && !h.hub.registry.isConnected("beta"),
                3_000,
                20,
              );
              faultLog.push(action);

              const offline = await invokeMutation(outageMutation);
              const state = recordResult(outageMutation, offline);
              if (state !== "not_dispatched") {
                harnessFailures.push(
                  "full-outage call returned " + String(state) + " instead of not_dispatched",
                );
              } else {
                const lines = await markerLines(outageMutation.marker);
                if (lines.length !== 0) {
                  invariantFailures.not_dispatched_has_no_side_effect.push(
                    outageMutation.key +
                      " produced " +
                      JSON.stringify(lines) +
                      " during the full outage",
                  );
                }
              }

              await Promise.all([h.startAgent("alpha"), h.startAgent("beta")]);
              retries++;
              const replay = await invokeMutation(outageMutation);
              recordResult(outageMutation, replay);
            }
          }
        } catch (error) {
          stopScheduling = true;
          throw error;
        }
      })();

      const [workerResults, faultResults] = await Promise.all([
        Promise.allSettled(workers),
        Promise.allSettled([faults]),
      ]);
      for (const result of [...workerResults, ...faultResults]) {
        if (result.status === "rejected") {
          harnessFailures.push("chaos phase failed: " + String(result.reason));
        }
      }

      await Promise.all([waitConnected("alpha"), waitConnected("beta")]);
      await h.restartHub();
      await Promise.all([waitConnected("alpha"), waitConnected("beta")]);

      for (const deferred of deferredReads) {
        readRetries++;
        try {
          const result = await invoke("read_file", deferred);
          if (result.isError) {
            harnessFailures.push(
              "a deferred read_file call still failed after quiescence: " +
                result.content.map((part) => part.text ?? "").join("\n"),
            );
          }
        } catch (error) {
          harnessFailures.push(
            "a deferred read_file transport still failed after quiescence: " +
              String(error),
          );
        }
      }

      for (const mutation of allMutations) {
        let row = h.store.findIdempotent("test:owner", mutation.machine, mutation.tool, mutation.key);
        if (!row) {
          retries++;
          try {
            recordResult(mutation, await invokeMutation(mutation));
          } catch {
            observation(mutation.key).transportErrors++;
          }
          row = h.store.findIdempotent("test:owner", mutation.machine, mutation.tool, mutation.key);
        }
        if (row && !TERMINAL_STATES.has(row.state)) {
          retries++;
          try {
            recordResult(mutation, await invokeMutation(mutation));
          } catch {
            observation(mutation.key).transportErrors++;
          }
          await pollStatus(mutation, row.request_id, 3_000);
        }
      }

      await waitFor(
        async () => {
          const mutationRows = allMutations
            .map((mutation) =>
              h.store.findIdempotent(
                "test:owner",
                mutation.machine,
                mutation.tool,
                mutation.key,
              ),
            )
            .filter((row) => row !== null);
          const ledger = h.store.recentRequests(500);
          return mutationRows.length === MUTATION_COUNT &&
            ledger.every((row) => TERMINAL_STATES.has(row.state))
            ? ledger
            : false;
        },
        10_000,
        100,
      ).catch(() => null);

      const rows = allMutations.map((mutation) => ({
        mutation,
        row: h.store.findIdempotent("test:owner", mutation.machine, mutation.tool, mutation.key),
      }));

      const stateCounts: Record<string, number> = {};
      const ledger = h.store.recentRequests(500);
      const mutationRequestIds = new Set(
        rows.flatMap(({ row }) => (row ? [row.request_id] : [])),
      );
      for (const row of ledger) {
        stateCounts[row.state] = (stateCounts[row.state] ?? 0) + 1;
        if (
          !TERMINAL_STATES.has(row.state) &&
          !mutationRequestIds.has(row.request_id)
        ) {
          invariantFailures.all_requests_terminal.push(
            "ledger request " +
              row.request_id +
              " (" +
              row.tool +
              " on " +
              row.machine +
              ") stayed " +
              row.state +
              " after final recovery; error_code=" +
              String(row.error_code) +
              "; outcome=" +
              String(row.outcome_json),
          );
        }
      }
      for (const { mutation, row } of rows) {
        const lines = await markerLines(mutation.marker);
        if (!row) {
          invariantFailures.all_requests_terminal.push(
            mutation.key + " has no ledger row",
          );
          continue;
        }
        if (!TERMINAL_STATES.has(row.state)) {
          const seen = observation(mutation.key);
          invariantFailures.all_requests_terminal.push(
            mutation.key +
              " stayed " +
              row.state +
              " after final recovery; request=" +
              row.request_id +
              "; last_client_text=" +
              JSON.stringify(seen.lastText),
          );
        }
        if (lines.length > 1 || lines.some((line) => line !== mutation.key)) {
          invariantFailures.no_duplicate_side_effects.push(
            mutation.key + " side effect was not at-most-once; observed lines=" + JSON.stringify(lines),
          );
        }
        if (row.state === "completed") {
          const outcome = row.outcome_json ? JSON.parse(row.outcome_json) : null;
          const mismatch = await completedOutcomeMismatch(
            mutation,
            outcome,
            h.agents[mutation.machine].stateDir,
          );
          if (mismatch || lines.length !== 1 || lines[0] !== mutation.key) {
            invariantFailures.completed_matches_side_effect.push(
              mutation.key +
                " completed outcome did not match its side effect; outcome=" +
                row.outcome_json +
                "; lines=" +
                JSON.stringify(lines) +
                (mismatch ? "; " + mismatch : ""),
            );
          }
        }
        const seen = observation(mutation.key);
        const mismatchedIds = [...seen.requestIds].filter(
          (requestId) => requestId !== row.request_id,
        );
        if (mismatchedIds.length > 0) {
          harnessFailures.push(
            mutation.key +
              " returned request IDs that do not match its keyed ledger row: " +
              JSON.stringify(mismatchedIds) +
              " versus " +
              row.request_id,
          );
        }
        if (row.state === "not_dispatched" || seen.toldNotDispatched) {
          if (lines.length !== 0) {
            invariantFailures.not_dispatched_has_no_side_effect.push(
              mutation.key + " was reported not_dispatched but produced " + JSON.stringify(lines),
            );
          }
        }
      }

      const violations = [
        ...Object.values(invariantFailures).flat(),
        ...harnessFailures,
      ];
      const observed = [...observations.values()];
      const report = {
        seed,
        mutations: MUTATION_COUNT,
        concurrency: CONCURRENCY,
        faults_injected: faultLog.length,
        fault_schedule: faultLog,
        retries,
        mutation_attempts: observed.reduce(
          (total, item) => total + item.attempts,
          0,
        ),
        transport_errors: observed.reduce(
          (total, item) => total + item.transportErrors,
          0,
        ),
        not_dispatched_observations: observed.filter(
          (item) => item.toldNotDispatched,
        ).length,
        interleaved_reads: readCalls,
        read_retries: readRetries,
        deferred_reads: deferredReads.length,
        ledger_states: stateCounts,
        invariants: Object.fromEntries(
          Object.entries(invariantFailures).map(([name, failures]) => [
            name,
            failures.length === 0,
          ]),
        ),
        harness_failures: harnessFailures,
        violations,
      };
      console.info("[chaos] " + JSON.stringify(report));
      expect(violations, "chaos seed " + seed + "\n" + JSON.stringify(report, null, 2)).toEqual([]);
    } finally {
      await h.cleanup();
    }
  },
  60_000,
);
