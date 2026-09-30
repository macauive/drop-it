import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDatabase, migrate, type Database } from "../server/db.js";
import { createApp } from "../server/app.js";
import type { Config } from "../server/config.js";
import type { Auth } from "../server/auth.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

let server: Server,
  db: Database,
  dir: string,
  origin: string,
  cookie: string,
  auth: Auth,
  oauth: OAuthClientInformationFull;
const password = randomBytes(24).toString("base64url");
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`${origin}${path}`, {
    method,
    redirect: "manual",
    headers: {
      Origin: origin,
      Cookie: cookie ?? "",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "drop-it-http-"));
  db = await openDatabase({ dataDir: dir });
  await migrate(db);
  server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  const config: Config = {
    port,
    origin,
    local: true,
    redirectUris: [`${origin}/oauth-callback`],
    dataDir: dir,
    databaseUrl: undefined,
    production: false,
  };
  const html = await readFile(
    new URL("../dist/web/index.html", import.meta.url),
    "utf8",
  );
  const built = createApp(db, config, html);
  auth = built.auth;
  server.on("request", built.app);
});
after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});

test("serves a built UI with CSP, requires login, and rejects cross-origin setup", async () => {
  const ui = await request("/");
  assert.equal(ui.status, 200);
  assert.match(ui.headers.get("content-security-policy") ?? "", /sha256-/);
  assert.match(await ui.text(), /<title>Drop It<\/title>/);
  assert.equal((await request("/api/search", "POST", {})).status, 401);
  assert.equal(
    (
      await request(
        "/api/setup",
        "POST",
        { password },
        { Origin: "https://example.com" },
      )
    ).status,
    403,
  );
  const setup = await request("/api/setup", "POST", { password });
  assert.equal(setup.status, 200);
  const setCookie = setup.headers.get("set-cookie")!;
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  cookie = setCookie.split(";")[0];
  assert.equal((await request("/api/setup", "POST", { password })).status, 409);
});

test("real HTTP capture/upload/search/edit/export/delete flow preserves original screenshot", async () => {
  const bytes = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#286a53" },
  })
    .png()
    .toBuffer();
  const upload = await fetch(`${origin}/api/attachments`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "image/png" },
    body: bytes,
  });
  assert.equal(upload.status, 201);
  const { attachmentId } = await upload.json();
  const input = {
    requestId: randomUUID(),
    title: "HTTP capture",
    category: "Cloud Infrastructure",
    tags: ["database"],
    source: { attachmentId, originalText: "Original HTTP source" },
  };
  const save = await request("/api/items", "POST", input);
  assert.equal(save.status, 201);
  const detail = await save.json();
  const retry = await request("/api/items", "POST", input);
  assert.equal((await retry.json()).item.id, detail.item.id);
  const search = await request("/api/search", "POST", {
    query: "HTTP database",
    category: "cloud infrastructure",
  });
  const found = await search.json();
  assert.equal(found.total, 1);
  assert.deepEqual(found.categories, ["Cloud Infrastructure"]);
  const edit = await request(`/api/items/${detail.item.id}`, "PATCH", {
    revision: 1,
    status: "Done",
    notes: "Tried it",
    category: "Software Projects",
  });
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).item.category, "Software Projects");
  const image = await request(`/api/sources/${detail.source.id}/image`);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  const exported = await request("/api/export");
  assert.match(exported.headers.get("content-disposition") ?? "", /attachment/);
  assert.ok((await exported.json()).sources[0].imageBase64);
  assert.equal(
    (await request(`/api/items/${detail.item.id}`, "DELETE", { revision: 2 }))
      .status,
    200,
  );
  assert.equal(
    (await request(`/api/sources/${detail.source.id}/image`)).status,
    404,
  );
});

test("OAuth discovery and registration enforce resource metadata and redirect allowlist", async () => {
  const metadata = await request("/.well-known/oauth-protected-resource/mcp");
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).resource, `${origin}/mcp`);
  const bad = await request("/register", "POST", {
    redirect_uris: ["https://example.com/steal"],
    token_endpoint_auth_method: "none",
  });
  assert.equal(bad.status, 400);
  const registration = await request("/register", "POST", {
    redirect_uris: [`${origin}/oauth-callback`],
    token_endpoint_auth_method: "none",
    client_name: "Drop It test client",
  });
  assert.equal(registration.status, 201);
  oauth = await registration.json();
});

