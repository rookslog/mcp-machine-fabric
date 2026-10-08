import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { FabricOAuthProvider, SCOPES, createOAuthRouter } from "../src/hub/oauth.js";
import { HubStore } from "../src/hub/store.js";
import { call, makeHarness, text, type Harness as McpHarness } from "./helpers.js";

const execFileAsync = promisify(execFile);
const OWNER_PASSPHRASE = "correct horse battery staple";
const VERIFIER = "a".repeat(64);
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build"], { cwd: process.cwd(), timeout: 30_000 });
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

test("PAT --machines stores machine scopes through the real CLI", async () => {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "mmf-machine-pat-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const store = new HubStore(dir);
  store.addDevice("alpha");
  store.addDevice("beta");
  store.close();

  const { stdout } = await execFileAsync(
    "node",
    ["dist/cli.js", "token", "create", "machine-client", "--machines", "alpha"],
    { cwd: process.cwd(), env: { ...process.env, MMF_DATA_DIR: dir }, timeout: 10_000 },
  );
  const token = stdout.match(/mmf_pat_[A-Za-z0-9_-]+/)?.[0];
  expect(token).toEqual(expect.any(String));

  const reopened = new HubStore(dir);
  const provider = new FabricOAuthProvider({
    db: reopened.db,
    mcpResourceUrl: "http://127.0.0.1:8787/mcp",
    listMachines: () => reopened.listDevices().filter((device) => !device.revoked_at).map((device) => device.name),
  });
  const auth = await provider.verifyAccessToken(token!);
  expect(auth.scopes).toEqual([...SCOPES, "machine:alpha"]);
  reopened.close();
});

describe("machine-scoped MCP grants", () => {
  test("filters tool schemas, health, calls, and API status while unrestricted grants remain compatible", async () => {
    const harness = await makeHarness(["alpha", "beta"], {
      restricted: ["fabric:read", "fabric:write", "fabric:exec", "machine:alpha"],
      peer: ["fabric:read", "fabric:write", "fabric:exec", "machine:alpha"],
      unrestricted: ["fabric:read", "fabric:write", "fabric:exec"],
    });
    cleanups.push(() => harness.cleanup());
    await harness.startAgent("alpha");
    await harness.startAgent("beta");

    const restricted = await harness.client("restricted");
    const tools = await restricted.listTools();
    const readFile = tools.tools.find((tool) => tool.name === "read_file")!;
    expect((readFile.inputSchema.properties as any).machine.enum).toEqual(["alpha"]);

    const machines = await call(restricted, "list_machines", {});
    expect((machines.structuredContent!.machines as Array<{ machine: string }>).map((machine) => machine.machine)).toEqual(["alpha"]);

    const forged = await call(restricted, "read_file", { machine: "beta", path: harness.agents.beta.root });
    expect(forged.isError).toBe(true);
    expect(forged.structuredContent).toMatchObject({ state: "not_dispatched", error_code: "policy_denied" });

    const allowed = await call(restricted, "run_command", { machine: "alpha", command: "echo alpha-ok" });
    expect(allowed.isError).toBeFalsy();
    expect(text(allowed)).toContain("alpha-ok");
    const allowedRequestId = allowed.structuredContent!.request_id as string;

    const peer = await harness.client("peer");
    const peerLookup = await call(peer, "get_request_status", { request_id: allowedRequestId });
    expect(peerLookup.isError).toBe(true);

    const peerRecent = await call(peer, "list_recent_requests", {});
    expect(peerRecent.structuredContent!.requests).toEqual([]);

    const status = await fetch(`${harness.url}/api/status`, {
      headers: { authorization: "Bearer restricted" },
    });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { machines: Array<{ machine: string }> }).machines.map((machine) => machine.machine)).toEqual(["alpha"]);

    const unrestricted = await harness.client("unrestricted");
    const ownerLookup = await call(unrestricted, "get_request_status", { request_id: allowedRequestId });
    expect(ownerLookup.isError).toBeFalsy();
    expect(text(ownerLookup)).toContain("alpha-ok");
    const allMachines = await call(unrestricted, "list_machines", {});
    expect((allMachines.structuredContent!.machines as Array<{ machine: string }>).map((machine) => machine.machine).sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });
});

