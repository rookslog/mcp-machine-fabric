#!/usr/bin/env node
// Live end-to-end check against a deployed hub, using the official MCP SDK
// client over Streamable HTTP — the same path ChatGPT/Claude/Codex use.
//
//   MMF_TOKEN=mmf_pat_… node scripts/live-check.mjs --url http://hub:8787/mcp [--machine apollo ...]
//
// For each machine: health, write/read/edit in a scratch dir, a command, a job
// that outlives the call, request-status lookup, idempotent replay, cleanup.
// Prints one line per check and exits non-zero on any failure.
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { values } = parseArgs({ options: { url: { type: "string" }, machine: { type: "string", multiple: true } } });
const token = process.env.MMF_TOKEN;
if (!values.url || !token) {
  console.error("usage: MMF_TOKEN=… live-check.mjs --url URL [--machine NAME ...]");
  process.exit(2);
}

const client = new Client({ name: "mmf-live-check", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(values.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
let failures = 0;
const t = (r) => r.content.map((c) => c.text ?? "").join("\n");
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    console.log(`PASS ${name} (${Date.now() - t0} ms)${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name} (${Date.now() - t0} ms) — ${err.message}`);
  }
}
const call = async (name, args) => client.callTool({ name, arguments: args });
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const health = (await call("list_machines", {})).structuredContent.machines;
console.log(t(await call("list_machines", {})));
const machines = values.machine ?? health.filter((m) => m.ready).map((m) => m.machine);
const stamp = Date.now().toString(36);

for (const m of machines) {
  const h = health.find((x) => x.machine === m);
  await check(`${m}: ready`, async () => {
    must(h?.ready, `not ready: ${h?.reason}`);
    return `${h.agent.platform}/${h.agent.arch} rtt=${h.heartbeat_rtt_ms}ms`;
  });
  if (!h?.ready) continue;
  const home = h.agent.policy.roots[0];
  const dir = `${home}/.cache/mmf-live-check-${stamp}`;
  const file = `${dir}/probe.txt`;
  await check(`${m}: write_file`, async () => {
    const r = await call("write_file", { machine: m, path: file, content: "alpha\nbeta\n" });
    must(!r.isError, t(r));
  });
  await check(`${m}: read_file`, async () => {
    const r = await call("read_file", { machine: m, path: file });
    must(!r.isError && t(r).includes("beta"), t(r));
  });
  await check(`${m}: edit_file`, async () => {
    const r = await call("edit_file", { machine: m, path: file, old_text: "beta", new_text: "gamma" });
    must(!r.isError, t(r));
    const back = await call("read_file", { machine: m, path: file });
    must(t(back).includes("gamma"), t(back));
  });
  await check(`${m}: search_files`, async () => {
    const r = await call("search_files", { machine: m, path: dir, content_regex: "gam+a" });
    const hits = r.structuredContent.matches ?? [];
    must(!r.isError && hits.some((x) => String(x.path).endsWith("probe.txt")), t(r));
    must(t(r).includes("probe.txt"), `match paths missing from text content: ${t(r)}`);
    return `engine=${r.structuredContent.engine}`;
  });
  await check(`${m}: run_command`, async () => {
    const r = await call("run_command", { machine: m, command: "uname -sn; echo $((6*7))", cwd: dir });
    must(!r.isError && r.structuredContent.exit_code === 0 && t(r).includes("42"), t(r));
    return t(r).split("\n")[1];
  });
  let jobId;
  await check(`${m}: run_command outliving its wait becomes a job`, async () => {
    const r = await call("run_command", { machine: m, command: "echo begin; sleep 3; echo end", cwd: dir, wait_seconds: 1 });
    must(r.structuredContent.status === "running" && r.structuredContent.job_id, t(r));
    jobId = r.structuredContent.job_id;
    let cursor = r.structuredContent.next_cursor;
    let rec = { status: "running" };
    for (let i = 0; i < 20 && rec.status === "running"; i++) {
      const step = await call("read_job_output", { machine: m, job_id: jobId, cursor, wait_seconds: 5 });
      rec = step.structuredContent.job;
      cursor = step.structuredContent.next_cursor;
    }
    const out = await call("read_job_output", { machine: m, job_id: jobId, cursor: 0 });
    must(rec.status === "exited" && t(out).includes("end"), t(out));
    return jobId;
  });
  await check(`${m}: get_request_status`, async () => {
    const r = await call("read_file", { machine: m, path: file });
    const s = await call("get_request_status", { request_id: r.structuredContent.request_id });
    must(s.structuredContent.state === "completed", t(s));
  });
  await check(`${m}: idempotent replay`, async () => {
    const args = { machine: m, path: `${dir}/append.txt`, content: "x\n", mode: "append", idempotency_key: `live-${stamp}-${m}` };
    await call("write_file", args);
    const second = await call("write_file", args);
    must(second.structuredContent.replayed === true, t(second));
    const back = await call("read_file", { machine: m, path: `${dir}/append.txt` });
    must(t(back).split("\n").filter((l) => l === "x").length === 1, t(back));
  });
  await check(`${m}: cleanup`, async () => {
    const r = await call("run_command", { machine: m, command: `rm -rf ${JSON.stringify(dir)}` });
    must(!r.isError && r.structuredContent.exit_code === 0, t(r));
  });
}

await client.close();
console.log(failures ? `${failures} check(s) FAILED` : "all checks passed");
process.exit(failures ? 1 : 0);