async function grant(scopes = ["library:read", "library:write"]) {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: oauth.client_id,
    redirect_uri: oauth.redirect_uris[0],
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope: scopes.join(" "),
    resource: `${origin}/mcp`,
    state: "roundtrip",
  });
  const authorization = await request(`/authorize?${query}`);
  assert.equal(authorization.status, 302);
  const pending = new URL(
    authorization.headers.get("location")!,
  ).searchParams.get("authorize");
  assert.ok(pending);
  const preview = await request(`/api/authorize/${pending}`);
  assert.equal(preview.status, 200);
  const approval = await request(`/api/authorize/${pending}`, "POST", {
    approved: true,
  });
  assert.equal(approval.status, 200);
  const redirect = new URL((await approval.json()).redirect);
  assert.equal(redirect.searchParams.get("state"), "roundtrip");
  return { code: redirect.searchParams.get("code")!, verifier };
}

test("OAuth code flow checks PKCE/resource, prevents replay, rotates and revokes tokens", async () => {
  const { code, verifier } = await grant();
  await assert.rejects(
    auth.exchangeAuthorizationCode(
      oauth,
      code,
      "wrong",
      oauth.redirect_uris[0],
      new URL(`${origin}/mcp`),
    ),
  );
  await assert.rejects(
    auth.exchangeAuthorizationCode(
      oauth,
      code,
      verifier,
      oauth.redirect_uris[0],
      new URL("https://example.com/mcp"),
    ),
  );
  const tokenResponse = await fetch(`${origin}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: oauth.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: oauth.redirect_uris[0],
      resource: `${origin}/mcp`,
    }),
  });
  const tokens = await tokenResponse.json();
  assert.equal(
    tokenResponse.status,
    200,
    tokenResponse.ok ? "" : JSON.stringify(tokens),
  );
  const identity = await auth.verifyAccessToken(tokens.access_token);
  assert.ok(identity.extra.owner);
  await assert.rejects(
    auth.exchangeAuthorizationCode(
      oauth,
      code,
      verifier,
      oauth.redirect_uris[0],
      new URL(`${origin}/mcp`),
    ),
  );
  const refreshed = await auth.exchangeRefreshToken(
    oauth,
    tokens.refresh_token,
    undefined,
    new URL(`${origin}/mcp`),
  );
  await assert.rejects(auth.verifyAccessToken(tokens.access_token));
  await assert.rejects(
    auth.exchangeRefreshToken(
      oauth,
      tokens.refresh_token,
      undefined,
      new URL(`${origin}/mcp`),
    ),
  );
  assert.equal(
    (await auth.verifyAccessToken(refreshed.access_token)).extra.owner,
    identity.extra.owner,
  );
  await auth.revokeToken(oauth, { token: refreshed.refresh_token! });
  await assert.rejects(auth.verifyAccessToken(refreshed.access_token));
});

test("MCP SDK client can discover tools, authenticate, and enforce read-only scopes", async () => {
  const anonymous = new Client({ name: "drop-it-test", version: "1" });
  await anonymous.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)),
  );
  const tools = await anonymous.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "save_item"));
  const denied = await anonymous.callTool({
    name: "search_items",
    arguments: {},
  });
  assert.equal(denied.isError, true);
  assert.ok(denied._meta?.["mcp/www_authenticate"]);
  await anonymous.close();
  const { code, verifier } = await grant(["library:read"]);
  const tokens = await auth.exchangeAuthorizationCode(
    oauth,
    code,
    verifier,
    oauth.redirect_uris[0],
    new URL(`${origin}/mcp`),
  );
  const client = new Client({ name: "drop-it-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      },
    }),
  );
  const search = await client.callTool({ name: "search_items", arguments: {} });
  assert.notEqual(search.isError, true);
  const write = await client.callTool({
    name: "save_item",
    arguments: {
      requestId: randomUUID(),
      title: "Must not save",
      source: { originalText: "Read-only check" },
    },
  });
  assert.equal(write.isError, true);
  const resource = await client.readResource({
    uri: "ui://drop-it/library-v1.html",
  });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  await client.close();
});

test("session logout invalidates browser access and origin checks protect changes", async () => {
  assert.equal(
    (await request("/api/items", "POST", {}, { Origin: "https://example.com" }))
      .status,
    403,
  );
  assert.equal((await request("/api/logout", "POST", {})).status, 200);
  assert.equal((await request("/api/export")).status, 401);
  const login = await request("/api/login", "POST", { password });
  assert.equal(login.status, 200);
});
