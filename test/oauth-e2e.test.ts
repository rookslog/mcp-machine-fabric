import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, test } from "vitest";

import { Agent } from "../src/agent/agent.js";
import { normalizePolicy } from "../src/agent/policy.js";
import { createOAuthRouter, FabricOAuthProvider, SCOPES } from "../src/hub/oauth.js";
import { createHub, type Hub } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";

const OWNER_PASSPHRASE = "correct horse battery staple";

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, any>;
  isError?: boolean;
};

class InteractiveOAuthClient implements OAuthClientProvider {
  #clientInformation?: OAuthClientInformationMixed;
  #tokens?: OAuthTokens;
  #codeVerifier?: string;
  #discovery?: OAuthDiscoveryState;
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  authorizationCode?: string;
  authorizationUrl?: URL;
  consentScopes: string[] = [];
  registrationSaves = 0;
  tokenSaves = 0;

  constructor(
    private readonly publicUrl: string,
    private readonly ownerPassphrase: string,
    private readonly grantedScopes: readonly string[] = SCOPES,
    name = "OAuth E2E client",
  ) {
    this.redirectUrl = `${publicUrl}/oauth/client-callback`;
    this.clientMetadata = {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: name,
      scope: SCOPES.join(" "),
    };
  }

  state(): string {
    return "oauth-e2e-state";
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.#clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.#clientInformation = clientInformation;
    this.registrationSaves += 1;
  }

  tokens(): OAuthTokens | undefined {
    return this.#tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.#tokens = tokens;
    this.tokenSaves += 1;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.#codeVerifier) throw new Error("PKCE verifier was not saved");
    return this.#codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discovery;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.authorizationUrl = new URL(authorizationUrl);
    const consent = await fetch(authorizationUrl, { redirect: "manual" });
    if (consent.status !== 200) {
      throw new Error(`authorization page returned ${consent.status}`);
    }
    const html = await consent.text();
    const pendingId = html.match(/name="pending_id" value="([A-Za-z0-9_-]+)"/)?.[1];
    if (!pendingId) throw new Error("consent page did not contain a pending id");

    const inputTags = html.match(/<input\b[^>]*name="scope"[^>]*>/g) ?? [];
    this.consentScopes = inputTags.map((tag) => {
      const value = tag.match(/value="([^"]+)"/)?.[1];
      if (!value) throw new Error("scope checkbox did not have a value");
      return value;
    });
    const allowed = new Set(this.grantedScopes);
    const body = new URLSearchParams({
      pending_id: pendingId,
      action: "approve",
      passphrase: this.ownerPassphrase,
    });
    for (const scope of this.consentScopes) {
      if (allowed.has(scope)) body.append("scope", scope);
    }

    const approval = await fetch(new URL("/oauth/approve", authorizationUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });
    if (approval.status !== 302) {
      throw new Error(`approval returned ${approval.status}: ${await approval.text()}`);
    }
    const location = new URL(approval.headers.get("location")!);
    if (location.searchParams.get("state") !== "oauth-e2e-state") {
      throw new Error("authorization response state did not match");
    }
    const code = location.searchParams.get("code");
    if (!code) throw new Error("authorization response did not contain a code");
    this.authorizationCode = code;
  }
}

interface OAuthHarness {
  dir: string;
  publicUrl: string;
  store: HubStore;
  hub: Hub;
  provider: FabricOAuthProvider;
  agent: Agent;
  agentRoot: string;
  advanceNow(milliseconds: number): void;
  clients: Client[];
  close(): Promise<void>;
}

const harnesses: OAuthHarness[] = [];

async function unusedPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, "close");
  return port;
}

