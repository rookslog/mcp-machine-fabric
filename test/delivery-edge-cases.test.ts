import { readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import WebSocket from "ws";
import { expect, test } from "vitest";
import { PROTOCOL_VERSION, type AgentInfo, type AgentToHub, type HubToAgent } from "../src/shared/protocol.js";
import { call, makeHarness, waitFor, type Harness } from "./helpers.js";

async function rawAgent(h: Harness, machine: string): Promise<WebSocket> {
  const enrolled = h.agents[machine];
  const stateId = (await readFile(nodePath.join(enrolled.stateDir, "state_id"), "utf8")).trim();
  const ws = new WebSocket(`${h.url.replace(/^http/, "ws")}/agent`, {
    headers: { Authorization: `Bearer ${enrolled.token}` },
  });

  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as HubToAgent;
    if (message.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", nonce: message.nonce } satisfies AgentToHub));
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const info: AgentInfo = {
    agent_version: "test",
    protocol_version: PROTOCOL_VERSION,
    hostname: "raw-agent",
    platform: process.platform,
    arch: process.arch,
    tools: ["read_file"],
    policy: { read_only: true, roots: [enrolled.root], allow_exec: false },
    started_at: new Date().toISOString(),
    state_id: stateId,
  };
  ws.send(JSON.stringify({ type: "hello", info } satisfies AgentToHub));
  await waitFor(async () => h.hub.registry.isConnected(machine), 3_000, 10);
  return ws;
}

async function releaseAndSettleJob(h: Harness, machine: string, gate: string | undefined, jobId: string | undefined): Promise<void> {
  if (gate) await writeFile(gate, "release\n").catch(() => {});
  if (!jobId) return;
  const jobs = h.agents[machine]?.agent.executor.jobs;
  if (!jobs) return;
  const settled = await waitFor(async () => {
    const job = await jobs.get(jobId);
    return job && job.status !== "running" ? job : null;
  }, 3_000, 25).catch(() => null);
  if (settled) return;
  await jobs.cancel(jobId, 100).catch(() => null);
  await waitFor(async () => {
    const job = await jobs.get(jobId);
    return job && job.status !== "running" ? job : null;
  }, 3_000, 25).catch(() => null);
}

test("same-state agent restart cannot classify a received call as not_dispatched", async () => {
  const h = await makeHarness(["alpha"]);
  let gate: string | undefined;
  let jobId: string | undefined;
  let marker: string | undefined;
  try {
    await h.startAgent("alpha");
    const client = await h.client();
    gate = nodePath.join(h.agents.alpha.root, "release-agent-restart");
    marker = nodePath.join(h.agents.alpha.root, "agent-restart.txt");
    const started = nodePath.join(h.agents.alpha.root, "agent-restart-started");
    const pending = call(client, "run_command", {
      machine: "alpha",
      command: `printf 'started\\n' > ${JSON.stringify(started)}; barrier_tries=0; while [ ! -f ${JSON.stringify(gate)} ] && [ "$barrier_tries" -lt 200 ]; do sleep 0.05; barrier_tries=$((barrier_tries + 1)); done; [ -f ${JSON.stringify(gate)} ] || exit 124; printf 'once\\n' >> ${JSON.stringify(marker)}`,
      cwd: h.agents.alpha.root,
      wait_seconds: 5,
      idempotency_key: "same-state-restart-0001",
    });

    const row = await waitFor(async () => {
      const candidate = h.store.recentRequests(10).find((request) => request.tool === "run_command");
      return candidate?.state === "accepted" ? candidate : null;
    });
    const resultFile = nodePath.join(h.agents.alpha.stateDir, "results", `${row.request_id}.json`);
    const cached = await waitFor(async () => {
      const cached = JSON.parse(await readFile(resultFile, "utf8")) as { job_id?: string };
      return cached.job_id ? cached : null;
    });
    jobId = cached.job_id;
    await waitFor(async () => readFile(started, "utf8").then(() => true).catch(() => false));

    await h.agents.alpha.agent.stop();
    const interrupted = await pending;
    expect(interrupted.structuredContent?.state).toBe("dispatched_unknown");

    await h.startAgent("alpha");
    const terminal = await waitFor(async () => {
      const current = h.store.getRequest(row.request_id);
      return current && (current.state === "completed" || current.state === "failed" || current.state === "not_dispatched")
        ? current
        : null;
    });

    expect(terminal.state).toBe("failed");
    expect(terminal.state).not.toBe("not_dispatched");
    expect(terminal.outcome_json).toContain("agent restarted while this call was executing");
    await writeFile(gate, "release\n");
    await waitFor(
      async () => readFile(marker, "utf8").then((content) => content === "once\n").catch(() => false),
      3_000,
      25,
    );
  } finally {
    await releaseAndSettleJob(h, "alpha", gate, jobId);
    await h.cleanup();
  }
});

test("a late result frame cannot regress a resolved request", async () => {
  const h = await makeHarness(["alpha"]);
  let ws: WebSocket | undefined;
  try {
    await h.startAgent("alpha");
    const source = nodePath.join(h.agents.alpha.root, "first.txt");
    await writeFile(source, "original result\n");
    const client = await h.client();
    const first = await call(client, "read_file", { machine: "alpha", path: source });
    const requestId = first.structuredContent?.request_id as string;
    expect(first.structuredContent?.state).toBe("completed");
    const originalOutcome = h.store.getRequest(requestId)?.outcome_json;

    await h.agents.alpha.agent.stop();
    ws = await rawAgent(h, "alpha");
    let responseNumber = 0;
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as HubToAgent;
      if (message.type !== "call") return;
      responseNumber++;
      ws!.send(JSON.stringify({ type: "accepted", request_id: message.request_id } satisfies AgentToHub));
      ws!.send(
        JSON.stringify({
          type: "result",
          request_id: message.request_id,
          outcome: { ok: true, text: `ordering sentinel ${responseNumber}` },
          duration_ms: 1,
        } satisfies AgentToHub),
      );
    });

    ws.send(
      JSON.stringify({
        type: "result",
        request_id: requestId,
        outcome: { ok: false, code: "internal", message: "stale late result" },
        duration_ms: 2,
      } satisfies AgentToHub),
    );
    const sentinel = await call(client, "read_file", {
      machine: "alpha",
      path: nodePath.join(h.agents.alpha.root, "sentinel.txt"),
    });
    expect(sentinel.structuredContent?.state).toBe("completed");

    const row = h.store.getRequest(requestId);
    expect(row?.state).toBe("completed");
    expect(row?.error_code).toBeNull();
    expect(row?.outcome_json).toBe(originalOutcome);
  } finally {
    ws?.terminate();
    await h.cleanup();
  }
});

