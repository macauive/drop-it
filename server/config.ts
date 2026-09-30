import { resolve } from "node:path";
import { z } from "zod";
export type Config = ReturnType<typeof loadConfig>;
export function loadConfig() {
  const port = z.coerce
    .number()
    .int()
    .min(1024)
    .max(65535)
    .parse(process.env.PORT ?? 4317);
  const publicUrl = new URL(
    process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  );
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(
    publicUrl.hostname,
  );
  if (
    (!local && publicUrl.protocol !== "https:") ||
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
      if (url.protocol !== "https:" && !(local && url.hostname === "localhost"))
        throw new Error("Invalid OAuth redirect URI.");
      if (url.hash || url.username || url.password)
        throw new Error("Invalid OAuth redirect URI.");
      return url.href;
    });
  return {
    port,
    origin: publicUrl.origin,
    local,
    redirectUris,
    dataDir: resolve(process.env.DATA_DIR ?? ".data"),
    databaseUrl: process.env.DATABASE_URL || undefined,
    production: process.env.NODE_ENV === "production",
  };
}
