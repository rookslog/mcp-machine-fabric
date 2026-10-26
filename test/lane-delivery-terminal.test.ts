import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { AgentToHub } from "../src/shared/protocol.js";
import { call, makeHarness, waitFor } from "./helpers.js";

test("a recovered terminal outcome cannot be reopened by pending-call disconnect cleanup", async () => {
  const h = await makeHarness(["alpha"]);
  try {
    const agent = await h.startAgent("alpha");
    const internal = agent as unknown as { send(frame: AgentToHub): void };
    const send = internal.send.bind(agent);
    let id = "";
    // Model an owning agent's out-of-sequence recovered frame, carrying its
    // actual completed outcome. Neither outcome nor side effect is fabricated.
    vi.spyOn(internal, "send").mockImplementation((frame) => {
      if (frame.type === "result") {
        id = frame.request_id;
        send({ type: "recovered", request_id: frame.request_id, state: frame.outcome.ok ? "completed" : "failed", outcome: frame.outcome });
      } else send(frame);
    });
    const client = await h.client();
    const marker = path.join(h.agents.alpha.root, "terminal.txt");
    const pending = call(client, "write_file", { machine: "alpha", path: marker, content: "once\n", mode: "append", idempotency_key: "lane-terminal-monotonic" });
    await waitFor(async () => id && h.store.getRequest(id)?.state === "completed");
    const terminalOutcome = h.store.getRequest(id)?.outcome_json;
    expect(await readFile(marker, "utf8")).toBe("once\n");
    await agent.stop();
    const response = await pending;
    expect.soft(h.store.getRequest(id)?.state, "disconnect must preserve the already-recorded terminal outcome").toBe("completed");
    expect.soft(h.store.getRequest(id)?.outcome_json).toBe(terminalOutcome);
    expect.soft(response.structuredContent?.state, "a recovered terminal outcome must settle the pending caller").toBe("completed");
  } finally {
    vi.restoreAllMocks();
    await h.cleanup();
  }
});
