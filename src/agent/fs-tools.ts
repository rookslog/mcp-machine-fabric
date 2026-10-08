/**
 * File tools executed on the agent. CONTRACT (implemented by the fs slice; see
 * test/fs-tools.test.ts): every function takes the normalized Policy and the
 * already-validated args for the tool of the same name in src/shared/tools.ts,
 * enforces policy via checkPath() from ./policy.ts, and returns a ToolOutcome.
 * Expected failures return {ok:false, code, message}; they never throw.
 *
 *   read_file         text only (NUL byte in first 8KB => {ok:false, code:"invalid_arguments", "binary file"}),
 *                     data: {path, total_lines, offset, lines_returned, sha256, truncated}
 *   list_directory    data: {entries:[{path, type:"file"|"dir"|"symlink"|"other", size}], truncated}
 *   get_file_info     data: {path, type, size, mode (octal string), mtime, lines? (text files <1MB)}
 *   search_files      ripgrep if on PATH else a bounded JS walk; data: {matches:[{path, line?, text?}], truncated, engine}
 *   write_file        rewrite = write tmp + rename (atomic); append; expected_sha256 mismatch => code "conflict";
 *                     data: {path, bytes_written, sha256}
 *   edit_file         exact-count replacement; count mismatch => code "conflict" with data {found}; atomic rewrite
 *   create_directory  mkdir -p
 *   move_path         refuses existing destination (code "conflict"); both ends policy-checked
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { ToolErrorCode, ToolOutcome } from "../shared/protocol.js";
import { checkPath, PolicyError, type Policy } from "./policy.js";

export type FsToolName =
  | "read_file"
  | "list_directory"
  | "get_file_info"
  | "search_files"
  | "write_file"
  | "edit_file"
  | "create_directory"
  | "move_path";

export interface RunFsToolOptions {
  forceJsSearch?: boolean;
}

const MAX_READ_BYTES = 50 * 1024 * 1024;
const MAX_INFO_TEXT_BYTES = 1024 * 1024;
const MAX_SEARCH_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 2000;
const MAX_WALK_ENTRIES = 20_000;
const MAX_SYMLINK_HOPS = 40;
const SEARCH_TIMEOUT_MS = 30_000;
let mutationTail = Promise.resolve();

interface SearchMatch {
  path: string;
  line?: number;
  text?: string;
}

interface DirectoryEntry {
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
}

class ExpectedFailure extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ExpectedFailure";
  }
}

export async function runFsTool(
  policy: Policy,
  tool: FsToolName,
  args: Record<string, any>,
  options: RunFsToolOptions = {},
): Promise<ToolOutcome> {
  try {
    switch (tool) {
      case "read_file":
        return await readFileTool(policy, args);
      case "list_directory":
        return await listDirectoryTool(policy, args);
      case "get_file_info":
        return await getFileInfoTool(policy, args);
      case "search_files":
        return await searchFilesTool(policy, args, options);
      case "write_file":
        return await writeFileTool(policy, args);
      case "edit_file":
        return await editFileTool(policy, args);
      case "create_directory":
        return await createDirectoryTool(policy, args);
      case "move_path":
        return await movePathTool(policy, args);
      default:
        throw new ExpectedFailure("invalid_arguments", `unknown filesystem tool: ${String(tool)}`);
    }
  } catch (error) {
    return failureFor(error);
  }
}

async function readFileTool(policy: Policy, args: Record<string, any>): Promise<ToolOutcome> {
  const checked = await checkedPath(policy, args.path, "read");
  const info = await stat(checked);
  if (info.size > MAX_READ_BYTES) {
    throw new ExpectedFailure("too_large", `file is larger than ${MAX_READ_BYTES} bytes`);
  }

  const content = await readFile(checked);
  if (isBinary(content)) throw new ExpectedFailure("invalid_arguments", "binary file cannot be read as text");

  const lines = textLines(content.toString("utf8"));
  const requestedOffset = args.offset ?? 0;
  const offset = Math.min(
    lines.length,
    requestedOffset < 0 ? Math.max(0, lines.length + requestedOffset) : requestedOffset,
  );
  const length = args.length ?? 1000;
  const selected = lines.slice(offset, offset + length);
  const last = selected.length === 0 ? offset : offset + selected.length - 1;
  const header = `[lines ${offset}-${last} of ${lines.length}]`;

  return {
    ok: true,
    text: selected.length > 0 ? `${header}\n${selected.join("\n")}` : header,
    data: {
      path: checked,
      total_lines: lines.length,
      offset,
      lines_returned: selected.length,
      sha256: sha256(content),
      truncated: offset > 0 || offset + selected.length < lines.length,
    },
  };
}

async function listDirectoryTool(policy: Policy, args: Record<string, any>): Promise<ToolOutcome> {
  const root = await checkedPath(policy, args.path, "read");
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new ExpectedFailure("invalid_arguments", "path is not a directory");

  const maxDepth = args.depth ?? 1;
  const includeHidden = args.include_hidden ?? false;
  const entries: DirectoryEntry[] = [];
  let truncated = false;

  async function visit(directory: string, depth: number): Promise<void> {
    if (truncated) return;
    const checkedDirectory = await checkedPath(policy, directory, "read");
    const children = await readdir(checkedDirectory, { withFileTypes: true });
    children.sort((left, right) => {
      const leftDirectory = left.isDirectory();
      const rightDirectory = right.isDirectory();
      if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

    const directories: string[] = [];
    for (const child of children) {
      if (!includeHidden && child.name.startsWith(".")) continue;
      if (entries.length === MAX_DIRECTORY_ENTRIES) {
        truncated = true;
        return;
      }

      const childPath = path.join(checkedDirectory, child.name);
      const childInfo = await lstat(childPath);
      const type = fileType(childInfo);
      entries.push({ path: childPath, type, size: childInfo.size });
      if (type === "dir") directories.push(childPath);
    }

    if (depth < maxDepth) {
      for (const childDirectory of directories) {
        await visit(childDirectory, depth + 1);
        if (truncated) return;
      }
    }
  }

  await visit(root, 1);
  entries.sort((left, right) => {
    const leftDirectory = left.type === "dir";
    const rightDirectory = right.type === "dir";
    if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
    return path.relative(root, left.path).localeCompare(path.relative(root, right.path));
  });
  return {
    ok: true,
    text: [
      `${entries.length} entr${entries.length === 1 ? "y" : "ies"} under ${root}${truncated ? " (truncated)" : ""}`,
      ...entries.map((e) => `${e.type === "dir" ? "[dir] " : e.type === "symlink" ? "[link]" : e.type === "file" ? "[file]" : "[other]"} ${path.relative(root, e.path) || "."}${e.type === "file" ? `  (${e.size} bytes)` : ""}`),
    ].join("\n"),
    data: { entries, truncated },
  };
}

async function getFileInfoTool(policy: Policy, args: Record<string, any>): Promise<ToolOutcome> {
  const checked = await checkedPath(policy, args.path, "read");
  const info = await stat(checked);
  const data: Record<string, unknown> = {
    path: checked,
    type: fileType(info),
    size: info.size,
    mode: (info.mode & 0o7777).toString(8),
    mtime: info.mtime.toISOString(),
  };

  if (info.isFile() && info.size < MAX_INFO_TEXT_BYTES) {
    const content = await readFile(checked);
    if (!isBinary(content)) data.lines = textLines(content.toString("utf8")).length;
  }

  return {
    ok: true,
    text: `${checked}: ${data.type}, ${info.size} bytes, mode ${data.mode}, modified ${data.mtime}${data.lines !== undefined ? `, ${data.lines} lines` : ""}`,
    data,
  };
}

async function searchFilesTool(
  policy: Policy,
  args: Record<string, any>,
  options: RunFsToolOptions,
): Promise<ToolOutcome> {
  const root = await checkedPath(policy, args.path, "read");
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new ExpectedFailure("invalid_arguments", "search path is not a directory");
  if (!args.name_pattern && !args.content_regex) {
    throw new ExpectedFailure("invalid_arguments", "search_files requires name_pattern and/or content_regex");
  }

  let contentRegex: RegExp | undefined;
  if (args.content_regex) {
    try {
      contentRegex = new RegExp(args.content_regex);
    } catch {
      throw new ExpectedFailure("invalid_arguments", "content_regex is not a valid regular expression");
    }
  }

  const maxResults = args.max_results ?? 100;
  if (!options.forceJsSearch) {
    const rgResult = await searchWithRipgrep(root, args, maxResults);
    if (rgResult) {
      return { ok: true, text: searchText(rgResult), data: { ...rgResult, engine: "ripgrep" } };
    }
  }

  const jsResult = await searchWithJs(policy, root, args, maxResults, contentRegex);
  return { ok: true, text: searchText(jsResult), data: { ...jsResult, engine: "js" } };
}

function searchText(result: { matches: Array<{ path: string; line?: number; text?: string }>; truncated: boolean }): string {
  const head = `${result.matches.length} match${result.matches.length === 1 ? "" : "es"}${result.truncated ? " (truncated; narrow the search or raise max_results)" : ""}`;
  const lines = result.matches.map((m) =>
    m.line !== undefined ? `${m.path}:${m.line}: ${(m.text ?? "").slice(0, 300)}` : m.path,
  );
  return [head, ...lines].join("\n");
}

async function searchWithRipgrep(
  root: string,
  args: Record<string, any>,
  maxResults: number,
): Promise<{ matches: SearchMatch[]; truncated: boolean } | null> {
  const rgArgs: string[] = ["--no-config"];
  const namesOnly = !args.content_regex;
  if (namesOnly) {
    rgArgs.push("--files", "--null", "--color", "never");
  } else {
    rgArgs.push("--json", "--line-number", "--with-filename", "--color", "never", "--max-count", String(maxResults + 1));
  }
  if (args.include_hidden) rgArgs.push("--hidden");
  if (args.name_pattern) rgArgs.push("--glob", args.name_pattern);
  if (!namesOnly) rgArgs.push("--regexp", args.content_regex);
  rgArgs.push("--", root);

  return await new Promise((resolve, reject) => {
    const child = spawn("rg", rgArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const matches: SearchMatch[] = [];
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killedForLimit = false;
    let settled = false;
    const separator = namesOnly ? "\0" : "\n";

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SEARCH_TIMEOUT_MS);

    const addMatch = (match: SearchMatch) => {
      if (matches.length <= maxResults) matches.push(match);
      if (matches.length > maxResults && !killedForLimit) {
        killedForLimit = true;
        child.kill("SIGTERM");
      }
    };

    const consumeRecord = (record: string) => {
      if (!record) return;
      if (namesOnly) {
        addMatch({ path: path.resolve(record) });
        return;
      }
      try {
        const event = JSON.parse(record) as {
          type?: string;
          data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number };
        };
        if (event.type !== "match" || !event.data?.path?.text) return;
        addMatch({
          path: path.resolve(event.data.path.text),
          line: event.data.line_number,
          text: (event.data.lines?.text ?? "").replace(/\r?\n$/, ""),
        });
      } catch {
        // Ignore incomplete/non-JSON diagnostic lines; process status decides fallback.
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const records = stdout.split(separator);
      stdout = records.pop() ?? "";
      for (const record of records) consumeRecord(record);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === "ENOENT") resolve(null);
      else reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdout) consumeRecord(stdout);
      if (timedOut) {
        reject(new ExpectedFailure("timeout", `search exceeded ${SEARCH_TIMEOUT_MS / 1000} seconds`));
        return;
      }
      if (killedForLimit || code === 0 || code === 1) {
        resolve({ matches: matches.slice(0, maxResults), truncated: matches.length > maxResults });
        return;
      }
      // ripgrep and JavaScript regular expressions differ; a JS-valid query
      // that rg cannot execute is still searchable by the portable engine.
      void stderr;
      resolve(null);
    });
  });
}

async function searchWithJs(
  policy: Policy,
  root: string,
  args: Record<string, any>,
  maxResults: number,
  contentRegex: RegExp | undefined,
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  const matches: SearchMatch[] = [];
  const nameRegex = args.name_pattern ? globToRegex(args.name_pattern) : undefined;
  const explicitNodeModules = Boolean(args.include_hidden && args.name_pattern?.split(/[\\/]/).includes("node_modules"));
  let walked = 0;
  let traversalTruncated = false;

  async function visit(directory: string): Promise<void> {
    if (matches.length > maxResults || traversalTruncated) return;
    const checkedDirectory = await checkedPath(policy, directory, "read");
    const children = await readdir(checkedDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      if (matches.length > maxResults || traversalTruncated) return;
      if (child.name === ".git") continue;
      if (child.name === "node_modules" && !explicitNodeModules) continue;
      if (!args.include_hidden && child.name.startsWith(".")) continue;
      walked += 1;
      if (walked > MAX_WALK_ENTRIES) {
        traversalTruncated = true;
        return;
      }

      const childPath = path.join(checkedDirectory, child.name);
      const childInfo = await lstat(childPath);
      if (childInfo.isSymbolicLink()) continue;
      if (childInfo.isDirectory()) {
        await visit(childPath);
        continue;
      }
      if (!childInfo.isFile()) continue;

      const relative = path.relative(root, childPath).split(path.sep).join("/");
      const nameToMatch = args.name_pattern?.includes("/") ? relative : child.name;
      if (nameRegex && !nameRegex.test(nameToMatch)) continue;

      if (!contentRegex) {
        matches.push({ path: childPath });
        continue;
      }
      if (childInfo.size >= MAX_SEARCH_TEXT_BYTES) continue;
      const content = await readFile(childPath);
      if (isBinary(content)) continue;
      for (const [index, line] of textLines(content.toString("utf8")).entries()) {
        if (contentRegex.test(line)) matches.push({ path: childPath, line: index + 1, text: line });
        if (matches.length > maxResults) return;
      }
    }
  }

  await visit(root);
  return {
    matches: matches.slice(0, maxResults),
    truncated: traversalTruncated || matches.length > maxResults,
  };
}

async function writeFileTool(policy: Policy, args: Record<string, any>): Promise<ToolOutcome> {
  const checked = await checkedPath(policy, args.path, "write");
  const parent = await checkedPath(policy, path.dirname(args.path), "write");

  return await withMutationLock(async () => {
    if (args.expected_sha256 !== undefined) {
      let current: Buffer;
      try {
        current = await readFile(checked);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          throw new ExpectedFailure("conflict", "file is missing; expected_sha256 cannot match");
        }
        throw error;
      }
      if (sha256(current) !== args.expected_sha256) {
        throw new ExpectedFailure("conflict", "file changed since expected_sha256 was calculated");
      }
    }

    await mkdir(parent, { recursive: true });
    const content = Buffer.from(args.content, "utf8");
    if ((args.mode ?? "rewrite") === "append") await appendFile(checked, content);
    else await atomicRewrite(checked, content);

    const finalContent = await readFile(checked);
    return {
      ok: true,
      text: `wrote ${content.byteLength} bytes to ${checked}`,
      data: { path: checked, bytes_written: content.byteLength, sha256: sha256(finalContent) },
    };
  });
}

async function editFileTool(policy: Policy, args: Record<string, any>): Promise<ToolOutcome> {
  const checked = await checkedPath(policy, args.path, "write");
  return await withMutationLock(async () => {
    const content = await readFile(checked, "utf8");
    const expected = args.expected_replacements ?? 1;
    const found = countOccurrences(content, args.old_text);
    if (found !== expected) {
      throw new ExpectedFailure("conflict", `expected ${expected} replacements but found ${found}`, { found });
    }

    const updated = content.split(args.old_text).join(args.new_text);
    await atomicRewrite(checked, Buffer.from(updated, "utf8"));
    const oldContext = shortContext(args.old_text);
    const newContext = shortContext(args.new_text);
    return {
      ok: true,
      text: `@@ ${found} replacement${found === 1 ? "" : "s"} @@\n-${oldContext}\n+${newContext}`,
      data: { path: checked, replacements: found, sha256: sha256(Buffer.from(updated, "utf8")) },
    };
  });
}

async function createDirectoryTool(policy: Policy, args: Record<string, any>): Promise<ToolOutcome> {
  const checked = await checkedPath(policy, args.path, "write");
  return await withMutationLock(async () => {
    await mkdir(checked, { recursive: true });
    return { ok: true, text: `directory ready: ${checked}`, data: { path: checked } };
  });
}

async function movePathTool(policy: Policy, args: Record<string, any>): Promise<ToolOutcome> {
  const source = await checkedPath(policy, args.source, "write");
  const destination = await checkedPath(policy, args.destination, "write");

  return await withMutationLock(async () => {
    try {
      await lstat(destination);
      throw new ExpectedFailure("conflict", `destination already exists: ${destination}`);
    } catch (error) {
      if (error instanceof ExpectedFailure) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
    }

    try {
      await rename(source, destination);
    } catch (error) {
      if (errorCode(error) !== "EXDEV") throw error;
      await cp(source, destination, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      await rm(source, { recursive: true, force: false });
    }

    return { ok: true, text: `moved ${source} to ${destination}`, data: { source, destination } };
  });
}

async function atomicRewrite(file: string, content: Buffer): Promise<void> {
  let existingMode: number | undefined;
  try {
    existingMode = (await stat(file)).mode & 0o7777;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: existingMode ?? 0o666 });
    if (existingMode !== undefined) await chmod(temporary, existingMode);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function checkedPath(policy: Policy, requested: string, effect: "read" | "write"): Promise<string> {
  let checked = await checkPath(policy, requested, effect);
  const seen = new Set<string>();
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
    if (seen.has(checked)) throw new ExpectedFailure("invalid_arguments", "symlink cycle detected");
    seen.add(checked);
    try {
      const info = await lstat(checked);
      if (!info.isSymbolicLink()) return checked;
      const target = await readlink(checked);
      checked = await checkPath(policy, path.resolve(path.dirname(checked), target), effect);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return checked;
      throw error;
    }
  }
  throw new ExpectedFailure("invalid_arguments", `symlink chain exceeds ${MAX_SYMLINK_HOPS} hops`);
}

async function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  mutationTail = tail;
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationTail === tail) mutationTail = Promise.resolve();
  }
}

function failureFor(error: unknown): ToolOutcome {
  if (error instanceof ExpectedFailure) {
    return { ok: false, code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) };
  }
  if (error instanceof PolicyError) return { ok: false, code: "policy_denied", message: error.message };

  const code = errorCode(error);
  if (code === "ENOENT") return { ok: false, code: "not_found", message: errorMessage(error) };
  if (code === "EACCES" || code === "EPERM") {
    return { ok: false, code: "permission_denied", message: errorMessage(error) };
  }
  if (code === "EISDIR" || code === "ENOTDIR" || code === "EINVAL") {
    return { ok: false, code: "invalid_arguments", message: errorMessage(error) };
  }
  if (code === "EEXIST" || code === "ENOTEMPTY") {
    return { ok: false, code: "conflict", message: errorMessage(error) };
  }
  return { ok: false, code: "internal", message: errorMessage(error) };
}

function fileType(info: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): DirectoryEntry["type"] {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "dir";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8192).includes(0);
}

function textLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function shortContext(text: string): string {
  const oneLine = text.replace(/\r?\n/g, "\\n");
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
}

function globToRegex(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