async function makeOAuthHarness(): Promise<OAuthHarness> {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "mmf-oauth-e2e-"));
  const port = await unusedPort();
  const publicUrl = `http://127.0.0.1:${port}`;
  let now = Date.now();
  const store = new HubStore(nodePath.join(dir, "hub"));
  const provider = new FabricOAuthProvider({
    db: store.db,
    mcpResourceUrl: `${publicUrl}/mcp`,
    now: () => now,
  });
  provider.setOwnerPassphrase(OWNER_PASSPHRASE);
  const hub = createHub({
    store,
    publicUrl,
    hubVersion: "oauth-e2e",
    verifier: provider,
    authRouter: createOAuthRouter({
      provider,
      issuerUrl: new URL(publicUrl),
      mcpResourceUrl: new URL(`${publicUrl}/mcp`),
      resourceName: "Machine Fabric",
    }),
    heartbeatIntervalMs: 200,
    heartbeatTimeoutMs: 2_000,
  });
  await hub.listen(port, "127.0.0.1");

  const device = store.addDevice("alpha");
  const agentRoot = nodePath.join(dir, "agent-root");
  await mkdir(agentRoot, { recursive: true });
  const policy = await normalizePolicy({ roots: [agentRoot], read_only: false, allow_exec: true });
  const agent = new Agent({
    hubUrl: `ws://127.0.0.1:${port}/agent`,
    token: device.token,
    policy,
    stateDir: nodePath.join(dir, "agent-state"),
    minBackoffMs: 50,
    maxBackoffMs: 200,
  });
  await agent.start();
  await agent.waitConnected();

  const harness: OAuthHarness = {
    dir,
    publicUrl,
    store,
    hub,
    provider,
    agent,
    agentRoot: policy.roots[0],
    advanceNow(milliseconds) {
      now += milliseconds;
    },
    clients: [],
    async close() {
      for (const client of this.clients) await client.close().catch(() => {});
      await agent.stop();
      await hub.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

async function connectThroughOAuth(
  harness: OAuthHarness,
  oauth: InteractiveOAuthClient,
): Promise<Client> {
  const client = await connectSdkClient(harness.publicUrl, oauth);
  harness.clients.push(client);
  return client;
}

async function connectSdkClient(
  publicUrl: string,
  oauth: InteractiveOAuthClient,
): Promise<Client> {
  const firstTransport = new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), {
    authProvider: oauth,
  });
  const firstClient = new Client({ name: "oauth-e2e", version: "1" });
  await expect(firstClient.connect(firstTransport)).rejects.toBeInstanceOf(UnauthorizedError);
  expect(oauth.authorizationCode).toEqual(expect.any(String));
  await firstTransport.finishAuth(oauth.authorizationCode!);
  await firstClient.close().catch(() => {});

  const transport = new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), {
    authProvider: oauth,
  });
  const client = new Client({ name: "oauth-e2e", version: "1" });
  await client.connect(transport);
  return client;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function resultText(result: ToolResult): string {
  return result.content.map((entry) => entry.text ?? "").join("\n");
}

