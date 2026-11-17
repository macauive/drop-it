import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, migrate, type Database } from "../server/db.js";
import { createApp } from "../server/app.js";
import { onboardingSchema } from "../shared/onboarding.js";

const extensionRedirect =
  "https://aiaflcebjdegligolapfpgdplbofplbo.chromiumapp.org/drop-it";
const chatgptRedirect =
  "https://chatgpt.com/connector/oauth/synthetic-onboarding";
let db: Database,
  dir: string,
  server: Server,
  origin: string,
  built: ReturnType<typeof createApp>;
let owners: string[], cookies: string[];
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "drop-it-onboarding-"));
  db = await openDatabase({ dataDir: dir });
  await migrate(db);
  server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  built = createApp(
    db,
    {
      port,
      origin,
      dataDir: dir,
      local: true,
      production: false,
      databaseUrl: undefined,
      ai: undefined,
      redirectUris: [extensionRedirect, chatgptRedirect],
    },
    "<!doctype html><title>Synthetic onboarding</title>",
  );
  server.on("request", built.app);
});
beforeEach(async () => {
  owners = [randomUUID(), randomUUID()];
  cookies = [];
  for (const owner of owners) {
    await db.query(
      "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,'synthetic-unusable-hash')",
      [owner],
    );
    cookies.push(`drop_it_session=${await built.auth.session(owner)}`);
  }
});
after(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await built?.close();
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  owner: number | null = 0,
  requestOrigin = origin,
) =>
  fetch(origin + path, {
    method,
    redirect: "manual",
    headers: {
      Origin: requestOrigin,
      ...(owner === null ? {} : { Cookie: cookies[owner] }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const status = async (owner = 0) =>
  onboardingSchema.parse(
    await (await request("/api/onboarding", "GET", undefined, owner)).json(),
  );
const act = (action: string, owner = 0) =>
  request("/api/onboarding", "PATCH", { action }, owner);
const save = (owner = 0, title = "Orchid care <script>literal</script>") =>
  built.library.save(owners[owner], {
    requestId: randomUUID(),
    title,
    tags: [],
    source: { originalText: "Water orchids on Saturday." },
  });
async function grant(
  owner: number,
  redirect: string,
  scopes: string[],
  kind = "refresh",
  expired = false,
) {
  const id = randomUUID(),
    hash = randomUUID();
  await db.query("INSERT INTO oauth_clients(id,data) VALUES($1,$2)", [
    id,
    JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirect] }),
  ]);
  await db.query(
    `INSERT INTO oauth_tokens(hash,family,owner,client_id,kind,scopes,resource,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+($8::int*interval '1 hour'))`,
    [
      hash,
      randomUUID(),
      owners[owner],
      id,
      kind,
      scopes,
      `${origin}/mcp`,
      expired ? -1 : 1,
    ],
  );
  return hash;
}

test("new accounts see setup; authentication, strict fields and origin protect progress", async () => {
  assert.equal(
    (await request("/api/onboarding", "GET", undefined, null)).status,
    401,
  );
  assert.equal(
    (await request("/api/onboarding/extension", "GET", undefined, null)).status,
    401,
  );
  assert.equal(
    (
      await request(
        "/api/onboarding",
        "PATCH",
        { action: "dismiss" },
        0,
        "https://other.example.test",
      )
    ).status,
    403,
  );
  for (const body of [
    { found: true },
    { action: "dismiss", owner: owners[1] },
    { action: "completed" },
    { action: "use-website", connections: { chatgpt: true } },
  ])
    assert.equal((await request("/api/onboarding", "PATCH", body)).status, 400);
  assert.deepEqual(await status(), {
    dismissed: false,
    found: false,
    websiteOnly: false,
    firstDrop: null,
    connections: { extension: false, chatgpt: false },
    extensionAvailable: false,
    chatgptAvailable: true,
  });
  assert.equal((await request("/api/onboarding/extension")).status, 404);
});

test("dismiss, reopen and website choice persist and stay scoped to the signed-in owner", async () => {
  await act("use-website");
  await act("dismiss");
  assert.equal((await status()).dismissed, true);
  assert.equal((await status()).websiteOnly, true);
  assert.equal((await status(1)).dismissed, false);
  assert.equal((await status(1)).websiteOnly, false);
  await act("reopen");
  assert.equal((await status()).dismissed, false);
  await act("choose-connection");
  assert.equal((await status()).websiteOnly, false);
  assert.deepEqual((await status()).connections, {
    extension: false,
    chatgpt: false,
  });
});

test("first drop is real owned content, supports full titles, and excludes Trash", async () => {
  const first = await save(1, "Other owner's synthetic drop");
  assert.equal((await status()).firstDrop, null);
  const owned = await save(0, "x".repeat(200));
  assert.deepEqual((await status()).firstDrop, {
    id: owned.item.id,
    title: "x".repeat(200),
  });
  assert.equal((await status(1)).firstDrop?.id, first.item.id);
  await db.query(
    "UPDATE items SET trashed_at=clock_timestamp() WHERE owner=$1",
    [owners[0]],
  );
  assert.equal((await status()).firstDrop, null);
});

test("only a successful nonempty search for active owned drops completes retrieval", async () => {
  await save(1, "Other secret nebula");
  await request("/api/search", "POST", { query: "nebula", mode: "keyword" });
  assert.equal((await status()).found, false);
  await save();
  await request("/api/search", "POST", { query: "", mode: "keyword" });
  assert.equal((await status()).found, false);
  await request("/api/search", "POST", { query: "absent", mode: "keyword" });
  assert.equal((await status()).found, false);
  await db.query(
    "UPDATE items SET trashed_at=clock_timestamp() WHERE owner=$1",
    [owners[0]],
  );
  await request("/api/search", "POST", {
    query: "orchids",
    view: "Trash",
    mode: "keyword",
  });
  assert.equal((await status()).found, false);
  await db.query("UPDATE items SET trashed_at=NULL WHERE owner=$1", [
    owners[0],
  ]);
  const response = await request("/api/search", "POST", {
    query: "orchids",
    mode: "keyword",
  });
  assert.equal(response.status, 200);
  assert.equal((await status()).found, true);
  assert.equal((await status(1)).found, false);
  await act("dismiss");
  await act("reopen");
  assert.equal((await status()).found, true);
});

test("connection progress requires current owner grants, approved redirects and suitable scopes", async () => {
  await grant(1, chatgptRedirect, ["library:read"]);
  await grant(0, chatgptRedirect, ["library:read"], "refresh_used");
  await grant(0, chatgptRedirect, ["library:read"], "access", true);
  await grant(0, "https://example.test/callback", ["library:read"]);
  await grant(0, extensionRedirect, ["library:read"]);
  await grant(0, chatgptRedirect, ["capture:write"]);
  assert.deepEqual((await status()).connections, {
    extension: false,
    chatgpt: false,
  });
  assert.equal((await status(1)).connections.chatgpt, true);
  const extension = await grant(0, extensionRedirect, ["capture:write"]);
  const chatgpt = await grant(0, chatgptRedirect, ["library:read"]);
  assert.deepEqual((await status()).connections, {
    extension: true,
    chatgpt: true,
  });
  await db.query("DELETE FROM oauth_tokens WHERE hash=ANY($1::text[])", [
    [extension, chatgpt],
  ]);
  assert.deepEqual((await status()).connections, {
    extension: false,
    chatgpt: false,
  });
});

test("migration keeps existing users quiet, defaults new accounts to setup, and is repeatable", async () => {
  const legacyDir = await mkdtemp(
    join(tmpdir(), "drop-it-onboarding-upgrade-"),
  );
  const legacy = await openDatabase({ dataDir: legacyDir });
  try {
    await migrate(legacy);
    const owner = randomUUID();
    await legacy.query(
      "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,'synthetic-unusable-hash')",
      [owner],
    );
    await legacy.query(
      "ALTER TABLE users DROP COLUMN onboarding_dismissed,DROP COLUMN onboarding_found,DROP COLUMN onboarding_website_only",
    );
    await legacy.query("DELETE FROM schema_migrations WHERE version=16");
    await migrate(legacy);
    await migrate(legacy);
    assert.equal(
      (
        await legacy.query<{ onboarding_dismissed: boolean }>(
          "SELECT onboarding_dismissed FROM users WHERE id=$1",
          [owner],
        )
      ).rows[0].onboarding_dismissed,
      true,
    );
  } finally {
    await legacy.close();
    await rm(legacyDir, { recursive: true, force: true });
  }
});
