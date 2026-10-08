import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const setupScript = path.join(repoRoot, "scripts", "setup-openai-tunnel.sh");
const tunnelClient = spawnSync("bash", ["-lc", "command -v tunnel-client"], { encoding: "utf8" }).stdout.trim();
const tunnelClientAvailable = tunnelClient.length > 0 && spawnSync(tunnelClient, ["--version"], { stdio: "ignore" }).status === 0;
const realInstall = spawnSync("bash", ["-lc", "command -v install"], { encoding: "utf8" }).stdout.trim();
const tempRoots = new Set<string>();
const servers = new Set<Server>();

interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function makeSandbox(): Promise<{ root: string; home: string; temp: string; runtimeEnv: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "mmf-openai-tunnel-test-"));
  tempRoots.add(root);
  const home = path.join(root, "home");
  const temp = path.join(root, "tmp");
  const runtimeEnv = path.join(root, "arxiv-local.env");
  await Promise.all([mkdir(home), mkdir(temp)]);
  await writeFile(runtimeEnv, "CONTROL_PLANE_API_KEY=dry-run-control-plane-key\n", { mode: 0o600 });
  await chmod(runtimeEnv, 0o600);
  return { root, home, temp, runtimeEnv };
}

async function runScript(
  args: string[],
  sandbox: Awaited<ReturnType<typeof makeSandbox>>,
  env: NodeJS.ProcessEnv = {},
): Promise<ScriptResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("bash", [setupScript, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: sandbox.home,
        TMPDIR: sandbox.temp,
        OPENAI_TUNNEL_RUNTIME_ENV: sandbox.runtimeEnv,
        TUNNEL_CLIENT_BIN: tunnelClient,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`script timed out: ${args.join(" ")}`));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? 128,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function mode(file: string): Promise<number> {
  return (await stat(file)).mode & 0o777;
}

async function startMcpServer(metadataStatus: number): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url === "/mcp") {
      response.writeHead(405).end();
      return;
    }
    if (request.url === "/.well-known/oauth-protected-resource/mcp") {
      response.writeHead(metadataStatus).end();
      return;
    }
    response.writeHead(404).end();
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected an ephemeral TCP address");
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function seedExistingPat(sandbox: Awaited<ReturnType<typeof makeSandbox>>): Promise<string> {
  const patDir = path.join(sandbox.home, ".config", "mmf");
  await mkdir(patDir, { recursive: true });
  const pat = "mmf_pat_existing_test_token";
  await writeFile(path.join(patDir, "pat-openai-tunnel.token"), `${pat}\n`, { mode: 0o600 });
  return pat;
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.clear();
  await Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.clear();
});

