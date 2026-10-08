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

Agent (run on every machine you want to control):
  mmf agent --hub wss://HUB/agent --token-file FILE [--root DIR ...] [--read-only] [--no-exec] [--state-dir DIR]
            (or MMF_AGENT_TOKEN in the environment)

Environment: MMF_DATA_DIR (hub data, default ~/.local/share/mmf-hub), MMF_PUBLIC_URL, MMF_PORT, MMF_HOST.
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
      const hub = createHub({
        store,
        publicUrl: pub,
        hubVersion: VERSION,
        verifier: provider,
        authRouter: createOAuthRouter({ provider, issuerUrl: new URL(pub), mcpResourceUrl: new URL(`${pub}/mcp`), resourceName: "Machine Fabric" }),
        log,
      });
      const bound = await hub.listen(port, host);
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
          console.log(`Enrolled ${name}. Device token (shown once; store it in a 0600 file on that machine):\n${token}`);
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
      const policy = await normalizePolicy({
        roots: values.root,
        read_only: values["read-only"] ?? false,
        allow_exec: !(values["no-exec"] ?? false),
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
