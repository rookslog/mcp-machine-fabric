import { readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL, call, makeHarness, text, waitFor, type Harness } from "./helpers.js";

/**
 * End-to-end: real hub HTTP server, real MCP SDK client over Streamable HTTP,
 * real agents over WebSocket executing real file and process operations.
 */
describe("hub + agents end to end", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness(["alpha", "beta", "gamma"], { owner: ALL, reader: ["fabric:read"] });
    await h.startAgent("alpha");
    await h.startAgent("beta");
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("advertises tools with a machine argument and safety annotations", async () => {
    const c = await h.client();
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_machines", "read_file", "write_file", "run_command", "read_job_output", "get_request_status"]));
    const write = tools.find((t) => t.name === "write_file")!;
    expect(write.annotations?.readOnlyHint).toBe(false);
    expect(write.annotations?.destructiveHint).toBe(true);
    expect((write.inputSchema.properties as any).machine.enum).toEqual(["alpha", "beta", "gamma"]);
    expect(tools.find((t) => t.name === "read_file")!.annotations?.readOnlyHint).toBe(true);
  });

  it("reports layered health truthfully, including an enrolled-but-offline machine", async () => {
    const c = await h.client();
    const r = await call(c, "list_machines", {});
    const ms = r.structuredContent!.machines as any[];
    const by = Object.fromEntries(ms.map((m) => [m.machine, m]));
    expect(by.alpha.ready).toBe(true);
    expect(by.alpha.agent.policy.roots).toEqual([h.agents.alpha.root]);
    expect(by.gamma.ready).toBe(false);
    expect(by.gamma.reason).toBe("agent not connected");
    expect(text(r)).toMatch(/gamma: NOT READY/);
  });

  it("routes file operations to the right machine", async () => {
    const c = await h.client();
    const fa = nodePath.join(h.agents.alpha.root, "a.txt");
    const fb = nodePath.join(h.agents.beta.root, "b.txt");
    expect((await call(c, "write_file", { machine: "alpha", path: fa, content: "from alpha\n" })).isError).toBeFalsy();
    expect((await call(c, "write_file", { machine: "beta", path: fb, content: "from beta\n" })).isError).toBeFalsy();
    expect(await readFile(fa, "utf8")).toBe("from alpha\n");
    const rb = await call(c, "read_file", { machine: "beta", path: fb });
    expect(text(rb)).toContain("from beta");
    // Clients that render only structuredContent must still see the payload.
    expect(rb.structuredContent!.text).toContain("from beta");
    // alpha's policy root does not include beta's directory
    const cross = await call(c, "read_file", { machine: "alpha", path: fb });
    expect(cross.isError).toBe(true);
    expect(cross.structuredContent!.error_code).toBe("policy_denied");
  });

  it("runs commands, and a command outliving the wait becomes a pollable job", async () => {
    const c = await h.client();
    const quick = await call(c, "run_command", { machine: "alpha", command: "echo hello; exit 3", cwd: h.agents.alpha.root });
    expect(quick.structuredContent!.exit_code).toBe(3);
    expect(text(quick)).toContain("hello");

    const slow = await call(c, "run_command", { machine: "alpha", command: "echo start; sleep 1.5; echo end", wait_seconds: 0.3, cwd: h.agents.alpha.root });
    expect(slow.isError).toBeFalsy();
    expect(slow.structuredContent!.status).toBe("running");
    const jobId = slow.structuredContent!.job_id as string;
    const done = await call(c, "read_job_output", { machine: "alpha", job_id: jobId, cursor: 0, wait_seconds: 5 });
    const fin = await waitFor(async () => {
      const r = await call(c, "read_job_output", { machine: "alpha", job_id: jobId, cursor: 0, wait_seconds: 2 });
      return r.structuredContent!.job.status === "exited" ? r : null;
    });
    expect(text(fin)).toContain("start");
    expect(text(fin)).toContain("end");
    expect(fin.structuredContent!.job.exit_code).toBe(0);
    expect(done.isError).toBeFalsy();
  });

  it("refuses to dispatch to an offline machine and says it is safe to retry", async () => {
    const c = await h.client();
    const r = await call(c, "run_command", { machine: "gamma", command: "true" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent!.state).toBe("not_dispatched");
    expect(text(r)).toMatch(/safe to retry/);
    const st = await call(c, "get_request_status", { request_id: r.structuredContent!.request_id });
    expect(st.structuredContent!.state).toBe("not_dispatched");
  });

  it("idempotency keys prevent duplicate side effects on retry", async () => {
    const c = await h.client();
    const f = nodePath.join(h.agents.alpha.root, "log.txt");
    const args = { machine: "alpha", path: f, content: "line\n", mode: "append", idempotency_key: "retry-key-0001" };
    const first = await call(c, "write_file", args);
    const second = await call(c, "write_file", args);
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(second.structuredContent!.replayed).toBe(true);
    expect(second.structuredContent!.request_id).toBe(first.structuredContent!.request_id);
    expect(await readFile(f, "utf8")).toBe("line\n");
  });

  it("enforces OAuth scopes at the hub", async () => {
    const reader = await h.client("reader");
    const f = nodePath.join(h.agents.alpha.root, "x.txt");
    await writeFile(f, "readable\n");
    expect(text(await call(reader, "read_file", { machine: "alpha", path: f }))).toContain("readable");
    const w = await call(reader, "write_file", { machine: "alpha", path: f, content: "nope" });
    expect(w.isError).toBe(true);
    expect(w.structuredContent!.error_code).toBe("policy_denied");
    const x = await call(reader, "run_command", { machine: "alpha", command: "touch should-not-exist" });
    expect(x.isError).toBe(true);
    expect(await readFile(f, "utf8")).toBe("readable\n");
  });

  it("rejects unauthenticated MCP and agent connections", async () => {
    const res = await fetch(`${h.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    const bad = await fetch(`${h.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: "{}" });
    expect(bad.status).toBe(401);
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/agent`, { headers: { Authorization: "Bearer mmf_dev_forged" } });
      ws.on("unexpected-response", (_q, r) => resolve(r.statusCode ?? 0));
      ws.on("open", () => resolve(101));
      ws.on("error", () => {});
    });
    expect(status).toBe(401);
  });

  it("recovers the true outcome of a call whose connection dropped mid-flight", async () => {
    const c = await h.client();
    const marker = nodePath.join(h.agents.alpha.root, "ran.txt");
    const pending = call(c, "run_command", {
      machine: "alpha",
      command: `sleep 0.8; echo once >> ${JSON.stringify(marker)}; echo finished`,
      wait_seconds: 5,
      cwd: h.agents.alpha.root,
      idempotency_key: "drop-test-0001",
    });
    await new Promise((r) => setTimeout(r, 300));
    h.agents.alpha.agent.dropConnection();
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.structuredContent!.state).toBe("dispatched_unknown");
    const id = r.structuredContent!.request_id as string;
    // Agent reconnects on its own; the hub asks it what happened.
    const st = await waitFor(async () => {
      const s = await call(c, "get_request_status", { request_id: id });
      return s.structuredContent!.state === "completed" ? s : null;
    }, 15_000, 200);
    expect(text(st)).toContain("finished");
    // Retrying with the same key returns the recorded outcome, not a second run.
    const again = await call(c, "run_command", {
      machine: "alpha",
      command: `sleep 0.8; echo once >> ${JSON.stringify(marker)}; echo finished`,
      wait_seconds: 5,
      idempotency_key: "drop-test-0001",
    });
    expect(again.structuredContent!.replayed).toBe(true);
    expect(await readFile(marker, "utf8")).toBe("once\n");
  });

  it("survives a hub restart: in-flight call is recovered after agents reconnect", async () => {
    const c = await h.client();
    const pending = call(c, "run_command", { machine: "beta", command: "sleep 0.8; echo survived", wait_seconds: 5 }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 300));
    const inflight = h.store.recentRequests(5).find((r) => r.tool === "run_command")!;
    await h.restartHub();
    await pending;
    expect(h.store.getRequest(inflight.request_id)!.state).toBe("dispatched_unknown");
    const c2 = await h.client();
    const st = await waitFor(async () => {
      const s = await call(c2, "get_request_status", { request_id: inflight.request_id });
      return s.structuredContent!.state === "completed" ? s : null;
    }, 15_000, 200);
    expect(text(st)).toContain("survived");
  });

  it("agent-side read-only policy holds even for a fully scoped client", async () => {
    await h.agents.beta.agent.stop();
    await h.startAgent("beta", { readOnly: true });
    const c = await h.client();
    const f = nodePath.join(h.agents.beta.root, "ro.txt");
    const w = await call(c, "write_file", { machine: "beta", path: f, content: "x" });
    expect(w.isError).toBe(true);
    expect(w.structuredContent!.error_code).toBe("policy_denied");
    const x = await call(c, "run_command", { machine: "beta", command: "echo hi" });
    expect(x.structuredContent!.error_code).toBe("policy_denied");
  });

  it("records an audit trail with summarized arguments", async () => {
    const c = await h.client();
    const big = "x".repeat(5000);
    await call(c, "write_file", { machine: "alpha", path: nodePath.join(h.agents.alpha.root, "big.txt"), content: big });
    const r = await call(c, "list_recent_requests", { limit: 5 });
    const req = (r.structuredContent!.requests as any[]).find((q) => q.tool === "write_file");
    expect(req.state).toBe("completed");
    expect(req.principal).toBe("test:owner");
    expect(req.args.content).toEqual({ sha256: expect.any(String), length: 5000 });
  });
});
