import WebSocket from "ws";
import { expect, test } from "vitest";
import type { AgentToHub } from "../src/shared/protocol.js";
import { newRequestId } from "../src/hub/store.js";
import { makeHarness, waitFor } from "./helpers.js";

test.each([
  ["result", "different"], ["recovered-completed", "different"], ["recovered-running", "different"], ["recovered-failed", "different"],
  ["result", "missing"], ["recovered-completed", "missing"], ["recovered-running", "missing"], ["recovered-failed", "missing"],
] as const)(
  "%s with a %s state directory route must not update the original request",
  async (kind, route) => {
    const h = await makeHarness(["alpha"]);
    let ws: WebSocket | undefined;
    try {
      const agent = await h.startAgent("alpha");
      const info = { ...agent.info(), hostname: "fixture", state_id: "s_replacement_directory" };
      const originalState = agent.info().state_id!;
      await agent.stop();
      const target = newRequestId();
      const sentinel = newRequestId();
      for (const id of [target, sentinel]) {
        h.store.createRequest({ request_id: id, machine: "alpha", tool: "write_file", effect: "write", principal: "test:owner", idempotency_key: null, args_summary: "{}", state: "dispatched_unknown" });
        if (id !== target || route !== "missing") h.store.recordRoute(id, id === target ? originalState : info.state_id);
      }
      ws = new WebSocket(`${h.url.replace(/^http/, "ws")}/agent`, { headers: { Authorization: `Bearer ${h.agents.alpha.token}` } });
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "ping") ws!.send(JSON.stringify({ type: "pong", nonce: msg.nonce }));
      });
      await new Promise<void>((resolve, reject) => { ws!.once("open", resolve); ws!.once("error", reject); });
      ws.send(JSON.stringify({ type: "hello", info } satisfies AgentToHub));
      await waitFor(async () => h.hub.registry.isConnected("alpha"));
      const outcome = kind === "recovered-failed" ? { ok: false as const, code: "internal" as const, message: "wrong directory failure" } : { ok: true as const, text: "answer from replacement directory" };
      const frame: AgentToHub = kind === "result"
        ? { type: "result", request_id: target, outcome, duration_ms: 1 }
        : kind === "recovered-completed"
          ? { type: "recovered", request_id: target, state: "completed", outcome }
          : kind === "recovered-failed"
            ? { type: "recovered", request_id: target, state: "failed", outcome }
            : { type: "recovered", request_id: target, state: "running" };
      ws.send(JSON.stringify(frame));
      ws.send(JSON.stringify({ type: "result", request_id: sentinel, outcome: { ok: true, text: "ordering sentinel" }, duration_ms: 1 } satisfies AgentToHub));
      await waitFor(async () => h.store.getRequest(sentinel)?.state === "completed");
      expect(h.store.getRequest(target)).toMatchObject({ state: "dispatched_unknown", outcome_json: null });
    } finally {
      ws?.terminate();
      await h.cleanup();
    }
  },
);
