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
import { dimensions } from "../server/ai.js";
import { pdfFixture } from "./pdf-fixture.js";
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
    ai: undefined,
  };
  const html = await readFile(
    new URL("../dist/web/index.html", import.meta.url),
    "utf8",
  );
  const built = createApp(db, config, html, {
    draft: async () => ({
      title: "HTTP AI draft",
      summary: "Drafted metadata",
      category: "Gardening",
      tags: ["herbs"],
      extractedText: "",
      sourceUrl: "",
    }),
    embed: async (texts) =>
      texts.map(() =>
        Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0)),
      ),
  });
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
    (await request("/api/draft", "POST", { source: { originalText: "test" } }))
      .status,
    401,
  );
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

test("HTTP AI drafts require same-origin authenticated access and explicit save", async () => {
  assert.equal(
    (
      await request(
        "/api/draft",
        "POST",
        { source: { originalText: "herbs" } },
        { Origin: "https://example.com" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/draft", "POST", { source: {} })).status,
    400,
  );
  const result = await request("/api/draft", "POST", {
    source: { originalText: "herbs", url: "" },
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).draft.title, "HTTP AI draft");
  assert.equal(
    (
      await request("/api/draft", "POST", {
        source: { originalText: "herbs", url: "not-a-url" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await (await request("/api/search", "POST", {})).json()).total,
    0,
  );
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
  const semantic = await request("/api/search", "POST", {
    query: "Find a useful project",
    mode: "semantic",
  });
  assert.equal(semantic.status, 200);
  assert.equal((await semantic.json()).items[0].id, detail.item.id);
  const edit = await request(`/api/items/${detail.item.id}`, "PATCH", {
    revision: 1,
    isSaved: true,
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
    200,
  );
  const trashed = await (await request(`/api/items/${detail.item.id}`)).json();
  assert.ok(trashed.item.trashedAt);
  assert.equal(
    (
      await request(
        `/api/items/${detail.item.id}/restore`,
        "POST",
        { revision: trashed.item.revision },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        `/api/items/${detail.item.id}/restore`,
        "POST",
        { revision: trashed.item.revision },
        { Cookie: "" },
      )
    ).status,
    401,
  );
  const restored = await request(
    `/api/items/${detail.item.id}/restore`,
    "POST",
    { revision: trashed.item.revision },
  );
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).item.isSaved, true);
});

test("HTTP file upload, save and private download support PDFs and JSON without inline execution", async () => {
  for (const [filename, mime, bytes] of [
    ["notes.pdf", "application/pdf", pdfFixture()],
    ["data.json", "application/json", Buffer.from('{"notes":"Grow basil"}')],
  ] as const) {
    const headers = {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": mime,
      "X-File-Name": encodeURIComponent(filename),
    };
    const anonymous = await fetch(`${origin}/api/attachments`, {
      method: "POST",
      headers: { ...headers, Cookie: "" },
      body: bytes,
    });
    assert.equal(anonymous.status, 401);
    const crossOrigin = await fetch(`${origin}/api/attachments`, {
      method: "POST",
      headers: { ...headers, Origin: "https://example.com" },
      body: bytes,
    });
    assert.equal(crossOrigin.status, 403);
    const upload = await fetch(`${origin}/api/attachments`, {
      method: "POST",
      headers,
      body: bytes,
    });
    assert.equal(upload.status, 201);
    const { attachmentId } = await upload.json();
    const saved = await request("/api/items", "POST", {
      requestId: randomUUID(),
      title: filename,
      source: {
        attachmentId,
        url: `https://example.com/basil/${encodeURIComponent(filename)}`,
      },
    });
    assert.equal(saved.status, 201);
    const detail = await saved.json();
    assert.equal(detail.source.filename, filename);
    assert.equal(detail.source.hasImage, false);
    const path = `/api/sources/${detail.source.id}/file`;
    assert.equal(
      (await request(path, "GET", undefined, { Cookie: "" })).status,
      401,
    );
    const download = await request(path);
    assert.equal(download.status, 200);
    assert.match(
      download.headers.get("content-disposition") ?? "",
      /^attachment;/,
    );
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.equal(download.headers.get("content-security-policy"), "sandbox");
    assert.ok(download.headers.get("content-type")?.startsWith(mime));
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal(
      (await request(`/api/sources/${detail.source.id}/image`)).status,
      404,
    );
    assert.equal(
      (await request(`/api/items/${detail.item.id}`, "DELETE", { revision: 1 }))
        .status,
      200,
    );
    assert.equal((await request(path)).status, 200);
  }
  const invalid = await fetch(`${origin}/api/attachments`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/octet-stream",
      "X-File-Name": "bad%ZZ.txt",
    },
    body: "hello",
  });
  assert.equal(invalid.status, 400);
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
  assert.equal(
    (await auth.verifyAccessToken(refreshed.access_token)).extra.owner,
    identity.extra.owner,
  );
  await assert.rejects(
    auth.exchangeRefreshToken(
      oauth,
      tokens.refresh_token,
      undefined,
      new URL(`${origin}/mcp`),
    ),
  );
  // Reuse of a rotated token signals theft and invalidates its successor.
  await assert.rejects(auth.verifyAccessToken(refreshed.access_token));
  const freshGrant = await grant();
  const fresh = await auth.exchangeAuthorizationCode(
    oauth,
    freshGrant.code,
    freshGrant.verifier,
    oauth.redirect_uris[0],
    new URL(`${origin}/mcp`),
  );
  await auth.revokeToken(oauth, { token: fresh.refresh_token! });
  await assert.rejects(auth.verifyAccessToken(fresh.access_token));
});

test("MCP SDK client can discover tools, authenticate, and enforce read-only scopes", async () => {
  const anonymous = new Client({ name: "drop-it-test", version: "1" });
  await anonymous.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)),
  );
  const tools = await anonymous.listTools();
  // ChatGPT rejects Unicode property escapes in published JSON Schema patterns.
  // Runtime category refinements still enforce Unicode character restrictions.
  for (const tool of tools.tools) {
    assert.doesNotMatch(JSON.stringify(tool.inputSchema), /\\\\[pP]\{/);
  }
  assert.ok(tools.tools.some((tool) => tool.name === "save_item"));
  assert.ok(tools.tools.some((tool) => tool.name === "restore_item"));
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
  const restoreDenied = await client.callTool({
    name: "restore_item",
    arguments: { id: randomUUID(), revision: 1 },
  });
  assert.equal(restoreDenied.isError, true);
  const draftDenied = await client.callTool({
    name: "draft_item",
    arguments: { source: { originalText: "Must not call AI" } },
  });
  assert.equal(draftDenied.isError, true);
  const resource = await client.readResource({
    uri: "ui://drop-it/library-v3.html",
  });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.deepEqual(resource.contents[0]._meta?.ui, {
    prefersBorder: true,
    csp: { connectDomains: [], resourceDomains: [] },
  });
  await client.close();
});

test("settings expose only safe owner-scoped configuration and disconnect preserves the library and session", async () => {
  assert.equal(
    (await request("/api/settings", "GET", undefined, { Cookie: "" })).status,
    401,
  );
  const baselineResponse = await request("/api/settings");
  assert.equal(baselineResponse.status, 200);
  assert.equal(baselineResponse.headers.get("cache-control"), "no-store");
  const baseline = await baselineResponse.json();
  assert.deepEqual(Object.keys(baseline).sort(), [
    "aiConfigured",
    "connectedApps",
    "trashRetentionDays",
  ]);
  assert.equal(baseline.aiConfigured, true);
  assert.equal(baseline.trashRetentionDays, 7);
  const owner = (
    await db.query<{ id: string }>("SELECT id FROM users WHERE singleton=true")
  ).rows[0].id;
  const other = randomUUID();
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$2)",
    [other, randomBytes(32).toString("hex")],
  );
  const family = randomUUID(),
    clientId = randomUUID();
  const insert = async (
    ownerId: string,
    client: string,
    kind: string,
    expiry: string,
  ) => {
    await db.query(
      "INSERT INTO oauth_tokens(hash,family,owner,client_id,kind,scopes,resource,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)",
      [
        randomBytes(32).toString("hex"),
        family,
        ownerId,
        client,
        kind,
        ["library:read"],
        `${origin}/mcp`,
        expiry,
      ],
    );
  };
  const future = new Date(Date.now() + 3600000).toISOString(),
    past = new Date(Date.now() - 1000).toISOString();
  await insert(owner, clientId, "access", future);
  await insert(owner, clientId, "refresh", future);
  await insert(owner, randomUUID(), "access", past);
  await insert(other, randomUUID(), "access", future);
  const settings = await (await request("/api/settings")).json();
  assert.equal(settings.connectedApps, baseline.connectedApps + 1);
  assert.equal(
    (
      await request(
        "/api/revoke-connections",
        "POST",
        {},
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/revoke-connections", "POST", {}, { Cookie: "" }))
      .status,
    401,
  );
  const before = await (await request("/api/export")).json();
  assert.equal(
    (await request("/api/revoke-connections", "POST", {})).status,
    200,
  );
  assert.equal(
    (await (await request("/api/settings")).json()).connectedApps,
    0,
  );
  assert.equal(
    (await db.query("SELECT hash FROM oauth_tokens WHERE owner=$1", [other]))
      .rows.length,
    1,
  );
  const after = await (await request("/api/export")).json();
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.sources, before.sources);
  assert.equal(
    (await (await request("/api/session")).json()).authenticated,
    true,
  );
  await db.query("DELETE FROM oauth_tokens WHERE owner=$1", [other]);
  await db.query("DELETE FROM users WHERE id=$1", [other]);
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
