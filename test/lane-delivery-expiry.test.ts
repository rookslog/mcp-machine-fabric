import { readFile, utimes } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { newRequestId } from "../src/hub/store.js";
import type { AgentToHub } from "../src/shared/protocol.js";
import { call, makeHarness, waitFor } from "./helpers.js";

test("an acknowledged append whose result expired must retain its key across hub restart", async () => {
  const h = await makeHarness(["alpha"]);
  try {
    const agent = await h.startAgent("alpha");
    const internal = agent as unknown as { send(frame: AgentToHub): void };
    const send = internal.send.bind(agent);
    let resultId = "";
    let intercepted!: () => void;
    const resultDropped = new Promise<void>((resolve) => { intercepted = resolve; });
    // Model a lost result frame, preserving the real durable record and accepted ack.
    vi.spyOn(internal, "send").mockImplementation((frame) => {
      if (frame.type === "result") {
        resultId = frame.request_id;
        intercepted();
      } else send(frame);
    });
    const client = await h.client();
    const marker = path.join(h.agents.alpha.root, "expiry-append.txt");
    const args = { machine: "alpha", path: marker, content: "once\n", mode: "append", idempotency_key: "lane-expired-result" };
    const first = call(client, "write_file", args);
    await resultDropped;
    await waitFor(async () => h.store.getRequest(resultId)?.state === "accepted");
    expect(await readFile(marker, "utf8")).toBe("once\n");
    await agent.stop();
    expect((await first).structuredContent?.state).toBe("dispatched_unknown");

    // Age the completed record, rather than waiting 25 hours. Startup uses real prune().
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    await utimes(path.join(h.agents.alpha.stateDir, "results", `${resultId}.json`), old, old);
    await h.restartHub();
    const replacement = new Agent({ hubUrl: h.url.replace(/^http/, "ws") + "/agent", token: h.agents.alpha.token, stateDir: h.agents.alpha.stateDir, policy: agent.executor.policy });
    const replacementInternal = replacement as unknown as { send(frame: AgentToHub): void };
    const replacementSend = replacementInternal.send.bind(replacement);
    let recoveredSent!: () => void;
    const recoverySent = new Promise<void>((resolve) => { recoveredSent = resolve; });
    vi.spyOn(replacementInternal, "send").mockImplementation((frame) => {
      replacementSend(frame);
      if (frame.type === "recovered" && frame.request_id === resultId) recoveredSent();
    });
    h.agents.alpha.agent = replacement;
    await replacement.start();
    await replacement.waitConnected();
    await recoverySent;
    // A same-socket ordering sentinel ensures the real recovery reached the ledger.
    const sentinel = newRequestId();
    h.store.createRequest({ request_id: sentinel, machine: "alpha", tool: "read_file", effect: "read", principal: "test:owner", idempotency_key: null, args_summary: "{}", state: "dispatched_unknown" });
    h.store.recordRoute(sentinel, replacement.info().state_id!);
    replacementInternal.send({ type: "result", request_id: sentinel, outcome: { ok: true, text: "ordering sentinel" }, duration_ms: 1 });
    await waitFor(async () => h.store.getRequest(sentinel)?.state === "completed");
    const recovered = h.store.getRequest(resultId)!;
    const retryClient = await h.client();
    const retries = await Promise.all([call(retryClient, "write_file", args), call(retryClient, "write_file", args)]);

    expect.soft(recovered.state, "a recorded accepted ack must survive cache expiry").toBe("dispatched_unknown");
    expect.soft(recovered.error_code).not.toBe("never_received");
    expect.soft(retries.map((r) => r.structuredContent?.request_id)).toEqual([resultId, resultId]);
    expect.soft(await readFile(marker, "utf8"), "same-key retries must not append again").toBe("once\n");
  } finally {
    vi.restoreAllMocks();
    await h.cleanup();
  }
});
