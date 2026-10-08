import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import express, { type Response, type Router } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export const SCOPES = ["fabric:read", "fabric:write", "fabric:exec"] as const;

type FabricScope = (typeof SCOPES)[number];

interface ProviderOptions {
  db: DatabaseSync;
  mcpResourceUrl: string | URL;
  now?: () => number;
}

export interface PersonalTokenSummary {
  id: string;
  name: string;
  scopes: string[];
  createdAt: number;
  revoked: boolean;
}

interface ClientRow {
  info_json: string;
}

interface OwnerCredentialRow {
  salt: string;
  hash: string;
}

interface PersonalTokenRow {
  id: string;
  name: string;
  scopes_json: string;
  created_at: number;
  revoked_at: number | null;
}

interface PendingAuthorizationRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scopes_json: string;
  resource: string;
  created_at: number;
  expires_at: number;
  info_json?: string;
}

interface AuthorizationCodeRow {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes_json: string;
  resource: string;
  expires_at: number;
  used_at: number | null;
  family_id: string | null;
}

interface AccessTokenRow {
  client_id: string;
  family_id: string;
  scopes_json: string;
  resource: string;
  expires_at: number;
  revoked_at: number | null;
  family_revoked_at: number | null;
}

interface RefreshTokenRow {
  client_id: string;
  family_id: string;
  scopes_json: string;
  family_scopes_json: string;
  resource: string;
  expires_at: number;
  status: "active" | "rotated" | "revoked";
  family_revoked_at: number | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomId(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function normalizeScopes(scopes: readonly string[]): FabricScope[] {
  const requested = new Set(scopes);
  return SCOPES.filter((scope) => requested.has(scope));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function redirectWithParams(
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(name, value);
  }
  return url.href;
}

export class FabricOAuthProvider implements OAuthServerProvider {
  readonly #db: DatabaseSync;
  readonly #mcpResourceUrl: URL;
  readonly #now: () => number;
  readonly #clientsStore: OAuthRegisteredClientsStore;

  constructor({ db, mcpResourceUrl, now = Date.now }: ProviderOptions) {
    this.#db = db;
    this.#mcpResourceUrl = new URL(String(mcpResourceUrl));
    this.#now = now;
    this.#createTables();
    this.#clientsStore = {
      getClient: (clientId) => this.#getClient(clientId),
      registerClient: (client) => this.#registerClient(client),
    };
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.#clientsStore;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (params.resource !== undefined && params.resource.href !== this.#mcpResourceUrl.href) {
      throw new InvalidTargetError("Requested resource is not served by this authorization server");
    }
    const id = randomId();
    const now = this.#nowSeconds();
    const requestedScopes =
      params.scopes === undefined || params.scopes.length === 0
        ? [...SCOPES]
        : normalizeScopes(params.scopes);
    const resource = params.resource?.href ?? this.#mcpResourceUrl.href;
    this.#db
      .prepare(
        `INSERT INTO oauth_pending_authorizations
           (id, client_id, redirect_uri, code_challenge, state, scopes_json,
            resource, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        client.client_id,
        params.redirectUri,
        params.codeChallenge,
        params.state ?? null,
        JSON.stringify(requestedScopes),
        resource,
        now,
        now + 10 * 60,
      );
    const pending = this.#getPending(id);
    if (!pending) throw new InvalidGrantError("Unable to create authorization request");
    this.renderConsentPage(pending, res);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const row = this.#findAuthorizationCode(authorizationCode);
    if (!row || row.client_id !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    if (row.used_at !== null) {
      if (row.family_id) this.#revokeFamily(row.family_id);
      throw new InvalidGrantError("Authorization code has already been used");
    }
    if (row.expires_at <= this.#nowSeconds()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.#findAuthorizationCode(authorizationCode);
    if (!row || row.client_id !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    if (row.used_at !== null) {
      if (row.family_id) this.#revokeFamily(row.family_id);
      throw new InvalidGrantError("Authorization code has already been used");
    }
    if (row.expires_at <= this.#nowSeconds()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource !== undefined && resource.href !== row.resource) {
      throw new InvalidGrantError("resource does not match the authorization request");
    }

    return this.#transaction(() => {
      const familyId = randomId(16);
      const scopes = JSON.parse(row.scopes_json) as string[];
      this.#db
        .prepare(
          `INSERT INTO oauth_token_families
             (id, client_id, scopes_json, resource, created_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(familyId, client.client_id, row.scopes_json, row.resource, this.#nowSeconds());
      const tokens = this.#issueTokens(familyId, client.client_id, scopes, row.resource);
      this.#db
        .prepare(
          `UPDATE oauth_authorization_codes
              SET used_at = ?, family_id = ?
            WHERE code_hash = ? AND used_at IS NULL`,
        )
        .run(this.#nowSeconds(), familyId, sha256(authorizationCode));
      return tokens;
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const tokenHash = sha256(refreshToken);
    const row = this.#db
      .prepare(
        `SELECT r.client_id, r.family_id, r.scopes_json,
                f.scopes_json AS family_scopes_json, r.resource, r.expires_at,
                r.status, f.revoked_at AS family_revoked_at
           FROM oauth_refresh_tokens AS r
           JOIN oauth_token_families AS f ON f.id = r.family_id
          WHERE r.token_hash = ?`,
      )
      .get(tokenHash) as RefreshTokenRow | undefined;
    if (!row || row.client_id !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (row.status === "rotated") {
      this.#revokeFamily(row.family_id);
      throw new InvalidGrantError("Refresh token reuse detected");
    }
    if (
      row.status !== "active" ||
      row.family_revoked_at !== null ||
      row.expires_at <= this.#nowSeconds()
    ) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (resource !== undefined && resource.href !== row.resource) {
      throw new InvalidGrantError("resource does not match the token family");
    }
    const familyScopes = JSON.parse(row.family_scopes_json) as string[];
    const grantedScopes = scopes === undefined ? familyScopes : normalizeScopes(scopes);
    if (
      scopes !== undefined &&
      (grantedScopes.length !== scopes.length ||
        grantedScopes.some((scope) => !familyScopes.includes(scope)))
    ) {
      throw new InvalidScopeError("Requested scope exceeds the original grant");
    }
    return this.#transaction(() => {
      const update = this.#db
        .prepare(
          `UPDATE oauth_refresh_tokens
              SET status = 'rotated'
            WHERE token_hash = ? AND status = 'active'`,
        )
        .run(tokenHash);
      if (update.changes !== 1) {
        throw new InvalidGrantError("Invalid refresh token");
      }
      return this.#issueTokens(row.family_id, client.client_id, grantedScopes, row.resource);
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const personal = this.#db
      .prepare(
        `SELECT id, name, scopes_json, created_at, revoked_at
           FROM oauth_personal_tokens
          WHERE token_hash = ?`,
      )
      .get(sha256(token)) as PersonalTokenRow | undefined;
    if (personal && personal.revoked_at === null) {
      return {
        token,
        clientId: `pat:${personal.id}`,
        scopes: JSON.parse(personal.scopes_json) as string[],
        expiresAt: 253_402_300_799,
        resource: new URL(this.#mcpResourceUrl),
      };
    }

    const access = this.#db
      .prepare(
        `SELECT a.client_id, a.family_id, a.scopes_json, a.resource,
                a.expires_at, a.revoked_at, f.revoked_at AS family_revoked_at
           FROM oauth_access_tokens AS a
           JOIN oauth_token_families AS f ON f.id = a.family_id
          WHERE a.token_hash = ?`,
      )
      .get(sha256(token)) as AccessTokenRow | undefined;
    if (
      !access ||
      access.revoked_at !== null ||
      access.family_revoked_at !== null ||
      access.expires_at <= this.#nowSeconds()
    ) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: access.client_id,
      scopes: JSON.parse(access.scopes_json) as string[],
      expiresAt: access.expires_at,
      resource: new URL(access.resource),
    };
  }

  getPendingAuthorization(id: string): PendingAuthorizationRow | undefined {
    return this.#getPending(id);
  }

  renderConsentPage(
    pending: PendingAuthorizationRow,
    res: Response,
    error?: string,
    selectedScopes?: readonly string[],
  ): void {
    const client = pending.info_json
      ? (JSON.parse(pending.info_json) as OAuthClientInformationFull)
      : undefined;
    const name = escapeHtml(client?.client_name ?? client?.client_id ?? pending.client_id);
    const redirectHost = escapeHtml(new URL(pending.redirect_uri).host);
    const redirectOrigin = new URL(pending.redirect_uri).origin;
    const scopes = JSON.parse(pending.scopes_json) as string[];
    const selected = new Set(selectedScopes === undefined ? scopes : normalizeScopes(selectedScopes));
    const scopeControls = scopes
      .map(
        (scope) =>
          `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}"${selected.has(scope as FabricScope) ? " checked" : ""}> ${escapeHtml(scope)}</label>`,
      )
      .join("\n");
    const errorMarkup = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}`,
    );
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ${name}</title><style>
body{font:16px system-ui,sans-serif;max-width:38rem;margin:4rem auto;padding:0 1rem;color:#171717}fieldset{border:1px solid #bbb;border-radius:.5rem;padding:1rem}label{display:block;margin:.6rem 0}input[type=password]{width:100%;box-sizing:border-box;padding:.6rem}.actions{display:flex;gap:.75rem;margin-top:1rem}.error{color:#a00}button{padding:.6rem 1rem}
</style></head><body><main><h1>Authorize ${name}</h1>
<p>This client will return to <strong>${redirectHost}</strong>.</p>${errorMarkup}
<form method="post" action="/oauth/approve"><input type="hidden" name="pending_id" value="${escapeHtml(pending.id)}">
<fieldset><legend>Requested scopes</legend>${scopeControls}</fieldset>
<label>Owner passphrase <input type="password" name="passphrase" autocomplete="current-password"></label>
<div class="actions"><button type="submit" name="action" value="approve">Approve</button><button type="submit" name="action" value="deny">Deny</button></div>
</form></main></body></html>`);
  }

  denyPendingAuthorization(id: string): PendingAuthorizationRow | undefined {
    const pending = this.#getPending(id);
    if (!pending) return undefined;
    this.#db.prepare("DELETE FROM oauth_pending_authorizations WHERE id = ?").run(id);
    return pending;
  }

  approvePendingAuthorization(id: string, selectedScopes: readonly string[]): {
    pending: PendingAuthorizationRow;
    code: string;
  } | undefined {
    const pending = this.#getPending(id);
    if (!pending) return undefined;
    const requested = new Set(JSON.parse(pending.scopes_json) as string[]);
    const granted = normalizeScopes(selectedScopes).filter((scope) => requested.has(scope));
    const code = randomId();
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO oauth_authorization_codes
             (code_hash, client_id, redirect_uri, code_challenge, scopes_json,
              resource, created_at, expires_at, used_at, family_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          sha256(code),
          pending.client_id,
          pending.redirect_uri,
          pending.code_challenge,
          JSON.stringify(granted),
          pending.resource,
          this.#nowSeconds(),
          this.#nowSeconds() + 10 * 60,
        );
      this.#db.prepare("DELETE FROM oauth_pending_authorizations WHERE id = ?").run(id);
    });
    return { pending, code };
  }

  recordApprovalFailure(id: string): boolean {
    const now = this.#nowSeconds();
    return this.#transaction(() => {
      this.#db
        .prepare("DELETE FROM oauth_authorization_failures WHERE occurred_at <= ?")
        .run(now - 15 * 60);
      this.#db
        .prepare(
          "INSERT INTO oauth_authorization_failures (pending_id, occurred_at) VALUES (?, ?)",
        )
        .run(id, now);
      const pendingCount = (
        this.#db
          .prepare(
            "SELECT COUNT(*) AS count FROM oauth_authorization_failures WHERE pending_id = ?",
          )
          .get(id) as { count: number }
      ).count;
      const hubCount = (
        this.#db
          .prepare("SELECT COUNT(*) AS count FROM oauth_authorization_failures")
          .get() as { count: number }
      ).count;
      const locked = pendingCount >= 5 || hubCount >= 20;
      if (locked) {
        this.#db.prepare("DELETE FROM oauth_pending_authorizations WHERE id = ?").run(id);
      }
      return locked;
    });
  }

  enforceHubApprovalLockout(id: string): boolean {
    const now = this.#nowSeconds();
    return this.#transaction(() => {
      this.#db
        .prepare("DELETE FROM oauth_authorization_failures WHERE occurred_at <= ?")
        .run(now - 15 * 60);
      const count = (
        this.#db
          .prepare("SELECT COUNT(*) AS count FROM oauth_authorization_failures")
          .get() as { count: number }
      ).count;
      if (count < 20) return false;
      this.#db.prepare("DELETE FROM oauth_pending_authorizations WHERE id = ?").run(id);
      return true;
    });
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = sha256(request.token);
    const access = this.#db
      .prepare("SELECT family_id, client_id FROM oauth_access_tokens WHERE token_hash = ?")
      .get(tokenHash) as { family_id: string; client_id: string } | undefined;
    if (access?.client_id === client.client_id) {
      this.#revokeFamily(access.family_id);
      return;
    }
    const refresh = this.#db
      .prepare("SELECT family_id, client_id FROM oauth_refresh_tokens WHERE token_hash = ?")
      .get(tokenHash) as { family_id: string; client_id: string } | undefined;
    if (refresh?.client_id === client.client_id) this.#revokeFamily(refresh.family_id);
  }

  setOwnerPassphrase(passphrase: string): void {
    if (passphrase.length < 12) {
      throw new RangeError("Owner passphrase must contain at least 12 characters");
    }
    const salt = randomBytes(16);
    const hash = scryptSync(passphrase, salt, 32, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    this.#db
      .prepare(
        `INSERT INTO oauth_owner_credentials (id, salt, hash)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET salt = excluded.salt, hash = excluded.hash`,
      )
      .run(salt.toString("base64"), hash.toString("base64"));
  }

  hasOwnerPassphrase(): boolean {
    return this.#db
      .prepare("SELECT 1 AS present FROM oauth_owner_credentials WHERE id = 1")
      .get() !== undefined;
  }

  verifyOwnerPassphrase(passphrase: string): boolean {
    const row = this.#db
      .prepare("SELECT salt, hash FROM oauth_owner_credentials WHERE id = 1")
      .get() as OwnerCredentialRow | undefined;
    if (!row) return false;
    const expected = Buffer.from(row.hash, "base64");
    const actual = scryptSync(passphrase, Buffer.from(row.salt, "base64"), expected.length, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  createPersonalToken(name: string, scopes: readonly string[]): { id: string; token: string } {
    const id = randomId(16);
    const token = `mmf_pat_${randomId()}`;
    this.#db
      .prepare(
        `INSERT INTO oauth_personal_tokens
           (id, name, scopes_json, token_hash, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, name, JSON.stringify(normalizeScopes(scopes)), sha256(token), this.#nowSeconds());
    return { id, token };
  }

  listPersonalTokens(): PersonalTokenSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT id, name, scopes_json, created_at, revoked_at
           FROM oauth_personal_tokens
          ORDER BY created_at, id`,
      )
      .all() as unknown as PersonalTokenRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      scopes: JSON.parse(row.scopes_json) as string[],
      createdAt: row.created_at,
      revoked: row.revoked_at !== null,
    }));
  }

  revokePersonalToken(id: string): boolean {
    const result = this.#db
      .prepare(
        `UPDATE oauth_personal_tokens
            SET revoked_at = ?
          WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(this.#nowSeconds(), id);
    return result.changes > 0;
  }

  #getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.#db
      .prepare("SELECT info_json FROM oauth_clients WHERE client_id = ?")
      .get(clientId) as ClientRow | undefined;
    return row ? (JSON.parse(row.info_json) as OAuthClientInformationFull) : undefined;
  }

  #getPending(id: string): PendingAuthorizationRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT p.*, c.info_json
           FROM oauth_pending_authorizations AS p
           JOIN oauth_clients AS c ON c.client_id = p.client_id
          WHERE p.id = ?`,
      )
      .get(id) as PendingAuthorizationRow | undefined;
    if (!row) return undefined;
    if (row.expires_at <= this.#nowSeconds()) {
      this.#db.prepare("DELETE FROM oauth_pending_authorizations WHERE id = ?").run(id);
      return undefined;
    }
    return row;
  }

  #findAuthorizationCode(code: string): AuthorizationCodeRow | undefined {
    return this.#db
      .prepare(
        `SELECT client_id, redirect_uri, code_challenge, scopes_json, resource,
                expires_at, used_at, family_id
           FROM oauth_authorization_codes
          WHERE code_hash = ?`,
      )
      .get(sha256(code)) as AuthorizationCodeRow | undefined;
  }

  #issueTokens(
    familyId: string,
    clientId: string,
    scopes: readonly string[],
    resource: string,
  ): OAuthTokens {
    const accessToken = randomId();
    const refreshToken = randomId();
    const now = this.#nowSeconds();
    const scopesJson = JSON.stringify(scopes);
    this.#db
      .prepare(
        `INSERT INTO oauth_access_tokens
           (token_hash, family_id, client_id, scopes_json, resource,
            created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(sha256(accessToken), familyId, clientId, scopesJson, resource, now, now + 60 * 60);
    this.#db
      .prepare(
        `INSERT INTO oauth_refresh_tokens
           (token_hash, family_id, client_id, scopes_json, resource,
            created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(
        sha256(refreshToken),
        familyId,
        clientId,
        scopesJson,
        resource,
        now,
        now + 30 * 24 * 60 * 60,
      );
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 60 * 60,
      scope: scopes.join(" "),
    };
  }

  #revokeFamily(familyId: string): void {
    this.#db
      .prepare("UPDATE oauth_token_families SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
      .run(this.#nowSeconds(), familyId);
  }

  #transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: randomId(),
      client_id_issued_at: this.#nowSeconds(),
    };
    this.#db
      .prepare("INSERT INTO oauth_clients (client_id, info_json) VALUES (?, ?)")
      .run(registered.client_id, JSON.stringify(registered));
    return registered;
  }

  #nowSeconds(): number {
    return Math.floor(this.#now() / 1000);
  }

  #createTables(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        info_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_owner_credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        salt TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_personal_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS oauth_pending_authorizations (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        state TEXT,
        scopes_json TEXT NOT NULL,
        resource TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id)
      );
      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        resource TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        family_id TEXT
      );
      CREATE TABLE IF NOT EXISTS oauth_token_families (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        resource TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS oauth_access_tokens (
        token_hash TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        resource TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        FOREIGN KEY (family_id) REFERENCES oauth_token_families(id)
      );
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        resource TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'rotated', 'revoked')),
        FOREIGN KEY (family_id) REFERENCES oauth_token_families(id)
      );
      CREATE TABLE IF NOT EXISTS oauth_authorization_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pending_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauth_authorization_failures_pending_time
        ON oauth_authorization_failures (pending_id, occurred_at);
      CREATE INDEX IF NOT EXISTS oauth_authorization_failures_time
        ON oauth_authorization_failures (occurred_at);
    `);
  }
}

interface OAuthRouterOptions {
  provider: FabricOAuthProvider;
  issuerUrl: URL;
  mcpResourceUrl: URL;
  resourceName: string;
}

export function createOAuthRouter({
  provider,
  issuerUrl,
  mcpResourceUrl,
  resourceName,
}: OAuthRouterOptions): Router {
  const router = express.Router();
  router.post("/oauth/approve", express.urlencoded({ extended: false }), (req, res) => {
    const pendingId = typeof req.body.pending_id === "string" ? req.body.pending_id : "";
    const action = typeof req.body.action === "string" ? req.body.action : "";
    const pending = provider.getPendingAuthorization(pendingId);
    if (!pending) {
      res.status(400).type("html").send("<!doctype html><title>Invalid request</title><p>This authorization request is invalid or expired.</p>");
      return;
    }
    if (action === "deny") {
      provider.denyPendingAuthorization(pendingId);
      res.redirect(
        302,
        redirectWithParams(pending.redirect_uri, {
          error: "access_denied",
          state: pending.state,
        }),
      );
      return;
    }
    if (action !== "approve") {
      res
        .status(400)
        .type("html")
        .send("<!doctype html><title>Invalid request</title><p>Unknown approval action.</p>");
      return;
    }
    if (provider.enforceHubApprovalLockout(pendingId)) {
      res
        .status(429)
        .type("html")
        .send("<!doctype html><title>Too many attempts</title><p>Too many failed attempts. Start a new authorization request.</p>");
      return;
    }
    const submitted = req.body.scope;
    const selectedScopes =
      typeof submitted === "string"
        ? [submitted]
        : Array.isArray(submitted)
          ? submitted.filter((scope): scope is string => typeof scope === "string")
          : [];
    const passphrase = typeof req.body.passphrase === "string" ? req.body.passphrase : "";
    if (!provider.verifyOwnerPassphrase(passphrase)) {
      if (provider.recordApprovalFailure(pendingId)) {
        res
          .status(429)
          .type("html")
          .send("<!doctype html><title>Too many attempts</title><p>Too many failed attempts. Start a new authorization request.</p>");
        return;
      }
      provider.renderConsentPage(pending, res, "Incorrect passphrase", selectedScopes);
      return;
    }
    const approved = provider.approvePendingAuthorization(pendingId, selectedScopes);
    if (!approved) {
      res.status(400).type("html").send("<!doctype html><title>Invalid request</title><p>This authorization request is invalid or expired.</p>");
      return;
    }
    res.redirect(
      302,
      redirectWithParams(approved.pending.redirect_uri, {
        code: approved.code,
        state: approved.pending.state,
      }),
    );
  });
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl: mcpResourceUrl,
      resourceName,
      scopesSupported: [...SCOPES],
      clientRegistrationOptions: { clientIdGeneration: false },
    }),
  );
  return router;
}

export function bearerMiddleware(provider: FabricOAuthProvider, mcpResourceUrl: URL | string) {
  const resource = new URL(String(mcpResourceUrl));
  return requireBearerAuth({
    verifier: provider,
    expectedResource: resource,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
  });
}
