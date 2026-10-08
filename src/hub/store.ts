import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Effect } from "../shared/tools.js";
import type { ToolOutcome } from "../shared/protocol.js";

/**
 * Request states. The point of the ledger is that a client (or the owner) can
 * always learn what happened to a call, even if the response was lost.
 *
 *   not_dispatched      never reached the agent (machine offline, policy/scope denial at hub)
 *   dispatched          sent to the agent, no acknowledgement yet
 *   accepted            agent acknowledged and is executing
 *   dispatched_unknown  connection lost or hub deadline passed before a result; may have run
 *   completed / failed  final outcome known
 */
export type RequestState = "not_dispatched" | "dispatched" | "accepted" | "dispatched_unknown" | "completed" | "failed";

export interface RequestRow {
  request_id: string;
  machine: string;
  tool: string;
  effect: Effect | "hub";
  principal: string;
  idempotency_key: string | null;
  args_summary: string;
  state: RequestState;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  error_code: string | null;
  outcome_json: string | null;
}

export interface DeviceRow {
  id: string;
  name: string;
  created_at: number;
  revoked_at: number | null;
  last_seen_at: number | null;
}

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function newRequestId(): string {
  return `r_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

/**
 * Summarize arguments for the audit trail without retaining file contents or
 * command environments verbatim: long strings become {sha256,length}.
 */
export function summarizeArgs(args: Record<string, unknown>, maxString = 512): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "env" && v && typeof v === "object") {
      out[k] = { keys: Object.keys(v as object) };
    } else if (typeof v === "string" && v.length > maxString) {
      out[k] = { sha256: sha256(v), length: v.length };
    } else {
      out[k] = v;
    }
  }
  return JSON.stringify(out);
}

export class HubStore {
  readonly db: DatabaseSync;

  constructor(dataDir: string | ":memory:") {
    if (dataDir === ":memory:") {
      this.db = new DatabaseSync(":memory:");
    } else {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(nodePath.join(dataDir, "hub.db"));
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_seen_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        machine TEXT NOT NULL,
        tool TEXT NOT NULL,
        effect TEXT NOT NULL,
        principal TEXT NOT NULL,
        idempotency_key TEXT,
        args_summary TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER,
        duration_ms INTEGER,
        error_code TEXT,
        outcome_json TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_by_time ON requests(created_at DESC);
      CREATE INDEX IF NOT EXISTS requests_by_machine_state ON requests(machine, state);
      CREATE UNIQUE INDEX IF NOT EXISTS requests_idem ON requests(principal, machine, tool, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
  }

  // ---- devices -----------------------------------------------------------

  addDevice(name: string): { device: DeviceRow; token: string } {
    if (!NAME_RE.test(name)) throw new Error("machine name must match ^[a-z][a-z0-9-]{0,31}$");
    const existing = this.db.prepare("SELECT id FROM devices WHERE name = ? AND revoked_at IS NULL").get(name);
    if (existing) throw new Error(`machine ${name} is already enrolled (revoke it first to re-enroll)`);
    this.db.prepare("DELETE FROM devices WHERE name = ? AND revoked_at IS NOT NULL").run(name);
    const token = `mmf_dev_${randomBytes(32).toString("base64url")}`;
    const id = `d_${randomBytes(6).toString("hex")}`;
    const now = Date.now();
    this.db
      .prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, name, sha256(token), now);
    return { device: { id, name, created_at: now, revoked_at: null, last_seen_at: null }, token };
  }

  deviceByToken(token: string): DeviceRow | null {
    const row = this.db
      .prepare("SELECT id, name, created_at, revoked_at, last_seen_at FROM devices WHERE token_hash = ?")
      .get(sha256(token)) as DeviceRow | undefined;
    if (!row || row.revoked_at) return null;
    return row;
  }

  listDevices(): DeviceRow[] {
    return this.db
      .prepare("SELECT id, name, created_at, revoked_at, last_seen_at FROM devices ORDER BY name")
      .all() as unknown as DeviceRow[];
  }

  revokeDevice(name: string): boolean {
    const r = this.db
      .prepare("UPDATE devices SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL")
      .run(Date.now(), name);
    return Number(r.changes) > 0;
  }

  touchDevice(id: string): void {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(Date.now(), id);
  }

  // ---- request ledger ----------------------------------------------------

  createRequest(r: {
    request_id: string;
    machine: string;
    tool: string;
    effect: Effect | "hub";
    principal: string;
    idempotency_key: string | null;
    args_summary: string;
    state: RequestState;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO requests (request_id, machine, tool, effect, principal, idempotency_key, args_summary, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.request_id, r.machine, r.tool, r.effect, r.principal, r.idempotency_key, r.args_summary, r.state, now, now);
  }

  setState(requestId: string, state: RequestState, errorCode: string | null = null): void {
    this.db
      .prepare("UPDATE requests SET state = ?, updated_at = ?, error_code = COALESCE(?, error_code) WHERE request_id = ?")
      .run(state, Date.now(), errorCode, requestId);
  }

  finish(requestId: string, outcome: ToolOutcome, keepFullOutcome: boolean): void {
    const row = this.getRequest(requestId);
    const now = Date.now();
    const stored = keepFullOutcome ? outcome : truncateOutcome(outcome);
    this.db
      .prepare(
        `UPDATE requests SET state = ?, updated_at = ?, finished_at = ?, duration_ms = ?, error_code = ?, outcome_json = ? WHERE request_id = ?`,
      )
      .run(
        outcome.ok ? "completed" : "failed",
        now,
        now,
        row ? now - row.created_at : null,
        outcome.ok ? null : outcome.code,
        JSON.stringify(stored),
        requestId,
      );
  }

  getRequest(requestId: string): RequestRow | null {
    return (this.db.prepare("SELECT * FROM requests WHERE request_id = ?").get(requestId) as RequestRow | undefined) ?? null;
  }

  findIdempotent(principal: string, machine: string, tool: string, key: string): RequestRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM requests WHERE principal = ? AND machine = ? AND tool = ? AND idempotency_key = ?")
        .get(principal, machine, tool, key) as RequestRow | undefined) ?? null
    );
  }

  unknownRequestsFor(machine: string): RequestRow[] {
    return this.db
      .prepare("SELECT * FROM requests WHERE machine = ? AND state IN ('dispatched', 'accepted', 'dispatched_unknown') ORDER BY created_at")
      .all(machine) as unknown as RequestRow[];
  }

  recentRequests(limit: number, machine?: string): RequestRow[] {
    if (machine) {
      return this.db
        .prepare("SELECT * FROM requests WHERE machine = ? ORDER BY created_at DESC LIMIT ?")
        .all(machine, limit) as unknown as RequestRow[];
    }
    return this.db.prepare("SELECT * FROM requests ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as RequestRow[];
  }

  /** Mark in-flight requests as unknown, e.g. after a hub restart or lost connection. */
  markInFlightUnknown(machine?: string): number {
    const sql =
      "UPDATE requests SET state = 'dispatched_unknown', updated_at = ? WHERE state IN ('dispatched', 'accepted')" +
      (machine ? " AND machine = ?" : "");
    const r = machine ? this.db.prepare(sql).run(Date.now(), machine) : this.db.prepare(sql).run(Date.now());
    return Number(r.changes);
  }

  pruneRequests(olderThanMs: number): number {
    const r = this.db
      .prepare("DELETE FROM requests WHERE created_at < ? AND state IN ('completed', 'failed', 'not_dispatched')")
      .run(Date.now() - olderThanMs);
    return Number(r.changes);
  }

  close(): void {
    this.db.close();
  }
}

function truncateOutcome(o: ToolOutcome): ToolOutcome {
  const limit = 2000;
  if (o.ok) {
    return { ok: true, text: o.text.length > limit ? o.text.slice(0, limit) + `\n…[${o.text.length - limit} chars not retained]` : o.text };
  }
  return o;
}
