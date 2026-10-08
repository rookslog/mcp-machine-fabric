import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { afterEach, describe, expect, test } from "vitest";

import { FabricOAuthProvider, bearerMiddleware, createOAuthRouter } from "../src/hub/oauth.js";
import { call, makeHarness, text, type Harness as McpHarness } from "./helpers.js";

const OWNER_PASSPHRASE = "correct horse battery staple";
const VERIFIER = "a".repeat(64);

interface OAuthHarness {
  baseUrl: string;
  db: DatabaseSync;
  provider: FabricOAuthProvider;
  setNow(value: number): void;
  close(): Promise<void>;
}

const oauthHarnesses: OAuthHarness[] = [];
const mcpHarnesses: McpHarness[] = [];

afterEach(async () => {
  await Promise.all(mcpHarnesses.splice(0).map((harness) => harness.cleanup()));
  await Promise.all(oauthHarnesses.splice(0).map((harness) => harness.close()));
});

async function makeOAuthHarness(initialNow = 1_800_000_000_000): Promise<OAuthHarness> {
  let now = initialNow;
  const db = new DatabaseSync(":memory:");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, "close");
  const baseUrl = `http://127.0.0.1:${port}`;
  const provider = new FabricOAuthProvider({
    db,
    mcpResourceUrl: `${baseUrl}/mcp`,
    now: () => now,
    listMachines: () => ["alpha", "beta"],
  });
  provider.setOwnerPassphrase(OWNER_PASSPHRASE);

  const app = express();
  app.set("trust proxy", "loopback");
  app.use(
    createOAuthRouter({
      provider,
      issuerUrl: new URL(baseUrl),
      mcpResourceUrl: new URL(`${baseUrl}/mcp`),
      resourceName: "Machine Fabric",
    }),
  );
  app.get("/mcp", bearerMiddleware(provider, `${baseUrl}/mcp`), (req, res) => {
    res.json({ clientId: req.auth?.clientId, scopes: req.auth?.scopes });
  });
  const server = app.listen(port, "127.0.0.1");
  await once(server, "listening");

  const harness: OAuthHarness = {
    baseUrl,
    db,
    provider,
    setNow(value) {
      now = value;
    },
    async close() {
      server.close();
      await once(server, "close");
      db.close();
    },
  };
  oauthHarnesses.push(harness);
  return harness;
}

