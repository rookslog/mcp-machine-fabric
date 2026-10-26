import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const sqliteAvailable = await new Promise<boolean>((resolve) => {
  const p = spawn("sqlite3", ["--version"], { stdio: "ignore" });
  p.on("error", () => resolve(false));
  p.on("exit", (code) => resolve(code === 0));
});

// Run the actual documented commands, so omissions in the restore/rollback
// instructions fail these tests rather than drifting into a parallel recipe.
async function procedure(section: string, block: number) {
  const doc = await readFile(path.join(repo, "docs/SELF_HOSTING.md"), "utf8");
  const body = doc.split(`## ${section}\n`)[1]?.split("\n## ")[0];
  const commands = [...(body ?? "").matchAll(/```bash\n([\s\S]*?)```/g)][block]?.[1];
  if (!commands) throw new Error(`missing executable ${section} procedure block ${block + 1}`);
  return commands;
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not become ready`);
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "mmf-procedures-"));
  const source = path.join(root, "source");
  const home = path.join(root, "home");
  await mkdir(source);
  await mkdir(home);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", npm_config_update_notifier: "false" };
  // Never inherit operator hub/agent settings into an isolated exercise.
  for (const key of Object.keys(env)) if (key.startsWith("MMF_")) delete env[key];
  const children = new Set<ChildProcess>();
  let portReservation: string | undefined;
  async function command(cmd: string, args: string[], cwd = source, extra: NodeJS.ProcessEnv = {}, input = "") {
    const p = spawn(cmd, args, { cwd, env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
    children.add(p);
    let out = "", err = "";
    p.stdout.on("data", (b) => { out += b; });
    p.stderr.on("data", (b) => { err += b; });
    p.stdin.on("error", () => {});
    p.stdin.end(input);
    const [code] = await once(p, "close");
    children.delete(p);
    // Commands that emit credentials are captured only, never included in an
    // assertion or diagnostic. All failures identify the operation and code.
    if (code !== 0) throw new Error(`${path.basename(cmd)} ${args[0] ?? ""}: exit ${code}; stderr suppressed (${err.length} bytes)`);
    return out.trim();
  }
  async function stop(p: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM") {
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    const closed = once(p, "close");
    p.kill(signal);
    const timeout = setTimeout(() => p.kill("SIGKILL"), 10_000);
    await closed;
    clearTimeout(timeout);
    children.delete(p);
  }
  async function cleanup() {
    for (const p of children) await stop(p);
    await rm(root, { recursive: true, force: true });
    if (portReservation) await rm(portReservation, { recursive: true, force: true });
  }
  try {
    for (const file of ["src", "scripts", "deploy", "package.json", "package-lock.json", "tsconfig.json", ".gitignore"]) {
      await cp(path.join(repo, file), path.join(source, file), { recursive: true });
    }
    await command("git", ["init", "-q"]);
    await command("git", ["add", "."]);
    const commit = async (message: string) => {
      await command("git", ["add", "."]);
      await command("git", ["-c", "user.name=Release Test", "-c", "user.email=release@example.invalid", "commit", "-qm", message]);
      return command("git", ["rev-parse", "--short", "HEAD"]);
    };
    const xSha = await commit("release X");
    const install = () => command("/bin/bash", ["scripts/install-release.sh"]);
    await install();
    const base = path.join(home, ".local/opt/mcp-machine-fabric");
    const current = path.join(base, "current");
    const x = await readlink(current);
    const cli = path.join(current, "dist/cli.js");
    const cliRun = (args: string[], input = "") => command(process.execPath, [cli, ...args], source, {}, input);
    let port = 0;
    for (let candidate = 18780; candidate <= 18799; candidate++) {
      const reservation = path.join(tmpdir(), `.mmf-release-port-${candidate}`);
      try { await mkdir(reservation); }
      catch (error: any) { if (error.code === "EEXIST") continue; throw error; }
      const available = await new Promise<boolean>((resolve) => {
        const server = createServer();
        server.on("error", () => resolve(false));
        server.listen(candidate, "127.0.0.1", () => server.close(() => resolve(true)));
      });
      if (available) { port = candidate; portReservation = reservation; break; }
      await rm(reservation, { recursive: true });
    }
    if (!port) throw new Error("no exercise port available in 18780-18799");
    const url = `http://127.0.0.1:${port}`;
    const data = path.join(home, ".local/share/mmf-hub");
    const db = path.join(data, "hub.db");
    const allowed = path.join(home, "allowed");
    await mkdir(allowed);
    await writeFile(path.join(allowed, "readme.txt"), "release procedure witness\n");
    await cliRun(["passphrase"], "isolated exercise passphrase\n");
    const device = (await cliRun(["device", "add", "witness"])).match(/^mmf_dev_\S+$/m)?.[0];
    const token = (await cliRun(["token", "create", "reader", "--scopes", "fabric:read"])).match(/^mmf_pat_\S+$/m)?.[0];
    if (!device || !token) throw new Error("enrollment did not return credentials");
    const tokenFile = path.join(home, "reader.token");
    const deviceFile = path.join(home, "device.token");
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    await writeFile(deviceFile, `${device}\n`, { mode: 0o600 });
    await command("/bin/bash", ["scripts/install-hub.sh", "--public-url", "https://example.invalid", "--port", String(port), "--platform", "linux", "--no-start"]);
    await command("/bin/bash", ["scripts/install-agent.sh", "--hub", `${url.replace("http", "ws")}/agent`, "--token-file", deviceFile, "--root", allowed, "--read-only", "--no-exec", "--platform", process.platform === "darwin" ? "darwin" : "linux", "--no-start"]);
    let hub: ChildProcess | undefined, agent: ChildProcess | undefined;
    function background(args: string[]) {
      const p = spawn(process.execPath, [cli, ...args], { cwd: source, env, stdio: ["ignore", "ignore", "pipe"] });
      p.stderr?.resume();
      children.add(p);
      return p;
    }
    const status = () => cliRun(["status", "--url", url, "--token-file", tokenFile]);
    async function start() {
      hub = background(["hub", "--port", String(port), "--host", "127.0.0.1", "--public-url", url]);
      await waitFor(async () => (await fetch(`${url}/readyz`)).ok, "hub");
      agent = background(["agent", "--hub", `${url.replace("http", "ws")}/agent`, "--token-file", deviceFile, "--root", allowed, "--read-only", "--no-exec"]);
      await waitFor(async () => /^witness +READY/m.test(await status()), "agent");
    }
    async function halt(crash = false) {
      await stop(agent);
      await stop(hub, crash ? "SIGKILL" : "SIGTERM");
    }
    async function read() {
      const client = new Client({ name: "release-procedures", version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
        const result = await client.callTool({ name: "read_file", arguments: { machine: "witness", path: path.join(allowed, "readme.txt") } });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent?.text).toContain("release procedure witness");
      } finally { await client.close(); }
    }
    async function checks() {
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
      expect((await fetch(`${url}/readyz`)).status).toBe(200);
      expect(await status()).toMatch(/^witness +READY/m);
      await read();
      console.log("post-restart checks: healthz=200 readyz=200 status=READY read_file=ok");
    }
    const sql = (file: string, query: string) => command("sqlite3", ["-cmd", ".timeout 5000", "-json", file, query]);
    const sidecars = async () => (await readdir(data)).filter((f) => /-wal$|-shm$/.test(f)).sort();
    await start();
    await read();
    await read();
    console.log(`isolated source install: X=${xSha}; enrolled=1 PAT=1 MCP reads=2`);
    return { root, source, home, env, command, cleanup, commit, install, current, x, xSha, cliRun, db, data, token,
      start, halt, read, checks, sql, sidecars, url };
  } catch (error) { await cleanup(); throw error; }
}

