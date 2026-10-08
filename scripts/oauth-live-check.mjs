#!/usr/bin/env node
// Live OAuth check: connect to a hub the way ChatGPT/Claude connectors do —
// discovery from a 401, dynamic client registration, PKCE authorization code
// flow, owner consent — with the MCP SDK's own OAuth client. The "human" step
// (consent page + passphrase) is scripted.
//
//   MMF_OWNER_PASSPHRASE=… node scripts/oauth-live-check.mjs --url https://hub/mcp [--scopes fabric:read,fabric:write]
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

const { values } = parseArgs({ options: { url: { type: "string" }, scopes: { type: "string" } } });
const passphrase = process.env.MMF_OWNER_PASSPHRASE;
if (!values.url || !passphrase) {
  console.error("usage: MMF_OWNER_PASSPHRASE=… oauth-live-check.mjs --url URL [--scopes a,b]");
  process.exit(2);
}
const grant = values.scopes ? values.scopes.split(",") : null;
const redirectUrl = "http://127.0.0.1:53682/callback";
const log = (...a) => console.log(...a);

let codeFromConsent = null;
const store = {};
const provider = {
  get redirectUrl() {
    return redirectUrl;
  },
  get clientMetadata() {
    return { client_name: "mmf oauth live check", redirect_uris: [redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  },
  clientInformation: () => store.client,
  saveClientInformation: (c) => {
    store.client = c;
    log("registered client", c.client_id);
  },
  tokens: () => store.tokens,
  saveTokens: (t) => {
    store.tokens = t;
    log("received tokens; scope =", t.scope, "expires_in =", t.expires_in, "refresh =", !!t.refresh_token);
  },
  saveCodeVerifier: (v) => (store.verifier = v),
  codeVerifier: () => store.verifier,
  async redirectToAuthorization(url) {
    log("authorize URL host:", url.host, "scopes requested:", url.searchParams.get("scope"));
    const page = await fetch(url, { redirect: "manual" });
    const html = await page.text();
    const pending = /name="pending_id" value="([^"]+)"/.exec(html)?.[1];
    if (!pending) throw new Error(`consent page missing pending id (HTTP ${page.status})`);
    const offered = [...html.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1]);
    log("consent page offers scopes:", offered.join(" "));
    const body = new URLSearchParams({ pending_id: pending, passphrase, action: "approve" });
    for (const s of grant ?? offered) body.append("scope", s);
    const res = await fetch(new URL("/oauth/approve", url), { method: "POST", body, redirect: "manual" });
    const loc = res.headers.get("location");
    if (res.status !== 302 || !loc) throw new Error(`approve did not redirect (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    const back = new URL(loc);
    codeFromConsent = back.searchParams.get("code");
    if (!codeFromConsent) throw new Error(`no code in redirect: ${loc}`);
    log("consent approved; got authorization code");
  },
};

const url = new URL(values.url);
const unauth = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
log("unauthenticated POST /mcp ->", unauth.status, unauth.headers.get("www-authenticate"));

let transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
let client = new Client({ name: "mmf-oauth-live-check", version: "0" });
try {
  await client.connect(transport);
} catch (err) {
  if (!(err instanceof UnauthorizedError)) throw err;
  await transport.finishAuth(codeFromConsent);
  transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  client = new Client({ name: "mmf-oauth-live-check", version: "0" });
  await client.connect(transport);
}
const { tools } = await client.listTools();
log("tools/list ->", tools.length, "tools");
const lm = await client.callTool({ name: "list_machines", arguments: {} });
log("list_machines ->", lm.content[0].text.split("\n").join(" | "));
const machines = lm.structuredContent.machines.filter((m) => m.ready);
if (machines.length) {
  const m = machines[0];
  const root = m.agent.policy.roots[0];
  const w = await client.callTool({ name: "write_file", arguments: { machine: m.machine, path: `${root}/oauth-live-check.txt`, content: `ok ${new Date().toISOString()}\n` } });
  log("write_file ->", w.isError ? "ERROR " : "", w.content[0].text);
  const r = await client.callTool({ name: "read_file", arguments: { machine: m.machine, path: `${root}/oauth-live-check.txt` } });
  log("read_file ->", r.isError ? "ERROR " : "", r.content[0].text.replace(/\n/g, " | "));
  const x = await client.callTool({ name: "run_command", arguments: { machine: m.machine, command: "echo exec-allowed" } });
  log("run_command ->", x.isError ? "ERROR " : "", x.content[0].text.replace(/\n/g, " | "));
}
// Refresh-token rotation through the real token endpoint.
const asMeta = await (await fetch(new URL("/.well-known/oauth-authorization-server", url))).json();
const refreshed = await fetch(asMeta.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: store.tokens.refresh_token, client_id: store.client.client_id }),
});
const rj = await refreshed.json();
log("refresh ->", refreshed.status, rj.access_token ? "new access token issued" : JSON.stringify(rj));
const reuse = await fetch(asMeta.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: store.tokens.refresh_token, client_id: store.client.client_id }),
});
log("refresh-token reuse ->", reuse.status, (await reuse.text()).slice(0, 120));
await client.close();
