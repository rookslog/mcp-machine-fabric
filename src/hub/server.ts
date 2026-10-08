import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import express, { type Request, type Response, type Router } from "express";
import { WebSocketServer } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createMcpServer } from "./mcp.js";
import { Registry } from "./registry.js";
import type { HubStore } from "./store.js";
import { renderDashboard } from "./dashboard.js";

export interface HubOptions {
  store: HubStore;
  /** Externally visible base URL, e.g. https://dionysus.tailnet.ts.net (no trailing slash). */
  publicUrl: string;
  hubVersion: string;
  verifier: OAuthTokenVerifier;
  /** Extra routes mounted at / before /mcp (OAuth endpoints, consent page). */
  authRouter?: Router;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface Hub {
  app: express.Express;
  server: Server;
  registry: Registry;
  /** Listen on one or more addresses (e.g. loopback plus a tailnet IP). Returns the bound port. */
  listen(port: number, host: string | string[]): Promise<number>;
  close(): Promise<void>;
}

export function jsonLogger(component: string) {
  return (msg: string, extra?: Record<string, unknown>) => {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), component, msg, ...extra }) + "\n");
  };
}

export function createHub(opts: HubOptions): Hub {
  const log = opts.log ?? (() => {});
  const { store } = opts;
  const recovered = store.markInFlightUnknown();
  if (recovered > 0) log("marked in-flight requests from previous hub run as dispatched_unknown", { count: recovered });

  const registry = new Registry(store, {
    hubVersion: opts.hubVersion,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs,
    log,
  });
  const ctx = { store, registry, hubVersion: opts.hubVersion };
  const mcpUrl = new URL("/mcp", opts.publicUrl);
  const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", opts.publicUrl).href;

  const app = express();
  app.disable("x-powered-by");
  // The hub is expected to sit behind a local reverse proxy (tailscale serve,
  // caddy, cloudflared, OpenAI tunnel-client) on loopback.
  app.set("trust proxy", "loopback");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: opts.hubVersion });
  });
  app.get("/readyz", (_req, res) => {
    try {
      store.db.prepare("SELECT 1").get();
      res.json({ ok: true, machines_connected: registry.allHealth().filter((h) => h.connected).length });
    } catch (err) {
      res.status(503).json({ ok: false, error: String(err) });
    }
  });

  if (opts.authRouter) app.use(opts.authRouter);

  const bearer = requireBearerAuth({ verifier: opts.verifier, resourceMetadataUrl });

  const callerOf = (req: Request) => {
    const auth = (req as Request & { auth?: AuthInfo }).auth!;
    return { principal: auth.clientId, scopes: auth.scopes };
  };

  app.get("/api/status", bearer, (_req, res) => {
    res.json({ version: opts.hubVersion, machines: registry.allHealth() });
  });
  app.get("/api/requests", bearer, (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 50) || 50, 500));
    res.json({ requests: store.recentRequests(limit, typeof req.query.machine === "string" ? req.query.machine : undefined) });
  });
  app.get("/", (_req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'");
    res.type("html").send(renderDashboard(opts.hubVersion));
  });

  app.post("/mcp", bearer, express.json({ limit: "64mb" }), async (req: Request, res: Response) => {
    const auth = (req as Request & { auth?: AuthInfo }).auth!;
    if (auth.resource && auth.resource.href !== mcpUrl.href) {
      res.status(401).json({ error: "invalid_token", error_description: "token was issued for a different resource" });
      return;
    }
    const server = createMcpServer(ctx, callerOf(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("mcp request failed", { error: String(err) });
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  });
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const server = createServer(app);
  const extraServers: Server[] = [];
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://hub");
    if (url.pathname !== "/agent") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const device = token ? store.deviceByToken(token) : null;
    if (!device) {
      log("rejected agent connection: bad device token", { remote: req.socket.remoteAddress });
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      log("agent connected", { machine: device.name });
      registry.attach(device.name, device.id, ws);
    });
  };
  server.on("upgrade", onUpgrade);

  const listenOne = (srv: Server, port: number, host: string) =>
    new Promise<number>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, host, () => {
        const addr = srv.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });

  return {
    app,
    server,
    registry,
    async listen(port, host) {
      const hosts = Array.isArray(host) ? host : [host];
      const bound = await listenOne(server, port, hosts[0]);
      for (const h of hosts.slice(1)) {
        const extra = createServer(app);
        extra.on("upgrade", onUpgrade);
        extraServers.push(extra);
        await listenOne(extra, bound, h);
      }
      return bound;
    },
    async close() {
      registry.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      const all = [server, ...extraServers];
      const closed = Promise.all(all.map((srv) => new Promise<void>((r) => (srv.listening ? srv.close(() => r()) : r()))));
      // Give in-flight MCP responses (now resolved as dispatched_unknown) a moment to flush.
      await new Promise((r) => setTimeout(r, 50));
      for (const srv of all) srv.closeAllConnections();
      await closed;
    },
  };
}
