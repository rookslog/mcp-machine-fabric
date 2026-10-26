// Lane REVIEW-AUTH finding: the LOW-6 registration cap turns unbounded DCR
// storage into a 30-day lockout. Unauthenticated registrations from rotating
// addresses (the SDK limiter is 20/hour per req.ip) fill the 500-client cap,
// and the owner's new connector can no longer register. Expected to FAIL on e2c9e77.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { afterEach, expect, test } from "vitest";
import { FabricOAuthProvider, createOAuthRouter } from "../src/hub/oauth.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

test("anonymous registrations cannot lock the owner's next connector out of DCR", async () => {
  let now = 1_800_000_000_000;
  const db = new DatabaseSync(":memory:");
  const app = express();
  app.set("trust proxy", "loopback"); // as src/hub/server.ts
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const provider = new FabricOAuthProvider({ db, mcpResourceUrl: `${baseUrl}/mcp`, now: () => now });
  app.use(createOAuthRouter({ provider, issuerUrl: new URL(baseUrl), mcpResourceUrl: new URL(`${baseUrl}/mcp`), resourceName: "t" }));
  closers.push(async () => {
    server.closeAllConnections();
    server.close();
    db.close();
  });

  const register = (ip: string, name: string) =>
    fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ redirect_uris: ["https://attacker.example/cb"], token_endpoint_auth_method: "none", client_name: name }),
    });

  // 25 addresses x 20 registrations = the whole 500-client cap.
  for (let ip = 0; ip < 25; ip += 1) {
    const batch = await Promise.all(Array.from({ length: 20 }, (_, i) => register(`203.0.113.${ip + 1}`, `junk-${ip}-${i}`)));
    expect(batch.map((r) => r.status)).toEqual(Array(20).fill(201));
  }

  // Two weeks later the owner adds ChatGPT (or Claude) as a connector.
  now += 14 * 24 * 60 * 60 * 1000;
  const owner = await register("198.51.100.7", "ChatGPT");
  expect(owner.status, JSON.stringify(await owner.json())).toBe(201);
}, 60_000);

// Cap eviction must not invalidate a live consent, authorization code, or grant.
test("capacity eviction removes the oldest unused client and preserves active clients", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    let now = 1_800_000_000_000;
    const provider = new FabricOAuthProvider({ db, mcpResourceUrl: "http://localhost/mcp", now: () => now });
    const register = () => provider.clientsStore.registerClient({ redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "none" });
    const pending = await register(), coded = await register(), tokened = await register();
    const ts = Math.floor(now / 1000);
    db.prepare("INSERT INTO oauth_pending_authorizations (id,client_id,redirect_uri,code_challenge,scopes_json,resource,created_at,expires_at) VALUES ('pending',?,'https://client.example/cb','challenge','[]','http://localhost/mcp',?,?)").run(pending.client_id, ts, ts + 600);
    db.prepare("INSERT INTO oauth_authorization_codes (code_hash,client_id,redirect_uri,code_challenge,scopes_json,resource,created_at,expires_at) VALUES ('code',?,'https://client.example/cb','challenge','[]','http://localhost/mcp',?,?)").run(coded.client_id, ts, ts + 600);
    db.prepare("UPDATE oauth_clients SET token_issued_at = ? WHERE client_id = ?").run(ts, tokened.client_id);
    const oldest = await register();
    for (let i = 0; i < 496; i++) await register();
    await expect(Promise.resolve().then(register)).resolves.toBeDefined();
    expect(await provider.clientsStore.getClient(oldest.client_id)).toBeUndefined();
    for (const client of [pending, coded, tokened]) expect(await provider.clientsStore.getClient(client.client_id)).toBeDefined();
    now += 3601_000;
    provider.pruneOAuthStorage();
    expect((db.prepare("SELECT COUNT(*) AS count FROM oauth_clients").get() as { count: number }).count).toBe(1);
    expect(await provider.clientsStore.getClient(tokened.client_id)).toBeDefined();
  } finally { db.close(); }
});
