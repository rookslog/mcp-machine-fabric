import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { connect as connectTcp, isIP } from "node:net";
import { homedir, platform as hostPlatform } from "node:os";
import path from "node:path";
import { connect as connectTls } from "node:tls";
import { promisify } from "node:util";
import WebSocket from "ws";
import { parseFrame, type HubToAgent } from "./shared/protocol.js";

export type DoctorStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  fix: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  exitCode: 0 | 1;
}

export interface DoctorOptions {
  hubUrl?: string;
  tokenFile?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

const execFileAsync = promisify(execFile);
const DEVICE_TOKEN = /^mmf_dev_/;

export async function runDoctor(options: DoctorOptions = {}, output: (line: string) => void = console.log): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? hostPlatform();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const add = (id: string, label: string, status: DoctorStatus, message: string, fix: string) => {
    const check = { id, label, status, message, fix };
    checks.push(check);
    output(`${status} ${label}: ${message} — fix: ${fix}`);
  };

  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  if (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13)) {
    add("node", "Node version", "PASS", process.versions.node, "none");
  } else {
    add("node", "Node version", "FAIL", `${process.versions.node}; requires >= 22.13`, "install Node 22.13 or newer");
  }

  try {
    await import("node:sqlite");
    add("sqlite", "node:sqlite", "PASS", "importable", "none");
  } catch (error) {
    add("sqlite", "node:sqlite", "FAIL", errorMessage(error), "install a Node build that includes node:sqlite");
  }

  const tokenFile = options.tokenFile ?? path.join(home, ".config/mmf/agent.token");
  let token: string | undefined;
  try {
    const info = await stat(tokenFile);
    token = (await readFile(tokenFile, "utf8")).trim();
    add("token_file", "token file", "PASS", tokenFile, "none");
    const mode = info.mode & 0o777;
    if (mode === 0o600) add("token_mode", "token mode", "PASS", "0600", "none");
    else add("token_mode", "token mode", "WARN", mode.toString(8).padStart(4, "0"), `run chmod 600 ${tokenFile}`);
  } catch (error) {
    token = env.MMF_AGENT_TOKEN?.trim();
    if (token && !options.tokenFile) {
      add("token_file", "token file", "WARN", `${tokenFile} not found; using MMF_AGENT_TOKEN`, `create ${tokenFile} with mode 0600`);
      add("token_mode", "token mode", "WARN", "not checked because MMF_AGENT_TOKEN is in use", `create ${tokenFile} with mode 0600`);
    } else {
      add("token_file", "token file", "FAIL", errorMessage(error), `create ${tokenFile} with the enrolled device token and mode 0600`);
    }
  }
  if (token && DEVICE_TOKEN.test(token)) add("token_format", "token format", "PASS", "mmf_dev_ device token", "none");
  else add("token_format", "token format", "FAIL", "expected an mmf_dev_ device token", "enroll this machine again and install the new token");

  const hubValue = options.hubUrl ?? env.MMF_HUB_URL;
  const hub = parseHubUrl(hubValue);
  if (hub.ok) {
    add("hub_url", "hub URL", "PASS", hub.url.href, "none");
    if (hub.url.protocol === "ws:" && !isLoopback(hub.url.hostname)) {
      add("hub_transport", "hub transport", "WARN", "unencrypted ws:// to a non-loopback host", "use wss:// in production");
    } else {
      add("hub_transport", "hub transport", "PASS", hub.url.protocol === "wss:" ? "TLS enabled" : "loopback ws://", "none");
    }
  } else {
    add("hub_url", "hub URL", "FAIL", hub.message, "set MMF_HUB_URL or --hub to ws:// or wss:// ending in /agent");
  }

  let reachable = false;
  if (hub.ok) {
    try {
      await probeReachability(hub.url, timeoutMs);
      reachable = true;
      add("tcp", "TCP/TLS reachability", "PASS", `${hub.url.hostname}:${hubPort(hub.url)}`, "none");
    } catch (error) {
      add("tcp", "TCP/TLS reachability", "FAIL", errorMessage(error), "check DNS, routing, firewall, TLS trust, and whether the hub is listening");
    }
  } else {
    add("tcp", "TCP/TLS reachability", "FAIL", "skipped because the hub URL is invalid", "fix the hub URL first");
  }

  if (hub.ok && reachable && token && DEVICE_TOKEN.test(token)) {
    const handshake = await probeWebSocket(hub.url, token, timeoutMs);
    if (handshake.kind === "welcome") {
      add("websocket", "hub WebSocket", "PASS", `connected as ${handshake.machine}`, "none");
      add(
        "websocket_effect",
        "hub probe safety",
        "WARN",
        "the current hub registers this diagnostic connection and may briefly replace an active agent",
        "run doctor during a maintenance window until the hub provides a non-registering diagnostic handshake",
      );
    } else if (handshake.kind === "unauthorized") {
      add("websocket", "hub WebSocket", "FAIL", "token revoked or wrong hub", "enroll the machine again and replace the device token");
    } else {
      add("websocket", "hub WebSocket", "FAIL", handshake.message, "check the hub logs and confirm the URL ends in /agent");
    }
  } else {
    add("websocket", "hub WebSocket", "FAIL", "skipped because a prerequisite failed", "fix the failed URL, reachability, or token check first");
  }

  const configuredRoots = env.MMF_ROOTS?.split(":").filter(Boolean);
  const roots = (configuredRoots && configuredRoots.length > 0 ? configuredRoots : [home]).map((root) =>
    path.resolve(expandHome(root, home)),
  );
  const badRoots: string[] = [];
  for (const root of roots) {
    try {
      if (!(await stat(root)).isDirectory()) badRoots.push(`${root} (not a directory)`);
    } catch {
      badRoots.push(`${root} (missing)`);
    }
  }
  if (badRoots.length === 0) add("policy_roots", "policy roots", "PASS", roots.join(", "), "none");
  else add("policy_roots", "policy roots", "FAIL", badRoots.join(", "), "create the roots or correct MMF_ROOTS");

  const stateDir = env.MMF_STATE_DIR ?? path.join(home, ".local/state/mmf-agent");
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await access(stateDir, constants.W_OK);
    add("state_dir", "state directory", "PASS", `${stateDir} is writable`, "none");
  } catch (error) {
    add("state_dir", "state directory", "FAIL", errorMessage(error), `create ${stateDir} and grant the agent user write access`);
  }

  if (platform === "linux") await checkLinux(home, env, add);
  else if (platform === "darwin") await checkMacOS(home, add);
  else add("service", "service manager", "WARN", `unsupported platform ${platform}`, "run the agent manually or configure an equivalent service");

  return { checks, exitCode: checks.some((check) => check.status === "FAIL") ? 1 : 0 };
}

