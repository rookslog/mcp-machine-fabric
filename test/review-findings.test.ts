import WebSocket from "ws";
import { afterEach, describe, expect, test } from "vitest";
import { parseFrame, type AgentToHub, type ToolOutcome } from "../src/shared/protocol.js";
import { newRequestId } from "../src/hub/store.js";
import { makeHarness, waitFor, type Harness } from "./helpers.js";

const harnesses = new Set<Harness>();
const sockets = new Set<WebSocket>();

async function harness(machines: string[], tokens: Record<string, string[]> = { owner: ["fabric:read", "fabric:write", "fabric:exec"] }) {
  const h = await makeHarness(machines, tokens);
  harnesses.add(h);
  return h;
}

async function authenticatedAgentSocket(h: Harness, machine: string): Promise<WebSocket> {
  await h.startAgent(machine);
  const enrolled = h.agents[machine];
  await enrolled.agent.stop();
  const ws = new WebSocket(`${h.url.replace(/^http/, "ws")}/agent`, {
    headers: { Authorization: `Bearer ${enrolled.token}` },
  });
  sockets.add(ws);
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as { type?: string; nonce?: string };
    if (message.type === "ping" && message.nonce) ws.send(JSON.stringify({ type: "pong", nonce: message.nonce }));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

function createUnknown(h: Harness, machine: string, requestId = newRequestId()): string {
  h.store.createRequest({
    request_id: requestId,
    machine,
    tool: "run_command",
    effect: "exec",
    principal: "test:owner",
    idempotency_key: null,
    args_summary: "{}",
    state: "dispatched_unknown",
  });
  return requestId;
}

function resultFrame(requestId: string, text: string): AgentToHub {
  const outcome: ToolOutcome = { ok: true, text };
  return { type: "result", request_id: requestId, outcome, duration_ms: 1 };
}

afterEach(async () => {
  for (const ws of sockets) ws.terminate();
  sockets.clear();
  await Promise.all([...harnesses].map((h) => h.cleanup()));
  harnesses.clear();
});

describe("delivery semantics", () => {
  test("a stale recovered-running frame cannot regress a terminal request", async () => {
    const h = await harness(["alpha"]);
    const ws = await authenticatedAgentSocket(h, "alpha");
    const target = createUnknown(h, "alpha");
    const sentinel = createUnknown(h, "alpha");

    ws.send(JSON.stringify(resultFrame(target, "completed first")));
    await waitFor(async () => h.store.getRequest(target)?.state === "completed");
    ws.send(JSON.stringify({ type: "recovered", request_id: target, state: "running" } satisfies AgentToHub));
    ws.send(JSON.stringify(resultFrame(sentinel, "ordering sentinel")));
    await waitFor(async () => h.store.getRequest(sentinel)?.state === "completed");

    expect(h.store.getRequest(target)?.state).toBe("completed");
  });
});

describe("security boundaries", () => {
  test("an authenticated agent cannot finalize another machine's request", async () => {
    const h = await harness(["alpha", "beta"]);
    const ws = await authenticatedAgentSocket(h, "alpha");
    const betaRequest = createUnknown(h, "beta");
    const sentinel = createUnknown(h, "alpha");

    ws.send(JSON.stringify(resultFrame(betaRequest, "forged by alpha")));
    ws.send(JSON.stringify(resultFrame(sentinel, "ordering sentinel")));
    await waitFor(async () => h.store.getRequest(sentinel)?.state === "completed");

    expect(h.store.getRequest(betaRequest)?.state).toBe("dispatched_unknown");
    expect(h.store.getRequest(betaRequest)?.outcome_json).toBeNull();
  });

  test("protocol parsing rejects structurally incomplete authenticated-agent frames", () => {
    expect(parseFrame<AgentToHub>(JSON.stringify({ type: "hello" }))).toBeNull();
    expect(parseFrame<AgentToHub>(JSON.stringify({ type: "result", request_id: "r_bad" }))).toBeNull();
  });

  test("unauthenticated malformed MCP bodies are rejected before JSON parsing", async () => {
    const h = await harness([]);
    const response = await fetch(`${h.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(401);
  });

  test("the requests API enforces its 500-row upper bound for negative limits", async () => {
    const h = await harness([]);
    for (let index = 0; index < 501; index++) {
      h.store.createRequest({
        request_id: newRequestId(),
        machine: "alpha",
        tool: "read_file",
        effect: "read",
        principal: "test:owner",
        idempotency_key: null,
        args_summary: "{}",
        state: "not_dispatched",
      });
    }

    const response = await fetch(`${h.url}/api/requests?limit=-1`, {
      headers: { Authorization: "Bearer owner" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { requests: unknown[] };
    expect(body.requests.length).toBeLessThanOrEqual(500);
  });
});
