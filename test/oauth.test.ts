import { createHash } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, test } from "vitest";

import {
  FabricOAuthProvider,
  SCOPES,
  bearerMiddleware,
  createOAuthRouter,
} from "../src/hub/oauth.js";

const OWNER_PASSPHRASE = "correct horse battery staple";
const VERIFIER = "a".repeat(64);

interface Harness {
  baseUrl: string;
  db: DatabaseSync;
  provider: FabricOAuthProvider;
  close(): Promise<void>;
  setNow(value: number): void;
}

const harnesses: Harness[] = [];

async function createHarness(initialNow = 1_800_000_000_000): Promise<Harness> {
  let now = initialNow;
  const app = express();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const db = new DatabaseSync(":memory:");
  const provider = new FabricOAuthProvider({
    db,
    mcpResourceUrl: `${baseUrl}/mcp`,
    now: () => now,
  });
  provider.setOwnerPassphrase(OWNER_PASSPHRASE);

  app.use(
    createOAuthRouter({
      provider,
      issuerUrl: new URL(baseUrl),
      mcpResourceUrl: new URL(`${baseUrl}/mcp`),
      resourceName: "Machine Fabric",
    }),
  );
  app.get("/mcp", bearerMiddleware(provider, new URL(`${baseUrl}/mcp`)), (req, res) => {
    res.json({ clientId: req.auth?.clientId, scopes: req.auth?.scopes });
  });

  const harness: Harness = {
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
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

async function registerClient(
  harness: Harness,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${harness.baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
      client_name: "Test client",
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Record<string, unknown>;
}

function challenge(verifier = VERIFIER): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

interface PendingConsent {
  id: string;
  html: string;
  response: Response;
}

async function beginAuthorization(
  harness: Harness,
  clientId: string,
  options: {
    scope?: string;
    state?: string;
    redirectUri?: string;
    verifier?: string;
    resource?: string;
  } = {},
): Promise<PendingConsent> {
  const url = new URL("/authorize", harness.baseUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", options.redirectUri ?? "http://127.0.0.1/callback");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", challenge(options.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (options.scope !== undefined) url.searchParams.set("scope", options.scope);
  if (options.state !== undefined) url.searchParams.set("state", options.state);
  if (options.resource !== undefined) url.searchParams.set("resource", options.resource);
  const response = await fetch(url, { redirect: "manual" });
  const html = await response.text();
  const id = html.match(/name="pending_id" value="([A-Za-z0-9_-]+)"/)?.[1];
  expect(id).toEqual(expect.any(String));
  return { id: id!, html, response };
}

async function submitConsent(
  harness: Harness,
  pendingId: string,
  options: { action?: "approve" | "deny"; passphrase?: string; scopes?: string[] } = {},
): Promise<Response> {
  const body = new URLSearchParams();
  body.set("pending_id", pendingId);
  body.set("action", options.action ?? "approve");
  if (options.passphrase !== undefined) body.set("passphrase", options.passphrase);
  for (const scope of options.scopes ?? []) body.append("scope", scope);
  return fetch(`${harness.baseUrl}/oauth/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
}

async function exchangeCode(
  harness: Harness,
  clientId: string,
  code: string,
  overrides: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${harness.baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: VERIFIER,
      redirect_uri: "http://127.0.0.1/callback",
      resource: `${harness.baseUrl}/mcp`,
      ...overrides,
    }),
  });
}

async function authorizeAndExchange(
  harness: Harness,
  scope = "fabric:read fabric:write",
): Promise<{
  clientId: string;
  code: string;
  accessToken: string;
  refreshToken: string;
}> {
  const client = await registerClient(harness);
  const clientId = client.client_id as string;
  const consent = await beginAuthorization(harness, clientId, {
    scope,
    resource: `${harness.baseUrl}/mcp`,
  });
  const approved = await submitConsent(harness, consent.id, {
    passphrase: OWNER_PASSPHRASE,
    scopes: scope.split(" "),
  });
  expect(approved.status).toBe(302);
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const tokenResponse = await exchangeCode(harness, clientId, code);
  expect(tokenResponse.status).toBe(200);
  const tokens = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
  };
  return {
    clientId,
    code,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
  };
}

async function exchangeRefresh(
  harness: Harness,
  clientId: string,
  refreshToken: string,
  options: { scope?: string; resource?: string } = {},
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    resource: options.resource ?? `${harness.baseUrl}/mcp`,
  });
  if (options.scope !== undefined) body.set("scope", options.scope);
  return fetch(`${harness.baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("OAuth discovery and registration", () => {
  test("publishes protected-resource and authorization-server metadata and registers a public client", async () => {
    const harness = await createHarness();

    const resourceResponse = await fetch(
      `${harness.baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(resourceResponse.status).toBe(200);
    expect(await resourceResponse.json()).toEqual({
      resource: `${harness.baseUrl}/mcp`,
      authorization_servers: [harness.baseUrl + "/"],
      scopes_supported: SCOPES,
      resource_name: "Machine Fabric",
    });

    const metadataResponse = await fetch(
      `${harness.baseUrl}/.well-known/oauth-authorization-server`,
    );
    expect(metadataResponse.status).toBe(200);
    expect(await metadataResponse.json()).toMatchObject({
      issuer: harness.baseUrl + "/",
      authorization_endpoint: `${harness.baseUrl}/authorize`,
      token_endpoint: `${harness.baseUrl}/token`,
      registration_endpoint: `${harness.baseUrl}/register`,
      revocation_endpoint: `${harness.baseUrl}/revoke`,
      scopes_supported: SCOPES,
      code_challenge_methods_supported: ["S256"],
    });

    const registered = await registerClient(harness);
    expect(registered.client_id).toEqual(expect.any(String));
    expect(registered.client_id_issued_at).toBe(1_800_000_000);
    expect(registered.client_secret).toBeUndefined();
    expect(await harness.provider.clientsStore.getClient(registered.client_id as string)).toEqual(
      registered,
    );
  });
});

describe("owner credentials and personal access tokens", () => {
  test("hashes the owner passphrase and enforces its minimum length", async () => {
    const harness = await createHarness();

    expect(harness.provider.hasOwnerPassphrase()).toBe(true);
    expect(harness.provider.verifyOwnerPassphrase(OWNER_PASSPHRASE)).toBe(true);
    expect(harness.provider.verifyOwnerPassphrase("incorrect phrase")).toBe(false);
    expect(() => harness.provider.setOwnerPassphrase("too short")).toThrow(/12/);

    const stored = harness.db
      .prepare("SELECT salt, hash FROM oauth_owner_credentials WHERE id = 1")
      .get() as { salt: string; hash: string };
    expect(stored.salt).not.toContain(OWNER_PASSPHRASE);
    expect(stored.hash).not.toContain(OWNER_PASSPHRASE);
  });

  test("creates, verifies, lists, and revokes hashed personal access tokens", async () => {
    const harness = await createHarness();
    const created = harness.provider.createPersonalToken("automation", [
      "fabric:read",
      "not-a-scope",
    ]);

    expect(created.id).toEqual(expect.any(String));
    expect(created.token).toMatch(/^mmf_pat_[A-Za-z0-9_-]+$/);
    expect(harness.provider.listPersonalTokens()).toEqual([
      expect.objectContaining({ id: created.id, name: "automation", scopes: ["fabric:read"] }),
    ]);
    const stored = harness.db
      .prepare("SELECT token_hash FROM oauth_personal_tokens WHERE id = ?")
      .get(created.id) as { token_hash: string };
    expect(stored.token_hash).not.toContain(created.token);

    await expect(harness.provider.verifyAccessToken(created.token)).resolves.toMatchObject({
      token: created.token,
      clientId: `pat:${created.id}`,
      scopes: ["fabric:read"],
      resource: new URL(`${harness.baseUrl}/mcp`),
    });

    expect(harness.provider.revokePersonalToken(created.id)).toBe(true);
    await expect(harness.provider.verifyAccessToken(created.token)).rejects.toThrow();
  });
});

describe("authorization consent", () => {
  test("renders escaped, framed-denied consent with the default known scopes", async () => {
    const harness = await createHarness();
    const client = await registerClient(harness, {
      client_name: '<script>alert("owned")</script>',
    });

    const consent = await beginAuthorization(harness, client.client_id as string);

    expect(consent.response.status).toBe(200);
    expect(consent.response.headers.get("x-frame-options")).toBe("DENY");
    expect(consent.response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1",
    );
    expect(consent.html).not.toContain('<script>alert("owned")</script>');
    expect(consent.html).toContain("&lt;script&gt;alert(&quot;owned&quot;)&lt;/script&gt;");
    expect(consent.html).toContain("127.0.0.1");
    for (const scope of SCOPES) {
      expect(consent.html).toContain(`value="${scope}"`);
    }
  });

  test("keeps the pending request after a wrong passphrase and completes a real S256 code flow", async () => {
    const harness = await createHarness();
    const client = await registerClient(harness);
    const clientId = client.client_id as string;
    const consent = await beginAuthorization(harness, clientId, {
      scope: "fabric:read fabric:write",
      state: "opaque-state",
      resource: `${harness.baseUrl}/mcp`,
    });

    const wrong = await submitConsent(harness, consent.id, {
      passphrase: "this is the wrong passphrase",
      scopes: ["fabric:read"],
    });
    expect(wrong.status).toBe(200);
    const wrongHtml = await wrong.text();
    expect(wrongHtml).toContain("Incorrect passphrase");
    expect(wrongHtml).toContain(`value="${consent.id}"`);

    const approved = await submitConsent(harness, consent.id, {
      passphrase: OWNER_PASSPHRASE,
      scopes: ["fabric:read"],
    });
    expect(approved.status).toBe(302);
    const redirect = new URL(approved.headers.get("location")!);
    expect(redirect.origin + redirect.pathname).toBe("http://127.0.0.1/callback");
    expect(redirect.searchParams.get("state")).toBe("opaque-state");
    const code = redirect.searchParams.get("code");
    expect(code).toEqual(expect.any(String));
    expect(
      harness.db
        .prepare("SELECT code_hash FROM oauth_authorization_codes WHERE code_hash = ?")
        .get(createHash("sha256").update(code!).digest("hex")),
    ).toBeDefined();

    const tokenResponse = await exchangeCode(harness, clientId, code!);
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as Record<string, unknown>;
    expect(tokens).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      token_type: "Bearer",
      expires_in: 3600,
      scope: "fabric:read",
    });
    expect(
      harness.db
        .prepare("SELECT 1 FROM oauth_access_tokens WHERE token_hash = ?")
        .get(createHash("sha256").update(tokens.access_token as string).digest("hex")),
    ).toBeDefined();
    expect(
      harness.db
        .prepare("SELECT 1 FROM oauth_refresh_tokens WHERE token_hash = ?")
        .get(createHash("sha256").update(tokens.refresh_token as string).digest("hex")),
    ).toBeDefined();
    await expect(harness.provider.verifyAccessToken(tokens.access_token as string)).resolves.toMatchObject({
      clientId,
      scopes: ["fabric:read"],
      expiresAt: 1_800_003_600,
      resource: new URL(`${harness.baseUrl}/mcp`),
    });
  });

  test("denial redirects with access_denied and preserves state", async () => {
    const harness = await createHarness();
    const client = await registerClient(harness);
    const consent = await beginAuthorization(harness, client.client_id as string, {
      state: "deny-state",
    });

    const denied = await submitConsent(harness, consent.id, { action: "deny" });

    expect(denied.status).toBe(302);
    const redirect = new URL(denied.headers.get("location")!);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("deny-state");
    const secondTry = await submitConsent(harness, consent.id, { action: "deny" });
    expect(secondTry.status).toBe(400);
  });

  test("drops unknown scopes and lets the owner narrow requested scopes", async () => {
    const harness = await createHarness();
    const client = await registerClient(harness);
    const clientId = client.client_id as string;
    const consent = await beginAuthorization(harness, clientId, {
      scope: "fabric:read unknown fabric:exec",
    });
    expect(consent.html).not.toContain('value="unknown"');

    const approved = await submitConsent(harness, consent.id, {
      passphrase: OWNER_PASSPHRASE,
      scopes: ["fabric:exec", "fabric:write", "unknown"],
    });
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const response = await exchangeCode(harness, clientId, code);
    const tokens = (await response.json()) as { scope: string };
    expect(tokens.scope).toBe("fabric:exec");
  });

  test("rejects an unknown approval action without consuming the pending request", async () => {
    const harness = await createHarness();
    const client = await registerClient(harness);
    const consent = await beginAuthorization(harness, client.client_id as string);

    const invalid = await fetch(`${harness.baseUrl}/oauth/approve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        pending_id: consent.id,
        action: "surprise",
        passphrase: OWNER_PASSPHRASE,
        scope: "fabric:read",
      }),
      redirect: "manual",
    });
    expect(invalid.status).toBe(400);

    const approved = await submitConsent(harness, consent.id, {
      passphrase: OWNER_PASSPHRASE,
      scopes: ["fabric:read"],
    });
    expect(approved.status).toBe(302);
  });

  test("returns a 400 page for an expired pending request", async () => {
    const harness = await createHarness();
    const client = await registerClient(harness);
    const consent = await beginAuthorization(harness, client.client_id as string);
    harness.setNow(1_800_000_601_000);

    const response = await submitConsent(harness, consent.id, {
      passphrase: OWNER_PASSPHRASE,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("invalid or expired");
  });

  test("preserves the owner's narrowed scope selection after a wrong passphrase", async () => {
    const harness = await createHarness();
    const client = await registerClient(harness);
    const consent = await beginAuthorization(harness, client.client_id as string, {
      scope: "fabric:read fabric:exec",
    });

    const wrong = await submitConsent(harness, consent.id, {
      passphrase: "wrong passphrase selection retry",
      scopes: ["fabric:read"],
    });
    const html = await wrong.text();

    expect(html).toMatch(/value="fabric:read" checked/);
    expect(html).not.toMatch(/value="fabric:exec" checked/);
  });

  test("rejects a resource other than the canonical MCP resource before consent", async () => {
    const harness = await createHarness();
    const client = await registerClient(harness);
    const url = new URL("/authorize", harness.baseUrl);
    url.searchParams.set("client_id", client.client_id as string);
    url.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge());
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", "https://other.example/mcp");

    const response = await fetch(url, { redirect: "manual" });

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("Invalid authorization request");
  });
});

describe("authorization-code security", () => {
  test("rejects a wrong PKCE verifier without consuming the code", async () => {
    const harness = await createHarness();
    const client = await registerClient(harness);
    const clientId = client.client_id as string;
    const consent = await beginAuthorization(harness, clientId, {
      resource: `${harness.baseUrl}/mcp`,
    });
    const approved = await submitConsent(harness, consent.id, {
      passphrase: OWNER_PASSPHRASE,
      scopes: ["fabric:read"],
    });
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

    const wrong = await exchangeCode(harness, clientId, code, {
      code_verifier: "b".repeat(64),
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });

    const correct = await exchangeCode(harness, clientId, code);
    expect(correct.status).toBe(200);
  });

  test("rejects redirect_uri and resource mismatches without consuming the code", async () => {
    const harness = await createHarness();
    const client = await registerClient(harness);
    const clientId = client.client_id as string;
    const consent = await beginAuthorization(harness, clientId, {
      resource: `${harness.baseUrl}/mcp`,
    });
    const approved = await submitConsent(harness, consent.id, {
      passphrase: OWNER_PASSPHRASE,
      scopes: ["fabric:read"],
    });
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

    const wrongRedirect = await exchangeCode(harness, clientId, code, {
      redirect_uri: "http://127.0.0.1/other",
    });
    expect(wrongRedirect.status).toBe(400);
    expect(await wrongRedirect.json()).toMatchObject({ error: "invalid_grant" });

    const wrongResource = await exchangeCode(harness, clientId, code, {
      resource: `${harness.baseUrl}/different-resource`,
    });
    expect(wrongResource.status).toBe(400);
    expect(await wrongResource.json()).toMatchObject({ error: "invalid_grant" });

    expect((await exchangeCode(harness, clientId, code)).status).toBe(200);
  });

  test("rejects an expired authorization code using the injected clock", async () => {
    const harness = await createHarness();
    const client = await registerClient(harness);
    const clientId = client.client_id as string;
    const consent = await beginAuthorization(harness, clientId);
    const approved = await submitConsent(harness, consent.id, {
      passphrase: OWNER_PASSPHRASE,
      scopes: ["fabric:read"],
    });
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    harness.setNow(1_800_000_601_000);

    const response = await exchangeCode(harness, clientId, code);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("rejects code replay and revokes every token issued from that code", async () => {
    const harness = await createHarness();
    const issued = await authorizeAndExchange(harness);

    const replay = await exchangeCode(harness, issued.clientId, issued.code);

    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    await expect(harness.provider.verifyAccessToken(issued.accessToken)).rejects.toThrow();
    const refresh = await exchangeRefresh(harness, issued.clientId, issued.refreshToken);
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("expired replay still revokes every token issued from the used code", async () => {
    const harness = await createHarness();
    const issued = await authorizeAndExchange(harness);
    harness.setNow(1_800_000_601_000);

    const replay = await exchangeCode(harness, issued.clientId, issued.code);

    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    await expect(harness.provider.verifyAccessToken(issued.accessToken)).rejects.toThrow();
    expect(
      (await exchangeRefresh(harness, issued.clientId, issued.refreshToken)).status,
    ).toBe(400);
  });
});

describe("refresh and revocation", () => {
  test("rotates refresh tokens and revokes the family when a rotated token is reused", async () => {
    const harness = await createHarness();
    const issued = await authorizeAndExchange(harness);

    const rotatedResponse = await exchangeRefresh(
      harness,
      issued.clientId,
      issued.refreshToken,
      { scope: "fabric:read" },
    );
    expect(rotatedResponse.status).toBe(200);
    const rotated = (await rotatedResponse.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(rotated.refresh_token).not.toBe(issued.refreshToken);
    expect(rotated.scope).toBe("fabric:read");

    const reuse = await exchangeRefresh(harness, issued.clientId, issued.refreshToken);
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toMatchObject({ error: "invalid_grant" });
    await expect(harness.provider.verifyAccessToken(rotated.access_token)).rejects.toThrow();
    expect(
      (await exchangeRefresh(harness, issued.clientId, rotated.refresh_token)).status,
    ).toBe(400);
  });

  test("rejects scope escalation during refresh without consuming the token", async () => {
    const harness = await createHarness();
    const issued = await authorizeAndExchange(harness, "fabric:read");

    const escalated = await exchangeRefresh(harness, issued.clientId, issued.refreshToken, {
      scope: "fabric:read fabric:exec",
    });
    expect(escalated.status).toBe(400);
    expect(await escalated.json()).toMatchObject({ error: "invalid_scope" });

    expect(
      (await exchangeRefresh(harness, issued.clientId, issued.refreshToken)).status,
    ).toBe(200);
  });

  test("the revocation endpoint revokes a refresh token and its whole family", async () => {
    const harness = await createHarness();
    const issued = await authorizeAndExchange(harness);

    const response = await fetch(`${harness.baseUrl}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: issued.clientId,
        token: issued.refreshToken,
        token_type_hint: "refresh_token",
      }),
    });

    expect(response.status).toBe(200);
    await expect(harness.provider.verifyAccessToken(issued.accessToken)).rejects.toThrow();
    expect(
      (await exchangeRefresh(harness, issued.clientId, issued.refreshToken)).status,
    ).toBe(400);
  });
});

describe("bearer authentication", () => {
  test("advertises protected-resource metadata in a bearer challenge", async () => {
    const harness = await createHarness();

    const response = await fetch(`${harness.baseUrl}/mcp`);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${harness.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  test("accepts a personal access token through the real bearer middleware", async () => {
    const harness = await createHarness();
    const pat = harness.provider.createPersonalToken("cli", ["fabric:read"]);

    const response = await fetch(`${harness.baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${pat.token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      clientId: `pat:${pat.id}`,
      scopes: ["fabric:read"],
    });
  });
});

describe("approval lockout", () => {
  test("invalidates a pending request on its fifth wrong passphrase in 15 minutes", async () => {
    const harness = await createHarness();
    const client = await registerClient(harness);
    const consent = await beginAuthorization(harness, client.client_id as string);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await submitConsent(harness, consent.id, {
        passphrase: `wrong passphrase attempt ${attempt}`,
      });
      expect(response.status).toBe(200);
    }
    const locked = await submitConsent(harness, consent.id, {
      passphrase: "wrong passphrase attempt 5",
    });
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("Too many failed attempts");
    expect(
      (await submitConsent(harness, consent.id, { passphrase: OWNER_PASSPHRASE })).status,
    ).toBe(400);
  });

  test("invalidates the twentieth failed pending request hub-wide", async () => {
    const harness = await createHarness();
    const client = await registerClient(harness);
    const pendingIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      pendingIds.push((await beginAuthorization(harness, client.client_id as string)).id);
    }

    for (let attempt = 0; attempt < 19; attempt += 1) {
      const response = await submitConsent(harness, pendingIds[attempt % 5]!, {
        passphrase: `hub wrong passphrase ${attempt}`,
      });
      expect(response.status).toBe(200);
    }
    const locked = await submitConsent(harness, pendingIds[4]!, {
      passphrase: "hub wrong passphrase 20",
    });
    expect(locked.status).toBe(429);
    expect(
      (await submitConsent(harness, pendingIds[4]!, { passphrase: OWNER_PASSPHRASE })).status,
    ).toBe(400);
  });

  test("blocks fresh pending requests until the hub-wide failure window expires", async () => {
    const harness = await createHarness();
    const client = await registerClient(harness);
    const pendingIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      pendingIds.push((await beginAuthorization(harness, client.client_id as string)).id);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await submitConsent(harness, pendingIds[attempt % 5]!, {
        passphrase: `window wrong passphrase ${attempt}`,
      });
    }
    const fresh = await beginAuthorization(harness, client.client_id as string);

    const blocked = await submitConsent(harness, fresh.id, {
      passphrase: OWNER_PASSPHRASE,
    });

    expect(blocked.status).toBe(429);
    expect(
      (await submitConsent(harness, fresh.id, { passphrase: OWNER_PASSPHRASE })).status,
    ).toBe(400);

    harness.setNow(1_800_000_901_000);
    const recovered = await beginAuthorization(harness, client.client_id as string);
    expect(
      (
        await submitConsent(harness, recovered.id, {
          passphrase: OWNER_PASSPHRASE,
          scopes: ["fabric:read"],
        })
      ).status,
    ).toBe(302);
  });
});
