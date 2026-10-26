import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { expect, test, vi } from "vitest";
import type { ResultCache } from "../src/agent/result-cache.js";
import { newRequestId } from "../src/hub/store.js";
import type { AgentToHub } from "../src/shared/protocol.js";
import { call, makeHarness, waitFor } from "./helpers.js";

test("concurrent retries of a genuinely not-dispatched key create one new execution", async () => {
  const h = await makeHarness(["alpha"]);
  try {
    const agent = await h.startAgent("alpha");
    await agent.stop();
    await waitFor(async () => !h.hub.registry.isConnected("alpha"));
    const client = await h.client();
    const marker = path.join(h.agents.alpha.root, "released-key.txt");
    const args = { machine: "alpha", path: marker, content: "once\n", mode: "append", idempotency_key: "lane-released-key" };
    const first = await call(client, "write_file", args);
    expect(first.structuredContent?.state).toBe("not_dispatched");
    expect(h.store.getRequest(first.structuredContent?.request_id as string)?.error_code).toBe("unavailable");
    await h.startAgent("alpha");
    const replies = await Promise.all(Array.from({ length: 16 }, () => call(client, "write_file", args)));
    const ids = new Set(replies.map((r) => r.structuredContent?.request_id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).not.toBe(first.structuredContent?.request_id);
    expect(await readFile(marker, "utf8")).toBe("once\n");
    expect(h.store.getRequest(first.structuredContent?.request_id as string)).toMatchObject({ state: "not_dispatched", idempotency_key: null });
    expect(h.store.getRequest([...ids][0] as string)?.state).toBe("completed");
  } finally { await h.cleanup(); }
});

test("probe frames cannot register, replace the live agent, or finalize its request", async () => {
  const h = await makeHarness(["alpha"]);
  let probe: WebSocket | undefined;
  try {
    const agent = await h.startAgent("alpha");
    await waitFor(async () => h.hub.registry.isConnected("alpha"));
    const before = h.hub.registry.health("alpha").connected_since;
    const id = newRequestId();
    h.store.createRequest({ request_id: id, machine: "alpha", tool: "read_file", effect: "read", principal: "test:owner", idempotency_key: null, args_summary: "{}", state: "dispatched_unknown" });
    h.store.recordRoute(id, agent.info().state_id!);
    probe = new WebSocket(`${h.url.replace(/^http/, "ws")}/agent?probe=1`, { headers: { Authorization: `Bearer ${h.agents.alpha.token}` } });
    let welcomedAsProbe = false;
    probe.on("message", (raw) => { const frame = JSON.parse(raw.toString()); welcomedAsProbe ||= frame.type === "welcome" && frame.probe === true && frame.machine === "alpha"; });
    const closed = new Promise<void>((resolve, reject) => { probe!.once("close", () => resolve()); probe!.once("error", reject); });
    probe.on("open", () => {
      probe!.send(JSON.stringify({ type: "hello", info: { ...agent.info(), hostname: "fixture" } } satisfies AgentToHub));
      probe!.send(JSON.stringify({ type: "result", request_id: id, outcome: { ok: true, text: "forged through probe" }, duration_ms: 1 } satisfies AgentToHub));
    });
    await closed;
    expect(welcomedAsProbe).toBe(true);
    expect(h.hub.registry.health("alpha").connected_since).toBe(before);
    expect(h.store.getRequest(id)).toMatchObject({ state: "dispatched_unknown", outcome_json: null });
    const file = path.join(h.agents.alpha.root, "live.txt");
    await writeFile(file, "live agent still answers\n");
    const client = await h.client();
    expect((await call(client, "read_file", { machine: "alpha", path: file })).structuredContent?.state).toBe("completed");
  } finally { probe?.terminate(); await h.cleanup(); }
});

test("same-process recovery before cache.begin completes reports running, never unknown", async () => {
  const h = await makeHarness(["alpha"]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let pending: ReturnType<typeof call> | undefined;
  try {
    const agent = await h.startAgent("alpha");
    const internal = agent as unknown as { cache: ResultCache; send(frame: AgentToHub): void; onMessage(raw: string): Promise<void> };
    const begin = internal.cache.begin.bind(internal.cache);
    let seen!: () => void;
    const beginning = new Promise<void>((resolve) => { seen = resolve; });
    let id = "";
    vi.spyOn(internal.cache, "begin").mockImplementation(async (requestId, tool) => { id = requestId; seen(); await gate; await begin(requestId, tool); });
    const replies: AgentToHub[] = [];
    const send = internal.send.bind(agent);
    vi.spyOn(internal, "send").mockImplementation((frame) => { replies.push(frame); send(frame); });
    const client = await h.client();
    const marker = path.join(h.agents.alpha.root, "guarded-receipt.txt");
    pending = call(client, "write_file", { machine: "alpha", path: marker, content: "once\n", mode: "append" });
    await beginning;
    await internal.onMessage(JSON.stringify({ type: "recover", request_ids: [id] }));
    expect(replies.filter((frame) => frame.type === "recovered")).toEqual([{ type: "recovered", request_id: id, state: "running" }]);
    release();
    expect((await pending).structuredContent?.state).toBe("completed");
    expect(await readFile(marker, "utf8")).toBe("once\n");
  } finally { release(); await pending; vi.restoreAllMocks(); await h.cleanup(); }
});
