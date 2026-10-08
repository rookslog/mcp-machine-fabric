import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import nodePath from "node:path";
import type { Effect } from "../shared/tools.js";

/**
 * Local policy is enforced by the agent, on the machine being controlled, so a
 * compromised or misconfigured hub cannot widen it.
 *
 * Honest scope: `roots` confines the *file* tools (after symlink resolution).
 * A shell command can touch anything the agent user can, so `allow_exec` is the
 * only exec control; `roots` additionally constrains the exec working directory.
 */
export interface Policy {
  read_only: boolean;
  allow_exec: boolean;
  /** Absolute, symlink-resolved directory prefixes the file tools may touch. */
  roots: string[];
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return nodePath.join(homedir(), p.slice(2));
  return p;
}

export async function normalizePolicy(input: Partial<Policy>): Promise<Policy> {
  const roots = input.roots && input.roots.length > 0 ? input.roots : [homedir()];
  const resolved: string[] = [];
  for (const r of roots) {
    const abs = nodePath.resolve(expandHome(r));
    resolved.push(await realpathOrSelf(abs));
  }
  return { read_only: input.read_only ?? false, allow_exec: input.allow_exec ?? true, roots: resolved };
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/**
 * Resolve a requested path to the real location it would touch: the realpath
 * of the deepest existing ancestor, joined with the not-yet-existing tail. This
 * defeats `root/link-to-etc/passwd` style escapes for both reads and creates.
 */
export async function resolveReal(requested: string): Promise<string> {
  const abs = nodePath.resolve(expandHome(requested));
  let existing = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(existing);
      return tail.length ? nodePath.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = nodePath.dirname(existing);
      if (parent === existing) return abs;
      tail.push(nodePath.basename(existing));
      existing = parent;
    }
  }
}

export function isWithin(root: string, target: string): boolean {
  if (root === "/") return true;
  const rel = nodePath.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !nodePath.isAbsolute(rel));
}

/** Check a file path for the given effect; returns the resolved real path. */
export async function checkPath(policy: Policy, requested: string, effect: Effect): Promise<string> {
  if (typeof requested !== "string" || requested.length === 0) throw new PolicyError("path is required");
  if (!nodePath.isAbsolute(expandHome(requested))) {
    throw new PolicyError(`path must be absolute (got ${JSON.stringify(requested)})`);
  }
  if (effect !== "read" && policy.read_only) throw new PolicyError("agent is in read-only mode");
  const real = await resolveReal(requested);
  if (!policy.roots.some((root) => isWithin(root, real))) {
    throw new PolicyError(`path ${real} is outside the allowed roots (${policy.roots.join(", ")})`);
  }
  return real;
}

export function checkExec(policy: Policy): void {
  if (policy.read_only) throw new PolicyError("agent is in read-only mode");
  if (!policy.allow_exec) throw new PolicyError("command execution is disabled on this agent");
}
