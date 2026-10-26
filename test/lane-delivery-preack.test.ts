import { readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { Agent } from "../src/agent/agent.js";
import type { ResultCache } from "../src/agent/result-cache.js";
import { newRequestId } from "../src/hub/store.js";
import type { AgentToHub } from "../src/shared/protocol.js";
import { call, makeHarness, waitFor } from "./helpers.js";
import { startAgentProcess, killAgentProcess } from "./agent-process.js";
import type { ChildProcess } from "node:child_process";

test("a replacement sharing the state directory cannot attest non-receipt while the old process is recording", async () => {
  const h = await makeHarness(["alpha"]);
  let releaseBegin!: () => void;
  const beginGate = new Promise<void>((resolve) => { releaseBegin = resolve; });
  let oldFinished: Promise<void> | undefined;
  try {
    const old = await h.startAgent("alpha");
    const oldInternal = old as unknown as { cache: ResultCache; received: Set<string>; send(frame: AgentToHub): void };
    const begin = oldInternal.cache.begin.bind(oldInternal.cache);
    let observedBegin!: () => void;
    const beginning = new Promise<void>((resolve) => { observedBegin = resolve; });
    let requestId = "";
    vi.spyOn(oldInternal.cache, "begin").mockImplementation(async (id, tool) => {
      requestId = id;
      observedBegin();
      // Hold the actual disk operation at the exact pre-recording await boundary.
      await beginGate;
      await begin(id, tool);
    });
    const oldSend = oldInternal.send.bind(old);
    let observedFinish!: () => void;
    oldFinished = new Promise<void>((resolve) => { observedFinish = resolve; });
    vi.spyOn(oldInternal, "send").mockImplementation((frame) => {
      oldSend(frame);
      if (frame.type === "result") observedFinish();
    });
    const client = await h.client();
    const marker = path.join(h.agents.alpha.root, "preack-append.txt");
    const args = { machine: "alpha", path: marker, content: "once\n", mode: "append", idempotency_key: "lane-preack-overlap" };
    const first = call(client, "write_file", args);
    await beginning;
    expect(oldInternal.received.has(requestId)).toBe(true);
    expect(await oldInternal.cache.get(requestId)).toBeNull();

    const replacement = new Agent({ hubUrl: h.url.replace(/^http/, "ws") + "/agent", token: h.agents.alpha.token, stateDir: h.agents.alpha.stateDir, policy: old.executor.policy, minBackoffMs: 60_000 });
    const replacementInternal = replacement as unknown as { send(frame: AgentToHub): void };
    const send = replacementInternal.send.bind(replacement);
    let observedRecovery!: () => void;
    const recovered = new Promise<void>((resolve) => { observedRecovery = resolve; });
    vi.spyOn(replacementInternal, "send").mockImplementation((frame) => {
      send(frame);
      if (frame.type === "recovered" && frame.request_id === requestId) observedRecovery();
    });
    h.agents.alpha.agent = replacement;
    let refused: unknown;
    try { await replacement.start(); } catch (err) { refused = err; }
    if (refused) {
      expect(String(refused)).toMatch(/state directory.*lock/i);
      h.agents.alpha.agent = old;
      // stop closes the socket but must keep ownership until this handler drains.
      const stopping = old.stop();
      expect((await first).structuredContent?.state).toBe("dispatched_unknown");
      await expect(replacement.start()).rejects.toThrow(/state directory.*lock/i);
      const recoveryRow = h.store.getRequest(requestId)!;
      const retry = await call(client, "write_file", args);
      releaseBegin();
      await oldFinished;
      await stopping;
      expect.soft(recoveryRow.state, "the replaced process still owns a received handler").not.toBe("not_dispatched");
      expect.soft(retry.structuredContent?.request_id).toBe(requestId);
      expect.soft(await readFile(marker, "utf8"), "the old handler and same-key retry must not both append").toBe("once\n");
      await replacement.start();
      h.agents.alpha.agent = replacement;
      await replacement.waitConnected();
      await waitFor(async () => h.store.getRequest(requestId)?.state === "completed");
      return;
    }
    await replacement.waitConnected();
    expect((await first).structuredContent?.state).toBe("dispatched_unknown");
    await old.stop(); // Prevent reconnect; stop does not cancel the outstanding handler.
    await recovered;
    const sentinel = newRequestId();
    h.store.createRequest({ request_id: sentinel, machine: "alpha", tool: "read_file", effect: "read", principal: "test:owner", idempotency_key: null, args_summary: "{}", state: "dispatched_unknown" });
    h.store.recordRoute(sentinel, replacement.info().state_id!);
    replacementInternal.send({ type: "result", request_id: sentinel, outcome: { ok: true, text: "ordering sentinel" }, duration_ms: 1 });
    await waitFor(async () => h.store.getRequest(sentinel)?.state === "completed");
    const recoveryRow = h.store.getRequest(requestId)!;
    const retry = await call(client, "write_file", args);
    releaseBegin();
    await oldFinished;

    expect.soft(recoveryRow.state, "the replaced process still owns a received handler").not.toBe("not_dispatched");
    expect.soft(retry.structuredContent?.request_id).toBe(requestId);
    expect.soft(await readFile(marker, "utf8"), "the old handler and same-key retry must not both append").toBe("once\n");
  } finally {
    releaseBegin();
    if (oldFinished) await oldFinished;
    vi.restoreAllMocks();
    await h.cleanup();
  }
});

test("state directory ownership excludes other processes and aliases, and refuses stale locks", async () => {
  const h = await makeHarness(["alpha"]);
  let child: ChildProcess | undefined;
  try {
    const old = await h.startAgent("alpha");
    const options = { hubUrl: h.url.replace(/^http/, "ws") + "/agent", token: h.agents.alpha.token, stateDir: h.agents.alpha.stateDir, policy: old.executor.policy };
    let refused: unknown;
    let unexpected: ChildProcess | undefined;
    try { unexpected = await startAgentProcess(options); } catch (err) { refused = err; }
    if (unexpected) await killAgentProcess(unexpected);
    expect(String(refused)).toMatch(/state directory.*lock/i);
    const alias = path.join(h.dir, "state-alias");
    await symlink(options.stateDir, alias, "dir");
    await expect(new Agent({ ...options, stateDir: alias }).start()).rejects.toThrow(/state directory.*lock/i);
    await old.stop();
    child = await startAgentProcess(options);
    await expect(new Agent(options).start()).rejects.toThrow(/live pid/);
    await killAgentProcess(child);
    await expect(new Agent(options).start()).rejects.toThrow(/dead pid/);
  } finally {
    if (child) await killAgentProcess(child);
    await h.cleanup();
  }
});
