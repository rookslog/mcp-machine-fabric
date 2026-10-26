// Removing raw-mode input or confirmation exposes the secret on this real PTY.
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, expect, test } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { FabricOAuthProvider } from "../src/hub/oauth.js";
const exec = promisify(execFile), dirs: string[] = [];
beforeAll(async () => { await exec("npm", ["run", "build"], { timeout: 60_000 }); }, 90_000);
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function home() { const dir = await mkdtemp(path.join(tmpdir(), "mmf-passphrase-")); dirs.push(dir); return dir; }
for (const mode of ["matching", "mismatch", "interrupt"]) test(`TTY passphrase ${mode}: no echo, confirmation, and terminal restoration`, async () => {
  const dir = await home();
  const { stdout } = await exec("python3", ["test/fixtures/passphrase-pty.py", mode], { env: { ...process.env, HOME: dir, MMF_DATA_DIR: dir }, timeout: 30_000 });
  const result = JSON.parse(stdout);
  expect(result).toMatchObject({ prompted: true, echoOff: true, confirmation: true, echoed: false, restored: true });
  expect(result.code === 0).toBe(mode === "matching");
  const store = new HubStore(dir);
  try {
    const provider = new FabricOAuthProvider({ db: store.db, mcpResourceUrl: "http://localhost/mcp" });
    expect(provider.hasOwnerPassphrase()).toBe(mode === "matching");
    if (mode === "matching") expect(await provider.verifyOwnerPassphrase("private example passphrase")).toBe(true);
  } finally { store.close(); }
});
test("piped passphrase input keeps its single-input behavior", async () => {
  const dir = await home();
  const result = spawnSync("node", ["dist/cli.js", "passphrase"], { env: { ...process.env, HOME: dir, MMF_DATA_DIR: dir }, input: "private piped passphrase\n", encoding: "utf8", timeout: 10_000 });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Owner passphrase set");
  expect(result.stderr).not.toContain("Confirm");
});
