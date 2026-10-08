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
import type { ToolOutcome } from "../shared/protocol.js";
import type { Policy } from "./policy.js";

export type FsToolName =
  | "read_file"
  | "list_directory"
  | "get_file_info"
  | "search_files"
  | "write_file"
  | "edit_file"
  | "create_directory"
  | "move_path";

export declare function runFsTool(policy: Policy, tool: FsToolName, args: Record<string, any>): Promise<ToolOutcome>;
