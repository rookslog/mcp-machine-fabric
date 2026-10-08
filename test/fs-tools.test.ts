import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runFsTool, type FsToolName } from "../src/agent/fs-tools.js";
import { normalizePolicy, type Policy } from "../src/agent/policy.js";
import type { ToolOutcome } from "../src/shared/protocol.js";

const rgAvailable = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
const crossDeviceParent = findCrossDeviceTempParent();

function findCrossDeviceTempParent(): string | undefined {
  const candidate = "/dev/shm";
  try {
    if (!existsSync(candidate) || statSync(candidate).dev === statSync(tmpdir()).dev) return undefined;
    accessSync(candidate, constants.W_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

function success(outcome: ToolOutcome) {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.code}: ${outcome.message}`);
  return outcome;
}

function failure(outcome: ToolOutcome, code: string) {
  expect(outcome).toMatchObject({ ok: false, code });
  if (outcome.ok) throw new Error("expected failure");
  return outcome;
}

describe("runFsTool", () => {
  let sandbox: string;
  let root: string;
  let outside: string;
  let policy: Policy;

  beforeEach(async () => {
    sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "mmf-fs-tools-")));
    root = path.join(sandbox, "root");
    outside = path.join(sandbox, "outside");
    await Promise.all([mkdir(root), mkdir(outside)]);
    policy = await normalizePolicy({ roots: [root] });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  test("read_file reads a negative offset and hashes the whole file", async () => {
    const file = path.join(root, "lines.txt");
    await writeFile(file, "zero\none\ntwo\nthree");

    const outcome = success(await runFsTool(policy, "read_file", { path: file, offset: -2, length: 10 }));

    expect(outcome.text).toBe("[lines 2-3 of 4]\ntwo\nthree");
    expect(outcome.data).toEqual({
      path: file,
      total_lines: 4,
      offset: 2,
      lines_returned: 2,
      sha256: "b08a9bad77181d6af8581640099f69e0689f1fcc2ab75207f1fad104e8412936",
      truncated: true,
    });
  });

  test("read_file defaults to 1000 lines", async () => {
    const file = path.join(root, "many-lines.txt");
    await writeFile(file, Array.from({ length: 1001 }, (_, index) => `line-${index}`).join("\n"));

    const outcome = success(await runFsTool(policy, "read_file", { path: file }));

    expect(outcome.data).toMatchObject({ total_lines: 1001, offset: 0, lines_returned: 1000, truncated: true });
    expect(outcome.text.startsWith("[lines 0-999 of 1001]\nline-0\n")).toBe(true);
    expect(outcome.text.endsWith("\nline-999")).toBe(true);
  });

  test("read_file rejects binary and oversized files without dumping them", async () => {
    const binary = path.join(root, "binary.dat");
    const huge = path.join(root, "huge.txt");
    await writeFile(binary, Buffer.from([65, 0, 66]));
    await writeFile(huge, "x");
    await truncate(huge, 50 * 1024 * 1024 + 1);

    expect(failure(await runFsTool(policy, "read_file", { path: binary }), "invalid_arguments").message).toContain(
      "binary file",
    );
    failure(await runFsTool(policy, "read_file", { path: huge }), "too_large");
  });

  test("list_directory recurses without following symlinked directories and sorts directories first", async () => {
    const dirA = path.join(root, "a-dir");
    const deeper = path.join(dirA, "deeper");
    const dirZ = path.join(root, "z-dir");
    await Promise.all([mkdir(deeper, { recursive: true }), mkdir(dirZ)]);
    await Promise.all([
      writeFile(path.join(root, "b.txt"), "b"),
      writeFile(path.join(root, "a.txt"), "a"),
      writeFile(path.join(root, ".hidden"), "hidden"),
      writeFile(path.join(dirA, "nested.txt"), "nested"),
      writeFile(path.join(outside, "secret.txt"), "secret"),
    ]);
    await symlink(outside, path.join(root, "outside-link"));

    const outcome = success(await runFsTool(policy, "list_directory", { path: root, depth: 2 }));
    const entries = outcome.data?.entries as Array<{ path: string; type: string; size: number }>;

    expect(entries.map((entry) => [path.relative(root, entry.path), entry.type])).toEqual([
      ["a-dir", "dir"],
      ["a-dir/deeper", "dir"],
      ["z-dir", "dir"],
      ["a-dir/nested.txt", "file"],
      ["a.txt", "file"],
      ["b.txt", "file"],
      ["outside-link", "symlink"],
    ]);
    expect(outcome.data?.truncated).toBe(false);
  });

  test("list_directory includes hidden entries on request and caps output at 2000 entries", async () => {
    await writeFile(path.join(root, ".visible-on-request"), "yes");
    await Promise.all(
      Array.from({ length: 2001 }, (_, index) => writeFile(path.join(root, `entry-${String(index).padStart(4, "0")}`), "")),
    );

    const outcome = success(await runFsTool(policy, "list_directory", { path: root, include_hidden: true }));
    const entries = outcome.data?.entries as unknown[];

    expect(entries).toHaveLength(2000);
    expect(outcome.data?.truncated).toBe(true);
  });

  test("get_file_info reports metadata and line count for a small text file", async () => {
    const file = path.join(root, "info.txt");
    await writeFile(file, "first\nsecond\n");
    await chmod(file, 0o640);

    const outcome = success(await runFsTool(policy, "get_file_info", { path: file }));

    expect(outcome.data).toMatchObject({ path: file, type: "file", size: 13, mode: "640", lines: 2 });
    expect(typeof outcome.data?.mtime).toBe("string");
  });

  test("write_file creates parents, appends, rewrites, and preserves an existing mode", async () => {
    const file = path.join(root, "nested", "write.txt");

    const created = success(await runFsTool(policy, "write_file", { path: file, content: "hello\n" }));
    expect(created.data).toMatchObject({ path: file, bytes_written: 6 });
    expect(created.data?.sha256).toBe("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03");

    await runFsTool(policy, "write_file", { path: file, content: "world\n", mode: "append" });
    expect(await readFile(file, "utf8")).toBe("hello\nworld\n");

    await chmod(file, 0o640);
    await runFsTool(policy, "write_file", { path: file, content: "replacement", mode: "rewrite" });
    expect(await readFile(file, "utf8")).toBe("replacement");
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });

  test("write_file rejects a stale hash and a hash for a missing file", async () => {
    const existing = path.join(root, "existing.txt");
    const missingParent = path.join(root, "not-created-on-conflict");
    const missing = path.join(missingParent, "missing.txt");
    await writeFile(existing, "current");

    failure(
      await runFsTool(policy, "write_file", { path: existing, content: "new", expected_sha256: "stale" }),
      "conflict",
    );
    failure(
      await runFsTool(policy, "write_file", { path: missing, content: "new", expected_sha256: "anything" }),
      "conflict",
    );
    expect(await readFile(existing, "utf8")).toBe("current");
    await expect(lstat(missingParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("write_file serializes expected hashes so only one concurrent rewrite wins", async () => {
    const file = path.join(root, "compare-and-write.txt");
    await writeFile(file, "hello\n");
    const expectedSha256 = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";

    const outcomes = await Promise.all([
      runFsTool(policy, "write_file", { path: file, content: "first", expected_sha256: expectedSha256 }),
      runFsTool(policy, "write_file", { path: file, content: "second", expected_sha256: expectedSha256 }),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok && outcome.code === "conflict")).toHaveLength(1);
    expect(["first", "second"]).toContain(await readFile(file, "utf8"));
  });

  test("edit_file replaces the exact expected count and returns context", async () => {
    const file = path.join(root, "edit.txt");
    await writeFile(file, "before\nneedle\nafter\nneedle\nend");

    const outcome = success(
      await runFsTool(policy, "edit_file", {
        path: file,
        old_text: "needle",
        new_text: "changed",
        expected_replacements: 2,
      }),
    );

    expect(await readFile(file, "utf8")).toBe("before\nchanged\nafter\nchanged\nend");
    expect(outcome.text).toContain("-needle");
    expect(outcome.text).toContain("+changed");
    expect(outcome.data).toMatchObject({ path: file, replacements: 2 });
  });

  test("edit_file reports the found count and leaves the file unchanged on mismatch", async () => {
    const file = path.join(root, "edit-conflict.txt");
    await writeFile(file, "one needle only");

    const outcome = failure(
      await runFsTool(policy, "edit_file", {
        path: file,
        old_text: "needle",
        new_text: "changed",
        expected_replacements: 2,
      }),
      "conflict",
    );

    expect(outcome.data).toEqual({ found: 1 });
    expect(await readFile(file, "utf8")).toBe("one needle only");
  });

  test("create_directory is recursive and idempotent but conflicts with a file", async () => {
    const directory = path.join(root, "one", "two");
    success(await runFsTool(policy, "create_directory", { path: directory }));
    success(await runFsTool(policy, "create_directory", { path: directory }));
    expect((await stat(directory)).isDirectory()).toBe(true);

    const file = path.join(root, "not-a-directory");
    await writeFile(file, "file");
    failure(await runFsTool(policy, "create_directory", { path: file }), "conflict");
  });

  test("move_path moves a path and refuses to overwrite a destination", async () => {
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    await writeFile(source, "move me");

    success(await runFsTool(policy, "move_path", { source, destination }));
    expect(await readFile(destination, "utf8")).toBe("move me");
    await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });

    const another = path.join(root, "another.txt");
    await writeFile(another, "another");
    failure(await runFsTool(policy, "move_path", { source: another, destination }), "conflict");
    expect(await readFile(another, "utf8")).toBe("another");
  });

  test("move_path serializes competing destinations without losing the losing source", async () => {
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    const destination = path.join(root, "winner.txt");
    await Promise.all([writeFile(first, "first"), writeFile(second, "second")]);

    const outcomes = await Promise.all([
      runFsTool(policy, "move_path", { source: first, destination }),
      runFsTool(policy, "move_path", { source: second, destination }),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok && outcome.code === "conflict")).toHaveLength(1);
    const destinationContent = await readFile(destination, "utf8");
    const losingSource = destinationContent === "first" ? second : first;
    expect(await readFile(losingSource, "utf8")).toBe(destinationContent === "first" ? "second" : "first");
  });

  test("move_path and an expected-hash write to its source have a serial outcome", async () => {
    const source = path.join(root, "move-write-source.txt");
    const destination = path.join(root, "move-write-destination.txt");
    await writeFile(source, "hello\n");
    const expectedSha256 = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";

    const [writeOutcome, moveOutcome] = await Promise.all([
      runFsTool(policy, "write_file", { path: source, content: "new content", expected_sha256: expectedSha256 }),
      runFsTool(policy, "move_path", { source, destination }),
    ]);

    expect(moveOutcome.ok).toBe(true);
    await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    if (writeOutcome.ok) {
      expect(await readFile(destination, "utf8")).toBe("new content");
    } else {
      expect(writeOutcome.code).toBe("conflict");
      expect(await readFile(destination, "utf8")).toBe("hello\n");
    }
  });

  test.skipIf(!crossDeviceParent)("move_path preserves relative symlinks during an EXDEV fallback", async () => {
    const destinationSandbox = await mkdtemp(path.join(crossDeviceParent!, "mmf-fs-tools-exdev-"));
    try {
      const source = path.join(root, "source-directory");
      const destination = path.join(destinationSandbox, "moved-directory");
      await mkdir(source);
      await writeFile(path.join(source, "target.txt"), "target");
      await symlink("target.txt", path.join(source, "relative-link"));
      const crossDevicePolicy = await normalizePolicy({ roots: [root, destinationSandbox] });

      success(await runFsTool(crossDevicePolicy, "move_path", { source, destination }));

      expect(await readlink(path.join(destination, "relative-link"))).toBe("target.txt");
      expect(await readFile(path.join(destination, "relative-link"), "utf8")).toBe("target");
      await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(destinationSandbox, { recursive: true, force: true });
    }
  });

  test("the JS search engine supports glob and content filters and reports truncation", async () => {
    await Promise.all([
      writeFile(path.join(root, "one.ts"), "first\nmatch alpha\n"),
      writeFile(path.join(root, "two.ts"), "match beta\n"),
      writeFile(path.join(root, "three.ts"), "match gamma\n"),
      writeFile(path.join(root, "ignored.txt"), "match ignored\n"),
      writeFile(path.join(root, ".hidden.ts"), "match hidden\n"),
    ]);

    const outcome = success(
      await runFsTool(
        policy,
        "search_files",
        { path: root, name_pattern: "*.ts", content_regex: "match", max_results: 2 },
        { forceJsSearch: true },
      ),
    );
    const matches = outcome.data?.matches as Array<{ path: string; line: number; text: string }>;

    expect(outcome.data?.engine).toBe("js");
    expect(matches).toHaveLength(2);
    expect(matches.every((match) => match.path.endsWith(".ts") && !match.path.includes(".hidden"))).toBe(true);
    expect(matches.every((match) => match.line >= 1 && match.text.includes("match"))).toBe(true);
    expect(outcome.data?.truncated).toBe(true);
  });

  test.skipIf(!rgAvailable)("the ripgrep search engine supports glob and content filters", async () => {
    await Promise.all([
      writeFile(path.join(root, "one.ts"), "first\nmatch alpha\n"),
      writeFile(path.join(root, "two.txt"), "match ignored\n"),
    ]);

    const outcome = success(
      await runFsTool(policy, "search_files", {
        path: root,
        name_pattern: "*.ts",
        content_regex: "match",
        max_results: 10,
      }),
    );

    expect(outcome.data?.engine).toBe("ripgrep");
    expect(outcome.data?.matches).toEqual([{ path: path.join(root, "one.ts"), line: 2, text: "match alpha" }]);
    expect(outcome.data?.truncated).toBe(false);
  });

  test.skipIf(!rgAvailable)("ripgrep treats option-looking content regexes as patterns", async () => {
    await writeFile(path.join(root, "option.txt"), "ToolOutcome\n");
    const restricted = await normalizePolicy({ roots: [root], read_only: true, allow_exec: false });

    const outcome = success(
      await runFsTool(restricted, "search_files", { path: root, content_regex: "--regexp=ToolOutcome" }),
    );

    expect(outcome.data).toMatchObject({ engine: "ripgrep", matches: [], truncated: false });
  });

  test.skipIf(!rgAvailable)("ripgrep keeps a newline-containing filename as one name-only match", async () => {
    const file = path.join(root, "line\nbreak.ts");
    await writeFile(file, "content");

    const rgOutcome = success(await runFsTool(policy, "search_files", { path: root, name_pattern: "*.ts" }));
    const jsOutcome = success(
      await runFsTool(policy, "search_files", { path: root, name_pattern: "*.ts" }, { forceJsSearch: true }),
    );

    expect(rgOutcome.data).toMatchObject({ engine: "ripgrep", matches: [{ path: file }], truncated: false });
    expect(jsOutcome.data).toMatchObject({ engine: "js", matches: [{ path: file }], truncated: false });
  });

  test("search_files requires a filter and rejects an invalid regex", async () => {
    failure(await runFsTool(policy, "search_files", { path: root }, { forceJsSearch: true }), "invalid_arguments");
    failure(
      await runFsTool(policy, "search_files", { path: root, content_regex: "[" }, { forceJsSearch: true }),
      "invalid_arguments",
    );
  });

  test("outside-root and dot-dot traversal are denied", async () => {
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");

    failure(await runFsTool(policy, "read_file", { path: outsideFile }), "policy_denied");
    failure(
      await runFsTool(policy, "read_file", { path: path.join(root, "..", "outside", "secret.txt") }),
      "policy_denied",
    );
  });

  test("symlinks inside the root pointing outside are denied for reads and writes", async () => {
    const outsideFile = path.join(outside, "secret.txt");
    const readLink = path.join(root, "read-link");
    const writeLink = path.join(root, "write-link");
    await writeFile(outsideFile, "secret");
    await Promise.all([symlink(outsideFile, readLink), symlink(outsideFile, writeLink)]);

    failure(await runFsTool(policy, "read_file", { path: readLink }), "policy_denied");
    failure(await runFsTool(policy, "write_file", { path: writeLink, content: "overwrite" }), "policy_denied");
    expect(await readFile(outsideFile, "utf8")).toBe("secret");
  });

  test("a broken symlink targeting an outside path is denied before append can create its target", async () => {
    const outsideTarget = path.join(outside, "not-created.txt");
    const brokenLink = path.join(root, "broken-link");
    await symlink(outsideTarget, brokenLink);

    failure(
      await runFsTool(policy, "write_file", { path: brokenLink, content: "escape", mode: "append" }),
      "policy_denied",
    );
    await expect(lstat(outsideTarget)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a multi-hop broken symlink chain targeting outside is denied", async () => {
    const outsideTarget = path.join(outside, "not-created-through-chain.txt");
    const secondLink = path.join(root, "second-link");
    const firstLink = path.join(root, "first-link");
    await symlink(outsideTarget, secondLink);
    await symlink(secondLink, firstLink);

    failure(
      await runFsTool(policy, "write_file", { path: firstLink, content: "escape", mode: "append" }),
      "policy_denied",
    );
    await expect(lstat(outsideTarget)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("read-only policy allows reads and denies every mutating tool", async () => {
    const file = path.join(root, "readable.txt");
    const destination = path.join(root, "destination.txt");
    await writeFile(file, "readable");
    const readOnly = await normalizePolicy({ roots: [root], read_only: true });

    success(await runFsTool(readOnly, "read_file", { path: file }));

    const mutations: Array<[FsToolName, Record<string, unknown>]> = [
      ["write_file", { path: file, content: "changed" }],
      ["edit_file", { path: file, old_text: "readable", new_text: "changed" }],
      ["create_directory", { path: path.join(root, "new-dir") }],
      ["move_path", { source: file, destination }],
    ];
    for (const [tool, args] of mutations) {
      failure(await runFsTool(readOnly, tool, args), "policy_denied");
    }
    expect(await readFile(file, "utf8")).toBe("readable");
  });

  test("common filesystem misuse and missing paths map to stable error codes", async () => {
    const directory = path.join(root, "directory");
    await mkdir(directory);

    failure(await runFsTool(policy, "read_file", { path: path.join(root, "missing") }), "not_found");
    failure(await runFsTool(policy, "read_file", { path: directory }), "invalid_arguments");
    failure(await runFsTool(policy, "list_directory", { path: path.join(root, "missing") }), "not_found");
  });
});
