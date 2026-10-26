import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];
const handles: Awaited<ReturnType<typeof open>>[] = [];

async function scratch() {
  const root = await mkdtemp(path.join(tmpdir(), "mmf-release-"));
  roots.push(root);
  return root;
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input = "") {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => { stdout += b; });
    child.stderr.on("data", (b) => { stderr += b; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 128, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function fixture() {
  const root = await scratch();
  const home = path.join(root, "home");
  await mkdir(home);
  const env = { ...process.env, HOME: home, npm_config_cache: path.join(root, "cache"), npm_config_offline: "true", npm_config_update_notifier: "false", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const exec = (command: string, args: string[]) => run(command, args, root, env);
  const git = async (...args: string[]) => {
    const r = await exec("git", args);
    expect(r.code, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  await mkdir(path.join(root, "scripts"));
  await cp(path.join(repo, "scripts/install-release.sh"), path.join(root, "scripts/install-release.sh"));
  try { await cp(path.join(repo, "scripts/release-state.mjs"), path.join(root, "scripts/release-state.mjs")); }
  catch (e: any) { if (e.code !== "ENOENT") throw e; }
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "release-fixture", version: "1.0.0", scripts: { build: "node build.cjs" } }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ name: "release-fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "release-fixture", version: "1.0.0" } } }));
  await writeFile(path.join(root, "payload"), "release X\n");
  await writeFile(path.join(root, "build.cjs"), 'const fs = require("node:fs"); fs.mkdirSync("dist", {recursive:true}); fs.copyFileSync("payload", "dist/cli.js");\n');
  await writeFile(path.join(root, ".gitignore"), "home/\ncache/\nnode_modules/\ndist/\nbin/\n");
  await git("init", "-q");
  await git("add", ".");
  await git("-c", "user.name=Release Test", "-c", "user.email=release@example.invalid", "commit", "-qm", "release X");
  const install = () => exec("/bin/bash", ["scripts/install-release.sh"]);
  const base = path.join(home, ".local/opt/mcp-machine-fabric");
  const current = () => readlink(path.join(base, "current"));
  return { root, home, env, exec, git, install, base, current };
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

describe("immutable source releases", () => {
  test("reuses a clean release without replacing its inode and records the rollback target", async () => {
    const f = await fixture();
    expect((await f.install()).code).toBe(0);
    const x = await f.current();
    const before = await lstat(x);
    const liveFile = await open(path.join(x, "dist/cli.js"), "r");
    handles.push(liveFile); // keep the inode allocated while reinstalling
    const cliBefore = await liveFile.stat();
    await writeFile(path.join(f.root, "payload"), "release Y\n");
    await f.git("add", "payload");
    await f.git("-c", "user.name=Release Test", "-c", "user.email=release@example.invalid", "commit", "-qm", "release Y");
    const upgrade = await f.install();
    expect(upgrade.code, upgrade.stderr).toBe(0);
    const y = await f.current();
    await f.git("checkout", "HEAD~1");
    const reuse = await f.install();
    expect(reuse.code, reuse.stderr).toBe(0);
    expect(await f.current()).toBe(x);
    expect((await lstat(x)).ino).toBe(before.ino);
    expect((await lstat(path.join(x, "dist/cli.js"))).ino).toBe(cliBefore.ino);
    expect(upgrade.stdout).toContain(`previous current: ${x}`);
    expect(reuse.stdout).toContain(`previous current: ${y}`);
    expect(await readFile(path.join(y, "dist/cli.js"), "utf8")).toBe("release Y\n");
  });

  test("dirty names distinguish staged edits and untracked contents, and identical contents reuse the inode", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "payload"), "dirty one\n");
    expect((await f.install()).code).toBe(0);
    const first = await f.current();
    const firstInode = (await lstat(first)).ino;
    await writeFile(path.join(f.root, "payload"), "dirty two\n");
    await f.git("add", "payload");
    expect((await f.install()).code).toBe(0);
    const second = await f.current();
    expect(second).not.toBe(first);
    await writeFile(path.join(f.root, "untracked"), "one");
    expect((await f.install()).code).toBe(0);
    const third = await f.current();
    await writeFile(path.join(f.root, "untracked"), "two");
    expect((await f.install()).code).toBe(0);
    expect(await f.current()).not.toBe(third);
    await rm(path.join(f.root, "untracked"));
    await f.git("reset", "--quiet");
    await writeFile(path.join(f.root, "payload"), "dirty one\n");
    expect((await f.install()).code).toBe(0);
    expect(await f.current()).toBe(first);
    expect((await lstat(first)).ino).toBe(firstInode);
    expect(await readFile(path.join(second, "dist/cli.js"), "utf8")).toBe("dirty two\n");
  }, 60_000);

  test.each(["changed", "extra", "missing", "mode"])("rejects a %s installed tree without repairing or replacing it", async (damage) => {
    const f = await fixture();
    expect((await f.install()).code).toBe(0);
    const target = await f.current();
    const ino = (await lstat(target)).ino;
    const cli = path.join(target, "dist/cli.js");
    if (damage === "changed") await writeFile(cli, "damaged");
    if (damage === "extra") await writeFile(path.join(target, "foreign"), "preserve me");
    if (damage === "missing") await rm(cli);
    if (damage === "mode") await chmod(cli, 0o700);
    const result = await f.install();
    expect(result.code).not.toBe(0);
    expect(await f.current()).toBe(target);
    expect((await lstat(target)).ino).toBe(ino);
    if (damage === "changed") expect(await readFile(cli, "utf8")).toBe("damaged");
    if (damage === "extra") expect(await readFile(path.join(target, "foreign"), "utf8")).toBe("preserve me");
    if (damage === "missing") await expect(lstat(cli)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("failed build preserves current and existing releases", async () => {
    const f = await fixture();
    expect((await f.install()).code).toBe(0);
    const target = await f.current();
    const ino = (await lstat(target)).ino;
    await writeFile(path.join(f.root, "build.cjs"), "process.exit(19);\n");
    const failed = await f.install();
    expect(failed.code).not.toBe(0);
    expect(await f.current()).toBe(target);
    expect((await lstat(target)).ino).toBe(ino);
    expect(failed.stdout).toContain(`previous current: ${target}`);
    expect(await readFile(path.join(target, "dist/cli.js"), "utf8")).toBe("release X\n");
    expect((await readdir(f.base)).sort()).toEqual(["current", path.basename(target)].sort());
  });

  test("an existing installer lock prevents any release or current changes", async () => {
    const f = await fixture();
    expect((await f.install()).code).toBe(0);
    const target = await f.current();
    const inode = (await lstat(target)).ino;
    await mkdir(path.join(f.base, ".install-lock"));
    await writeFile(path.join(f.base, ".install-lock", "owner"), "other installer");
    expect((await f.install()).code).not.toBe(0);
    expect(await f.current()).toBe(target);
    expect((await lstat(target)).ino).toBe(inode);
    expect(await readFile(path.join(f.base, ".install-lock", "owner"), "utf8")).toBe("other installer");
  });

  test("failed runtime dependency install preserves preexisting directories and cleans only its own stage", async () => {
    const f = await fixture();
    expect((await f.install()).code).toBe(0);
    const target = await f.current();
    const leftover = `${target}.tmp`;
    await mkdir(leftover);
    await writeFile(path.join(leftover, "keep"), "existing release data");
    const bin = path.join(f.root, "bin");
    await mkdir(bin);
    const npm = spawnSync("which", ["npm"], { encoding: "utf8" }).stdout.trim();
    await writeFile(path.join(bin, "npm"), `#!/usr/bin/env bash\nfor arg in "$@"; do if [[ "$arg" == --omit=dev ]]; then exit 23; fi; done\nexec '${npm.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
    f.env.PATH = `${bin}:${process.env.PATH}`;
    expect((await f.install()).code).not.toBe(0);
    expect(await f.current()).toBe(target);
    expect(await readFile(path.join(leftover, "keep"), "utf8")).toBe("existing release data");
    expect((await readdir(f.base)).sort()).toEqual(["current", path.basename(target), path.basename(leftover)].sort());
  });
});
