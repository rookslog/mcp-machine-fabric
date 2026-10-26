#!/usr/bin/env node
// Bounded doctor double: 0.0.16 JSON/text contract, with a legacy 0.0.9 mode.
// Exercise real profile/header reads, HTTP probes and health binds. Never poll.
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

const args = process.argv.slice(2);
const legacy = process.env.MMF_TEST_TUNNEL_CLIENT_LEGACY === "1";
if (args.length === 1 && args[0] === "--version") {
  console.log(legacy ? "0.0.9-test-stub" : "0.0.16-test-stub");
  process.exit(0);
}
if (args.shift() !== "doctor") throw new Error("test stub only permits doctor and --version; no daemon or control-plane calls");
const options = new Map();
while (args.length) {
  const flag = args.shift();
  if (["--json", "--explain"].includes(flag)) options.set(flag, true);
  else if (["--profile", "--profile-dir"].includes(flag) && args.length) options.set(flag, args.shift());
  else throw new Error(`unsupported test stub argument: ${flag}`);
}
if (!options.has("--profile") || !options.has("--profile-dir")) throw new Error("explicit isolated profile required");
const file = path.join(options.get("--profile-dir"), `${options.get("--profile")}.yaml`);
const text = await readFile(file, "utf8");
// The setup script emits JSON-quoted YAML scalars. This double accepts that
// bounded format rather than pretending to be a general-purpose YAML parser.
const scalar = (key) => {
  const match = text.match(new RegExp(`^\\s*${key}: (".*")$`, "m"));
  if (!match) throw new Error(`missing quoted profile field: ${key}`);
  return JSON.parse(match[1]);
};
if (!text.includes("config_version: 1\n")) throw new Error("unsupported config version");
const checks = [
  { id: "config_source", status: "PASS", summary: `profile: ${options.get("--profile")}` },
  { id: "profile_load", status: "PASS", summary: file },
];
const check = (id, status, summary, details = {}) => checks.push({ id, status, summary, ...details });
const id = scalar("tunnel_id");
const validId = /^tunnel_[a-z0-9]{32}$/.test(id);
const malformedKey = !legacy && /\s/.test(process.env.CONTROL_PLANE_API_KEY || "");
if (!malformedKey) check("tunnel_id", validId ? "PASS" : "FAIL", validId ? id : `invalid tunnel ID "${id}": must match tunnel_<32 lowercase letters or digits>`);
const urls = {
  tunnels_management_url: "https://platform.openai.com/settings/organization/tunnels",
  runtime_api_keys_url: "https://platform.openai.com/settings/organization/api-keys",
  admin_api_keys_url: "https://platform.openai.com/settings/organization/admin-keys",
  chatgpt_connector_settings_url: "https://chatgpt.com/#settings/Connectors",
};
if (validId || malformedKey) {
  const keyRef = scalar("api_key");
  const hasKey = !malformedKey && keyRef === "env:CONTROL_PLANE_API_KEY" && Boolean(process.env.CONTROL_PLANE_API_KEY);
  check("control_plane_api_key", hasKey ? "PASS" : "FAIL", malformedKey ? "control plane API key is malformed" : keyRef);
}
for (const [name, url] of Object.entries(urls)) check(name, "PASS", url);
if (validId && !malformedKey) {
  const target = scalar("url");
  const url = new URL(target);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || ["8787", "8080"].includes(url.port)) {
    throw new Error(`test stub refuses non-fixture target: ${target}`);
  }
  check("mcp_target", "PASS", target);
  const refs = [...text.matchAll(/^\s*Authorization: (".*")$/gm)].map((match) => JSON.parse(match[1]));
  if (refs.length !== 2 || refs.some((ref) => !ref.startsWith("file:"))) throw new Error("runtime and discovery header files required");
  const headers = await Promise.all(refs.map((ref) => readFile(ref.slice(5), "utf8")));
  if (headers.some((value) => !/^Bearer mmf_pat_[A-Za-z0-9_-]+\n$/.test(value))) throw new Error("invalid fixture Authorization file");
  const probe = async (target) => {
    try {
      const response = await fetch(target, { headers: { Authorization: headers[1].trim() }, signal: AbortSignal.timeout(1500), redirect: "error" });
      await response.arrayBuffer();
      return response.status;
    } catch {
      return 0;
    }
  };
  const status = await probe(target);
  check("mcp_server_reachable", status > 0 && status < 500 ? "PASS" : "FAIL", status ? `HTTP ${status} from ${target}` : `unreachable ${target}`);
  const metadataUrl = new URL(`/.well-known/oauth-protected-resource${url.pathname}`, url).href;
  const metadataStatus = await probe(metadataUrl);
  const rootStatus = legacy ? metadataStatus : await probe(new URL("/.well-known/oauth-protected-resource", url).href);
  if (!legacy && metadataStatus === 404 && rootStatus === 404) {
    check("oauth_metadata", "PASS", "OAuth metadata not advertised; all candidates returned HTTP 404");
  } else if (metadataStatus >= 200 && metadataStatus < 300) {
    check("oauth_metadata", "PASS", `HTTP ${metadataStatus} from ${metadataUrl}`);
  } else {
    check("oauth_metadata", "FAIL", `HTTP ${metadataStatus} from ${metadataUrl}`, {
      why: "HTTP MCP servers that rely on DCR/PRMD should expose the protected-resource metadata and authorization-server metadata contract or readiness can stay degraded.",
      evidence: [metadataUrl, `HTTP ${metadataStatus}`],
      next: ["verify the MCP server exposes GET /.well-known/oauth-protected-resource/mcp", "verify authorization_servers[0] resolves to GET /.well-known/oauth-authorization-server", "inspect /readyz and the embedded UI after startup"],
    });
  }
  const address = scalar("listen_addr");
  const [host, port] = address.split(":");
  const listener = createServer();
  try {
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(Number(port), host, resolve);
    });
    check("health_listener", "PASS", `bind ok on http://${address}`);
    check("ui", "PASS", `http://${address}/ui`);
  } catch (error) {
    check("health_listener", "FAIL", error.message, { evidence: [address, error.message] });
    check("ui", "SKIP", "blocked by health listener check");
  } finally {
    if (listener.listening) await new Promise((resolve) => listener.close(resolve));
  }
}
check("codex_plugin", "SKIP", "Codex detected; Tunnel MCP plugin not installed (run `tunnel-client codex plugin install`)", {
  why: "the optional Codex plugin gives tunnel-client a more discoverable Codex-native control surface.",
  evidence: [`CODEX_HOME: ${process.env.CODEX_HOME}`, `expected plugin dir: ${process.env.CODEX_HOME}/plugins/cache/debug/tunnel-mcp/local`],
  next: ["tunnel-client codex plugin install"],
});
const failed = checks.filter((entry) => entry.status === "FAIL").map((entry) => entry.id);
const report = failed.length ? { result: "fail", failed_checks: failed, checks } : {
  result: "ok", next: `tunnel-client run --profile ${options.get("--profile")}`, checks,
};
if (options.has("--json")) console.log(JSON.stringify(report, null, 2));
else {
  for (const entry of checks) console.log(`CHECK ${entry.id.padEnd(24)} ${entry.status} ${entry.summary}`);
  console.log(`\nRESULT ${report.result}`);
  if (failed.length) console.log(`FAILED_CHECKS ${failed.join(",")}`);
  console.log(`EXIT_CODE ${failed.length ? 2 : 0}`);
}
process.exitCode = failed.length ? 2 : 0;