async function registerClient(
  harness: OAuthHarness,
  overrides: Record<string, unknown> = {},
): Promise<{ response: Response; body: Record<string, any> }> {
  const response = await fetch(`${harness.baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
      client_name: "Security regression client",
      ...overrides,
    }),
  });
  return { response, body: (await response.json()) as Record<string, any> };
}

function challenge(): string {
  return createHash("sha256").update(VERIFIER).digest("base64url");
}

async function beginAuthorization(
  harness: OAuthHarness,
  clientId: string,
  options: { redirectUri?: string; scope?: string; method?: string; resource?: string } = {},
): Promise<{ response: Response; html: string; id?: string }> {
  const url = new URL("/authorize", harness.baseUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", options.redirectUri ?? "http://127.0.0.1/callback");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", challenge());
  url.searchParams.set("code_challenge_method", options.method ?? "S256");
  if (options.scope !== undefined) url.searchParams.set("scope", options.scope);
  if (options.resource !== undefined) url.searchParams.set("resource", options.resource);
  const response = await fetch(url, { redirect: "manual" });
  const html = await response.text();
  return {
    response,
    html,
    id: html.match(/name="pending_id" value="([A-Za-z0-9_-]+)"/)?.[1],
  };
}

async function submitConsent(
  harness: OAuthHarness,
  pendingId: string,
  options: {
    passphrase?: string;
    scopes?: string[];
    machines?: string[];
    machineMode?: "all" | "only";
    forwardedFor?: string;
  } = {},
): Promise<Response> {
  const body = new URLSearchParams({
    pending_id: pendingId,
    action: "approve",
    passphrase: options.passphrase ?? OWNER_PASSPHRASE,
    machine_mode: options.machineMode ?? "all",
  });
  for (const scope of options.scopes ?? []) body.append("scope", scope);
  for (const machine of options.machines ?? []) body.append("machine", machine);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (options.forwardedFor) headers["x-forwarded-for"] = options.forwardedFor;
  return fetch(`${harness.baseUrl}/oauth/approve`, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
  });
}

describe("security regressions", () => {
  test("HIGH-1 isolates audit rows and requires exec scope for job output", async () => {
    const harness = await makeHarness(["alpha"], {
      writer: ["fabric:read", "fabric:write", "fabric:exec"],
      reader: ["fabric:read"],
      empty: [],
    });
    mcpHarnesses.push(harness);
    await harness.startAgent("alpha");

    const writer = await harness.client("writer");
    const command = await call(writer, "run_command", {
      machine: "alpha",
      command: "echo TOPSECRET_$((6*7))",
    });
    expect(text(command)).toContain("TOPSECRET_42");
    const requestId = command.structuredContent!.request_id as string;
    const jobId = command.structuredContent!.job_id as string;

    const reader = await harness.client("reader");
    const status = await call(reader, "get_request_status", { request_id: requestId });
    expect(status.isError).toBe(true);
    expect(text(status)).not.toContain("TOPSECRET_42");

    const recent = await call(reader, "list_recent_requests", {});
    expect(recent.structuredContent!.requests).toEqual([]);
    expect(text(recent)).not.toContain("TOPSECRET_42");

    for (const [tool, args] of [
      ["read_job_output", { machine: "alpha", job_id: jobId }],
      ["list_jobs", { machine: "alpha" }],
    ] as const) {
      const denied = await call(reader, tool, args);
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({ error_code: "policy_denied" });
      expect(text(denied)).not.toContain("TOPSECRET_42");
    }

    const readerApi = await fetch(`${harness.url}/api/requests`, {
      headers: { authorization: "Bearer reader" },
    });
    expect(readerApi.status).toBe(200);
    const readerRows = ((await readerApi.json()) as { requests: Array<Record<string, unknown>> }).requests;
    expect(readerRows.length).toBeGreaterThan(0);
    expect(readerRows.every((row) => row.principal === "test:reader")).toBe(true);
    expect(readerRows.some((row) => row.request_id === requestId)).toBe(false);
    expect(readerRows.every((row) => !("outcome_json" in row))).toBe(true);

    for (const path of ["/api/status", "/api/requests", "/mcp"]) {
      const response = await fetch(`${harness.url}${path}`, {
        method: path === "/mcp" ? "POST" : "GET",
        headers: { authorization: "Bearer empty", "content-type": "application/json" },
        body: path === "/mcp" ? "{}" : undefined,
      });
      expect(response.status).toBe(403);
    }

    const ownerApi = await fetch(`${harness.url}/api/requests`, {
      headers: { authorization: "Bearer writer" },
    });
    expect(ownerApi.status).toBe(200);
    const ownerRows = ((await ownerApi.json()) as { requests: Array<Record<string, unknown>> }).requests;
    expect(ownerRows).toEqual(expect.arrayContaining([expect.objectContaining({ request_id: requestId })]));
    expect(ownerRows.every((row) => !("outcome_json" in row))).toBe(true);
  });

  test("HIGH-2 refuses an OAuth approval with no fabric scope", async () => {
    const harness = await makeOAuthHarness();
    const registration = await registerClient(harness);
    expect(registration.response.status).toBe(201);
    const consent = await beginAuthorization(harness, registration.body.client_id, {
      scope: "fabric:read fabric:exec",
    });
    expect(consent.id).toEqual(expect.any(String));

    const approval = await submitConsent(harness, consent.id!, { scopes: [] });
    expect(approval.status).toBe(200);
    expect(await approval.text()).toContain("Select at least one fabric scope");
    expect(harness.provider.getPendingAuthorization(consent.id!)).toBeDefined();
  });

  test("MEDIUM-3 attacker failures do not lock out a different client IP", async () => {
    const harness = await makeOAuthHarness();
    const registration = await registerClient(harness);
    const clientId = registration.body.client_id as string;
    const attackerPending: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      attackerPending.push((await beginAuthorization(harness, clientId)).id!);
    }
    const ownerPending = (await beginAuthorization(harness, clientId)).id!;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await submitConsent(harness, attackerPending[attempt % 5]!, {
        passphrase: `wrong passphrase ${attempt}`,
        scopes: ["fabric:read"],
        forwardedFor: "198.51.100.10",
      });
      expect([200, 429]).toContain(response.status);
    }

    const approved = await submitConsent(harness, ownerPending, {
      scopes: ["fabric:read"],
      forwardedFor: "203.0.113.20",
    });
    expect(approved.status).toBe(302);
    expect(new URL(approved.headers.get("location")!).searchParams.get("code")).toEqual(expect.any(String));
    expect(harness.provider.getPendingAuthorization(attackerPending[0]!)).toBeDefined();
  });

  test("MEDIUM-4 malformed phase-2 authorization stays on the hub", async () => {
    const harness = await makeOAuthHarness();
    const registration = await registerClient(harness, {
      redirect_uris: ["https://evil.example/cb"],
      client_name: "Redirect probe",
    });
    const response = await beginAuthorization(harness, registration.body.client_id, {
      redirectUri: "https://evil.example/cb",
      method: "plain",
    });

    expect(response.response.status).toBe(400);
    expect(response.response.headers.get("location")).toBeNull();
    expect(response.html).toContain("Invalid authorization request");
    expect(response.html).not.toContain("https://evil.example/cb?error=");
  });

  test("MEDIUM-4 invalid resource stays on the hub for a loopback callback", async () => {
    const harness = await makeOAuthHarness();
    const registration = await registerClient(harness);
    const response = await beginAuthorization(harness, registration.body.client_id, {
      resource: "https://other.example/mcp",
    });

    expect(response.response.status).toBe(400);
    expect(response.response.headers.get("location")).toBeNull();
    expect(response.html).toContain("Invalid authorization request");
  });

  test("MEDIUM-4 duplicate phase-2 parameters stay on the hub", async () => {
    const harness = await makeOAuthHarness();
    const registration = await registerClient(harness, {
      redirect_uris: ["https://evil.example/cb"],
      client_name: "Duplicate parameter probe",
    });

    for (const [name, first, second] of [
      ["state", "owner-state", "attacker-state"],
      ["scope", "fabric:read", "fabric:exec"],
      ["resource", `${harness.baseUrl}/mcp`, "https://evil.example/mcp"],
    ] as const) {
      const url = new URL("/authorize", harness.baseUrl);
      url.searchParams.set("client_id", registration.body.client_id);
      url.searchParams.set("redirect_uri", "https://evil.example/cb");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", challenge());
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.append(name, first);
      url.searchParams.append(name, second);

      const response = await fetch(url, { redirect: "manual" });
      const html = await response.text();
      expect(response.status, name).toBe(400);
      expect(response.headers.get("location"), name).toBeNull();
      expect(html, name).toContain("Invalid authorization request");
    }
  });

  test("MEDIUM-4 accepts an omitted redirect URI when the client has one callback", async () => {
    const harness = await makeOAuthHarness();
    const registration = await registerClient(harness);
    const url = new URL("/authorize", harness.baseUrl);
    url.searchParams.set("client_id", registration.body.client_id);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge());
    url.searchParams.set("code_challenge_method", "S256");

    const response = await fetch(url, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('name="pending_id"');
  });

  test("LOW-5 consent defaults to read and identifies an unverified risky client", async () => {
    const harness = await makeOAuthHarness();
    const redirectUri = "http://evil.example/callback?destination=owner";
    const registration = await registerClient(harness, {
      redirect_uris: [redirectUri],
      client_name: "Trusted Support Portal",
    });
    const consent = await beginAuthorization(harness, registration.body.client_id, { redirectUri });

    expect(consent.response.status).toBe(200);
    expect(consent.html).toMatch(/value="fabric:read" checked/);
    expect(consent.html).not.toMatch(/value="fabric:write" checked/);
    expect(consent.html).not.toMatch(/value="fabric:exec" checked/);
    expect(consent.html).toContain("unverified (self-registered)");
    expect(consent.html).toContain("http://evil.example/callback?destination=owner");
    expect(consent.html).toContain("Non-HTTPS, non-loopback redirect");

    const emptyScope = await beginAuthorization(harness, registration.body.client_id, { redirectUri, scope: "" });
    expect(emptyScope.response.status).toBe(200);
    expect(emptyScope.html).toMatch(/value="fabric:read" checked/);
    expect(emptyScope.html).not.toMatch(/value="fabric:write" checked/);
    expect(emptyScope.html).not.toMatch(/value="fabric:exec" checked/);
  });

  test("LOW-5 explicit authorization scope does not inherit broader client metadata", async () => {
    const harness = await makeOAuthHarness();
    const registration = await registerClient(harness, {
      scope: "fabric:read fabric:exec machine:beta",
    });
    const consent = await beginAuthorization(harness, registration.body.client_id, {
      scope: "fabric:read machine:alpha",
    });

    expect(consent.response.status).toBe(200);
    expect(consent.html).toMatch(/value="fabric:read" checked/);
    expect(consent.html).not.toMatch(/value="fabric:exec" checked/);
    expect(consent.html).toMatch(/value="alpha" checked/);
    expect(consent.html).not.toMatch(/value="beta" checked/);
  });

  test("LOW-6 prunes expired OAuth state and caps unused registrations", async () => {
    const start = 1_800_000_000_000;
    const harness = await makeOAuthHarness(start);
    const staleClient = await registerClient(harness);
    const pending = await beginAuthorization(harness, staleClient.body.client_id);
    expect(pending.id).toEqual(expect.any(String));
    const approved = await submitConsent(harness, pending.id!, { scopes: ["fabric:read"] });
    expect(approved.status).toBe(302);
    const secondPending = await beginAuthorization(harness, staleClient.body.client_id);
    expect(secondPending.id).toEqual(expect.any(String));

    harness.setNow(start + 31 * 24 * 60 * 60 * 1000);
    const trigger = await registerClient(harness, { client_name: "Prune trigger" });
    expect(trigger.response.status).toBe(201);
    expect(await harness.provider.clientsStore.getClient(staleClient.body.client_id)).toBeUndefined();
    expect((harness.db.prepare("SELECT COUNT(*) AS count FROM oauth_pending_authorizations").get() as { count: number }).count).toBe(0);
    expect((harness.db.prepare("SELECT COUNT(*) AS count FROM oauth_authorization_codes").get() as { count: number }).count).toBe(0);

    const metadata = {
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none" as const,
      client_name: "Bulk client",
    };
    for (let index = 0; index < 499; index += 1) {
      await harness.provider.clientsStore.registerClient(metadata);
    }
    const capped = await registerClient(harness, { client_name: "Client 501" });
    expect(capped.response.status).toBe(400);
    expect(capped.body).toMatchObject({ error: "invalid_request" });
  });

  test("LOW-6 migration preserves a legacy client that already issued tokens", async () => {
    let now = 1_800_000_000_000;
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, info_json TEXT NOT NULL);
      CREATE TABLE oauth_token_families (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        resource TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
    `);
    const legacyClient = {
      client_id: "legacy-client",
      client_id_issued_at: 1_700_000_000,
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
    };
    db.prepare("INSERT INTO oauth_clients (client_id, info_json) VALUES (?, ?)").run(
      legacyClient.client_id,
      JSON.stringify(legacyClient),
    );
    db.prepare(
      "INSERT INTO oauth_token_families (id, client_id, scopes_json, resource, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)",
    ).run("legacy-family", legacyClient.client_id, '["fabric:read"]', "http://127.0.0.1/mcp", 1_700_000_000);

    const provider = new FabricOAuthProvider({ db, mcpResourceUrl: "http://127.0.0.1/mcp", now: () => now });
    now += 31 * 24 * 60 * 60 * 1000;
    await provider.clientsStore.registerClient({
      redirect_uris: ["http://127.0.0.1/new-callback"],
      token_endpoint_auth_method: "none",
    });

    expect(await provider.clientsStore.getClient(legacyClient.client_id)).toBeDefined();
    db.close();
  });

  test("LOW-6 keeps an old unused client while a fresh authorization code is live", async () => {
    const start = 1_800_000_000_000;
    const harness = await makeOAuthHarness(start);
    const oldClient = await registerClient(harness);
    harness.setNow(start + 31 * 24 * 60 * 60 * 1000);
    const consent = await beginAuthorization(harness, oldClient.body.client_id);
    const approval = await submitConsent(harness, consent.id!, { scopes: ["fabric:read"] });
    expect(approval.status).toBe(302);

    const trigger = await registerClient(harness, { client_name: "Live-code prune trigger" });
    expect(trigger.response.status).toBe(201);
    expect(await harness.provider.clientsStore.getClient(oldClient.body.client_id)).toBeDefined();
  });
});