for (const crash of [false, true]) {
  test.skipIf(!sqliteAvailable)(`documented SQLite backup and restore after ${crash ? "abrupt" : "graceful"} stop${sqliteAvailable ? "" : " (SKIP: sqlite3 CLI missing)"}`, async () => {
    // Read both before setup: an incomplete doc fails without provisioning.
    const backup = await procedure("Back up and restore", 0);
    const restore = await procedure("Back up and restore", 1);
    const f = await setup();
    try {
      await f.command("/bin/bash", ["-c", backup]);
      const backups = await readdir(path.join(f.source, "backups"));
      expect(backups).toHaveLength(1);
      const snapshot = path.join(f.source, "backups", backups[0]);
      const tables = ["devices", "oauth_personal_tokens", "requests"];
      const before: string[] = [];
      for (const t of tables) before.push(await f.sql(snapshot, `SELECT * FROM ${t} ORDER BY 1;`));
      expect(JSON.parse(before[0])).toHaveLength(1);
      expect(JSON.parse(before[1])).toHaveLength(1);
      expect(JSON.parse(before[2])).toHaveLength(2);
      expect((await lstat(snapshot)).mode & 0o777).toBe(0o600);
      expect(await f.sidecars()).toEqual(["hub.db-shm", "hub.db-wal"]);
      console.log(`online .backup: devices=1 tokens=1 requests=2; sidecars=${(await f.sidecars()).join(",")}`);
      await f.cliRun(["device", "add", "later"]);
      const laterToken = (await f.cliRun(["token", "create", "later", "--scopes", "fabric:read"])).match(/^mmf_pat_\S+$/m)?.[0];
      if (!laterToken) throw new Error("mutation token missing");
      await f.read();
      expect(JSON.parse(await f.sql(f.db, "SELECT id FROM devices;"))).toHaveLength(2);
      expect(JSON.parse(await f.sql(f.db, "SELECT id FROM oauth_personal_tokens;"))).toHaveLength(2);
      expect(JSON.parse(await f.sql(f.db, "SELECT request_id FROM requests;"))).toHaveLength(3);
      await f.halt(crash);
      const stoppedSidecars = await f.sidecars();
      expect(stoppedSidecars).toEqual(crash ? ["hub.db-shm", "hub.db-wal"] : []);
      console.log(`after ${crash ? "abrupt" : "graceful"} stop sidecars=${stoppedSidecars.join(",") || "none"}`);
      const restored = await f.command("/bin/bash", ["-c", restore], f.source, { backup: snapshot });
      expect(await f.sidecars()).toEqual([]);
      const saved = restored.replace("Pre-restore data retained at ", "");
      expect((await lstat(saved)).mode & 0o777).toBe(0o700);
      for (const table of tables) {
        const rows = JSON.parse(await f.sql(path.join(saved, "hub.db"), `SELECT * FROM ${table};`));
        expect(rows).toHaveLength(table === "requests" ? 3 : 2);
      }
      const after: string[] = [];
      for (const t of tables) after.push(await f.sql(f.db, `SELECT * FROM ${t} ORDER BY 1;`));
      // Boolean diagnostics do not print token hashes or ledger contents.
      for (let i = 0; i < tables.length; i++) expect(after[i] === before[i], `${tables[i]} exactly match snapshot`).toBe(true);
      expect(await f.sidecars()).toEqual([]);
      await f.start();
      expect((await fetch(`${f.url}/api/status`, { headers: { Authorization: `Bearer ${laterToken}` } })).status).toBe(401);
      await f.checks();
      console.log("restored rows exactly match backup; later PAT rejected; original PAT accepted");
    } finally { await f.cleanup(); }
  }, 180_000);
}

