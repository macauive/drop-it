import { resolve } from "node:path";
import { z } from "zod";
import { publicSiteSchema } from "./public-pages.js";
type LoadedConfig = ReturnType<typeof loadConfig>;
export type Config = Omit<
  LoadedConfig,
  | "chatgpt"
  | "publicAccounts"
  | "signupEnabled"
  | "trustProxy"
  | "publicSite"
  | "domainChallenge"
  | "libraryLimits"
> &
  Partial<
    Pick<
      LoadedConfig,
      | "chatgpt"
      | "publicAccounts"
      | "signupEnabled"
      | "trustProxy"
      | "publicSite"
      | "domainChallenge"
      | "libraryLimits"
    >
  >;
export function loadConfig() {
  const port = z.coerce
    .number()
    .int()
    .min(1024)
    .max(65535)
    .parse(process.env.PORT ?? 4317);
  const publicUrl = new URL(
    process.env.PUBLIC_URL ??
      process.env.RENDER_EXTERNAL_URL ??
      `http://localhost:${port}`,
  );
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(
    publicUrl.hostname,
  );
  if (
    (publicUrl.protocol !== "https:" &&
      !(local && publicUrl.protocol === "http:")) ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.username ||
    publicUrl.password
  ) {
    throw new Error(
      "PUBLIC_URL must be an HTTPS origin (HTTP is allowed on loopback only).",
    );
  }
  const redirectUris = (process.env.OAUTH_REDIRECT_URIS ?? "")
    .split(",")
    .filter(Boolean)
    .map((value) => {
      const url = new URL(value.trim());
      if (
        url.protocol !== "https:" &&
        !(local && url.protocol === "http:" && url.hostname === "localhost")
      )
        throw new Error("Invalid OAuth redirect URI.");
      if (url.hash || url.username || url.password)
        throw new Error("Invalid OAuth redirect URI.");
      return url.href;
    });
  const publicAccounts =
    z
      .enum(["private", "public"])
      .parse(process.env.ACCOUNT_MODE ?? "private") === "public";
  const signupEnabled =
    z.enum(["true", "false"]).parse(process.env.ALLOW_SIGNUP ?? "false") ===
    "true";
  if (signupEnabled && !publicAccounts)
    throw new Error("ALLOW_SIGNUP requires ACCOUNT_MODE=public.");
  if (
    process.env.NODE_ENV === "production" &&
    !local &&
    !process.env.DATABASE_URL
  )
    throw new Error(
      "Public production deployments require DATABASE_URL; local disk storage is development-only.",
    );
  const publicSite =
    process.env.PUBLIC_PUBLISHER_NAME &&
    process.env.PUBLIC_SUPPORT_EMAIL &&
    process.env.BACKUP_RETENTION_DAYS
      ? publicSiteSchema.parse({
          publisher: process.env.PUBLIC_PUBLISHER_NAME,
          supportEmail: process.env.PUBLIC_SUPPORT_EMAIL,
          backupRetentionDays: Number(process.env.BACKUP_RETENTION_DAYS),
        })
      : undefined;
  if (signupEnabled && !local && !publicSite)
    throw new Error(
      "Public signup requires publisher, support and backup retention settings.",
    );
  return {
    chatgpt: loadChatGPTConfig(),
    port,
    origin: publicUrl.origin,
    local,
    publicAccounts,
    signupEnabled,
    publicSite,
    domainChallenge: process.env.OPENAI_APPS_CHALLENGE
      ? z
          .string()
          .min(1)
          .max(512)
          .regex(/^[A-Za-z0-9._=-]+$/)
          .parse(process.env.OPENAI_APPS_CHALLENGE)
      : undefined,
    // Use only behind a proxy that replaces forwarding headers; never trust all hops.
    trustProxy: z.coerce
      .number()
      .int()
      .min(0)
      .max(5)
      .parse(process.env.TRUST_PROXY_HOPS ?? 0),
    redirectUris,
    dataDir: resolve(process.env.DATA_DIR ?? ".data"),
    databaseUrl: process.env.DATABASE_URL || undefined,
    production: process.env.NODE_ENV === "production",
    ai: process.env.OPENAI_API_KEY?.trim()
      ? {
          apiKey: process.env.OPENAI_API_KEY.trim(),
          model: z
            .string()
            .regex(/^[a-zA-Z0-9._-]{1,100}$/)
            .parse(process.env.OPENAI_MODEL ?? "gpt-5.6-luna"),
        }
      : undefined,
    libraryLimits: {
      ownerAttachmentBytes: z.coerce
        .number()
        .int()
        .min(1)
        .max(1024 ** 4)
        .parse(process.env.MAX_OWNER_ATTACHMENT_BYTES ?? 250 * 1024 ** 2),
      ownerDropCount: z.coerce
        .number()
        .int()
        .min(1)
        .max(1000000)
        .parse(process.env.MAX_OWNER_DROPS ?? 10000),
      ownerTextBytes: z.coerce
        .number()
        .int()
        .min(1)
        .max(1024 ** 4)
        .parse(process.env.MAX_OWNER_TEXT_BYTES ?? 25 * 1024 ** 2),
      serviceAttachmentBytes: z.coerce
        .number()
        .int()
        .min(1)
        .max(1024 ** 4)
        .parse(process.env.MAX_SERVICE_ATTACHMENT_BYTES ?? 3 * 1024 ** 3),
      aiConcurrent: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(process.env.MAX_AI_CONCURRENT ?? 4),
      aiStartsPerMinute: z.coerce
        .number()
        .int()
        .min(1)
        .max(10000)
        .parse(process.env.MAX_AI_STARTS_PER_MINUTE ?? 120),
    },
  };
}

export type ChatGPTConfig = {
  clientId: string;
  clientSecret?: string;
  authMethod: "none" | "client_secret_basic";
  encryptionKey: string;
  planScopes: string;
};
function loadChatGPTConfig(): ChatGPTConfig | undefined {
  if (process.env.CHATGPT_ENABLED !== "true") return undefined;
  const clientId = z
    .string()
    .regex(/^oaiapp_[A-Za-z0-9_-]{1,180}$/)
    .parse(process.env.CHATGPT_CLIENT_ID);
  const encryptionKey = z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .parse(process.env.CHATGPT_ENCRYPTION_KEY);
  const authMethod = z
    .enum(["none", "client_secret_basic"])
    .parse(process.env.CHATGPT_TOKEN_AUTH_METHOD ?? "none");
  const clientSecret =
    authMethod === "client_secret_basic"
      ? z.string().min(1).max(4096).parse(process.env.CHATGPT_CLIENT_SECRET)
      : undefined;
  // Commercial grants must be provisioned by OpenAI. Never substitute the
  // dynamic OSS client, invent a scope, or enable plan usage from identity alone.
  const planEnabled =
    z
      .enum(["true", "false"])
      .parse(process.env.CHATGPT_PLAN_ENABLED ?? "false") === "true";
  const planScopes = planEnabled
    ? z
        .string()
        .min(1)
        .max(500)
        .regex(/^[a-zA-Z0-9._:-]+(?: [a-zA-Z0-9._:-]+)*$/)
        .parse(process.env.CHATGPT_PLAN_SCOPES)
    : "";
  if (
    planEnabled &&
    (!planScopes.split(" ").includes("offline_access") ||
      !planScopes.split(" ").includes("resource.invoke"))
  )
    throw new Error(
      "ChatGPT plan usage requires the approved offline_access and resource.invoke scopes.",
    );
  return { clientId, clientSecret, authMethod, encryptionKey, planScopes };
}