describe("OAuth through the real hub and MCP SDK client", () => {
  test("discovers, dynamically registers, authorizes, runs tools, records identity, and refreshes", async () => {
    const harness = await makeOAuthHarness();

    const challenge = await fetch(`${harness.publicUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(challenge.status).toBe(401);
    const authenticate = challenge.headers.get("www-authenticate");
    const metadataUrl = authenticate?.match(/resource_metadata="([^"]+)"/)?.[1];
    expect(metadataUrl).toBe(`${harness.publicUrl}/.well-known/oauth-protected-resource/mcp`);

    const resourceMetadata = (await (await fetch(metadataUrl!)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(resourceMetadata.resource).toBe(`${harness.publicUrl}/mcp`);
    expect(resourceMetadata.authorization_servers).toHaveLength(1);
    const authorizationServer = new URL(resourceMetadata.authorization_servers[0]!);
    const authorizationMetadata = (await (
      await fetch(new URL("/.well-known/oauth-authorization-server", authorizationServer))
    ).json()) as Record<string, unknown>;
    expect(authorizationMetadata).toMatchObject({
      issuer: `${harness.publicUrl}/`,
      authorization_endpoint: `${harness.publicUrl}/authorize`,
      token_endpoint: `${harness.publicUrl}/token`,
      registration_endpoint: `${harness.publicUrl}/register`,
    });

    const oauth = new InteractiveOAuthClient(harness.publicUrl, OWNER_PASSPHRASE);
    const client = await connectThroughOAuth(harness, oauth);

    expect(oauth.registrationSaves).toBeGreaterThanOrEqual(1);
    expect(oauth.clientInformation()?.client_id).toEqual(expect.any(String));
    expect(
      (harness.store.db.prepare("SELECT COUNT(*) AS count FROM oauth_clients").get() as {
        count: number;
      }).count,
    ).toBe(1);
    expect(oauth.consentScopes).toEqual(SCOPES);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["list_machines", "read_file", "run_command"]),
    );
    const machines = await callTool(client, "list_machines", {});
    expect((machines.structuredContent!.machines as Array<{ machine: string; ready: boolean }>)).toEqual(
      expect.arrayContaining([expect.objectContaining({ machine: "alpha", ready: true })]),
    );

    const command = await callTool(client, "run_command", {
      machine: "alpha",
      command: "printf oauth-e2e",
      cwd: harness.agentRoot,
    });
    expect(command.isError).toBeFalsy();
    expect(resultText(command)).toContain("oauth-e2e");
    const clientId = oauth.clientInformation()!.client_id;
    const ledger = harness.store.recentRequests(10).find((request) => request.tool === "run_command");
    expect(ledger).toMatchObject({ state: "completed", principal: clientId });

    const firstTokens = oauth.tokens()!;
    expect(firstTokens.access_token).toEqual(expect.any(String));
    expect(firstTokens.refresh_token).toEqual(expect.any(String));
    harness.advanceNow(3_601_000);

    await client.listTools();

    expect(oauth.tokenSaves).toBeGreaterThanOrEqual(2);
    expect(oauth.tokens()!.access_token).not.toBe(firstTokens.access_token);
    expect(oauth.tokens()!.refresh_token).not.toBe(firstTokens.refresh_token);
    const oldRefreshHash = createHash("sha256").update(firstTokens.refresh_token!).digest("hex");
    expect(
      harness.store.db
        .prepare("SELECT status FROM oauth_refresh_tokens WHERE token_hash = ?")
        .get(oldRefreshHash),
    ).toMatchObject({ status: "rotated" });
  });

  test("honors narrowed consent: read_file works while run_command is policy_denied", async () => {
    const harness = await makeOAuthHarness();
    const oauth = new InteractiveOAuthClient(
      harness.publicUrl,
      OWNER_PASSPHRASE,
      ["fabric:read", "fabric:write"],
      "Narrow OAuth E2E client",
    );
    const client = await connectThroughOAuth(harness, oauth);
    expect(oauth.consentScopes).toEqual(SCOPES);
    expect(oauth.tokens()!.scope).toBe("fabric:read fabric:write");

    const denied = await callTool(client, "run_command", {
      machine: "alpha",
      command: "printf should-not-run",
      cwd: harness.agentRoot,
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      state: "not_dispatched",
      error_code: "policy_denied",
    });

    const readable = nodePath.join(harness.agentRoot, "readable.txt");
    await writeFile(readable, "oauth-readable\n");
    const read = await callTool(client, "read_file", {
      machine: "alpha",
      path: readable,
    });
    expect(read.isError).toBeFalsy();
    expect(resultText(read)).toContain("oauth-readable");
  });

  test("rejects a real OAuth access token minted for a different resource", async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), "mmf-oauth-foreign-resource-"));
    const store = new HubStore(nodePath.join(dir, "hub"));
    const foreignPort = await unusedPort();
    const foreignUrl = `http://127.0.0.1:${foreignPort}`;
    const foreignProvider = new FabricOAuthProvider({
      db: store.db,
      mcpResourceUrl: `${foreignUrl}/mcp`,
    });
    foreignProvider.setOwnerPassphrase(OWNER_PASSPHRASE);
    const foreignHub = createHub({
      store,
      publicUrl: foreignUrl,
      hubVersion: "oauth-e2e",
      verifier: foreignProvider,
      authRouter: createOAuthRouter({
        provider: foreignProvider,
        issuerUrl: new URL(foreignUrl),
        mcpResourceUrl: new URL(`${foreignUrl}/mcp`),
        resourceName: "Foreign Machine Fabric",
      }),
    });
    await foreignHub.listen(foreignPort, "127.0.0.1");
    let foreignHubOpen = true;
    let targetHub: Hub | undefined;
    try {
      const oauth = new InteractiveOAuthClient(
        foreignUrl,
        OWNER_PASSPHRASE,
        SCOPES,
        "Foreign-resource OAuth client",
      );
      const foreignClient = await connectSdkClient(foreignUrl, oauth);
      const accessToken = oauth.tokens()!.access_token;
      await foreignClient.close();
      await foreignHub.close();
      foreignHubOpen = false;

      const targetPort = await unusedPort();
      const targetUrl = `http://127.0.0.1:${targetPort}`;
      const targetProvider = new FabricOAuthProvider({
        db: store.db,
        mcpResourceUrl: `${targetUrl}/mcp`,
      });
      targetHub = createHub({
        store,
        publicUrl: targetUrl,
        hubVersion: "oauth-e2e",
        verifier: targetProvider,
      });
      await targetHub.listen(targetPort, "127.0.0.1");

      const response = await fetch(`${targetUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: "invalid_token",
        error_description: "token was issued for a different resource",
      });
    } finally {
      if (foreignHubOpen) await foreignHub.close();
      if (targetHub) await targetHub.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
