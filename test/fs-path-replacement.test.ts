// Deterministic versions of the co-resident writer races. Without descriptor
// reads/rechecks, the swaps below expose outside content/names or create there.
import { vi, afterEach, expect, test } from "vitest";
const races = vi.hoisted(() => ({ afterLstat: undefined as undefined | ((p: string) => Promise<void>), beforeReaddir: undefined as undefined | ((p: string) => Promise<void>), afterStat: undefined as undefined | ((p: string) => Promise<void>), beforeMkdir: undefined as undefined | ((p: string) => Promise<void>), beforeSpawn: undefined as undefined | (() => void), rgOutput: undefined as string | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => { const info = await fs.lstat(...args); await races.afterLstat?.(String(args[0])); return info; },
    stat: async (...args: Parameters<typeof fs.stat>) => { const info = await fs.stat(...args); await races.afterStat?.(String(args[0])); return info; },
    readdir: async (...args: Parameters<typeof fs.readdir>) => { await races.beforeReaddir?.(String(args[0])); return fs.readdir(...args); },
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => { await races.beforeMkdir?.(String(args[0])); return fs.mkdir(...args); },
  };
});
vi.mock("node:child_process", async (original) => {
  const cp = await original<typeof import("node:child_process")>();
  return { ...cp, spawn: (...args: Parameters<typeof cp.spawn>) => {
    races.beforeSpawn?.();
    if (args[0] === "rg" && races.rgOutput !== undefined) return cp.spawn(process.execPath, ["-e", "process.stdout.write(" + JSON.stringify(races.rgOutput) + ")"], { stdio: ["ignore", "pipe", "pipe"] });
    return cp.spawn(...args);
  } };
});
import { renameSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runFsTool } from "../src/agent/fs-tools.js";
import { normalizePolicy } from "../src/agent/policy.js";
const cleanup: string[] = [];
afterEach(async () => { for (const key of Object.keys(races) as (keyof typeof races)[]) races[key] = undefined; for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "mmf-fs-race-")); cleanup.push(base);
  const root = path.join(base, "root"), outside = path.join(base, "outside");
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(outside, "OUTSIDE_NAME"), "OUTSIDE_SECRET\nsecond\nthird\n");
  return { base, root, outside, policy: await normalizePolicy({ roots: [root] }) };
}

test("JS search does not read a file replaced after lstat", async () => {
  const f = await fixture(), victim = path.join(f.root, "victim"); await writeFile(victim, "harmless\n");
  races.afterLstat = async (p) => { if (p === victim) { races.afterLstat = undefined; await rm(victim); await symlink(path.join(f.outside, "OUTSIDE_NAME"), victim); } };
  const out = await runFsTool(f.policy, "search_files", { path: f.root, content_regex: "OUTSIDE_SECRET" }, { forceJsSearch: true });
  expect(out.ok && out.text.includes("OUTSIDE_SECRET")).toBe(false);
});

test("get_file_info does not count lines of a file replaced after stat", async () => {
  const f = await fixture(), victim = path.join(f.root, "victim"); await writeFile(victim, "harmless\n");
  races.afterStat = async (p) => { if (p === victim) { races.afterStat = undefined; await rm(victim); await symlink(path.join(f.outside, "OUTSIDE_NAME"), victim); } };
  const out = await runFsTool(f.policy, "get_file_info", { path: victim });
  expect(out.ok && out.data?.lines === 3).toBe(false);
});

test("list_directory does not return names from a replaced directory", async () => {
  const f = await fixture(), victim = path.join(f.root, "victim"); await mkdir(victim);
  races.beforeReaddir = async (p) => { if (p === victim || p.startsWith("/proc/self/fd/")) { races.beforeReaddir = undefined; await rename(victim, victim + "-old"); await symlink(f.outside, victim); } };
  const out = await runFsTool(f.policy, "list_directory", { path: victim });
  expect(out.ok && out.text.includes("OUTSIDE_NAME")).toBe(false);
});

test("create_directory does not create children through a replaced parent", async () => {
  const f = await fixture(), victim = path.join(f.root, "victim"); await mkdir(victim);
  races.beforeMkdir = async () => { races.beforeMkdir = undefined; await rename(victim, victim + "-old"); await symlink(f.outside, victim); };
  await runFsTool(f.policy, "create_directory", { path: path.join(victim, "child", "nested") });
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await expect(fs.stat(path.join(f.outside, "child"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("ripgrep content is reread from the verified file before it is returned", async () => {
  const f = await fixture(), victim = path.join(f.root, "victim"); await writeFile(victim, "harmless\n");
  races.rgOutput = JSON.stringify({ type: "match", data: { path: { text: victim }, line_number: 1, lines: { text: "OUTSIDE_SECRET\n" } } }) + "\n";
  const out = await runFsTool(f.policy, "search_files", { path: f.root, content_regex: "OUTSIDE_SECRET" });
  expect(out.ok).toBe(true);
  if (out.ok) { expect(out.data?.engine).toBe("ripgrep"); expect(out.text).not.toContain("OUTSIDE_SECRET"); }
});

test("portable directory creation uses an inherited parent descriptor", async () => {
  const f = await fixture(), victim = path.join(f.root, "victim"); await mkdir(victim);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    // Execute the non-Linux branch on this host; this is not macOS qualification.
    Object.defineProperty(process, "platform", { value: "darwin" });
    races.beforeSpawn = () => {
      races.beforeSpawn = undefined;
      renameSync(victim, victim + "-old"); symlinkSync(f.outside, victim);
    };
    await runFsTool(f.policy, "create_directory", { path: path.join(victim, "child") });
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await expect(fs.stat(path.join(f.outside, "child"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(path.join(victim + "-old", "child"))).isDirectory()).toBe(true);
  } finally { Object.defineProperty(process, "platform", platform); }
});
