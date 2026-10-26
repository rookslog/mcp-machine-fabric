// Lane REVIEW-AUTH finding: in the default agent layout (root = $HOME, state dir
// = $HOME/.local/state/mmf-agent) a fabric:read caller reads other principals'
// command output and call outcomes straight off the agent's state directory,
// bypassing both the per-principal audit filter and "job output requires
// fabric:exec". Expected to FAIL on e2c9e77.
import { mkdir, symlink, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { afterEach, expect, test } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { normalizePolicy } from "../src/agent/policy.js";
import { call, makeHarness, text, type Harness } from "./helpers.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.cleanup()));
});

test("a fabric:read caller cannot read another principal's command output from the agent state dir", async () => {
  const h = await makeHarness([], {
    writer: ["fabric:read", "fabric:write", "fabric:exec"],
    reader: ["fabric:read", "machine:alpha"],
  });
  harnesses.push(h);

  // Mirror `mmf agent` defaults: roots default to [homedir()], state dir to ~/.local/state/mmf-agent.
  const home = nodePath.join(h.dir, "home");
  await mkdir(home, { recursive: true });
  const stateDir = nodePath.join(home, ".local/state/mmf-agent");
  const { token } = h.store.addDevice("alpha");
  const tokenFile = nodePath.join(home, "custom-config/agent.token");
  await mkdir(nodePath.dirname(tokenFile));
  await writeFile(tokenFile, "private credential fixture");
  const policy = await normalizePolicy({ roots: [home] });
  const agent = new Agent({ hubUrl: `ws://127.0.0.1:${h.port}/agent`, token, policy, stateDir, tokenFile, minBackoffMs: 100, maxBackoffMs: 500 });
  await agent.start();
  await agent.waitConnected();
  h.agents.alpha = { agent, root: policy.roots[0], stateDir, token };

  const writer = await h.client("writer");
  const command = await call(writer, "run_command", { machine: "alpha", command: "echo TOPSECRET_$((6*7))" });
  expect(text(command)).toContain("TOPSECRET_42");

  const reader = await h.client("reader");
  // The supported path is closed (this is what the HIGH-1 regression test checks).
  const denied = await call(reader, "get_request_status", { request_id: command.structuredContent!.request_id });
  expect(text(denied)).not.toContain("TOPSECRET_42");

  // The bypass: enumerate the state dir with list_directory, then read_file each file.
  const listing = await call(reader, "list_directory", {
    machine: "alpha",
    path: nodePath.join(policy.roots[0], ".local/state/mmf-agent"),
    depth: 3,
    include_hidden: true,
  });
  const files = ((listing.structuredContent?.entries ?? []) as Array<{ path: string; type: string }>)
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.path);
  let leaked = "";
  for (const file of files) {
    const read = await call(reader, "read_file", { machine: "alpha", path: file });
    if (!read.isError && text(read).includes("TOPSECRET_42")) leaked += `${nodePath.relative(policy.roots[0], file)}\n`;
  }
  expect(listing.isError).toBe(true);
  await symlink(stateDir, nodePath.join(home, "state-alias"));
  await symlink(nodePath.dirname(tokenFile), nodePath.join(home, "config-alias"));
  for (const target of [tokenFile, nodePath.join(home, "config-alias/agent.token"), nodePath.join(home, "state-alias/state_id")]) {
    const out = await call(reader, "read_file", { machine: "alpha", path: target });
    expect(out.isError).toBe(true);
    expect(out.structuredContent).toMatchObject({ error_code: "policy_denied" });
  }
  const machines = await call(reader, "list_machines", {});
  expect(machines.structuredContent).toMatchObject({ machines: [expect.objectContaining({ agent: expect.objectContaining({ policy: expect.objectContaining({ deny_paths: expect.arrayContaining([stateDir, tokenFile, nodePath.dirname(tokenFile)]) }) }) })] });
  expect(leaked, `fabric:read caller read another principal's command output from:\n${leaked}`).toBe("");
}, 30_000);
