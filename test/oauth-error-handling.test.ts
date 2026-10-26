// Lane REVIEW-AUTH finding: an unauthenticated POST /authorize whose body is
// not urlencoded makes validateAuthorizationRequest() dereference an undefined
// req.body. The hub has no error handler, and the shipped systemd unit does not
// set NODE_ENV=production, so Express answers 500 with the stack trace and the
// absolute install path. Expected to FAIL on e2c9e77.
import express from "express";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { FabricOAuthProvider, createOAuthRouter } from "../src/hub/oauth.js";
import { createHub, type Hub } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

test("a malformed unauthenticated /authorize POST does not leak a stack trace", async () => {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "mmf-lane-leak-"));
  const store = new HubStore(dir);
  const publicUrl = "http://127.0.0.1:1"; // only used for URLs in metadata
  const provider = new FabricOAuthProvider({ db: store.db, mcpResourceUrl: `${publicUrl}/mcp` });
  const hub: Hub = createHub({
    store,
    publicUrl,
    hubVersion: "test",
    verifier: provider,
    authRouter: createOAuthRouter({ provider, issuerUrl: new URL(publicUrl), mcpResourceUrl: new URL(`${publicUrl}/mcp`), resourceName: "t" }),
  });
  const port = await hub.listen(0, "127.0.0.1");
  closers.push(async () => {
    await hub.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${port}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: "x" }),
  });
  const body = await res.text();
  const leakedFrames = body.split(/<br>|\n/).filter((line) => /validateAuthorizationRequest|src\/hub\/oauth|node_modules/.test(line)).length;
  console.log(`[lane-auth] status ${res.status}; ${leakedFrames} stack lines with source paths in the body`);
  expect(leakedFrames).toBe(0);
  expect(res.status).toBeLessThan(500);
});

async function errorHarness() {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "mmf-errors-"));
  const store = new HubStore(dir);
  const provider = new FabricOAuthProvider({ db: store.db, mcpResourceUrl: "http://localhost/mcp", listMachines: () => ["alpha"] });
  provider.setOwnerPassphrase("correct horse battery staple");
  const routes = express.Router();
  routes.get("/unexpected", () => { throw new Error("private-install-path/sentinel"); });
  routes.use(createOAuthRouter({ provider, issuerUrl: new URL("http://localhost"), mcpResourceUrl: new URL("http://localhost/mcp"), resourceName: "test" }));
  const hub = createHub({ store, publicUrl: "http://localhost", hubVersion: "test", verifier: provider, authRouter: routes });
  const port = await hub.listen(0, "127.0.0.1");
  closers.push(async () => { await hub.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${port}`, provider };
}

test("unexpected route failures return a generic 500 without stack or paths", async () => {
  const { base } = await errorHarness();
  const res = await fetch(`${base}/unexpected`);
  expect(res.status).toBe(500);
  const body = await res.text();
  expect(body).not.toMatch(/sentinel|node_modules|Error:|at /);
  expect(body).toContain("Internal server error");
});

test("approving a request with no requested fabric scope renders a consent error", async () => {
  const { base, provider } = await errorHarness();
  const client = await provider.clientsStore.registerClient({ redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "none" });
  const url = new URL("/authorize", base);
  for (const [k, v] of Object.entries({ client_id: client.client_id, response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update("x".repeat(64)).digest("base64url"), scope: "machine:alpha" })) url.searchParams.set(k, v);
  const html = await (await fetch(url)).text();
  const pending = html.match(/name="pending_id" value="([^"]+)"/)![1];
  const res = await fetch(`${base}/oauth/approve`, { method: "POST", body: new URLSearchParams({ pending_id: pending, action: "approve", passphrase: "correct horse battery staple", scope: "fabric:read" }), redirect: "manual" });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("At least one fabric scope is required");
  expect(provider.getPendingAuthorization(pending)).toBeDefined();
});