test("hub restart during an in-flight call recovers the correct terminal result", async () => {
  const h = await makeHarness(["alpha"]);
  let gate: string | undefined;
  let jobId: string | undefined;
  try {
    await h.startAgent("alpha");
    const client = await h.client();
    const marker = nodePath.join(h.agents.alpha.root, "hub-restart.txt");
    gate = nodePath.join(h.agents.alpha.root, "release-hub-restart");
    const started = nodePath.join(h.agents.alpha.root, "hub-restart-started");
    const pending = call(client, "run_command", {
      machine: "alpha",
      command: `printf 'started\\n' > ${JSON.stringify(started)}; barrier_tries=0; while [ ! -f ${JSON.stringify(gate)} ] && [ "$barrier_tries" -lt 200 ]; do sleep 0.05; barrier_tries=$((barrier_tries + 1)); done; [ -f ${JSON.stringify(gate)} ] || exit 124; printf 'survived\\n' >> ${JSON.stringify(marker)}; printf 'finished\\n'`,
      cwd: h.agents.alpha.root,
      wait_seconds: 5,
      idempotency_key: "hub-restart-edge-0001",
    }).catch(() => null);

    const row = await waitFor(async () => {
      const candidate = h.store.recentRequests(10).find((request) => request.tool === "run_command");
      return candidate?.state === "accepted" ? candidate : null;
    });
    const resultFile = nodePath.join(h.agents.alpha.stateDir, "results", `${row.request_id}.json`);
    const cached = await waitFor(async () => {
      const value = JSON.parse(await readFile(resultFile, "utf8")) as { job_id?: string };
      return value.job_id ? value : null;
    });
    jobId = cached.job_id;
    await waitFor(async () => readFile(started, "utf8").then(() => true).catch(() => false));
    await h.restartHub();
    await writeFile(gate, "release\n");
    await pending;

    const terminal = await waitFor(async () => {
      const current = h.store.getRequest(row.request_id);
      return current?.state === "completed" ? current : null;
    }, 10_000, 25);
    expect(terminal.state).toBe("completed");
    expect(JSON.parse(terminal.outcome_json!)).toMatchObject({ ok: true, text: expect.stringContaining("finished") });
    expect(await readFile(marker, "utf8")).toBe("survived\n");
  } finally {
    await releaseAndSettleJob(h, "alpha", gate, jobId);
    await h.cleanup();
  }
});

test("same-key retry after not_dispatched executes exactly once", async () => {
  const h = await makeHarness(["alpha"]);
  try {
    await h.startAgent("alpha");
    const marker = nodePath.join(h.agents.alpha.root, "retry-once.txt");
    await h.agents.alpha.agent.stop();
    await waitFor(async () => !h.hub.registry.isConnected("alpha"), 3_000, 10);
    const client = await h.client();
    const args = {
      machine: "alpha",
      path: marker,
      content: "once\n",
      mode: "append",
      idempotency_key: "not-dispatched-retry-0001",
    };

    const unavailable = await call(client, "write_file", args);
    expect(unavailable.structuredContent?.state).toBe("not_dispatched");

    await h.startAgent("alpha");
    const executed = await call(client, "write_file", args);
    const replayed = await call(client, "write_file", args);

    expect(executed.structuredContent?.state).toBe("completed");
    expect(executed.structuredContent?.request_id).not.toBe(unavailable.structuredContent?.request_id);
    expect(replayed.structuredContent).toMatchObject({
      state: "completed",
      replayed: true,
      request_id: executed.structuredContent?.request_id,
    });
    expect(h.store.getRequest(unavailable.structuredContent?.request_id as string)?.idempotency_key).toBeNull();
    expect(await readFile(marker, "utf8")).toBe("once\n");
  } finally {
    await h.cleanup();
  }
});
