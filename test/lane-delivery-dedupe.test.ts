import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { expect, test, vi } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { normalizePolicy } from "../src/agent/policy.js";
import type { ResultCache } from "../src/agent/result-cache.js";
import type { HubToAgent } from "../src/shared/protocol.js";
import { waitFor } from "./helpers.js";

test("concurrent delivery of the same request id executes an append once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mmf-lane-dedupe-"));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let agent: Agent | undefined;
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address === "string") throw new Error("expected TCP server");
    let peer!: WebSocket;
    let results = 0;
    server.on("connection", (socket) => {
      peer = socket;
      socket.on("message", (raw) => { if (JSON.parse(raw.toString()).type === "result") results++; });
      socket.send(JSON.stringify({ type: "welcome", machine: "alpha", hub_version: "test", protocol_version: 1 } satisfies HubToAgent));
    });
    agent = new Agent({ hubUrl: `ws://127.0.0.1:${address.port}/agent`, token: "fixture", stateDir: path.join(dir, "state"), policy: await normalizePolicy({ roots: [dir] }) });
    await agent.start();
    await agent.waitConnected();
    const cache = (agent as unknown as { cache: ResultCache }).cache;
    const get = cache.get.bind(cache);
    // Delay only real cache misses to expose the ordinary get()/begin() interleaving.
    // No return values are fabricated; a serialized check-and-claim would still pass.
    vi.spyOn(cache, "get").mockImplementation(async (id) => {
      const record = await get(id);
      if (!record) await new Promise((resolve) => setTimeout(resolve, 50));
      return record;
    });
    const marker = path.join(dir, "duplicate.txt");
    const frame: HubToAgent = { type: "call", request_id: "r_abc_123456abcdef", tool: "write_file", args: { path: marker, content: "once\n", mode: "append" }, deadline_ms: 30_000 };
    peer.send(JSON.stringify(frame));
    peer.send(JSON.stringify(frame));
    await waitFor(async () => results > 0 && agent!.executor.active === 0);
    expect(await readFile(marker, "utf8")).toBe("once\n");
  } finally {
    vi.restoreAllMocks();
    await agent?.stop();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("a duplicate re-acks its durable claim while the original executor is still running", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mmf-duplicate-ack-"));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let agent: Agent | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address === "string") throw new Error("expected TCP server");
    let peer!: WebSocket;
    let accepted = 0, results = 0;
    server.on("connection", (socket) => {
      peer = socket;
      socket.on("message", (raw) => { const frame = JSON.parse(raw.toString()); if (frame.type === "accepted") accepted++; if (frame.type === "result") results++; });
      socket.send(JSON.stringify({ type: "welcome", machine: "alpha", hub_version: "test", protocol_version: 1 }));
    });
    agent = new Agent({ hubUrl: `ws://127.0.0.1:${address.port}/agent`, token: "fixture", stateDir: path.join(dir, "state"), policy: await normalizePolicy({ roots: [dir] }) });
    await agent.start();
    await agent.waitConnected();
    const execute = agent.executor.execute.bind(agent.executor);
    let executing!: () => void;
    const started = new Promise<void>((resolve) => { executing = resolve; });
    vi.spyOn(agent.executor, "execute").mockImplementation(async (...args) => { executing(); await gate; return execute(...args); });
    const marker = path.join(dir, "duplicate-ack.txt");
    const frame: HubToAgent = { type: "call", request_id: "r_def_123456abcdef", tool: "write_file", args: { path: marker, content: "once\n", mode: "append" }, deadline_ms: 30_000 };
    peer.send(JSON.stringify(frame));
    await started;
    peer.send(JSON.stringify(frame));
    await waitFor(async () => accepted >= 2, 1000, 10).catch(() => null);
    expect(accepted, "the duplicate should acknowledge the durable receipt before execution completes").toBe(2);
    expect(results).toBe(0);
    release();
    await waitFor(async () => results > 0 && agent!.executor.active === 0);
    expect(await readFile(marker, "utf8")).toBe("once\n");
  } finally {
    release();
    await agent?.stop();
    vi.restoreAllMocks();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
