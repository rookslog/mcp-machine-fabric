import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { expect, test } from "vitest";
import { ResultCache } from "../src/agent/result-cache.js";
import { HubStore, newRequestId } from "../src/hub/store.js";
import { makeHarness, waitFor } from "./helpers.js";

// Removing any SQL terminal guard lets a cleanup/ack/late outcome overwrite truth.
test.each(["completed", "failed", "not_dispatched"] as const)("store preserves terminal %s against every updater", (state) => {
  const store = new HubStore(":memory:");
  try {
    const id = newRequestId();
    store.createRequest({ request_id: id, machine: "alpha", tool: "write_file", effect: "write", principal: "test", idempotency_key: "key", args_summary: "{}", state });
    const before = store.getRequest(id);
    store.setState(id, "accepted");
    store.setState(id, "dispatched_unknown");
    store.finish(id, { ok: true, text: "different outcome" }, true);
    store.markNeverReceived(id);
    store.recordAcknowledgement(id);
    store.markInFlightUnknown();
    expect(store.getRequest(id)).toEqual(before);
  } finally { store.close(); }
});

test("first acknowledgement survives unknown transitions and database reopen", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mmf-ack-"));
  let store = new HubStore(dir);
  try {
    const id = newRequestId();
    store.createRequest({ request_id: id, machine: "alpha", tool: "write_file", effect: "write", principal: "test", idempotency_key: "key", args_summary: "{}", state: "dispatched" });
    store.setState(id, "accepted");
    const ack = (store.getRequest(id) as any).acked_at;
    expect(ack).toEqual(expect.any(Number));
    store.setState(id, "dispatched_unknown");
    store.close();
    store = new HubStore(dir);
    expect((store.getRequest(id) as any).acked_at).toBe(ack);
    store.setState(id, "accepted");
    expect((store.getRequest(id) as any).acked_at).toBe(ack);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

// Lost accepted frames make the horizon check independently necessary.
test.each(["missing", "invalid", "numeric", "expired", "current", "acked", "late-acked"])("unknown recovery with %s history only releases an unacked retained request", async (history) => {
  const h = await makeHarness(["alpha"]);
  let ws: WebSocket | undefined;
  try {
    const agent = await h.startAgent("alpha");
    const info = agent.info();
    await agent.stop();
    const target = newRequestId();
    const sentinel = newRequestId();
    for (const id of [target, sentinel]) {
      h.store.createRequest({ request_id: id, machine: "alpha", tool: "write_file", effect: "write", principal: "test", idempotency_key: id, args_summary: "{}", state: "dispatched_unknown" });
      h.store.recordRoute(id, info.state_id!);
    }
    if (history === "acked") {
      h.store.setState(target, "accepted");
      h.store.setState(target, "dispatched_unknown");
    }
    const created = h.store.getRequest(target)!.created_at;
    const retained_since = history === "missing" ? undefined : history === "invalid" ? "not-a-date" : history === "numeric" ? "1" : new Date(created + (history === "expired" ? 1 : -1)).toISOString();
    ws = new WebSocket(`${h.url.replace(/^http/, "ws")}/agent`, { headers: { Authorization: `Bearer ${h.agents.alpha.token}` } });
    ws.on("message", (raw) => { const f = JSON.parse(raw.toString()); if (f.type === "ping") ws!.send(JSON.stringify({ type: "pong", nonce: f.nonce })); });
    await new Promise<void>((resolve, reject) => { ws!.once("open", resolve); ws!.once("error", reject); });
    ws.send(JSON.stringify({ type: "hello", info }));
    if (history === "late-acked") ws.send(JSON.stringify({ type: "accepted", request_id: target }));
    ws.send(JSON.stringify({ type: "recovered", request_id: target, state: "unknown", retained_since }));
    ws.send(JSON.stringify({ type: "result", request_id: sentinel, outcome: { ok: true, text: "sentinel" }, duration_ms: 1 }));
    await waitFor(async () => h.store.getRequest(sentinel)?.state === "completed");
    expect(h.store.getRequest(target)?.state).toBe(history === "current" ? "not_dispatched" : "dispatched_unknown");
    expect(h.store.getRequest(target)?.idempotency_key).toBe(target);
  } finally { ws?.terminate(); await h.cleanup(); }
});

test("cache expiry persists a horizon and keeps running receipts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mmf-horizon-"));
  try {
    const cache = new ResultCache(dir, "run");
    await cache.init();
    const done = "r_a_000000000001", running = "r_a_000000000002";
    await cache.begin(done, "write_file");
    await cache.finish(done, "write_file", { ok: true, text: "once" });
    await cache.begin(running, "write_file");
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    for (const id of [done, running]) await utimes(path.join(dir, `${id}.json`), old, old);
    await cache.prune();
    expect(await cache.get(done)).toBeNull();
    expect(await cache.get(running)).toMatchObject({ state: "running" });
    const horizon = (cache as any).retainedSince;
    expect(Number.isFinite(Date.parse(horizon))).toBe(true);
    const reopened = new ResultCache(dir, "next-run");
    await reopened.init();
    expect(Date.parse((reopened as any).retainedSince)).toBeGreaterThanOrEqual(Date.parse(horizon));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each(["{", "null", "{}"])("unreadable receipt history %s cannot become a cache miss", async (content) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mmf-corrupt-cache-"));
  try {
    const cache = new ResultCache(dir, "run");
    await cache.init();
    await writeFile(path.join(dir, "r_a_000000000001.json"), content);
    await expect(cache.get("r_a_000000000001")).rejects.toThrow();
    expect(await readFile(path.join(dir, "r_a_000000000001.json"), "utf8")).toBe(content);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("legacy unresolved acknowledgement history migrates conservatively and survives reopen", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mmf-migrate-"));
  let store = new HubStore(dir);
  try {
    const ids = [newRequestId(), newRequestId(), newRequestId()];
    for (const [i, id] of ids.entries()) {
      store.createRequest({ request_id: id, machine: "alpha", tool: "write_file", effect: "write", principal: "test", idempotency_key: id, args_summary: "{}", state: ["accepted", "dispatched_unknown", "dispatched"][i] as any });
    }
    // Reconstruct the pre-change schema without using the new history fields.
    store.db.exec("ALTER TABLE requests DROP COLUMN acked_at; ALTER TABLE requests DROP COLUMN dispatched_at;");
    store.close();
    store = new HubStore(dir);
    for (const id of ids.slice(0, 2)) {
      expect((store.getRequest(id) as any).acked_at).toEqual(expect.any(Number));
      store.markNeverReceived(id);
      expect(store.getRequest(id)?.state).not.toBe("not_dispatched");
    }
    expect((store.getRequest(ids[2]) as any).acked_at).toBeNull();
    expect((store.getRequest(ids[2]) as any).dispatched_at).toBe(store.getRequest(ids[2])?.created_at);
    store.close();
    store = new HubStore(dir);
    expect((store.getRequest(ids[0]) as any).acked_at).toEqual(expect.any(Number));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
