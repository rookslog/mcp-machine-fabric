import { z } from "zod";

/**
 * The tool catalogue is shared by hub and agent: the hub advertises these
 * schemas to MCP clients (adding a `machine` argument), the agent validates the
 * same schemas before executing. One source of truth means a client can never
 * see a schema the agent would reject.
 */

export type Effect = "read" | "write" | "exec";

export interface AgentToolSpec {
  name: string;
  title: string;
  description: string;
  effect: Effect;
  /** Safe to repeat with identical arguments (MCP idempotentHint). */
  idempotent: boolean;
  /** May destroy or overwrite data (MCP destructiveHint). */
  destructive: boolean;
  shape: z.ZodRawShape;
}

const path = z.string().min(1).describe("Absolute path on the target machine (~ is expanded to the agent user's home).");
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .optional()
  .describe(
    "Optional client-chosen key. Repeating a call with the same key returns the original result instead of executing again. Use it whenever you might retry a mutating call.",
  );

export const AGENT_TOOLS: AgentToolSpec[] = [
  {
    name: "read_file",
    title: "Read file",
    description:
      "Read a text file. Returns up to `length` lines starting at `offset` (0-based line index; negative reads from the end). Binary files are reported, not dumped.",
    effect: "read",
    idempotent: true,
    destructive: false,
    shape: {
      path,
      offset: z.number().int().optional().describe("First line (0-based). Negative = count from end."),
      length: z.number().int().min(1).max(5000).optional().describe("Max lines to return (default 1000)."),
    },
  },
  {
    name: "list_directory",
    title: "List directory",
    description: "List directory entries with type and size. `depth` > 1 recurses (bounded to 2000 entries).",
    effect: "read",
    idempotent: true,
    destructive: false,
    shape: {
      path,
      depth: z.number().int().min(1).max(5).optional().describe("Recursion depth (default 1)."),
      include_hidden: z.boolean().optional(),
    },
  },
  {
    name: "get_file_info",
    title: "File info",
    description: "Stat a path: type, size, mode, mtime, and line count for small text files.",
    effect: "read",
    idempotent: true,
    destructive: false,
    shape: { path },
  },
  {
    name: "search_files",
    title: "Search files",
    description:
      "Search under `path` for file names matching `name_pattern` (glob, e.g. *.ts) and/or file contents matching `content_regex`. Uses ripgrep when available. Results are bounded.",
    effect: "read",
    idempotent: true,
    destructive: false,
    shape: {
      path,
      name_pattern: z.string().optional(),
      content_regex: z.string().optional(),
      max_results: z.number().int().min(1).max(1000).optional().describe("Default 100."),
      include_hidden: z.boolean().optional(),
    },
  },
  {
    name: "write_file",
    title: "Write file",
    description:
      "Write text to a file, creating parent directories. mode=rewrite replaces the file atomically; mode=append appends. Pass `expected_sha256` to refuse the write if the file changed since you read it.",
    effect: "write",
    idempotent: false,
    destructive: true,
    shape: {
      path,
      content: z.string(),
      mode: z.enum(["rewrite", "append"]).optional(),
      expected_sha256: z.string().optional().describe("sha256 of current content; write fails with `conflict` if it differs."),
      idempotency_key: idempotencyKey,
    },
  },
  {
    name: "edit_file",
    title: "Edit file",
    description:
      "Replace exact text in a file. Fails unless `old_text` occurs exactly `expected_replacements` times (default 1), so edits never land in the wrong place.",
    effect: "write",
    idempotent: false,
    destructive: true,
    shape: {
      path,
      old_text: z.string().min(1),
      new_text: z.string(),
      expected_replacements: z.number().int().min(1).optional(),
      idempotency_key: idempotencyKey,
    },
  },
  {
    name: "create_directory",
    title: "Create directory",
    description: "Create a directory (and parents). Succeeds if it already exists.",
    effect: "write",
    idempotent: true,
    destructive: false,
    shape: { path },
  },
  {
    name: "move_path",
    title: "Move / rename",
    description: "Move or rename a file or directory. Refuses to overwrite an existing destination.",
    effect: "write",
    idempotent: false,
    destructive: true,
    shape: { source: path, destination: path, idempotency_key: idempotencyKey },
  },
  {
    name: "run_command",
    title: "Run command",
    description:
      "Run a shell command and wait up to `wait_seconds` (default 30, max 110) for it to finish. Every command runs as a durable job: if it is still running when the wait ends you get a `job_id` and can keep reading its output with read_job_output — the process is never killed just because the call returned or the connection dropped.",
    effect: "exec",
    idempotent: false,
    destructive: true,
    shape: {
      command: z.string().min(1).describe("Shell command line, run with the user's login shell (bash/zsh) -c."),
      cwd: z.string().optional().describe("Working directory (default: agent user's home)."),
      wait_seconds: z.number().min(0).max(110).optional(),
      env: z.record(z.string()).optional().describe("Extra environment variables."),
      idempotency_key: idempotencyKey,
    },
  },
  {
    name: "start_job",
    title: "Start background job",
    description:
      "Start a long-running command as a durable job and return immediately with a `job_id`. Output is written to disk on the target machine and survives agent restarts and client disconnects.",
    effect: "exec",
    idempotent: false,
    destructive: true,
    shape: {
      command: z.string().min(1),
      cwd: z.string().optional(),
      env: z.record(z.string()).optional(),
      label: z.string().max(200).optional().describe("Short human label for list_jobs."),
      idempotency_key: idempotencyKey,
    },
  },
  {
    name: "read_job_output",
    title: "Read job output",
    description:
      "Read a job's combined stdout/stderr from byte `cursor` (default 0). Returns new output, the next cursor, and status (running/exited/killed/lost) with exit code. Optionally wait up to `wait_seconds` for new output or exit.",
    effect: "read",
    idempotent: true,
    destructive: false,
    shape: {
      job_id: z.string().min(1),
      cursor: z.number().int().min(0).optional(),
      max_bytes: z.number().int().min(1).max(1_000_000).optional().describe("Default 64000."),
      wait_seconds: z.number().min(0).max(110).optional(),
    },
  },
  {
    name: "list_jobs",
    title: "List jobs",
    description: "List durable jobs on the machine (most recent first) with status, exit code, and age.",
    effect: "read",
    idempotent: true,
    destructive: false,
    shape: {
      status: z.enum(["running", "finished", "all"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  {
    name: "send_job_input",
    title: "Send job input",
    description: "Write text to a running job's stdin (e.g. answer a prompt or drive a REPL). Add a trailing \\n to submit a line.",
    effect: "exec",
    idempotent: false,
    destructive: true,
    shape: { job_id: z.string().min(1), input: z.string() },
  },
  {
    name: "cancel_job",
    title: "Cancel job",
    description: "Stop a running job: SIGTERM to its process group, then SIGKILL after `grace_seconds` (default 5).",
    effect: "exec",
    idempotent: true,
    destructive: true,
    shape: { job_id: z.string().min(1), grace_seconds: z.number().min(0).max(60).optional() },
  },
];

export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((t) => t.name);

export function findAgentTool(name: string): AgentToolSpec | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}
