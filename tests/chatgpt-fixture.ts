import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { openDatabase, migrate, type Database } from "../server/db.js";
import { createApp } from "../server/app.js";
import type { Config } from "../server/config.js";
import { ChatGPT } from "../server/chatgpt.js";

export async function chatgptFixture(
  html = "<!doctype html><title>ChatGPT fixture</title>",
  port = 0,
  database?: Database,
) {
  const dir = await mkdtemp(join(tmpdir(), "drop-it-chatgpt-"));
  const db = database ?? (await openDatabase({ dataDir: dir }));
  await migrate(db);
  const server = createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const key = await generateKeyPair("ES256");
  const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: "synthetic-test-key",
    alg: "ES256",
    use: "sig",
  };
  const config: Config = {
    port: 0,
    origin,
    local: true,
    production: false,
    redirectUris: [],
    dataDir: dir,
    databaseUrl: undefined,
    ai: undefined,
    publicAccounts: true,
    signupEnabled: true,
    chatgpt: {
      clientId: "oaiapp_synthetic",
      authMethod: "none",
      encryptionKey: randomBytes(32).toString("hex"),
      planScopes: "offline_access resource.invoke chatgpt.tokens.use.direct",
    },
  };
  const pending = new Map<
    string,
    { nonce: string; claims?: Record<string, unknown> }
  >();
  const calls: {
    url: string;
    body: URLSearchParams | Record<string, unknown>;
    authorization: string | null;
  }[] = [];
  const access = randomBytes(32).toString("base64url");
  let refresh = randomBytes(32).toString("base64url");
  const state = {
    siteCalls: 0,
    refreshCalls: 0,
    refreshStatus: 200,
    tokenScope: config.chatgpt!.planScopes,
    failure: "",
    revokeStatus: 200,
    revokedCurrentRefresh: false,
    beforeRefresh: undefined as (() => Promise<void>) | undefined,
  };
  const draft = {
    title: "Synthetic draft",
    summary: "Test",
    category: "Testing",
    tags: [],
    extractedText: "",
    sourceUrl: "",
  };
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const body =
      init?.body instanceof URLSearchParams
        ? init.body
        : init?.body
          ? JSON.parse(String(init.body))
          : {};
    calls.push({
      url,
      body,
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    if (url.endsWith("openid-configuration"))
      return Response.json({
        issuer: "https://auth.openai.com",
        authorization_endpoint:
          "https://auth.openai.com/api/accounts/authorize",
        token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
        jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
        revocation_endpoint: "https://auth.openai.com/revoke",
      });
    if (url.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/revoke")) {
      state.revokedCurrentRefresh = body.get("token") === refresh;
      return new Response("", { status: state.revokeStatus });
    }
    if (url.endsWith("/token")) {
      if (body.get("grant_type") === "refresh_token") {
        state.refreshCalls++;
        await state.beforeRefresh?.();
        if (state.refreshStatus !== 200)
          return Response.json(
            { error: "invalid_grant" },
            { status: state.refreshStatus },
          );
        if (body.get("refresh_token") !== refresh)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        refresh = randomBytes(32).toString("base64url");
        return Response.json({
          access_token: access,
          refresh_token: refresh,
          expires_in: 3600,
          token_type: "Bearer",
          scope: state.tokenScope,
        });
      }
      const item = pending.get(body.get("code"));
      if (!item)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      pending.delete(body.get("code"));
      const jwt = new SignJWT({
        sub: "synthetic-subject",
        nonce: item.nonce,
        ...item.claims,
      })
        .setProtectedHeader({ alg: "ES256", kid: jwk.kid })
        .setIssuer(String(item.claims?.iss ?? "https://auth.openai.com"))
        .setAudience(String(item.claims?.aud ?? config.chatgpt!.clientId))
        .setIssuedAt()
        .setExpirationTime(
          item.claims?.expired ? Math.floor(Date.now() / 1000) - 60 : "5m",
        );
      return Response.json({
        id_token: item.claims?.invalidSignature
          ? `${(await jwt.sign(key.privateKey)).split(".").slice(0, 2).join(".")}.invalid`
          : await jwt.sign(key.privateKey),
        access_token: access,
        refresh_token: refresh,
        expires_in: 3600,
        token_type: "Bearer",
        scope: state.tokenScope,
      });
    }
    if (url.endsWith("/models"))
      return Response.json({
        models: [{ slug: "test-model", visibility: "list" }],
      });
    if (url.endsWith("/responses")) {
      const result = state.failure
        ? {
            type: "response.failed",
            response: { error: { code: state.failure } },
          }
        : {
            type: "response.completed",
            response: {
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [
                    { type: "output_text", text: JSON.stringify(draft) },
                  ],
                },
              ],
            },
          };
      return new Response(`data: ${JSON.stringify(result)}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    throw new Error("Unexpected synthetic provider request");
  };
  const fallback = {
    draft: async () => {
      state.siteCalls++;
      return draft;
    },
    embed: async () => {
      state.siteCalls++;
      return [];
    },
  };
  const built = createApp(db, config, html, fallback, transport);
  server.on("request", built.app);
  const password = "synthetic-only-drop-it-password";
  const session = await built.auth.setup(password);
  const owner = (await built.auth.sessionOwner(session))!;
  const cookie = `drop_it_session=${session}`;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    cookies = cookie,
    headers: Record<string, string> = {},
  ) =>
    fetch(origin + path, {
      method,
      redirect: "manual",
      headers: {
        Origin: origin,
        Cookie: cookies,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const begin = async (
    link = true,
    plan = true,
    cookies = cookie,
    claims?: Record<string, unknown>,
  ) => {
    const response = await request(
      "/api/chatgpt/start",
      "POST",
      { link, plan, ...(link ? { currentPassword: password } : {}) },
      cookies,
    );
    const result = await response.json();
    if (!response.ok) throw new Error(`Start failed: ${response.status}`);
    const url = new URL(result.url);
    const browserCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("drop_it_chatgpt="))!
      .split(";")[0];
    const code = randomUUID();
    pending.set(code, { nonce: url.searchParams.get("nonce")!, claims });
    return {
      url,
      code,
      browserCookie,
      callback: `/auth/chatgpt/callback?state=${url.searchParams.get("state")}&code=${code}`,
    };
  };
  return {
    ...built,
    db,
    config,
    state,
    calls,
    access,
    password,
    owner,
    session,
    cookie,
    request,
    begin,
    origin,
    chatgpt: new ChatGPT(db, built.auth, config, transport),
    fallback,
    transport,
    close: async () => {
      built.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!database) await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
