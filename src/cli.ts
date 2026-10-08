#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import { parseArgs } from "node:util";
import { Agent } from "./agent/agent.js";
import { normalizePolicy } from "./agent/policy.js";
import { createOAuthRouter, FabricOAuthProvider, SCOPES } from "./hub/oauth.js";
import { createHub, jsonLogger } from "./hub/server.js";
import { HubStore } from "./hub/store.js";
import { VERSION } from "./version.js";

const USAGE = `mcp-machine-fabric ${VERSION}

Hub (run on the always-on host):
  mmf hub [--port 8787] [--host 127.0.0.1] [--public-url URL] [--data-dir DIR]
  mmf passphrase                      set the owner passphrase (read from stdin)
  mmf device add <name>               enroll a machine; prints its device token ONCE
  mmf device list | revoke <name>
  mmf token create <name> [--scopes fabric:read,fabric:write,fabric:exec]
  mmf token list | revoke <id>        personal access tokens for CLI MCP clients
  mmf status [--url URL] [--token-file F]   machine health as the hub sees it

Agent (run on every machine you want to control):
  mmf agent --hub wss://HUB/agent --token-file FILE [--root DIR ...] [--read-only] [--no-exec] [--state-dir DIR]
            (or MMF_AGENT_TOKEN in the environment)

Environment: hub: MMF_DATA_DIR (default ~/.local/share/mmf-hub), MMF_PUBLIC_URL, MMF_PORT, MMF_HOST (comma-separated addresses)
             agent: MMF_HUB_URL, MMF_AGENT_TOKEN, MMF_ROOTS (colon-separated), MMF_READ_ONLY=1, MMF_NO_EXEC=1, MMF_STATE_DIR
`;

function dataDir(flag?: string): string {
  return flag ?? process.env.MMF_DATA_DIR ?? nodePath.join(homedir(), ".local/share/mmf-hub");
}

