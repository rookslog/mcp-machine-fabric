import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const installAgent = path.join(repoRoot, "scripts", "install-agent.sh");
const installHub = path.join(repoRoot, "scripts", "install-hub.sh");
const validToken = "mmf_dev_abcdefghijklmnopqrstuvwxyz";
const tempRoots = new Set<string>();

interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function tempPrefix(): Promise<string> {
  const prefix = await mkdtemp(path.join(tmpdir(), "mmf-installers-"));
  tempRoots.add(prefix);
  return prefix;
}

async function runScript(script: string, args: string[], input = "", env: NodeJS.ProcessEnv = {}): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`script timed out: ${path.basename(script)} ${args.join(" ")}`));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 128, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

async function mode(file: string): Promise<number> {
  return (await stat(file)).mode & 0o777;
}

afterEach(async () => {
  await Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.clear();
});

describe("install-agent.sh", () => {
  test("installs a Linux agent from stdin with private files and an idempotent user unit", async () => {
    const prefix = await tempPrefix();
    const rootA = path.join(prefix, "root one");
    const rootB = path.join(prefix, "root-two");
    await mkdir(rootA);
    await mkdir(rootB);
    const args = [
      "--hub",
      "wss://hub.example.test/agent",
      "--root",
      rootA,
      "--root",
      rootB,
      "--read-only",
      "--no-exec",
      "--prefix",
      prefix,
      "--platform",
      "linux",
      "--dry-run",
    ];

    const first = await runScript(installAgent, args, `${validToken}\n`);
    expect(first.code).toBe(0);
    expect(first.stdout + first.stderr).not.toContain(validToken);

    const configDir = path.join(prefix, ".config", "mmf");
    const tokenFile = path.join(configDir, "agent.token");
    const envFile = path.join(configDir, "agent.env");
    const unitFile = path.join(prefix, ".config", "systemd", "user", "mmf-agent.service");
    expect(await readFile(tokenFile, "utf8")).toBe(`${validToken}\n`);
    expect(await readFile(envFile, "utf8")).toBe(
      [
        "MMF_HUB_URL=wss://hub.example.test/agent",
        `MMF_ROOTS=${rootA}:${rootB}`,
        "MMF_READ_ONLY=1",
        "MMF_NO_EXEC=1",
        "",
      ].join("\n"),
    );
    expect(await readFile(unitFile, "utf8")).toContain("KillMode=process");
    expect(await mode(configDir)).toBe(0o700);
    expect(await mode(path.dirname(unitFile))).toBe(0o700);
    expect(await mode(tokenFile)).toBe(0o600);
    expect(await mode(envFile)).toBe(0o600);
    expect(await mode(unitFile)).toBe(0o600);

    const before = await Promise.all([tokenFile, envFile, unitFile].map((file) => readFile(file, "utf8")));
    const second = await runScript(installAgent, args, `${validToken}\n`);
    expect(second.code).toBe(0);
    await expect(Promise.all([tokenFile, envFile, unitFile].map((file) => readFile(file, "utf8")))).resolves.toEqual(before);
  });

  test("reads a token file without disclosing the token", async () => {
    const prefix = await tempPrefix();
    const source = path.join(prefix, "source.token");
    await writeFile(source, `${validToken}\n`, { mode: 0o600 });

    const result = await runScript(installAgent, [
      "--hub",
      "wss://hub.example.test/agent",
      "--token-file",
      source,
      "--prefix",
      prefix,
      "--platform",
      "linux",
      "--dry-run",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(validToken);
    expect(await readFile(path.join(prefix, ".config", "mmf", "agent.token"), "utf8")).toBe(`${validToken}\n`);
  });

  test("rejects malformed tokens without writing or printing them", async () => {
    const prefix = await tempPrefix();
    const badToken = "mmf_dev_too-short";
    const result = await runScript(
      installAgent,
      ["--hub", "wss://hub.example.test/agent", "--prefix", prefix, "--platform", "linux", "--dry-run"],
      `${badToken}\n`,
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(badToken);
    expect(result.stderr).toMatch(/invalid.*token/i);
    await expect(access(path.join(prefix, ".config", "mmf", "agent.token"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects bad hub URLs and warns for insecure non-loopback WebSockets", async () => {
    const badPrefix = await tempPrefix();
    const bad = await runScript(
      installAgent,
      ["--hub", "https://hub.example.test/agent", "--prefix", badPrefix, "--platform", "linux", "--dry-run"],
      `${validToken}\n`,
    );
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toMatch(/hub.*ws:\/\/.*wss:\/\//i);

    const warningPrefix = await tempPrefix();
    const warning = await runScript(
      installAgent,
      ["--hub", "ws://hub.example.test/agent", "--prefix", warningPrefix, "--platform", "linux", "--dry-run"],
      `${validToken}\n`,
    );
    expect(warning.code).toBe(0);
    expect(warning.stderr).toMatch(/warning.*insecure|warning.*unencrypted/i);

    const loopbackPrefix = await tempPrefix();
    const loopback = await runScript(
      installAgent,
      ["--hub", "ws://127.0.0.1:8787/agent", "--prefix", loopbackPrefix, "--platform", "linux", "--dry-run"],
      `${validToken}\n`,
    );
    expect(loopback.code).toBe(0);
    expect(loopback.stderr).not.toMatch(/warning.*insecure|warning.*unencrypted/i);
  });

  test("renders a valid macOS plist with XML-escaped environment values", async () => {
    const prefix = await tempPrefix();
    const specialRoot = path.join(prefix, "root&one<two>");
    const args = [
      "--hub",
      "wss://hub.example.test/agent",
      "--root",
      specialRoot,
      "--read-only",
      "--prefix",
      prefix,
      "--platform",
      "darwin",
      "--dry-run",
    ];

    const first = await runScript(installAgent, args, `${validToken}\n`);
    expect(first.code).toBe(0);
    expect(first.stdout + first.stderr).not.toContain(validToken);
    const plistFile = path.join(prefix, "Library", "LaunchAgents", "dev.mcp-machine-fabric.agent.plist");
    const plist = await readFile(plistFile, "utf8");
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<key>MMF_HUB_URL</key>");
    expect(plist).toContain("<key>MMF_ROOTS</key>");
    expect(plist).toContain("<key>MMF_READ_ONLY</key><string>1</string>");
    expect(plist).toContain("<key>MMF_NO_EXEC</key><string>0</string>");
    expect(plist).toContain(specialRoot.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
    expect(plist).not.toContain("<string>--hub</string>");
    expect(plist).toContain("<key>AbandonProcessGroup</key><true/>");
    expect(await mode(path.dirname(plistFile))).toBe(0o700);
    expect(await mode(plistFile)).toBe(0o600);

    const second = await runScript(installAgent, args, `${validToken}\n`);
    expect(second.code).toBe(0);
    expect(await readFile(plistFile, "utf8")).toBe(plist);
  });
});

describe("install-hub.sh", () => {
  test("installs private Linux hub configuration idempotently and prints next steps", async () => {
    const prefix = await tempPrefix();
    const args = [
      "--public-url",
      "https://hub.example.test:8443",
      "--port",
      "9876",
      "--prefix",
      prefix,
      "--platform",
      "linux",
      "--dry-run",
    ];

    const first = await runScript(installHub, args);
    expect(first.code).toBe(0);
    const configDir = path.join(prefix, ".config", "mmf");
    const envFile = path.join(configDir, "hub.env");
    const unitFile = path.join(prefix, ".config", "systemd", "user", "mmf-hub.service");
    expect(await readFile(envFile, "utf8")).toBe(
      ["MMF_PUBLIC_URL=https://hub.example.test:8443", "MMF_PORT=9876", "MMF_HOST=127.0.0.1", ""].join("\n"),
    );
    expect(await readFile(unitFile, "utf8")).toContain("ExecStart=");
    expect(await mode(configDir)).toBe(0o700);
    expect(await mode(path.dirname(unitFile))).toBe(0o700);
    expect(await mode(envFile)).toBe(0o600);
    expect(await mode(unitFile)).toBe(0o600);
    expect(first.stdout).toContain("mmf passphrase");
    expect(first.stdout).toContain("mmf device add");
    expect(first.stdout).toContain("tailscale serve");
    expect(first.stdout).toContain("http://127.0.0.1:9876");

    const before = await Promise.all([envFile, unitFile].map((file) => readFile(file, "utf8")));
    const second = await runScript(installHub, args);
    expect(second.code).toBe(0);
    await expect(Promise.all([envFile, unitFile].map((file) => readFile(file, "utf8")))).resolves.toEqual(before);
  });

  test("rejects invalid public URLs, ports, and non-Linux platforms", async () => {
    const invalidUrl = await runScript(installHub, [
      "--public-url",
      "http://hub.example.test",
      "--prefix",
      await tempPrefix(),
      "--platform",
      "linux",
      "--dry-run",
    ]);
    expect(invalidUrl.code).not.toBe(0);
    expect(invalidUrl.stderr).toMatch(/public.*https:\/\//i);

    const invalidPort = await runScript(installHub, [
      "--public-url",
      "https://hub.example.test",
      "--port",
      "70000",
      "--prefix",
      await tempPrefix(),
      "--platform",
      "linux",
      "--dry-run",
    ]);
    expect(invalidPort.code).not.toBe(0);
    expect(invalidPort.stderr).toMatch(/port/i);

    const darwin = await runScript(installHub, [
      "--public-url",
      "https://hub.example.test",
      "--prefix",
      await tempPrefix(),
      "--platform",
      "darwin",
      "--dry-run",
    ]);
    expect(darwin.code).not.toBe(0);
    expect(darwin.stderr).toMatch(/linux/i);
  });
});

const plutilAvailable = spawnSync("plutil", ["-help"], { stdio: "ignore" }).error === undefined;

test.skipIf(!plutilAvailable)("generated macOS plist passes plutil lint", async () => {
  const prefix = await tempPrefix();
  const result = await runScript(
    installAgent,
    ["--hub", "wss://hub.example.test/agent", "--prefix", prefix, "--platform", "darwin", "--dry-run"],
    `${validToken}\n`,
  );
  expect(result.code).toBe(0);
  const plistFile = path.join(prefix, "Library", "LaunchAgents", "dev.mcp-machine-fabric.agent.plist");
  const lint = spawnSync("plutil", ["-lint", plistFile], { encoding: "utf8" });
  expect(lint.status, lint.stderr || lint.stdout).toBe(0);
});