describe.skipIf(!tunnelClientAvailable)("setup-openai-tunnel.sh", () => {
  test("dry-run writes an isolated PAT-header profile and unit preview without touching systemd", async () => {
    const sandbox = await makeSandbox();
    const result = await runScript(
      ["tunnel_0123456789abcdef", "--profile", "mmf-hub", "--health", "127.0.0.1:8082", "--dry-run"],
      sandbox,
    );

    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("mmf_pat_dry_run");
    const artifactDir = result.stdout.match(/^Dry-run artifact directory: (.+)$/m)?.[1];
    expect(artifactDir).toEqual(expect.any(String));
    expect(path.dirname(artifactDir!)).toBe(sandbox.temp);

    const profile = path.join(artifactDir!, "profiles", "mmf-hub.yaml");
    const unit = path.join(artifactDir!, "mmf-openai-tunnel.service");
    const rawPat = path.join(artifactDir!, "pat-openai-tunnel.token");
    const authHeader = path.join(artifactDir!, "pat-openai-tunnel.authorization");
    const profileText = await readFile(profile, "utf8");
    const unitText = await readFile(unit, "utf8");

    expect(profileText).toContain('tunnel_id: "tunnel_0123456789abcdef"');
    expect(profileText).toContain('listen_addr: "127.0.0.1:8082"');
    expect(profileText).toContain('url: "http://127.0.0.1:8787/mcp"');
    expect(profileText).toContain(`Authorization: "file:${authHeader}"`);
    expect(profileText.match(/Authorization:/g)).toHaveLength(2);
    expect(await readFile(rawPat, "utf8")).toMatch(/^mmf_pat_dry_run_[A-Za-z0-9_-]+\n$/);
    expect(await readFile(authHeader, "utf8")).toMatch(/^Bearer mmf_pat_dry_run_[A-Za-z0-9_-]+\n$/);
    expect(unitText).toContain(`EnvironmentFile=${sandbox.runtimeEnv}`);
    expect(unitText).toContain(
      `ExecStart="${tunnelClient}" run --profile "mmf-hub" --profile-dir "${path.join(artifactDir!, "profiles")}"`,
    );
    expect(unitText).toContain("Description=OpenAI Secure MCP Tunnel for MCP Machine Fabric");
    expect(await mode(profile)).toBe(0o600);
    expect(await mode(unit)).toBe(0o600);
    expect(await mode(rawPat)).toBe(0o600);
    expect(await mode(authHeader)).toBe(0o600);
    expect(result.stdout + result.stderr).toMatch(/invalid tunnel ID.*tunnel_0123456789abcdef/i);
    expect(result.stdout).toContain("Dry-run doctor exit code: 2");
    await expect(access(path.join(sandbox.home, ".config", "systemd", "user"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects unsafe profile names and the arXiv tunnel health port before writing", async () => {
    const badProfileSandbox = await makeSandbox();
    const badProfile = await runScript(
      ["tunnel_0123456789abcdef", "--profile", "../escape", "--dry-run"],
      badProfileSandbox,
    );
    expect(badProfile.code).toBe(2);
    expect(badProfile.stderr).toMatch(/invalid profile/i);
    expect(await access(badProfileSandbox.temp).then(() => true)).toBe(true);
    expect(await readFile(badProfileSandbox.runtimeEnv, "utf8")).toBe("CONTROL_PLANE_API_KEY=dry-run-control-plane-key\n");

    const protectedProfileSandbox = await makeSandbox();
    const protectedProfile = await runScript(
      ["tunnel_0123456789abcdef", "--profile", "arxiv-local", "--dry-run"],
      protectedProfileSandbox,
    );
    expect(protectedProfile.code).toBe(2);
    expect(protectedProfile.stderr).toMatch(/arxiv-local.*reserved|reserved.*arxiv-local/i);

    const portSandbox = await makeSandbox();
    const arxivPort = await runScript(
      ["tunnel_0123456789abcdef", "--health", "127.0.0.1:8080", "--dry-run"],
      portSandbox,
    );
    expect(arxivPort.code).toBe(2);
    expect(arxivPort.stderr).toMatch(/8080.*arxiv|arxiv.*8080/i);
    await expect(access(path.join(portSandbox.home, ".config", "systemd", "user"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("requires exactly one tunnel id and rejects unknown options", async () => {
    const missingSandbox = await makeSandbox();
    const missing = await runScript(["--dry-run"], missingSandbox);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Usage:");

    const unknownSandbox = await makeSandbox();
    const unknown = await runScript(["tunnel_0123456789abcdef", "--wat"], unknownSandbox);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/unknown option/i);
  });

  test("dry-run treats the external EnvironmentFile as data and never executes it", async () => {
    const sandbox = await makeSandbox();
    const sentinel = path.join(sandbox.root, "executed");
    await writeFile(sandbox.runtimeEnv, `CONTROL_PLANE_API_KEY=$(touch ${sentinel})\n`, { mode: 0o600 });

    const result = await runScript(["tunnel_0123456789abcdef", "--dry-run"], sandbox);

    expect(result.code).toBe(0);
    await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a failed production preflight preserves an existing managed profile and unit", async () => {
    const sandbox = await makeSandbox();
    const profileDir = path.join(sandbox.home, ".config", "tunnel-client");
    const unitDir = path.join(sandbox.home, ".config", "systemd", "user");
    const patDir = path.join(sandbox.home, ".config", "mmf");
    await Promise.all([mkdir(profileDir, { recursive: true }), mkdir(unitDir, { recursive: true }), mkdir(patDir, { recursive: true })]);
    const profile = path.join(profileDir, "mmf-hub.yaml");
    const unit = path.join(unitDir, "mmf-openai-tunnel.service");
    const oldProfile = "# Managed by setup-openai-tunnel.sh\nold-profile\n";
    const oldUnit = "# Managed by setup-openai-tunnel.sh\nold-unit\n";
    await Promise.all([
      writeFile(profile, oldProfile, { mode: 0o600 }),
      writeFile(unit, oldUnit, { mode: 0o600 }),
      writeFile(path.join(patDir, "pat-openai-tunnel.token"), "mmf_pat_existing_test_token\n", { mode: 0o600 }),
    ]);
    const missingRuntimeEnv = path.join(sandbox.root, "missing-runtime.env");

    const result = await runScript(
      ["tunnel_0123456789abcdef0123456789abcdef"],
      sandbox,
      { OPENAI_TUNNEL_RUNTIME_ENV: missingRuntimeEnv },
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/EnvironmentFile.*not readable|not readable.*EnvironmentFile/i);
    expect(await readFile(profile, "utf8")).toBe(oldProfile);
    expect(await readFile(unit, "utf8")).toBe(oldUnit);
  });

  test("quotes systemd paths containing spaces", async () => {
    const sandbox = await makeSandbox();
    const spacedBinDir = path.join(sandbox.root, "bin with $dollar space");
    const spacedRuntimeDir = path.join(sandbox.root, "runtime $env");
    await Promise.all([mkdir(spacedBinDir), mkdir(spacedRuntimeDir)]);
    const spacedTunnelClient = path.join(spacedBinDir, "tunnel-client");
    const spacedRuntimeEnv = path.join(spacedRuntimeDir, "arxiv-local.env");
    await symlink(tunnelClient, spacedTunnelClient);
    await writeFile(spacedRuntimeEnv, "CONTROL_PLANE_API_KEY=dry-run-control-plane-key\n", { mode: 0o600 });

    const result = await runScript(
      ["tunnel_0123456789abcdef", "--dry-run"],
      sandbox,
      { TUNNEL_CLIENT_BIN: spacedTunnelClient, OPENAI_TUNNEL_RUNTIME_ENV: spacedRuntimeEnv },
    );

    expect(result.code).toBe(0);
    const artifactDir = result.stdout.match(/^Dry-run artifact directory: (.+)$/m)?.[1];
    const unit = await readFile(path.join(artifactDir!, "mmf-openai-tunnel.service"), "utf8");
    expect(unit).toContain(`EnvironmentFile=${spacedRuntimeEnv.replaceAll(" ", "\\x20").replaceAll("$", "\\x24")}`);
    expect(unit).toContain(
      `ExecStart="${spacedTunnelClient.replaceAll("$", () => "$$")}" run --profile "mmf-hub" --profile-dir "${path.join(artifactDir!, "profiles")}"`,
    );
  });

  test("a valid dry-run reaches doctor target and header checks", async () => {
    const sandbox = await makeSandbox();
    const result = await runScript(["tunnel_0123456789abcdef0123456789abcdef", "--dry-run"], sandbox);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("CHECK tunnel_id                PASS");
    expect(result.stdout).toContain("CHECK mcp_target               PASS http://127.0.0.1:8787/mcp");
    expect(result.stdout + result.stderr).not.toContain("mmf_pat_dry_run");
    const artifactDir = result.stdout.match(/^Dry-run artifact directory: (.+)$/m)?.[1];
    const profile = await readFile(path.join(artifactDir!, "profiles", "mmf-hub.yaml"), "utf8");
    expect(profile.match(/Authorization:/g)).toHaveLength(2);
    expect(profile).toContain("file:");
  });

  test("production accepts only the expected local OAuth-metadata 404 and installs the bundle", async () => {
    const sandbox = await makeSandbox();
    const mcpUrl = await startMcpServer(404);
    const pat = await seedExistingPat(sandbox);

    const result = await runScript(
      ["tunnel_0123456789abcdef0123456789abcdef"],
      sandbox,
      { MMF_TUNNEL_MCP_URL: mcpUrl },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("expected HTTP 404 OAuth-metadata absence");
    const profile = await readFile(path.join(sandbox.home, ".config", "tunnel-client", "mmf-hub.yaml"), "utf8");
    expect(profile).toContain(`url: "${mcpUrl}"`);
    expect(await readFile(path.join(sandbox.home, ".config", "mmf", "pat-openai-tunnel.authorization"), "utf8")).toBe(
      `Bearer ${pat}\n`,
    );
    expect(await mode(path.join(sandbox.home, ".config", "systemd", "user", "mmf-openai-tunnel.service"))).toBe(0o600);
  });

  test("production rejects a local OAuth-metadata 5xx before installation", async () => {
    const sandbox = await makeSandbox();
    const mcpUrl = await startMcpServer(500);
    await seedExistingPat(sandbox);

    const result = await runScript(
      ["tunnel_0123456789abcdef0123456789abcdef"],
      sandbox,
      { MMF_TUNNEL_MCP_URL: mcpUrl },
    );

    expect(result.code).not.toBe(0);
    await expect(access(path.join(sandbox.home, ".config", "tunnel-client", "mmf-hub.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(sandbox.home, ".config", "systemd", "user", "mmf-openai-tunnel.service"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(sandbox.home, ".config", "mmf", "pat-openai-tunnel.authorization"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("an incomplete rollback preserves recovery files and attempts every restoration", async () => {
    const sandbox = await makeSandbox();
    const mcpUrl = await startMcpServer(404);
    const pat = await seedExistingPat(sandbox);
    const profileDir = path.join(sandbox.home, ".config", "tunnel-client");
    const unitDir = path.join(sandbox.home, ".config", "systemd", "user");
    const patDir = path.join(sandbox.home, ".config", "mmf");
    await Promise.all([mkdir(profileDir, { recursive: true }), mkdir(unitDir, { recursive: true })]);
    const oldProfile = "# Managed by setup-openai-tunnel.sh\nold-profile\n";
    const oldUnit = "# Managed by setup-openai-tunnel.sh\nold-unit\n";
    const oldAuth = `Bearer ${pat}\n`;
    await Promise.all([
      writeFile(path.join(profileDir, "mmf-hub.yaml"), oldProfile, { mode: 0o600 }),
      writeFile(path.join(unitDir, "mmf-openai-tunnel.service"), oldUnit, { mode: 0o600 }),
      writeFile(path.join(patDir, "pat-openai-tunnel.authorization"), oldAuth, { mode: 0o600 }),
    ]);
    const installWrapper = path.join(sandbox.root, "install-with-failures.sh");
    const installState = path.join(sandbox.root, "install-state");
    await writeFile(
      installWrapper,
      `#!/usr/bin/env bash\nset -eu\nsrc="\${@: -2:1}"\ndst="\${@: -1}"\nif [[ "$dst" == *mmf-openai-tunnel.service && "$src" != */backups/* ]]; then exit 73; fi\nif [[ "$src" == */backups/0 ]]; then printf failed > "${installState}"; exit 74; fi\nexec "${realInstall}" "$@"\n`,
      { mode: 0o700 },
    );
    await chmod(installWrapper, 0o700);

    const result = await runScript(
      ["tunnel_0123456789abcdef0123456789abcdef"],
      sandbox,
      { MMF_TUNNEL_MCP_URL: mcpUrl, MMF_TUNNEL_INSTALL_BIN: installWrapper },
    );

    expect(result.code).not.toBe(0);
    expect(await readFile(installState, "utf8")).toBe("failed");
    expect(await readFile(path.join(profileDir, "mmf-hub.yaml"), "utf8")).toBe(oldProfile);
    expect(await readFile(path.join(unitDir, "mmf-openai-tunnel.service"), "utf8")).toBe(oldUnit);
    expect(await readFile(path.join(patDir, "pat-openai-tunnel.authorization"), "utf8")).toBe(oldAuth);
    const recoveryDir = result.stderr.match(/^Recovery files preserved at: (.+)$/m)?.[1];
    expect(recoveryDir).toEqual(expect.any(String));
    expect(await readFile(path.join(recoveryDir!, "0"), "utf8")).toBe(`${pat}\n`);
  });
});
