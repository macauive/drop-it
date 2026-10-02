import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../server/app.js";
import { migrate, type Database } from "../server/db.js";
import type { Config } from "../server/config.js";
import { dimensions } from "../server/ai.js";
import sharp from "sharp";

let db: Database,
  server: Server,
  origin: string,
  built: ReturnType<typeof createApp>;
const owners = [randomUUID(), randomUUID()];
const cookies: string[] = [];
let aiCalls = 0;
const html =
  '<!doctype html><html lang="en"><title>Synthetic launch test</title><div id="root"></div><script>document.title="Synthetic launch test"</script></html>';
before(async () => {
  const raw = new PGlite();
  await raw.waitReady;
  db = {
    query: (sql, params) => raw.query(sql, params),
    transaction: (run) => raw.transaction(run),
    close: () => raw.close(),
  };
  await migrate(db);
  await db.query(
    "INSERT INTO users(id,singleton,password_hash,username) VALUES($1,NULL,'synthetic-unusable-hash','audit-http-a'),($2,NULL,'synthetic-unusable-hash','audit-http-b')",
    owners,
  );
  server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  const config: Config = {
    port,
    origin,
    local: true,
    production: false,
    publicAccounts: true,
    signupEnabled: false,
    redirectUris: [],
    dataDir: "unused",
    databaseUrl: undefined,
    ai: undefined,
  };
  built = createApp(db, config, html, {
    draft: async () => {
      aiCalls++;
      return {
        title: "Synthetic",
        summary: "",
        category: "Audit",
        tags: [],
        extractedText: "",
        sourceUrl: "",
      };
    },
    embed: async (texts) => {
      aiCalls++;
      return texts.map(() =>
        Array.from({ length: dimensions }, (_, i) => Number(i === 0)),
      );
    },
  });
  server.on("request", built.app);
  for (const owner of owners)
    cookies.push(`drop_it_session=${await built.auth.session(owner)}`);
});
after(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await built?.close();
  await db?.close();
});
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  owner: number | null = 0,
  headers: Record<string, string> = {},
) =>
  fetch(origin + path, {
    method,
    redirect: "manual",
    headers: {
      Origin: origin,
      ...(owner === null ? {} : { Cookie: cookies[owner] }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("HTTP preferences default to opt-out, enforce auth/origin/strict fields and isolate accounts", async () => {
  const settings = await (await request("/api/settings")).json();
  assert.equal(settings.aiSearchEnabled, false);
  assert.equal(settings.storage.attachmentBytes, 0);
  const saved = await request("/api/items", "POST", {
    requestId: randomUUID(),
    title: "A needle",
    source: { originalText: "Synthetic needle" },
  });
  assert.equal(saved.status, 201);
  const count = aiCalls;
  const keyword = await (
    await request("/api/search", "POST", { query: "needle", mode: "semantic" })
  ).json();
  assert.equal(keyword.mode, "keyword");
  assert.equal(keyword.aiSearchEnabled, false);
  assert.equal(aiCalls, count);
  assert.equal(
    (
      await request(
        "/api/preferences",
        "PATCH",
        { aiSearchEnabled: true },
        null,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/preferences", "PATCH", { aiSearchEnabled: true }, 0, {
        Origin: "https://other.example.test",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/preferences", "PATCH", {
        aiSearchEnabled: true,
        owner: owners[1],
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/api/preferences", "PATCH", { aiSearchEnabled: true }))
      .status,
    200,
  );
  assert.equal(
    (await (await request("/api/settings", "GET", undefined, 1)).json())
      .aiSearchEnabled,
    false,
  );
  const enabled = await (
    await request("/api/search", "POST", { query: "needle" })
  ).json();
  assert.equal(enabled.mode, "hybrid");
  assert.ok(aiCalls > count);
  assert.equal(enabled.items[0].matchType, "both");
  assert.equal(typeof enabled.items[0].matchSnippet, "string");
  assert.ok(!("matchText" in enabled.items[0]));
  assert.equal(
    (await request("/api/preferences", "PATCH", { aiSearchEnabled: false }))
      .status,
    200,
  );
});

test("HTTP storage and discard stay owner-scoped and retain referenced originals", async () => {
  const file = await built.library.upload(
    owners[0],
    Buffer.from("123456"),
    "text/plain",
    "six.txt",
  );
  assert.equal(
    (await (await request("/api/settings")).json()).storage.abandonedBytes,
    6,
  );
  assert.equal(
    (await (await request("/api/settings", "GET", undefined, 1)).json()).storage
      .attachmentBytes,
    0,
  );
  assert.equal(
    (
      await request(
        `/api/attachments/${file.attachmentId}`,
        "DELETE",
        undefined,
        null,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request(
        `/api/attachments/${file.attachmentId}`,
        "DELETE",
        undefined,
        0,
        { Origin: "https://other.example.test" },
      )
    ).status,
    403,
  );
  assert.deepEqual(
    await (
      await request(
        `/api/attachments/${file.attachmentId}`,
        "DELETE",
        undefined,
        1,
      )
    ).json(),
    { discarded: false },
  );
  const saved = await built.library.save(owners[0], {
    requestId: randomUUID(),
    title: "Referenced original",
    source: { attachmentId: file.attachmentId },
  });
  assert.deepEqual(
    await (
      await request(`/api/attachments/${file.attachmentId}`, "DELETE")
    ).json(),
    { discarded: false },
  );
  assert.equal(
    (await built.library.file(owners[0], saved.source.id)).bytes.toString(),
    "123456",
  );
  const abandoned = await built.library.upload(
    owners[0],
    Buffer.from("abc"),
    "text/plain",
    "three.txt",
  );
  assert.deepEqual(
    await (
      await request(`/api/attachments/${abandoned.attachmentId}`, "DELETE")
    ).json(),
    { discarded: true },
  );
  assert.equal(
    (await (await request("/api/settings")).json()).storage.attachmentBytes,
    6,
  );
  assert.equal(
    (await request("/api/attachments/not-a-uuid", "DELETE")).status,
    400,
  );
  assert.equal(
    (await request("/api/portability/preview", "POST", {}, null)).status,
    401,
  );
  assert.equal(
    (
      await request("/api/portability/apply", "POST", {}, 0, {
        Origin: "https://other.example.test",
      })
    ).status,
    403,
  );
});

test("share target accepts only bounded text/link drafts, escapes markup, and never saves or invokes AI", async () => {
  const count = aiCalls;
  const before = await db.query<{ count: string }>(
    "SELECT count(*) FROM items",
  );
  const sharedText =
    '</template><script>window.syntheticAttack=true</script>& quoted "text"';
  const response = await fetch(origin + "/share", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://share-source.example.test",
    },
    body: new URLSearchParams({
      title: "Synthetic share",
      text: sharedText,
      url: "https://example.com/article#section",
    }),
  });
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.ok(page.includes('<template id="shared-drop">'));
  assert.ok(page.includes("&lt;/template&gt;&lt;script&gt;"));
  assert.ok(!page.includes("<script>window.syntheticAttack"));
  assert.ok(page.includes("https://example.com/article#section"));
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /script-src 'self' 'sha256-/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  for (const body of [
    new URLSearchParams({ url: "javascript:alert(1)" }),
    new URLSearchParams({ text: "x".repeat(50001) }),
    new URLSearchParams({ title: "Synthetic", owner: owners[0] }),
  ]) {
    assert.equal(
      (
        await fetch(origin + "/share", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        })
      ).status,
      400,
    );
  }
  assert.equal(aiCalls, count);
  assert.equal(
    (await db.query<{ count: string }>("SELECT count(*) FROM items")).rows[0]
      .count,
    before.rows[0].count,
  );
});

test("manifest and service worker support install/share without offline private-content caching", async () => {
  const response = await request(
    "/manifest.webmanifest",
    "GET",
    undefined,
    null,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const manifest = await response.json();
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.share_target.action, "/share");
  assert.equal(manifest.share_target.method, "POST");
  for (const size of [192, 512]) {
    const path = `/app-icon-${size}.png`;
    assert.ok(
      manifest.icons.some(
        (icon: { src: string; sizes: string; type: string }) =>
          icon.src === path &&
          icon.sizes === `${size}x${size}` &&
          icon.type === "image/png",
      ),
    );
    const icon = await request(path, "GET", undefined, null);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");
    assert.equal(icon.headers.get("cache-control"), "no-store");
    const bytes = Buffer.from(await icon.arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
    const repeated = await request(path + "?size=9000", "GET", undefined, null);
    assert.deepEqual(Buffer.from(await repeated.arrayBuffer()), bytes);
  }
  assert.equal(
    (await request("/app-icon-9000.png", "GET", undefined, null)).status,
    404,
  );
  const worker = await request("/sw.js", "GET", undefined, null);
  assert.equal(worker.status, 200);
  assert.equal(worker.headers.get("cache-control"), "no-store");
  const source = await worker.text();
  assert.ok(!/caches\b|indexedDB|respondWith|fetch\s*\(/.test(source));
});

test("readiness returns bounded failure for a stalled database and recovers on the next probe", async () => {
  const realQuery = db.query;
  db.query = async <T>(sql: string, params?: unknown[]) =>
    sql === "SELECT 1"
      ? new Promise<{ rows: T[] }>(() => {})
      : realQuery<T>(sql, params);
  try {
    const started = Date.now();
    const response = await request("/ready", "GET", undefined, null);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false });
    assert.ok(Date.now() - started < 6000);
  } finally {
    db.query = realQuery;
  }
  assert.deepEqual(
    await (await request("/ready", "GET", undefined, null)).json(),
    { ok: true },
  );
});