function publicUrl(flag: string | undefined, port: number): string {
  return (flag ?? process.env.MMF_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
}

function openProvider(dir: string, pub: string) {
  const store = new HubStore(dir);
  const provider = new FabricOAuthProvider({ db: store.db, mcpResourceUrl: `${pub}/mcp` });
  return { store, provider };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "hub": {
      const { values } = parseArgs({
        args: rest,
        options: {
          port: { type: "string" },
          host: { type: "string" },
          "public-url": { type: "string" },
          "data-dir": { type: "string" },
        },
      });
      const port = Number(values.port ?? process.env.MMF_PORT ?? 8787);
      const host = values.host ?? process.env.MMF_HOST ?? "127.0.0.1";
      const pub = publicUrl(values["public-url"], port);
      const log = jsonLogger("hub");
      const { store, provider } = openProvider(dataDir(values["data-dir"]), pub);
      if (!provider.hasOwnerPassphrase()) {
        log("WARNING: no owner passphrase set; OAuth consent cannot be approved until you run `mmf passphrase`");
      }
      // OAuth 2.1 requires an HTTPS issuer (loopback excepted). Behind plain
      // HTTP (e.g. a raw tailnet address) only personal access tokens work.
      const pubUrl = new URL(pub);
      const oauthOk = pubUrl.protocol === "https:" || ["localhost", "127.0.0.1"].includes(pubUrl.hostname);
      if (!oauthOk) log("OAuth disabled: public URL is not HTTPS; only personal access tokens (mmf token create) will authenticate", { public_url: pub });
      const hub = createHub({
        store,
        publicUrl: pub,
        hubVersion: VERSION,
        verifier: provider,
        authRouter: oauthOk
          ? createOAuthRouter({ provider, issuerUrl: pubUrl, mcpResourceUrl: new URL(`${pub}/mcp`), resourceName: "Machine Fabric" })
          : undefined,
        log,
      });
      const bound = await hub.listen(port, host.split(",").map((h) => h.trim()).filter(Boolean));
      log("hub listening", { host, port: bound, public_url: pub, mcp: `${pub}/mcp`, agent_ws: `${pub.replace(/^http/, "ws")}/agent` });
      const prune = setInterval(() => store.pruneRequests(30 * 24 * 3600 * 1000), 3600 * 1000);
      prune.unref();
      const shutdown = async (sig: string) => {
        log("shutting down", { signal: sig });
        await hub.close();
        store.close();
        process.exit(0);
      };
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      process.on("SIGINT", () => void shutdown("SIGINT"));
      return new Promise(() => {});
    }
    case "passphrase": {
      const pub = publicUrl(undefined, 8787);
      const { store, provider } = openProvider(dataDir(), pub);
      if (process.stdin.isTTY) process.stderr.write("Enter new owner passphrase (min 12 chars), then Ctrl-D: ");
      const pass = await readStdin();
      provider.setOwnerPassphrase(pass);
      store.close();
      console.log("Owner passphrase set.");
      return 0;
    }
    case "device": {
      const [sub, name] = rest;
      const store = new HubStore(dataDir());
      try {
        if (sub === "add" && name) {
          const { token } = store.addDevice(name);
          const pub = process.env.MMF_PUBLIC_URL?.replace(/\/+$/, "");
          const wsUrl = pub ? `${pub.replace(/^http/, "ws")}/agent` : "wss://<hub>/agent";
          console.log(`Enrolled ${name}. Device token (shown once):\n${token}\n`);
          console.log(`On ${name}, from a checkout of this repo (after ./scripts/install-release.sh):`);
          console.log(`  echo '<token>' | ./scripts/install-agent.sh --hub ${wsUrl} --root ~`);
        } else if (sub === "list") {
          for (const d of store.listDevices()) {
            console.log(`${d.name}\t${d.revoked_at ? "revoked" : "active"}\tlast_seen=${d.last_seen_at ? new Date(d.last_seen_at).toISOString() : "never"}`);
          }
        } else if (sub === "revoke" && name) {
          console.log(store.revokeDevice(name) ? `Revoked ${name}. Restart the hub or wait for the agent to reconnect to drop it.` : `No active device ${name}.`);
        } else {
          console.error(USAGE);
          return 2;
        }
      } finally {
        store.close();
      }
      return 0;
    }
    case "token": {
      const [sub, ...more] = rest;
      const { values, positionals } = parseArgs({ args: more, options: { scopes: { type: "string" } }, allowPositionals: true });
      const pub = publicUrl(undefined, 8787);
      const { store, provider } = openProvider(dataDir(), pub);
      try {
        if (sub === "create" && positionals[0]) {
          const scopes = values.scopes ? values.scopes.split(",").map((s) => s.trim()) : [...SCOPES];
          const { id, token } = provider.createPersonalToken(positionals[0], scopes);
          console.log(`Created token ${id} (${scopes.join(" ")}). Shown once:\n${token}`);
        } else if (sub === "list") {
          for (const t of provider.listPersonalTokens()) console.log(JSON.stringify(t));
        } else if (sub === "revoke" && positionals[0]) {
          provider.revokePersonalToken(positionals[0]);
          console.log(`Revoked ${positionals[0]}.`);
        } else {
          console.error(USAGE);
          return 2;
        }
      } finally {
        store.close();
      }
      return 0;
    }
    case "agent": {
      const { values } = parseArgs({
        args: rest,
        options: {
          hub: { type: "string" },
          "token-file": { type: "string" },
          root: { type: "string", multiple: true },
          "read-only": { type: "boolean" },
          "no-exec": { type: "boolean" },
          "state-dir": { type: "string" },
        },
      });
      const hubUrl = values.hub ?? process.env.MMF_HUB_URL;
      const token = values["token-file"] ? readFileSync(values["token-file"], "utf8").trim() : process.env.MMF_AGENT_TOKEN;
      if (!hubUrl || !token) {
        console.error("agent needs --hub (or MMF_HUB_URL) and --token-file (or MMF_AGENT_TOKEN)\n\n" + USAGE);
        return 2;
      }
      const envRoots = process.env.MMF_ROOTS ? process.env.MMF_ROOTS.split(":").filter(Boolean) : undefined;
      const truthy = (v: string | undefined) => v === "1" || v === "true";
      const policy = await normalizePolicy({
        roots: values.root ?? envRoots,
        read_only: values["read-only"] ?? truthy(process.env.MMF_READ_ONLY),
        allow_exec: !(values["no-exec"] ?? truthy(process.env.MMF_NO_EXEC)),
      });
      const log = jsonLogger("agent");
      const stateDir = values["state-dir"] ?? process.env.MMF_STATE_DIR ?? nodePath.join(homedir(), ".local/state/mmf-agent");
      const agent = new Agent({ hubUrl, token, policy, stateDir, log });
      await agent.start();
      log("agent started", { hub: hubUrl, policy, state_dir: stateDir });
      const shutdown = async (sig: string) => {
        log("agent stopping (running jobs keep running)", { signal: sig });
        await agent.stop();
        process.exit(0);
      };
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      process.on("SIGINT", () => void shutdown("SIGINT"));
      return new Promise(() => {});
    }
    case "status": {
      const { values } = parseArgs({ args: rest, options: { url: { type: "string" }, "token-file": { type: "string" } } });
      const base = (values.url ?? process.env.MMF_PUBLIC_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
      const token = values["token-file"] ? readFileSync(values["token-file"], "utf8").trim() : process.env.MMF_TOKEN;
      if (!token) {
        console.error("status needs --token-file or MMF_TOKEN (a PAT with fabric:read)");
        return 2;
      }
      const res = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        console.error(`hub answered ${res.status}`);
        return 1;
      }
      const body = (await res.json()) as { version: string; machines: Array<Record<string, any>> };
      console.log(`hub ${base} v${body.version}`);
      for (const m of body.machines) {
        console.log(
          `${m.machine.padEnd(16)} ${m.ready ? "READY    " : "NOT READY"} ${m.reason ?? ""}${m.agent ? ` ${m.agent.platform}/${m.agent.arch} agent ${m.agent.agent_version}` : ""}${m.heartbeat_rtt_ms != null ? ` rtt=${m.heartbeat_rtt_ms}ms` : ""}${m.executor ? ` jobs=${m.executor.running_jobs}` : ""} last_seen=${m.last_seen ?? "never"}`,
        );
      }
      return 0;
    }
    case "version":
    case "--version":
      console.log(VERSION);
      return 0;
    default:
      console.log(USAGE);
      return cmd ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
