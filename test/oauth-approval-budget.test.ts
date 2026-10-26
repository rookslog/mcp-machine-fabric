// Lane REVIEW-AUTH finding: the consent-approval throttle is keyed only by
// pending id and full client IP, and its "global pressure" delay is computed
// before the request's own failure is recorded, so a concurrent burst from
// rotating addresses (one IPv6 /64) gets every guess evaluated by scrypt with
// no delay and no 429. Expected to FAIL on e2c9e77.
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { afterEach, expect, test } from "vitest";
import { FabricOAuthProvider, createOAuthRouter } from "../src/hub/oauth.js";

const OWNER_PASSPHRASE = "correct horse battery staple";
const VERIFIER = "b".repeat(64);
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function harness(now?: () => number) {
  const db = new DatabaseSync(":memory:");
  const app = express();
  app.set("trust proxy", "loopback"); // as src/hub/server.ts
  app.get("/ping", (_req, res) => res.send("pong"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const provider = new FabricOAuthProvider({ db, mcpResourceUrl: `${baseUrl}/mcp`, now, listMachines: () => ["alpha"] });
  provider.setOwnerPassphrase(OWNER_PASSPHRASE);
  app.use(createOAuthRouter({ provider, issuerUrl: new URL(baseUrl), mcpResourceUrl: new URL(`${baseUrl}/mcp`), resourceName: "t" }));
  closers.push(async () => {
    server.closeAllConnections();
    server.close();
    db.close();
  });
  return { baseUrl, provider };
}

test("rotating addresses inside one IPv6 /64 do not get unthrottled passphrase guesses", async () => {
  const { baseUrl } = await harness();
  const reg = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://attacker.example/cb"], token_endpoint_auth_method: "none", client_name: "x" }),
  });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const challenge = createHash("sha256").update(VERIFIER).digest("base64url");
  const addr = (i: number) => `2001:db8:0:1::${(i + 1).toString(16)}`;

  const GUESSES = 120;
  const pendings: string[] = [];
  for (let i = 0; i < GUESSES / 4; i += 1) {
    const url = new URL("/authorize", baseUrl);
    for (const [k, v] of Object.entries({ client_id: clientId, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" })) url.searchParams.set(k, v);
    const html = await (await fetch(url, { headers: { "x-forwarded-for": addr(1000 + i) } })).text();
    pendings.push(html.match(/name="pending_id" value="([A-Za-z0-9_-]+)"/)![1]!);
  }

  let maxPingMs = 0;
  let stop = false;
  const pinger = (async () => {
    while (!stop) {
      const t = Date.now();
      await fetch(`${baseUrl}/ping`);
      maxPingMs = Math.max(maxPingMs, Date.now() - t);
      await new Promise((r) => setTimeout(r, 10));
    }
  })();

  const started = Date.now();
  const statuses = await Promise.all(
    Array.from({ length: GUESSES }, async (_, i) => {
      const body = new URLSearchParams({ pending_id: pendings[Math.floor(i / 4)]!, action: "approve", passphrase: `guess-number-${i}`, scope: "fabric:read" });
      const res = await fetch(`${baseUrl}/oauth/approve`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": addr(i) },
        body,
      });
      const html = await res.text();
      return html.includes("Incorrect passphrase") ? "evaluated" : String(res.status);
    }),
  );
  const elapsedMs = Date.now() - started;
  stop = true;
  await pinger;
  const evaluated = statuses.filter((s) => s === "evaluated").length;
  console.log(`[lane-auth] ${evaluated}/${GUESSES} guesses evaluated in ${elapsedMs} ms; worst /ping latency ${maxPingMs} ms`);

  // A per-/64 (or global) budget at the per-IP limit of 20 would stop this burst.
  expect(maxPingMs).toBeLessThan(2_000);
  expect(evaluated, `${evaluated} passphrase guesses evaluated in ${elapsedMs} ms from one /64`).toBeLessThanOrEqual(20);
}, 120_000);

// A missing global ceiling would evaluate every request across distinct networks.
test("the global failure budget survives address rotation and expires after the window", async () => {
  let now = 1_800_000_000_000;
  const { baseUrl, provider } = await harness(() => now);
  const client = await provider.clientsStore.registerClient({ redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "none" });
  const pendingIds: string[] = [];
  for (let i = 0; i < 45; i++) {
    const url = new URL("/authorize", baseUrl);
    for (const [k, v] of Object.entries({ client_id: client.client_id, response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(VERIFIER).digest("base64url") })) url.searchParams.set(k, v);
    const html = await (await fetch(url)).text();
    pendingIds.push(html.match(/name="pending_id" value="([^"]+)"/)![1]);
  }
  const approve = (id: string, i: number) => fetch(`${baseUrl}/oauth/approve`, { method: "POST", headers: { "x-forwarded-for": `2001:db8:${i.toString(16)}::1` }, body: new URLSearchParams({ pending_id: id, action: "approve", passphrase: "incorrect example passphrase", scope: "fabric:read" }) });
  const responses = await Promise.all(pendingIds.map(approve));
  expect(responses.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(5);
  const bodies = await Promise.all(responses.map((r) => r.text()));
  expect(bodies.filter((body) => body.includes("Incorrect passphrase")).length).toBeLessThanOrEqual(40);
  now += 15 * 60 * 1000 + 1;
  expect(provider.enforceHubApprovalLockout("fresh", "2001:db8:abcd::1")).toBe(false);
}, 60_000);
