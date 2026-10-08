import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { Agent } from "../src/agent/agent.js";
import { normalizePolicy } from "../src/agent/policy.js";
import { createHub, type Hub } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";

export const ALL = ["fabric:read", "fabric:write", "fabric:exec"];

export class StaticVerifier implements OAuthTokenVerifier {
  constructor(private tokens: Record<string, string[]>) {}
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const scopes = this.tokens[token];
    if (!scopes) throw new InvalidTokenError("unknown token");
    return { token, clientId: `test:${token}`, scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  }
}

export interface Harness {
  dir: string;
  store: HubStore;
  hub: Hub;
  port: number;
  url: string;
  agents: Record<string, { agent: Agent; root: string; stateDir: string; token: string }>;
  client(token?: string): Promise<Client>;
  startAgent(name: string, opts?: { readOnly?: boolean; noExec?: boolean }): Promise<Agent>;
  restartHub(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function makeHarness(machineNames: string[], verifierTokens: Record<string, string[]> = { owner: ALL }): Promise<Harness> {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "mmf-e2e-"));
  const dataDir = nodePath.join(dir, "hub");
  let store = new HubStore(dataDir);
  const verifier = new StaticVerifier(verifierTokens);
  const mk = (s: HubStore) =>
    createHub({ store: s, publicUrl: "http://127.0.0.1:0", hubVersion: "test", verifier, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 2000 });
  let hub = mk(store);
  const port = await hub.listen(0, "127.0.0.1");
  const tokens: Record<string, string> = {};
  for (const m of machineNames) tokens[m] = store.addDevice(m).token;
  const clients: Client[] = [];

  const h: Harness = {
    dir,
    store,
    hub,
    port,
    url: `http://127.0.0.1:${port}`,
    agents: {},
    async client(token = "owner") {
      const c = new Client({ name: "e2e", version: "0" });
      const t = new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      await c.connect(t);
      clients.push(c);
      return c;
    },
    async startAgent(name, opts = {}) {
      const existing = h.agents[name];
      const root = existing?.root ?? (await mkdtemp(nodePath.join(dir, `root-${name}-`)));
      const stateDir = existing?.stateDir ?? nodePath.join(dir, `state-${name}`);
      const policy = await normalizePolicy({ roots: [root], read_only: opts.readOnly, allow_exec: !opts.noExec });
      const agent = new Agent({ hubUrl: `ws://127.0.0.1:${port}/agent`, token: tokens[name], policy, stateDir, minBackoffMs: 100, maxBackoffMs: 500 });
      await agent.start();
      await agent.waitConnected();
      h.agents[name] = { agent, root: policy.roots[0], stateDir, token: tokens[name] };
      return agent;
    },
    async restartHub() {
      await hub.close();
      store.close();
      store = new HubStore(dataDir);
      hub = mk(store);
      await hub.listen(port, "127.0.0.1");
      h.store = store;
      h.hub = hub;
    },
    async cleanup() {
      for (const c of clients) await c.close().catch(() => {});
      for (const a of Object.values(h.agents)) await a.agent.stop();
      await hub.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return h;
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 10_000, stepMs = 50): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

type CallResult = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, any>; isError?: boolean };

export async function call(c: Client, name: string, args: Record<string, unknown>): Promise<CallResult> {
  return (await c.callTool({ name, arguments: args })) as CallResult;
}

export function text(r: CallResult): string {
  return r.content.map((x) => x.text ?? "").join("\n");
}