interface OAuthHarness {
  baseUrl: string;
  db: DatabaseSync;
  provider: FabricOAuthProvider;
  close(): Promise<void>;
}

async function makeOAuthHarness(): Promise<OAuthHarness> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, "close");
  const baseUrl = `http://127.0.0.1:${port}`;
  const db = new DatabaseSync(":memory:");
  const provider = new FabricOAuthProvider({
    db,
    mcpResourceUrl: `${baseUrl}/mcp`,
    listMachines: () => ["alpha", "beta"],
  });
  provider.setOwnerPassphrase(OWNER_PASSPHRASE);
  const app = express();
  app.use(createOAuthRouter({ provider, issuerUrl: new URL(baseUrl), mcpResourceUrl: new URL(`${baseUrl}/mcp`), resourceName: "Machine Fabric" }));
  const server = app.listen(port, "127.0.0.1");
  await once(server, "listening");
  const harness = {
    baseUrl,
    db,
    provider,
    async close() {
      server.close();
      await once(server, "close");
      db.close();
    },
  };
  cleanups.push(() => harness.close());
  return harness;
}

test("OAuth consent stores a selected machine and refresh cannot widen it", async () => {
  const harness = await makeOAuthHarness();
  const registration = await fetch(`${harness.baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
      client_name: "Machine-scoped OAuth client",
    }),
  });
  expect(registration.status).toBe(201);
  const clientId = ((await registration.json()) as { client_id: string }).client_id;

  const authorize = new URL("/authorize", harness.baseUrl);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("code_challenge", createHash("sha256").update(VERIFIER).digest("base64url"));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("scope", "fabric:read machine:alpha machine:missing");
  authorize.searchParams.set("resource", `${harness.baseUrl}/mcp`);
  const consent = await fetch(authorize, { redirect: "manual" });
  expect(consent.status).toBe(200);
  const html = await consent.text();
  const pendingId = html.match(/name="pending_id" value="([A-Za-z0-9_-]+)"/)?.[1];
  expect(pendingId).toEqual(expect.any(String));
  expect(html).toContain("<legend>Machines</legend>");
  expect(html).toMatch(/name="machine_mode" value="only" checked/);
  expect(html).toMatch(/name="machine" value="alpha" checked/);
  expect(html).toContain('name="machine" value="beta"');
  expect(html).not.toContain("machine:missing");

  const approvalBody = new URLSearchParams({
    pending_id: pendingId!,
    action: "approve",
    passphrase: OWNER_PASSPHRASE,
    scope: "fabric:read",
    machine_mode: "only",
    machine: "alpha",
  });
  const approval = await fetch(`${harness.baseUrl}/oauth/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: approvalBody,
    redirect: "manual",
  });
  expect(approval.status).toBe(302);
  const code = new URL(approval.headers.get("location")!).searchParams.get("code")!;

  const tokenResponse = await fetch(`${harness.baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: VERIFIER,
      redirect_uri: "http://127.0.0.1/callback",
      resource: `${harness.baseUrl}/mcp`,
    }),
  });
  expect(tokenResponse.status).toBe(200);
  const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string; scope: string };
  expect(tokens.scope).toBe("fabric:read machine:alpha");
  expect((await harness.provider.verifyAccessToken(tokens.access_token)).scopes).toEqual(["fabric:read", "machine:alpha"]);

  const widened = await fetch(`${harness.baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
      scope: "fabric:read machine:alpha machine:beta",
      resource: `${harness.baseUrl}/mcp`,
    }),
  });
  expect(widened.status).toBe(400);
  expect(await widened.json()).toMatchObject({ error: "invalid_scope" });

  const unrestricted = await fetch(`${harness.baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
      scope: "fabric:read",
      resource: `${harness.baseUrl}/mcp`,
    }),
  });
  expect(unrestricted.status).toBe(400);
  expect(await unrestricted.json()).toMatchObject({ error: "invalid_scope" });

  const refresh = await fetch(`${harness.baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
      resource: `${harness.baseUrl}/mcp`,
    }),
  });
  expect(refresh.status).toBe(200);
  expect(((await refresh.json()) as { scope: string }).scope).toBe("fabric:read machine:alpha");
});