test("documented upgrade and rollback keep X immutable and restart the installed hub and agent", async () => {
  const rollback = await procedure("Upgrade and roll back", 1);
  const f = await setup();
  try {
    const inode = (await lstat(f.x)).ino;
    // Reinstall while actual processes are running from this release.
    await f.install();
    expect((await lstat(f.x)).ino).toBe(inode);
    await writeFile(path.join(f.source, "src/version.ts"), 'export const VERSION = "0.1.0-exercise-y";\n');
    const ySha = await f.commit("release Y");
    const upgrade = await f.install();
    expect(upgrade).toContain(`previous current: ${f.x}`);
    const y = await readlink(f.current);
    expect(y).not.toBe(f.x);
    await f.halt();
    await f.start();
    expect((await (await fetch(`${f.url}/healthz`)).json()).version).toBe("0.1.0-exercise-y");
    await f.checks();
    await f.halt();
    await f.command("/bin/bash", ["-c", rollback], f.source, { previous: f.x });
    expect(await readlink(f.current)).toBe(f.x);
    expect((await lstat(f.x)).ino).toBe(inode);
    await f.start();
    expect((await (await fetch(`${f.url}/healthz`)).json()).version).toBe("0.1.0");
    await f.checks();
    console.log(`upgrade/rollback: X=${f.xSha} Y=${ySha}; X inode preserved; Y and X both restarted`);
  } finally { await f.cleanup(); }
}, 180_000);

// A deterministic failed-copy boundary represents ENOSPC/permission failures.
// The shell block itself must stop before removing any original database file.
test("documented restore preserves the database when its pre-restore copy fails", async () => {
  const restore = await procedure("Back up and restore", 1);
  const root = await mkdtemp(path.join(tmpdir(), "mmf-restore-failure-"));
  try {
    const data = path.join(root, ".local/share/mmf-hub");
    const bin = path.join(root, "bin");
    await mkdir(data, { recursive: true });
    await mkdir(bin);
    const files = ["hub.db", "hub.db-wal", "hub.db-shm"];
    for (const file of files) await writeFile(path.join(data, file), `original ${file}`);
    const backup = path.join(root, "snapshot.db");
    await writeFile(backup, "snapshot contents");
    const cpPath = spawnSync("which", ["cp"], { encoding: "utf8" }).stdout.trim();
    await writeFile(path.join(bin, "cp"), `#!/bin/bash\nif [[ "$1" == -a ]]; then exit 28; fi\nexec '${cpPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
    const result = spawnSync("/bin/bash", ["-c", restore], {
      cwd: root, env: { ...process.env, HOME: root, MMF_DATA_DIR: data, backup, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    for (const file of files) expect(await readFile(path.join(data, file), "utf8")).toBe(`original ${file}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("documented rollback refuses a missing release without repointing current", async () => {
  const rollback = await procedure("Upgrade and roll back", 1);
  const home = await mkdtemp(path.join(tmpdir(), "mmf-rollback-failure-"));
  try {
    const base = path.join(home, ".local/opt/mcp-machine-fabric");
    const x = path.join(base, "release-x");
    await mkdir(x, { recursive: true });
    const current = path.join(base, "current");
    await symlink(x, current);
    const result = spawnSync("/bin/bash", ["-c", rollback], {
      env: { ...process.env, HOME: home, previous: path.join(base, "missing") }, encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(await readlink(current)).toBe(x);
  } finally { await rm(home, { recursive: true, force: true }); }
});
