// Lane REVIEW-AUTH finding: the TOCTOU hardening covers read_file and the
// mutating tools, but the portable search_files walk lstat()s a child and then
// readFile()s it by path (following symlinks), with no O_NOFOLLOW and no
// dev/ino re-check. A co-resident writer that swaps a regular file for a
// symlink between the two calls makes search_files return the lines of a file
// outside the roots. Probabilistic race; expected to FAIL on e2c9e77 within the
// iteration budget.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test } from "vitest";
import { runFsTool } from "../src/agent/fs-tools.js";
import { normalizePolicy } from "../src/agent/policy.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

test("search_files never returns content from outside the roots while a file is swapped for a symlink", async () => {
  const base = await mkdtemp(nodePath.join(tmpdir(), "mmf-lane-race-"));
  const root = nodePath.join(base, "root");
  const outside = nodePath.join(base, "outside");
  await mkdir(nodePath.join(root, ".stage"), { recursive: true });
  await mkdir(outside, { recursive: true });
  const secret = nodePath.join(outside, "secret.txt");
  await writeFile(secret, "OUTSIDE_SECRET_LINE\n");
  await writeFile(nodePath.join(root, "victim"), "harmless\n");
  const policy = await normalizePolicy({ roots: [root] });

  const swapper = new Worker(
    `const fs = require("node:fs"); const path = require("node:path");
     const { root, secret } = require("node:worker_threads").workerData;
     const victim = path.join(root, "victim"), link = path.join(root, ".stage/l"), plain = path.join(root, ".stage/p");
     for (;;) {
       try { fs.symlinkSync(secret, link); fs.renameSync(link, victim); } catch {}
       try { fs.writeFileSync(plain, "harmless\\n"); fs.renameSync(plain, victim); } catch {}
     }`,
    { eval: true, workerData: { root, secret } },
  );
  cleanups.push(async () => {
    await swapper.terminate();
    await rm(base, { recursive: true, force: true });
  });

  let leaked: string | undefined;
  const deadline = Date.now() + 20_000;
  let iterations = 0;
  while (!leaked && Date.now() < deadline && iterations < 20_000) {
    iterations += 1;
    const outcome = await runFsTool(policy, "search_files", { path: root, content_regex: "OUTSIDE_SECRET" }, { forceJsSearch: true });
    if (outcome.ok && outcome.text.includes("OUTSIDE_SECRET_LINE")) leaked = outcome.text;
  }
  console.log(`[lane-auth] ${leaked ? "leaked" : "no leak"} after ${iterations} searches`);
  expect(leaked, `search_files returned an outside-root line after ${iterations} searches:\n${leaked}`).toBeUndefined();
}, 40_000);
