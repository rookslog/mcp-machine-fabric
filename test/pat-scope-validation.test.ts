// Lane REVIEW-AUTH finding: `mmf token create` scope parsing fails open.
// `--scopes ""` mints a full read/write/exec token, and an invalid machine
// scope passed through --scopes is silently dropped, so the PAT ends up with
// access to ALL machines. Expected to FAIL on e2c9e77.
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, expect, test } from "vitest";
import { FabricOAuthProvider } from "../src/hub/oauth.js";
import { HubStore } from "../src/hub/store.js";

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
  await execFileAsync("npm", ["run", "build"], { cwd: process.cwd(), timeout: 60_000 });
}, 90_000);
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function createViaCli(args: string[]): Promise<{ code: number; scopes?: string[] }> {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "mmf-lane-cli-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const seed = new HubStore(dir);
  seed.addDevice("alpha");
  seed.addDevice("beta");
  seed.close();
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("node", ["dist/cli.js", "token", "create", "lane", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: dir, MMF_DATA_DIR: dir },
      timeout: 10_000,
    }));
  } catch (error) {
    return { code: (error as { code?: number }).code ?? 1 };
  }
  const token = stdout.match(/mmf_pat_[A-Za-z0-9_-]+/)![0];
  const store = new HubStore(dir);
  const provider = new FabricOAuthProvider({ db: store.db, mcpResourceUrl: "http://127.0.0.1:8787/mcp" });
  const scopes = (await provider.verifyAccessToken(token)).scopes;
  store.close();
  return { code: 0, scopes };
}

test("--scopes '' does not mint a full read/write/exec token", async () => {
  const result = await createViaCli(["--scopes", ""]);
  if (result.code === 0) expect(result.scopes).not.toContain("fabric:exec");
});

test("an invalid machine scope in --scopes is rejected rather than widened to all machines", async () => {
  const result = await createViaCli(["--scopes", "fabric:read,machine:Alpha"]);
  if (result.code === 0) expect(result.scopes!.some((scope) => scope.startsWith("machine:"))).toBe(true);
});

// Removing strict grant validation would make these tokens grant all machines.
test("the provider rejects empty, dropped, and unenrolled scope entries before persisting", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const provider = new FabricOAuthProvider({ db, mcpResourceUrl: "http://localhost/mcp", listMachines: () => ["alpha"] });
    for (const scopes of [[], ["fabric:read", ""], ["fabric:read", "unknown"], ["fabric:read", "machine:Alpha"], ["fabric:read", "machine:missing"]]) {
      expect(() => provider.createPersonalToken("invalid", scopes)).toThrow();
    }
    expect(provider.listPersonalTokens()).toHaveLength(0);
    expect(() => provider.createPersonalToken("valid", ["fabric:read", "machine:alpha"])).not.toThrow();
  } finally { db.close(); }
});

test("the CLI rejects an unenrolled machine passed through --scopes", async () => {
  expect((await createViaCli(["--scopes", "fabric:read,machine:missing"])).code).not.toBe(0);
});
