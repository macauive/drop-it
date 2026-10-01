import {
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Database, Queryable } from "./db.js";
import type { Config } from "./config.js";
import { digest } from "./library.js";
import { AppError } from "./errors.js";
import {
  currentPasswordSchema,
  newPasswordSchema,
  recoveryCodeSchema,
  idSchema,
  usernameSchema,
} from "../shared/schema.js";

// OWASP's 32 MiB scrypt profile; only these explicit profiles are accepted.
const passwordProfile = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const legacyPasswordProfile = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
};
const passwordHashPrefix = "scrypt$1$32768$8$3";
const currentPasswordHash =
  /^scrypt\$1\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const legacyPasswordHash = /^([a-f0-9]{32}):([a-f0-9]{128})$/;
let activePasswordJobs = 0;
const passwordQueue: Array<() => void> = [];

async function derivePassword(password: string, salt: string, legacy = false) {
  // Two simultaneous derivations keep normal scrypt memory near 64 MiB total.
  // A bounded queue also prevents distributed requests retaining passwords
  // indefinitely while the existing HTTP sign-in limiter handles each IP.
  if (activePasswordJobs >= 2) {
    if (passwordQueue.length >= 8)
      throw new AppError(
        503,
        "AUTH_BUSY",
        "Sign-in is busy. Please try again shortly.",
      );
    await new Promise<void>((resolve) => passwordQueue.push(resolve));
  } else activePasswordJobs++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        64,
        legacy ? legacyPasswordProfile : passwordProfile,
        (error, result) => (error ? reject(error) : resolve(result)),
      );
    });
  } finally {
    const next = passwordQueue.shift();
    if (next) next();
    else activePasswordJobs--;
  }
}
const secret = () => randomBytes(32).toString("base64url");
const sessionTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const scopesAllowed = ["library:read", "library:write"];
type UserRow = {
  id: string;
  password_hash: string;
  auth_version: number;
  recovery_hash: string | null;
  recovery_created_at: Date | null;
};
function sessionLabel(userAgent?: string) {
  if (!userAgent) return "Browser session";
  const ua = userAgent.slice(0, 512);
  const browser = /Edg(?:e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /(?:Firefox|FxiOS)\//.test(ua)
        ? "Firefox"
        : /(?:Chrome|CriOS)\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const platform = /(?:iPhone|iPad|iPod)/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows NT/.test(ua)
        ? "Windows"
        : /(?:Macintosh|Mac OS X)/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : undefined;
  return platform ? `${browser} on ${platform}` : `${browser} session`;
}
const loginFailed = () =>
  new AppError(401, "LOGIN_FAILED", "The password was not accepted.");
const unauthenticated = () =>
  new AppError(401, "UNAUTHENTICATED", "Sign in to manage account security.");
type StoredParams = Omit<AuthorizationParams, "resource"> & {
  resource: string;
};
type Grant = { owner: string; client_id: string; params: StoredParams };
type TokenRow = {
  owner: string;
  client_id: string;
  kind: string;
  scopes: string[];
  resource: string;
  family: string;
  expires_at: Date;
};

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = await derivePassword(password, salt);
  return `${passwordHashPrefix}$${salt}$${hash.toString("hex")}`;
}
async function verifyPassword(password: string, encoded: string) {
  const current = currentPasswordHash.exec(encoded);
  const parsed = current ?? legacyPasswordHash.exec(encoded);
  if (!parsed) return { valid: false, needsUpgrade: false };
  const actual = await derivePassword(password, parsed[1], !current);
  const expected = Buffer.from(parsed[2], "hex");
  return {
    valid: timingSafeEqual(expected, actual),
    needsUpgrade: !current,
  };
}

