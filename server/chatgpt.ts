import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";
import type { Config, ChatGPTConfig } from "./config.js";
import type { Database, Queryable } from "./db.js";
import type { Auth } from "./auth.js";
import { AppError } from "./errors.js";
import { OpenAIProvider, type AIProvider } from "./ai.js";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const random = () => randomBytes(32).toString("base64url");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const opaque = z.string().min(1).max(16384);
const tokenSchema = z.object({
  access_token: opaque,
  refresh_token: opaque,
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().min(1).max(86400),
  scope: z.string().max(2000).optional(),
});
type Tokens = z.infer<typeof tokenSchema>;
const pendingSchema = z.object({
  verifier: opaque,
  nonce: opaque,
  clientId: opaque,
  owner: z.string().uuid().optional(),
  sessionHash: z.string().optional(),
  authVersion: z.number().int().optional(),
  plan: z.boolean(),
  returnTo: z.string().max(200),
});
type Pending = z.infer<typeof pendingSchema>;
type Connection = {
  owner: string;
  subject: string;
  client_id: string;
  credentials: string | null;
  expires_at: Date | null;
};
const unavailable = () =>
  new AppError(
    503,
    "AI_CHATGPT_CONNECT",
    "Connect your ChatGPT plan in Settings to use AI drafts. Manual entry and keyword search are available.",
  );
const signInFailed = () =>
  new AppError(
    400,
    "CHATGPT_SIGN_IN",
    "ChatGPT sign-in could not be completed. Sign in with your Drop It password and connect ChatGPT in Settings, or try again.",
  );