type AddCheck = (id: string, label: string, status: DoctorStatus, message: string, fix: string) => void;

async function checkLinux(home: string, env: NodeJS.ProcessEnv, add: AddCheck): Promise<void> {
  const unit = path.join(home, ".config/systemd/user/mmf-agent.service");
  try {
    const text = await readFile(unit, "utf8");
    if (/^KillMode=process\s*$/m.test(text)) add("systemd_unit", "systemd unit", "PASS", "KillMode=process present", "none");
    else add("systemd_unit", "systemd unit", "FAIL", "KillMode=process missing", `add KillMode=process to ${unit} and reload the user daemon`);
  } catch {
    add("systemd_unit", "systemd unit", "WARN", `${unit} not found`, "install the agent service or run the agent manually");
  }

  const user = env.USER ?? env.LOGNAME;
  if (!user) {
    add("linger", "systemd linger", "WARN", "could not determine the user name", "run loginctl enable-linger <user>");
    return;
  }
  try {
    const { stdout } = await execFileAsync("loginctl", ["show-user", user, "-p", "Linger"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (/^Linger=yes\s*$/m.test(stdout)) add("linger", "systemd linger", "PASS", "enabled", "none");
    else add("linger", "systemd linger", "WARN", "disabled", `run loginctl enable-linger ${user}`);
  } catch (error) {
    add("linger", "systemd linger", "WARN", errorMessage(error), `run loginctl enable-linger ${user} if the agent must survive logout`);
  }
}

async function checkMacOS(home: string, add: AddCheck): Promise<void> {
  const plist = path.join(home, "Library/LaunchAgents/dev.mcp-machine-fabric.agent.plist");
  try {
    const text = await readFile(plist, "utf8");
    if (/<key>AbandonProcessGroup<\/key>\s*<true\s*\/>/.test(text)) {
      add("launch_agent", "LaunchAgent", "PASS", "AbandonProcessGroup true", "none");
    } else {
      add("launch_agent", "LaunchAgent", "FAIL", "AbandonProcessGroup true missing", `add AbandonProcessGroup=true to ${plist} and bootstrap it again`);
    }
  } catch {
    add("launch_agent", "LaunchAgent", "WARN", `${plist} not found`, "install the LaunchAgent or run the agent manually");
  }
}

function parseHubUrl(value: string | undefined): { ok: true; url: URL } | { ok: false; message: string } {
  if (!value) return { ok: false, message: "MMF_HUB_URL/--hub is missing; expected ws:// or wss:// ending in /agent" };
  try {
    const url = new URL(value);
    if (!["ws:", "wss:"].includes(url.protocol) || url.pathname !== "/agent" || url.search || url.hash || url.username || url.password) {
      return { ok: false, message: "expected ws:// or wss:// URL ending in /agent" };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, message: "expected ws:// or wss:// URL ending in /agent" };
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function hubPort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "wss:" ? 443 : 80;
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

async function probeReachability(url: URL, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const socket =
      url.protocol === "wss:"
        ? connectTls({ host, port: hubPort(url), servername: isIP(host) ? undefined : host })
        : connectTcp({ host, port: hubPort(url) });
    const event = url.protocol === "wss:" ? "secureConnect" : "connect";
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => done(new Error(`connection timed out after ${timeoutMs}ms`)));
    socket.once("error", done);
    socket.once(event, () => done());
  });
}

type HandshakeResult =
  | { kind: "welcome"; machine: string }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

async function probeWebSocket(url: URL, token: string, timeoutMs: number): Promise<HandshakeResult> {
  return await new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    let settled = false;
    const finish = (result: HandshakeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: "error", message: `welcome timed out after ${timeoutMs}ms` }), timeoutMs);
    socket.on("message", (raw) => {
      const frame = parseFrame<HubToAgent>(raw);
      if (frame?.type === "welcome") finish({ kind: "welcome", machine: frame.machine });
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      if (response.statusCode === 401) finish({ kind: "unauthorized" });
      else finish({ kind: "error", message: `hub answered HTTP ${response.statusCode}` });
    });
    socket.once("error", (error) => finish({ kind: "error", message: error.message }));
    socket.once("close", () => finish({ kind: "error", message: "connection closed before welcome" }));
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