export class Auth implements OAuthServerProvider {
  constructor(
    readonly db: Database,
    readonly config: Config,
  ) {}
  get resource() {
    return `${this.config.origin}/mcp`;
  }
  get clientsStore() {
    return {
      getClient: async (id: string) => {
        const { rows } = await this.db.query<{
          data: OAuthClientInformationFull;
        }>("SELECT data FROM oauth_clients WHERE id=$1", [id]);
        return rows[0]?.data;
      },
      registerClient: async (
        client: Omit<
          OAuthClientInformationFull,
          "client_id" | "client_id_issued_at"
        >,
      ) => {
        if (
          !client.redirect_uris.length ||
          client.redirect_uris.some(
            (uri) => !this.config.redirectUris.includes(uri),
          )
        )
          throw new InvalidClientMetadataError(
            "Redirect URI is not configured for this private app.",
          );
        if (client.token_endpoint_auth_method !== "none")
          throw new InvalidClientMetadataError(
            "Use a public PKCE client with token_endpoint_auth_method=none.",
          );
        const data: OAuthClientInformationFull = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        };
        await this.db.query(
          "INSERT INTO oauth_clients(id,data) VALUES($1,$2)",
          [data.client_id, JSON.stringify(data)],
        );
        return data;
      },
    };
  }
  async hasOwner() {
    return (
      (await this.db.query("SELECT id FROM users WHERE singleton=true LIMIT 1"))
        .rows.length > 0
    );
  }
  async setup(password: string, userAgent?: string) {
    newPasswordSchema.parse(password);
    const hash = await hashPassword(password);
    const id = randomUUID();
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        "INSERT INTO users(id,password_hash) VALUES($1,$2) ON CONFLICT(singleton) DO NOTHING RETURNING id",
        [id, hash],
      );
      if (!rows.length)
        throw new AppError(
          409,
          "ALREADY_CONFIGURED",
          "An owner account is already configured.",
        );
      return this.issueSession(tx, id, userAgent);
    });
  }
  async register(username: string, password: string, userAgent?: string) {
    if (!this.config.signupEnabled || !this.config.publicAccounts)
      throw new AppError(
        403,
        "SIGNUP_CLOSED",
        "New accounts are not available yet.",
      );
    username = usernameSchema.parse(username);
    newPasswordSchema.parse(password);
    if (username === "owner")
      throw new AppError(
        409,
        "USERNAME_UNAVAILABLE",
        "Choose another username.",
      );
    const hash = await hashPassword(password);
    return this.db.transaction(async (tx) => {
      const id = randomUUID();
      const { rows } = await tx.query(
        "INSERT INTO users(id,singleton,username,password_hash) VALUES($1,NULL,$2,$3) ON CONFLICT(username) DO NOTHING RETURNING id",
        [id, username, hash],
      );
      if (!rows.length)
        throw new AppError(
          409,
          "USERNAME_UNAVAILABLE",
          "Choose another username.",
        );
      return this.issueSession(tx, id, userAgent);
    });
  }
  async login(password: string, userAgent?: string, username?: string) {
    currentPasswordSchema.parse(password);
    const name =
      username === undefined ? "owner" : usernameSchema.parse(username);
    const { rows } = await this.db.query<UserRow>(
      "SELECT id,password_hash,auth_version FROM users WHERE username=$1 OR ($1='owner' AND singleton=true) LIMIT 1",
      [name],
    );
    const user = rows[0];
    // Unknown usernames still pay the normal password-work cost.
    if (!user) {
      await derivePassword(password, "00000000000000000000000000000000");
      throw loginFailed();
    }
    const verification =
      user && (await verifyPassword(password, user.password_hash));
    if (!verification?.valid) throw loginFailed();
    const upgraded = verification.needsUpgrade
      ? await hashPassword(password)
      : undefined;
    return this.db.transaction(async (tx) => {
      const current = await this.lockOwner(tx, user.id);
      if (
        !current ||
        current.password_hash !== user.password_hash ||
        current.auth_version !== user.auth_version
      )
        throw loginFailed();
      if (upgraded)
        await tx.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
          upgraded,
          user.id,
        ]);
      return this.issueSession(tx, user.id, userAgent);
    });
  }
  async session(owner: string, userAgent?: string) {
    idSchema.parse(owner);
    return this.db.transaction(async (tx) => {
      if (!(await this.lockOwner(tx, owner))) throw unauthenticated();
      return this.issueSession(tx, owner, userAgent);
    });
  }
  private async issueSession(tx: Queryable, owner: string, userAgent?: string) {
    const token = secret();
    await tx.query(
      "DELETE FROM sessions WHERE owner=$1 AND expires_at<=clock_timestamp()",
      [owner],
    );
    // Retain the 49 most recently used sessions before issuing the next one.
    await tx.query(
      `DELETE FROM sessions WHERE owner=$1 AND id IN (
      SELECT id FROM sessions WHERE owner=$1 ORDER BY last_seen_at DESC,created_at DESC,id DESC OFFSET 49
    )`,
      [owner],
    );
    await tx.query(
      "INSERT INTO sessions(hash,owner,label,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '7 days')",
      [digest(token), owner, sessionLabel(userAgent)],
    );
    return token;
  }
  async sessionOwner(token: unknown) {
    if (typeof token !== "string" || !sessionTokenPattern.test(token))
      return undefined;
    const { rows } = await this.db.query<{ owner: string }>(
      "SELECT owner FROM sessions WHERE hash=$1 AND expires_at>now()",
      [digest(token)],
    );
    if (rows[0])
      await this.db.query(
        "UPDATE sessions SET last_seen_at=clock_timestamp() WHERE hash=$1 AND expires_at>clock_timestamp() AND last_seen_at<clock_timestamp()-interval '5 minutes'",
        [digest(token)],
      );
    return rows[0]?.owner;
  }
  async logout(token: string) {
    if (typeof token !== "string" || !sessionTokenPattern.test(token)) return;
    const { rows } = await this.db.query<{ owner: string }>(
      "SELECT owner FROM sessions WHERE hash=$1",
      [digest(token)],
    );
    if (!rows[0]) return;
    await this.db.transaction(async (tx) => {
      await this.lockOwner(tx, rows[0].owner);
      await tx.query("DELETE FROM sessions WHERE owner=$1 AND hash=$2", [
        rows[0].owner,
        digest(token),
      ]);
    });
  }
  private async activeSession(tx: Queryable, owner: string, token: string) {
    if (typeof token !== "string" || !sessionTokenPattern.test(token))
      throw unauthenticated();
    const { rows } = await tx.query<{ id: string }>(
      "SELECT id FROM sessions WHERE owner=$1 AND hash=$2 AND expires_at>clock_timestamp()",
      [owner, digest(token)],
    );
    if (!rows[0]) throw unauthenticated();
    return rows[0];
  }
  private async reauthenticate(owner: string, token: string, password: string) {
    idSchema.parse(owner);
    currentPasswordSchema.parse(password);
    await this.activeSession(this.db, owner, token);
    const { rows } = await this.db.query<UserRow>(
      "SELECT id,password_hash,auth_version FROM users WHERE id=$1",
      [owner],
    );
    const user = rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash)).valid)
      throw loginFailed();
    return user;
  }
  private async recheck(tx: Queryable, snapshot: UserRow, token: string) {
    const current = await this.lockOwner(tx, snapshot.id);
    if (
      !current ||
      current.password_hash !== snapshot.password_hash ||
      current.auth_version !== snapshot.auth_version
    )
      throw unauthenticated();
    await this.activeSession(tx, snapshot.id, token);
    return current;
  }
  private async invalidateCredentials(
    tx: Queryable,
    owner: string,
    clearRecovery: boolean,
  ) {
    await tx.query("DELETE FROM sessions WHERE owner=$1", [owner]);
    await tx.query("DELETE FROM oauth_codes WHERE owner=$1", [owner]);
    await tx.query("DELETE FROM oauth_tokens WHERE owner=$1", [owner]);
    await tx.query(
      clearRecovery
        ? "UPDATE users SET auth_version=auth_version+1,recovery_hash=NULL,recovery_created_at=NULL WHERE id=$1"
        : "UPDATE users SET auth_version=auth_version+1 WHERE id=$1",
      [owner],
    );
  }
  async security(owner: string, token: string) {
    idSchema.parse(owner);
    return this.db.transaction(async (tx) => {
      const user = await this.lockOwner(tx, owner);
      if (!user) throw unauthenticated();
      const current = await this.activeSession(tx, owner, token);
      const { rows } = await tx.query<{
        id: string;
        label: string;
        created_at: Date;
        last_seen_at: Date;
        expires_at: Date;
      }>(
        "SELECT id,label,created_at,last_seen_at,expires_at FROM sessions WHERE owner=$1 AND expires_at>clock_timestamp() ORDER BY (id=$2) DESC,last_seen_at DESC,created_at DESC,id DESC LIMIT 50",
        [owner, current.id],
      );
      return {
        recoveryEnabled: Boolean(user.recovery_hash),
        recoveryCreatedAt: user.recovery_created_at
          ? new Date(user.recovery_created_at).toISOString()
          : null,
        sessions: rows.map((row) => ({
          id: row.id,
          label: row.label,
          createdAt: new Date(row.created_at).toISOString(),
          lastSeenAt: new Date(row.last_seen_at).toISOString(),
          expiresAt: new Date(row.expires_at).toISOString(),
          current: row.id === current.id,
        })),
      };
    });
  }
  async changePassword(
    owner: string,
    token: string,
    currentPassword: string,
    newPassword: string,
  ) {
    newPasswordSchema.parse(newPassword);
    const snapshot = await this.reauthenticate(owner, token, currentPassword);
    const hash = await hashPassword(newPassword);
    await this.db.transaction(async (tx) => {
      await this.recheck(tx, snapshot, token);
      await tx.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
        hash,
        owner,
      ]);
      await this.invalidateCredentials(tx, owner, true);
    });
  }
  async createRecoveryCode(
    owner: string,
    token: string,
    currentPassword: string,
  ) {
    const snapshot = await this.reauthenticate(owner, token, currentPassword);
    const recoveryCode = secret();
    await this.db.transaction(async (tx) => {
      await this.recheck(tx, snapshot, token);
      await tx.query(
        "UPDATE users SET recovery_hash=$1,recovery_created_at=clock_timestamp() WHERE id=$2",
        [digest(recoveryCode), owner],
      );
    });
    return { recoveryCode };
  }
  async recover(recoveryCode: string, newPassword: string) {
    recoveryCode = recoveryCodeSchema.parse(recoveryCode);
    newPasswordSchema.parse(newPassword);
    const codeHash = digest(recoveryCode);
    const { rows } = await this.db.query<UserRow>(
      "SELECT id,recovery_hash,auth_version FROM users WHERE recovery_hash=$1",
      [codeHash],
    );
    const snapshot = rows[0];
    const rejected = () =>
      new AppError(
        401,
        "RECOVERY_FAILED",
        "The recovery code was not accepted.",
      );
    if (!snapshot) throw rejected();
    const hash = await hashPassword(newPassword);
    await this.db.transaction(async (tx) => {
      const current = await this.lockOwner(tx, snapshot.id);
      if (
        !current ||
        current.recovery_hash !== codeHash ||
        current.auth_version !== snapshot.auth_version
      )
        throw rejected();
      await tx.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
        hash,
        snapshot.id,
      ]);
      await this.invalidateCredentials(tx, snapshot.id, true);
    });
  }
  async deleteAccount(owner: string, token: string, password: string) {
    const snapshot = await this.reauthenticate(owner, token, password);
    await this.db.transaction(async (tx) => {
      await this.recheck(tx, snapshot, token);
      // Keep the owner lock until both content and credentials are removed.
      // Explicit ordering preserves all foreign keys and rollback semantics.
      await tx.query("DELETE FROM item_embeddings WHERE owner=$1", [owner]);
      await tx.query("DELETE FROM save_requests WHERE owner=$1", [owner]);
      await tx.query("DELETE FROM items WHERE owner=$1", [owner]);
      await tx.query("DELETE FROM sources WHERE owner=$1", [owner]);
      await tx.query("DELETE FROM attachments WHERE owner=$1", [owner]);
      await tx.query("DELETE FROM sessions WHERE owner=$1", [owner]);
      await tx.query("DELETE FROM oauth_codes WHERE owner=$1", [owner]);
      await tx.query("DELETE FROM oauth_tokens WHERE owner=$1", [owner]);
      await tx.query("DELETE FROM users WHERE id=$1", [owner]);
    });
  }
  async logoutEverywhere(
    owner: string,
    token: string,
    currentPassword: string,
  ) {
    const snapshot = await this.reauthenticate(owner, token, currentPassword);
    await this.db.transaction(async (tx) => {
      await this.recheck(tx, snapshot, token);
      await this.invalidateCredentials(tx, owner, false);
    });
  }
  async revokeSession(
    owner: string,
    token: string,
    currentPassword: string,
    id: string,
  ) {
    idSchema.parse(id);
    const snapshot = await this.reauthenticate(owner, token, currentPassword);
    return this.db.transaction(async (tx) => {
      await this.recheck(tx, snapshot, token);
      const { rows } = await tx.query<{ current: boolean }>(
        "DELETE FROM sessions WHERE owner=$1 AND id=$2 AND expires_at>clock_timestamp() RETURNING hash=$3 AS current",
        [owner, id, digest(token)],
      );
      if (!rows[0])
        throw new AppError(
          404,
          "NOT_FOUND",
          "That browser session was not found.",
        );
      return { signedOut: rows[0].current };
    });
  }
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ) {
    if (params.resource?.href !== this.resource)
      throw new InvalidTargetError(
        "The resource must match this MCP endpoint.",
      );
    const scopes = params.scopes?.length ? params.scopes : scopesAllowed;
    if (scopes.some((scope) => !scopesAllowed.includes(scope)))
      throw new InvalidScopeError("Unsupported scope.");
    const id = secret();
    await this.db.query(
      "INSERT INTO oauth_pending(id,client_id,params,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
      [
        id,
        client.client_id,
        JSON.stringify({ ...params, scopes, resource: this.resource }),
      ],
    );
    res.redirect(`${this.config.origin}/?authorize=${encodeURIComponent(id)}`);
  }
  async pending(id: string) {
    const { rows } = await this.db.query<{
      client_id: string;
      params: StoredParams;
    }>(
      "SELECT client_id,params FROM oauth_pending WHERE id=$1 AND expires_at>now()",
      [id],
    );
    if (!rows[0])
      throw new AppError(
        410,
        "EXPIRED",
        "This connection request expired. Start again from ChatGPT.",
      );
    const client = await this.clientsStore.getClient(rows[0].client_id);
    return {
      clientName: client?.client_name ?? "MCP client",
      scopes: rows[0].params.scopes ?? [],
      redirectUri: rows[0].params.redirectUri,
    };
  }
  async consent(owner: string, id: string, approved: boolean, token?: string) {
    return this.db.transaction(async (tx) => {
      await this.lockOwner(tx, owner);
      if (token !== undefined) await this.activeSession(tx, owner, token);
      const { rows } = await tx.query<{
        client_id: string;
        params: StoredParams;
      }>(
        "DELETE FROM oauth_pending WHERE id=$1 AND expires_at>now() RETURNING client_id,params",
        [id],
      );
      if (!rows[0])
        throw new AppError(410, "EXPIRED", "This connection request expired.");
      const grant = rows[0];
      const redirect = new URL(grant.params.redirectUri);
      if (grant.params.state)
        redirect.searchParams.set("state", grant.params.state);
      if (approved) {
        const code = secret();
        await tx.query(
          "INSERT INTO oauth_codes(hash,owner,client_id,params,expires_at) VALUES($1,$2,$3,$4,now()+interval '2 minutes')",
          [digest(code), owner, grant.client_id, JSON.stringify(grant.params)],
        );
        redirect.searchParams.set("code", code);
      } else redirect.searchParams.set("error", "access_denied");
      return { redirect: redirect.href };
    });
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ) {
    const { rows } = await this.db.query<Grant>(
      "SELECT owner,client_id,params FROM oauth_codes WHERE hash=$1 AND client_id=$2 AND expires_at>now()",
      [digest(code), client.client_id],
    );
    if (!rows[0])
      throw new InvalidGrantError("Authorization code is invalid or expired.");
    return rows[0].params.codeChallenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ) {
    return this.db.transaction(async (tx) => {
      const original = await tx.query<{ owner: string }>(
        "SELECT owner FROM oauth_codes WHERE hash=$1 AND client_id=$2 AND expires_at>now()",
        [digest(code), client.client_id],
      );
      if (!original.rows[0])
        throw new InvalidGrantError(
          "Authorization code is invalid or expired.",
        );
      await this.lockOwner(tx, original.rows[0].owner);
      const { rows } = await tx.query<Grant>(
        "SELECT owner,client_id,params FROM oauth_codes WHERE hash=$1 AND client_id=$2 AND expires_at>now() FOR UPDATE",
        [digest(code), client.client_id],
      );
      const grant = rows[0];
      // The SDK validates PKCE before calling this method and omits the verifier.
      // Direct internal callers supplying a verifier must satisfy the same check.
      if (
        !grant ||
        (verifier !== undefined &&
          createHash("sha256").update(verifier).digest("base64url") !==
            grant.params.codeChallenge) ||
        redirectUri !== grant.params.redirectUri ||
        resource?.href !== grant.params.resource
      )
        throw new InvalidGrantError(
          "Authorization code, verifier, redirect, or resource is invalid.",
        );
      await tx.query("DELETE FROM oauth_codes WHERE hash=$1", [digest(code)]);
      return this.issue(
        tx,
        grant.owner,
        client.client_id,
        grant.params.scopes ?? [],
        randomUUID(),
      );
    });
  }
  private async issue(
    tx: Queryable,
    owner: string,
    client: string,
    scopes: string[],
    family: string,
  ) {
    const access = secret(),
      refresh = secret();
    await tx.query(
      "INSERT INTO oauth_tokens(hash,family,owner,client_id,kind,scopes,resource,expires_at) VALUES($1,$2,$3,$4,'access',$5,$6,now()+interval '1 hour'),($7,$2,$3,$4,'refresh',$5,$6,now()+interval '30 days')",
      [
        digest(access),
        family,
        owner,
        client,
        scopes,
        this.resource,
        digest(refresh),
      ],
    );
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
      scope: scopes.join(" "),
    };
  }
  private async lockOwner(tx: Queryable, owner: string) {
    // Issuance and revocation share this lock so a concurrent exchange cannot
    // recreate credentials after the owner's disconnect has completed.
    const { rows } = await tx.query<UserRow>(
      "SELECT id,password_hash,auth_version,recovery_hash,recovery_created_at FROM users WHERE id=$1 FOR UPDATE",
      [owner],
    );
    return rows[0];
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refresh: string,
    scopes?: string[],
    resource?: URL,
  ) {
    const result = await this.db.transaction(async (tx) => {
      const original = await tx.query<{ owner: string }>(
        "SELECT owner FROM oauth_tokens WHERE hash=$1 AND client_id=$2 AND kind IN ('refresh','refresh_used')",
        [digest(refresh), client.client_id],
      );
      if (!original.rows[0])
        throw new InvalidGrantError("Refresh token or resource is invalid.");
      await this.lockOwner(tx, original.rows[0].owner);
      const { rows } = await tx.query<TokenRow>(
        "SELECT * FROM oauth_tokens WHERE hash=$1 AND client_id=$2 AND kind IN ('refresh','refresh_used') AND (kind='refresh_used' OR expires_at>now()) FOR UPDATE",
        [digest(refresh), client.client_id],
      );
      const grant = rows[0];
      if (!grant || resource?.href !== grant.resource)
        throw new InvalidGrantError("Refresh token or resource is invalid.");
      if (grant.kind === "refresh_used") {
        await tx.query(
          "DELETE FROM oauth_tokens WHERE family=$1 AND owner=$2 AND client_id=$3",
          [grant.family, grant.owner, grant.client_id],
        );
        // Return instead of throwing here, so the family revocation commits.
        return undefined;
      }
      const requested = scopes ?? grant.scopes;
      if (requested.some((scope) => !grant.scopes.includes(scope)))
        throw new InvalidScopeError("A refresh cannot add scopes.");
      await tx.query(
        "DELETE FROM oauth_tokens WHERE family=$1 AND owner=$2 AND client_id=$3 AND kind='access'",
        [grant.family, grant.owner, grant.client_id],
      );
      await tx.query(
        "UPDATE oauth_tokens SET kind='refresh_used' WHERE hash=$1 AND owner=$2 AND client_id=$3",
        [digest(refresh), grant.owner, grant.client_id],
      );
      return this.issue(
        tx,
        grant.owner,
        grant.client_id,
        requested,
        grant.family,
      );
    });
    if (!result)
      throw new InvalidGrantError("Refresh token or resource is invalid.");
    return result;
  }
  async verifyAccessToken(token: string) {
    if (token.length > 100)
      throw new InvalidTokenError("Invalid access token.");
    const { rows } = await this.db.query<TokenRow>(
      "SELECT * FROM oauth_tokens WHERE hash=$1 AND kind='access' AND expires_at>now()",
      [digest(token)],
    );
    const grant = rows[0];
    if (!grant || grant.resource !== this.resource)
      throw new InvalidTokenError("Access token is invalid or expired.");
    return {
      token,
      clientId: grant.client_id,
      scopes: grant.scopes,
      expiresAt: new Date(grant.expires_at).getTime() / 1000,
      resource: new URL(grant.resource),
      extra: { owner: grant.owner },
    };
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ) {
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ owner: string }>(
        "SELECT owner FROM oauth_tokens WHERE hash=$1 AND client_id=$2",
        [digest(request.token), client.client_id],
      );
      if (!rows[0]) return;
      const owner = rows[0].owner;
      await this.lockOwner(tx, owner);
      await tx.query(
        "DELETE FROM oauth_tokens WHERE owner=$1 AND client_id=$2 AND family IN (SELECT family FROM oauth_tokens WHERE hash=$3 AND owner=$1 AND client_id=$2)",
        [owner, client.client_id, digest(request.token)],
      );
    });
  }
  async revokeAll(owner: string, token?: string) {
    await this.db.transaction(async (tx) => {
      await this.lockOwner(tx, owner);
      if (token !== undefined) await this.activeSession(tx, owner, token);
      await tx.query("DELETE FROM oauth_codes WHERE owner=$1", [owner]);
      await tx.query("DELETE FROM oauth_tokens WHERE owner=$1", [owner]);
    });
  }
}