// Bound all provider responses and reject redirects, including discovery/JWKS.
export async function boundedFetch(
  transport: typeof fetch,
  url: string | URL,
  init: RequestInit = {},
) {
  const response = await transport(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  const reader = response.body?.getReader();
  if (!reader) return response;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256 * 1024) throw signInFailed();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Response(Buffer.concat(chunks), {
    status: response.status,
    headers: response.headers,
  });
}
export class ChatGPT {
  private metadata?: Promise<{
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
    revocation_endpoint?: string;
  }>;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  constructor(
    readonly db: Database,
    readonly auth: Auth,
    readonly config: Config,
    private readonly transport: typeof fetch = fetch,
  ) {}
  get settings(): ChatGPTConfig {
    if (!this.config.chatgpt) throw signInFailed();
    return this.config.chatgpt;
  }
  private seal(value: unknown, context: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(this.settings.encryptionKey, "hex"),
      iv,
    );
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }
  private unseal(value: string, context: string): unknown {
    const data = Buffer.from(value, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(this.settings.encryptionKey, "hex"),
      data.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString("utf8"),
    );
  }
  private discovery() {
    if (!this.metadata)
      this.metadata = (async () => {
        const endpoint = z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return (
              url.origin === issuer &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash
            );
          });
        const response = await boundedFetch(
          this.transport,
          `${issuer}/.well-known/openid-configuration`,
        );
        if (!response.ok) throw signInFailed();
        return z
          .object({
            issuer: z.literal(issuer),
            authorization_endpoint: endpoint,
            token_endpoint: endpoint,
            jwks_uri: endpoint,
            revocation_endpoint: endpoint.optional(),
          })
          .parse(await response.json());
      })().catch((error) => {
        this.metadata = undefined;
        throw error;
      });
    return this.metadata;
  }
  private async tokenRequest(body: URLSearchParams, endpoint?: string) {
    body.set("client_id", this.settings.clientId);
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if (this.settings.authMethod === "client_secret_basic") {
      const encode = (value: string) =>
        new URLSearchParams({ value }).toString().slice(6);
      headers.Authorization = `Basic ${Buffer.from(`${encode(this.settings.clientId)}:${encode(this.settings.clientSecret!)}`).toString("base64")}`;
    }
    return boundedFetch(
      this.transport,
      endpoint ?? (await this.discovery()).token_endpoint,
      { method: "POST", headers, body },
    );
  }
  async start(
    browser: string,
    options: {
      owner?: string;
      session?: string;
      password?: string;
      plan?: boolean;
      returnTo?: string;
    },
  ) {
    const cfg = this.settings;
    const plan = Boolean(options.plan);
    if (plan && (!cfg.planScopes || !options.owner)) throw signInFailed();
    const authVersion = options.owner
      ? await this.auth.confirmPassword(
          options.owner,
          options.session!,
          options.password!,
        )
      : undefined;
    const state = random();
    const pending: Pending = {
      verifier: random(),
      nonce: random(),
      clientId: cfg.clientId,
      owner: options.owner,
      sessionHash: options.owner ? hash(options.session!) : undefined,
      authVersion,
      plan,
      returnTo: options.returnTo ?? "/",
    };
    const url = new URL((await this.discovery()).authorization_endpoint);
    const scope = plan
      ? `openid profile email ${cfg.planScopes}`
      : "openid profile email";
    url.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: `${this.config.origin}/auth/chatgpt/callback`,
      response_type: "code",
      scope,
      state,
      nonce: pending.nonce,
      code_challenge: createHash("sha256")
        .update(pending.verifier)
        .digest("base64url"),
      code_challenge_method: "S256",
      ...(plan ? { resource } : {}),
    }).toString();
    await this.db.transaction(async (tx) => {
      await tx.query(
        "DELETE FROM chatgpt_pending WHERE expires_at<now() OR browser_hash=$1",
        [hash(browser)],
      );
      await tx.query(
        "INSERT INTO chatgpt_pending(hash,browser_hash,data,owner) VALUES($1,$2,$3,$4)",
        [
          hash(state),
          hash(browser),
          this.seal(pending, hash(state)),
          options.owner ?? null,
        ],
      );
    });
    return url.href;
  }
  async finish(
    browser: unknown,
    query: unknown,
    session: unknown,
    userAgent?: string,
  ) {
    // Consume browser-bound state even on malformed/error callbacks.
    if (typeof browser !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(browser))
      throw signInFailed();
    const rows = await this.db.transaction(
      async (tx) =>
        (
          await tx.query<{ hash: string; data: string; valid: boolean }>(
            "DELETE FROM chatgpt_pending WHERE browser_hash=$1 RETURNING hash,data,expires_at>clock_timestamp() AS valid",
            [hash(browser)],
          )
        ).rows,
    );
    try {
      const callback = z
        .object({
          state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          code: opaque.optional(),
          error: z.string().max(200).optional(),
          error_description: z.string().max(2000).optional(),
          iss: z.literal(issuer).optional(),
        })
        .strict()
        .parse(query);
      const row = rows.find((entry) => entry.hash === hash(callback.state));
      if (!row?.valid || callback.error || !callback.code) throw signInFailed();
      const pending = pendingSchema.parse(this.unseal(row.data, row.hash));
      if (pending.clientId !== this.settings.clientId) throw signInFailed();
      const response = await this.tokenRequest(
        new URLSearchParams({
          grant_type: "authorization_code",
          code: callback.code,
          redirect_uri: `${this.config.origin}/auth/chatgpt/callback`,
          code_verifier: pending.verifier,
          ...(pending.plan ? { resource } : {}),
        }),
      );
      if (!response.ok) throw signInFailed();
      const raw = z
        .object({ id_token: opaque })
        .passthrough()
        .parse(await response.json());
      if (!this.jwks)
        this.jwks = createRemoteJWKSet(
          new URL((await this.discovery()).jwks_uri),
          {
            [customFetch]: (url, init) =>
              boundedFetch(this.transport, url, init),
            timeoutDuration: 8000,
          },
        );
      const { payload } = await jwtVerify(raw.id_token, this.jwks, {
        issuer,
        audience: this.settings.clientId,
        algorithms: ["RS256", "ES256"],
        requiredClaims: ["sub", "exp", "iat", "nonce"],
        clockTolerance: 5,
        maxTokenAge: "10 minutes",
      });
      const subject = z.string().min(1).max(255).parse(payload.sub);
      if (
        payload.nonce !== pending.nonce ||
        (Array.isArray(payload.aud) &&
          payload.aud.length > 1 &&
          payload.azp !== this.settings.clientId) ||
        (payload.azp !== undefined && payload.azp !== this.settings.clientId)
      )
        throw signInFailed();
      const tokens = pending.plan ? this.readTokens(raw) : undefined;
      const result = await this.db.transaction(async (tx) => {
        const existing = (
          await tx.query<Connection>(
            "SELECT * FROM chatgpt_connections WHERE issuer=$1 AND client_id=$2 AND subject=$3",
            [issuer, this.settings.clientId, subject],
          )
        ).rows[0];
        const owner = pending.owner ?? existing?.owner;
        if (!owner || (existing && existing.owner !== owner))
          throw signInFailed();
        const user = (
          await tx.query<{ auth_version: number }>(
            "SELECT auth_version FROM users WHERE id=$1 FOR UPDATE",
            [owner],
          )
        ).rows[0];
        if (!user) throw signInFailed();
        if (pending.owner) {
          if (
            typeof session !== "string" ||
            hash(session) !== pending.sessionHash ||
            user.auth_version !== pending.authVersion
          )
            throw signInFailed();
          const valid = await tx.query(
            "SELECT hash FROM sessions WHERE owner=$1 AND hash=$2 AND expires_at>clock_timestamp()",
            [owner, pending.sessionHash],
          );
          if (!valid.rows.length) throw signInFailed();
          const prior = (
            await tx.query<Connection>(
              "SELECT * FROM chatgpt_connections WHERE owner=$1",
              [owner],
            )
          ).rows[0];
          // Reconnecting may renew the same identity. Replacing it requires an
          // explicit disconnect; email is never used for automatic linking.
          if (
            prior &&
            (prior.subject !== subject ||
              prior.client_id !== this.settings.clientId)
          )
            throw signInFailed();
          await tx.query(
            `INSERT INTO chatgpt_connections(owner,issuer,client_id,subject,credentials,expires_at) VALUES($1,$2,$3,$4,$5,$6)
            ON CONFLICT(owner) DO UPDATE SET credentials=COALESCE(EXCLUDED.credentials,chatgpt_connections.credentials),
            expires_at=COALESCE(EXCLUDED.expires_at,chatgpt_connections.expires_at)`,
            [
              owner,
              issuer,
              this.settings.clientId,
              subject,
              tokens ? this.seal(tokens, this.context(owner, subject)) : null,
              tokens ? new Date(Date.now() + tokens.expires_in * 1000) : null,
            ],
          );
          if (tokens) {
            await tx.query(
              "UPDATE users SET chatgpt_plan_selected=true,ai_search_enabled=false WHERE id=$1",
              [owner],
            );
            await tx.query("DELETE FROM item_embeddings WHERE owner=$1", [
              owner,
            ]);
          }
        } else {
          // Re-read after the owner lock so a concurrent disconnect wins.
          const linked = await tx.query(
            "SELECT owner FROM chatgpt_connections WHERE owner=$1 AND issuer=$2 AND client_id=$3 AND subject=$4",
            [owner, issuer, this.settings.clientId, subject],
          );
          if (!linked.rows.length) throw signInFailed();
        }
        return {
          token: await this.auth.issueSession(tx, owner, userAgent),
          returnTo: pending.returnTo,
        };
      });
      return result;
    } catch {
      throw signInFailed();
    }
  }
  private context(owner: string, subject: string) {
    return `${issuer}:${this.settings.clientId}:${owner}:${subject}`;
  }
  private readTokens(raw: unknown, previous?: Tokens) {
    const tokens = tokenSchema.parse(raw);
    tokens.scope ??= previous?.scope;
    if (
      !tokens.scope ||
      !this.settings.planScopes
        .split(" ")
        .every((scope) => tokens.scope!.split(" ").includes(scope))
    )
      throw unavailable();
    return tokens;
  }
  async status(owner: string) {
    const row = (
      await this.db.query<{
        chatgpt_plan_selected: boolean;
        client_id: string | null;
        credentials: string | null;
      }>(
        "SELECT u.chatgpt_plan_selected,c.client_id,c.credentials FROM users u LEFT JOIN chatgpt_connections c ON c.owner=u.id WHERE u.id=$1",
        [owner],
      )
    ).rows[0];
    const enabled = Boolean(this.config.chatgpt);
    const connected =
      enabled && row?.client_id === this.config.chatgpt?.clientId;
    return {
      enabled,
      planAvailable: Boolean(this.config.chatgpt?.planScopes),
      connected,
      planConnected: Boolean(connected && row?.credentials),
      planRequired: Boolean(
        this.config.chatgpt?.planScopes || row?.chatgpt_plan_selected,
      ),
    };
  }
  async provider(
    owner: string,
    fallback?: AIProvider,
  ): Promise<AIProvider | undefined> {
    const state = await this.status(owner);
    if (!state.planRequired) return fallback;
    // Even a disconnect or disabled configuration cannot switch this user to
    // the operator's key. Fetch credentials only when a draft is requested.
    return {
      draft: async (context) => {
        const access = await this.access(owner);
        return new OpenAIProvider(
          { apiKey: access.token, model: access.model, chatgptPlan: true },
          this.transport,
        ).draft(context);
      },
      embed: async () => {
        throw new AppError(
          503,
          "AI_SEARCH_UNAVAILABLE",
          "ChatGPT plan accounts use keyword search. Search embeddings are not covered by this integration.",
        );
      },
    };
  }
  private async access(owner: string) {
    if (!this.config.chatgpt?.planScopes) throw unavailable();
    const metadata = await this.discovery();
    const token = await this.db.transaction(async (tx) => {
      // Serialize refresh/disconnect with the same owner lock across processes.
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
      const row = (
        await tx.query<Connection>(
          "SELECT * FROM chatgpt_connections WHERE owner=$1 AND client_id=$2 FOR UPDATE",
          [owner, this.settings.clientId],
        )
      ).rows[0];
      if (!row?.credentials) return null;
      let tokens: Tokens;
      try {
        tokens = this.readTokens(
          this.unseal(row.credentials, this.context(owner, row.subject)),
        );
      } catch {
        return null;
      }
      if (
        !row.expires_at ||
        new Date(row.expires_at).getTime() < Date.now() + 60000
      ) {
        let response: Response;
        try {
          response = await this.tokenRequest(
            new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: tokens.refresh_token,
              resource,
            }),
            metadata.token_endpoint,
          );
        } catch {
          throw new AppError(
            503,
            "AI_CHATGPT_RETRY",
            "ChatGPT could not renew access. Try again shortly.",
          );
        }
        if (!response.ok) {
          if ([400, 401, 403].includes(response.status)) {
            await tx.query(
              "UPDATE chatgpt_connections SET credentials=NULL,expires_at=NULL WHERE owner=$1",
              [owner],
            );
            return null;
          }
          throw new AppError(
            503,
            "AI_CHATGPT_RETRY",
            "ChatGPT could not renew access. Try again shortly.",
          );
        }
        try {
          tokens = this.readTokens(await response.json(), tokens);
        } catch {
          await tx.query(
            "UPDATE chatgpt_connections SET credentials=NULL,expires_at=NULL WHERE owner=$1",
            [owner],
          );
          return null;
        }
        await tx.query(
          "UPDATE chatgpt_connections SET credentials=$2,expires_at=$3 WHERE owner=$1",
          [
            owner,
            this.seal(tokens, this.context(owner, row.subject)),
            new Date(Date.now() + tokens.expires_in * 1000),
          ],
        );
      }
      return tokens.access_token;
    });
    if (!token) throw unavailable();
    try {
      const response = await boundedFetch(
        this.transport,
        `${resource}/models`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) throw unavailable();
      const catalog = z
        .object({
          models: z
            .array(
              z.object({
                slug: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
                visibility: z.string(),
              }),
            )
            .max(500),
        })
        .parse(await response.json());
      const model = catalog.models.find(
        (entry) => entry.visibility === "list",
      )?.slug;
      if (!model) throw unavailable();
      return { token, model };
    } catch {
      throw unavailable();
    }
  }
  async disconnect(owner: string, session: string, password: string) {
    const version = await this.auth.confirmPassword(owner, session, password);
    const row = await this.db.transaction(async (tx: Queryable) => {
      const user = (
        await tx.query<{ auth_version: number }>(
          "SELECT auth_version FROM users WHERE id=$1 FOR UPDATE",
          [owner],
        )
      ).rows[0];
      if (
        !user ||
        user.auth_version !== version ||
        !(
          await tx.query(
            "SELECT hash FROM sessions WHERE owner=$1 AND hash=$2 AND expires_at>clock_timestamp()",
            [owner, hash(session)],
          )
        ).rows.length
      )
        throw signInFailed();
      await tx.query("DELETE FROM chatgpt_pending WHERE owner=$1", [owner]);
      return (
        await tx.query<Connection>(
          "DELETE FROM chatgpt_connections WHERE owner=$1 RETURNING *",
          [owner],
        )
      ).rows[0];
    });
    let revoked = !row?.credentials;
    if (row?.credentials)
      try {
        const tokens = tokenSchema.parse(
          this.unseal(row.credentials, this.context(owner, row.subject)),
        );
        const endpoint = (await this.discovery()).revocation_endpoint;
        if (endpoint)
          revoked =
            (
              await this.tokenRequest(
                new URLSearchParams({
                  token: tokens.refresh_token,
                  token_type_hint: "refresh_token",
                }),
                endpoint,
              )
            ).status === 200;
      } catch {
        revoked = false;
      }
    return { revoked };
  }
}
