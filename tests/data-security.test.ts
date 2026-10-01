import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase, migrate, type Database } from "../server/db.js";
import { Library } from "../server/library.js";
import { createMcpServer } from "../server/mcp.js";
import { cleanupExpired } from "../server/maintenance.js";
import { AppError } from "../server/errors.js";
import { similarity } from "../server/semantic.js";
import type { Config } from "../server/config.js";
import type { AIProvider } from "../server/ai.js";

let dir: string, db: Database, library: Library;
const owner = randomUUID(),
  other = randomUUID();
const input = (title: string) => ({
  requestId: randomUUID(),
  title,
  source: { originalText: title },
});
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "drop-it-data-security-"));
  db = await openDatabase({ dataDir: dir });
  await migrate(db);
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$3),($2,NULL,$3)",
    [owner, other, randomBytes(32).toString("hex")],
  );
  library = new Library(db);
});
after(async () => {
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("database foreign keys independently reject cross-owner attachments, sources and embeddings", async () => {
  const file = await library.upload(
    owner,
    Buffer.from("Owned text"),
    "text/plain",
    "source.txt",
  );
  const saved = await library.save(owner, {
    ...input("Composite constraints"),
    source: { attachmentId: file.attachmentId },
  });
  const foreignKey = (error: unknown) =>
    (error as { code?: string }).code === "23503";
  await assert.rejects(
    db.query(
      "INSERT INTO sources(id,owner,original_text,url,attachment_id,fingerprint) VALUES($1,$2,'','',$3,'test')",
      [randomUUID(), other, file.attachmentId],
    ),
    foreignKey,
  );
  await assert.rejects(
    db.query(
      "INSERT INTO items(id,owner,source_id,title,summary,category,tags,notes) VALUES($1,$2,$3,'wrong','','Uncategorized','{}','')",
      [randomUUID(), other, saved.source.id],
    ),
    foreignKey,
  );
  await assert.rejects(
    db.query(
      "INSERT INTO item_embeddings(owner,item_id,model,fingerprint,vector) VALUES($1,$2,'test','test',ARRAY[1.0])",
      [other, saved.item.id],
    ),
    foreignKey,
  );
});

test("request IDs, duplicate detection, file downloads and exports remain isolated across owners", async () => {
  const marker = `Private source ${randomUUID()}`;
  const bytes = Buffer.from(marker);
  const file = await library.upload(owner, bytes, "text/plain", "private.txt");
  const request = input("Identical request across owners");
  const owned = await library.save(owner, {
    ...request,
    source: { attachmentId: file.attachmentId },
  });
  const foreign = await library.save(other, request);
  assert.notEqual(owned.item.id, foreign.item.id);
  await assert.rejects(library.file(other, owned.source.id), code("NOT_FOUND"));
  await assert.rejects(
    library.restore(other, { id: owned.item.id, revision: 1 }),
    code("NOT_FOUND"),
  );
  const exported = await library.export(other);
  assert.equal(JSON.stringify(exported).includes(marker), false);
  assert.equal(
    exported.items.some((item) => item.id === owned.item.id),
    false,
  );
  const ownExport = await library.export(owner);
  assert.equal(
    ownExport.sources.find((source) => source.id === owned.source.id)
      ?.fileBase64,
    bytes.toString("base64"),
  );
});

test("SQL metacharacters stay literal in content and search filters", async () => {
  const attack = "' OR TRUE; DROP TABLE items; --";
  const saved = await library.save(owner, {
    ...input(attack),
    tags: [attack],
    notes: "100%_wildcard",
  });
  assert.equal((await library.get(owner, saved.item.id)).item.title, attack);
  const found = await library.search(owner, { query: attack, mode: "keyword" });
  assert.deepEqual(
    found.items.map((item) => item.id),
    [saved.item.id],
  );
  assert.equal(
    (await library.search(other, { query: attack, mode: "keyword" })).total,
    0,
  );
  assert.deepEqual(
    (await library.search(owner, { tag: attack, mode: "keyword" })).items.map(
      (item) => item.id,
    ),
    [saved.item.id],
  );
  assert.deepEqual(
    (await library.search(owner, { query: "%_", mode: "keyword" })).items.map(
      (item) => item.id,
    ),
    [saved.item.id],
  );
});

test("racing edits and deletes have one winner and never lose a successful update", async () => {
  const saved = await library.save(owner, input("Concurrent integrity"));
  const updates = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      library.update(owner, {
        id: saved.item.id,
        revision: 1,
        notes: `Edit ${index}`,
      }),
    ),
  );
  assert.equal(
    updates.filter((result) => result.status === "fulfilled").length,
    1,
  );
  for (const result of updates)
    if (result.status === "rejected")
      assert.ok(code("CONFLICT")(result.reason));
  const winner = updates.find((result) => result.status === "fulfilled");
  assert.equal(
    (await library.get(owner, saved.item.id)).item.notes,
    winner?.value.item.notes,
  );
  const revision = 2;
  const race = await Promise.allSettled([
    library.update(owner, { id: saved.item.id, revision, notes: "Last edit" }),
    library.delete(owner, { id: saved.item.id, revision }),
  ]);
  assert.equal(
    race.filter((result) => result.status === "fulfilled").length,
    1,
  );
  for (const result of race)
    if (result.status === "rejected")
      assert.ok(
        code("CONFLICT")(result.reason) || code("IN_TRASH")(result.reason),
      );
  assert.equal((await library.get(owner, saved.item.id)).item.revision, 3);
});

test("concurrent duplicate saves create one source and expired retries cannot resurrect content", async () => {
  const request = input("Concurrent source uniqueness");
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      library.save(owner, { ...request, requestId: randomUUID() }),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  for (const result of results)
    if (result.status === "rejected")
      assert.ok(code("DUPLICATE")(result.reason));
  const disposableRequest = input("Deleted idempotency tombstone");
  const disposable = await library.save(owner, disposableRequest);
  await library.delete(owner, { id: disposable.item.id, revision: 1 });
  await db.query(
    "UPDATE items SET trashed_at=now()-interval '8 days' WHERE owner=$1 AND id=$2",
    [owner, disposable.item.id],
  );
  await assert.rejects(
    library.get(owner, disposable.item.id),
    code("NOT_FOUND"),
  );
  await assert.rejects(library.save(owner, disposableRequest), code("DELETED"));
  await cleanupExpired(db);
  await assert.rejects(library.save(owner, disposableRequest), code("DELETED"));
  assert.equal(
    (
      await db.query("SELECT id FROM sources WHERE owner=$1 AND id=$2", [
        owner,
        disposable.source.id,
      ])
    ).rows.length,
    0,
  );
});

async function mcpClient(
  scopes: string[],
  connectedOwner: string | undefined = owner,
) {
  const config: Config = {
    port: 4317,
    origin: "http://localhost:4317",
    local: true,
    redirectUris: [],
    dataDir: dir,
    databaseUrl: undefined,
    production: false,
    ai: undefined,
  };
  const server = createMcpServer(
    library,
    config,
    "<html></html>",
    connectedOwner,
    scopes,
  );
  const client = new Client({ name: "data-security-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("write-only MCP tokens cannot retrieve existing content through save, edit, restore or AI draft", async () => {
  const marker = `Scope protected ${randomUUID()}`;
  const file = await library.upload(
    owner,
    Buffer.from(marker),
    "text/plain",
    "scope.txt",
  );
  const saved = await library.save(owner, {
    ...input("Scope boundary"),
    source: { attachmentId: file.attachmentId },
  });
  const { client, close } = await mcpClient(["library:write"]);
  try {
    for (const call of [
      {
        name: "save_drop",
        arguments: {
          requestId: randomUUID(),
          title: "Probe source",
          sourceId: saved.source.id,
        },
      },
      { name: "update_drop", arguments: { id: saved.item.id, revision: 1 } },
      { name: "restore_drop", arguments: { id: saved.item.id, revision: 1 } },
      {
        name: "draft_drop",
        arguments: { source: { attachmentId: file.attachmentId } },
      },
      { name: "get_drop", arguments: { id: saved.item.id } },
      { name: "search_drops", arguments: {} },
      { name: "get_profile", arguments: {} },
    ]) {
      const result = await client.callTool(call);
      assert.equal(JSON.stringify(result).includes(marker), false, call.name);
      assert.equal(result.isError, true, call.name);
      assert.ok(result._meta?.["mcp/www_authenticate"], call.name);
    }
    const tools = await client.listTools();
    for (const name of [
      "save_drop",
      "update_drop",
      "restore_drop",
      "draft_drop",
    ]) {
      const meta = tools.tools.find((tool) => tool.name === name)?._meta;
      assert.deepEqual(meta?.securitySchemes, [
        { type: "oauth2", scopes: ["library:read", "library:write"] },
      ]);
    }
    assert.equal((await library.get(owner, saved.item.id)).item.revision, 1);
  } finally {
    await close();
  }
  const full = await mcpClient(["library:read", "library:write"]);
  try {
    const result = await full.client.callTool({
      name: "update_drop",
      arguments: { id: saved.item.id, revision: 1, notes: "Authorized update" },
    });
    assert.notEqual(result.isError, true);
    assert.equal(JSON.stringify(result).includes(marker), true);
  } finally {
    await full.close();
  }
});

test("read-only MCP tokens reject all writes and cross-owner reads do not disclose source files", async () => {
  const saved = await library.save(owner, input("Scope matrix target"));
  const readonly = await mcpClient(["library:read"]);
  try {
    for (const call of [
      { name: "save_drop", arguments: input("Denied save") },
      { name: "update_drop", arguments: { id: saved.item.id, revision: 1 } },
      { name: "wipe_drop", arguments: { id: saved.item.id, revision: 1 } },
      { name: "restore_drop", arguments: { id: saved.item.id, revision: 1 } },
      {
        name: "draft_drop",
        arguments: { source: { originalText: "Denied AI" } },
      },
      {
        name: "upload_source",
        arguments: {
          file: {
            download_url: "https://files.oaiusercontent.com/test",
            file_id: "test",
            filename: "test.txt",
            mime_type: "text/plain",
          },
        },
      },
    ])
      assert.equal(
        (await readonly.client.callTool(call)).isError,
        true,
        call.name,
      );
  } finally {
    await readonly.close();
  }
  const foreign = await mcpClient(["library:read", "library:write"], other);
  try {
    const result = await foreign.client.callTool({
      name: "get_drop",
      arguments: { id: saved.item.id },
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes(saved.item.title), false);
  } finally {
    await foreign.close();
  }
});

test("the AI concurrency gate rejects before loading attachment bytes or semantic source documents", async () => {
  await library.save(owner, input("Bounded semantic search"));
  const file = await library.upload(
    owner,
    await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer(),
    "image/png",
    "draft.png",
  );
  let attachmentReads = 0;
  let documentReads = 0;
  const observed: Database = {
    ...db,
    query: async (sql, params) => {
      if (
        sql.includes(
          "SELECT bytes,mime,filename,original_text FROM attachments",
        )
      )
        attachmentReads++;
      if (sql.includes('s.original_text AS "originalText"')) documentReads++;
      return db.query(sql, params);
    },
  };
  let started!: () => void, release!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ai: AIProvider = {
    draft: async () => {
      started();
      await resume;
      return {
        title: "Draft",
        summary: "",
        category: "Test",
        tags: [],
        extractedText: "",
        sourceUrl: "",
      };
    },
    embed: async () => [],
  };
  const guarded = new Library(observed, ai);
  const pending = guarded.draft(owner, {
    source: { originalText: "Synthetic draft" },
  });
  await active;
  try {
    await assert.rejects(
      guarded.draft(owner, { source: { attachmentId: file.attachmentId } }),
      code("AI_BUSY"),
    );
    assert.equal(attachmentReads, 0);
    await assert.rejects(
      guarded.search(owner, { query: "Bounded", mode: "semantic" }),
      code("AI_BUSY"),
    );
    assert.equal(documentReads, 0);
    const fallback = await guarded.search(owner, {
      query: "Bounded",
      mode: "hybrid",
    });
    assert.equal(fallback.mode, "keyword");
    assert.equal(fallback.total, 1);
    assert.equal(documentReads, 0);
  } finally {
    release();
    await pending;
  }
});

test("cosine ranking stays finite for extreme finite provider vector magnitudes", () => {
  for (const magnitude of [1e308, 1e-308, 1, Number.MIN_VALUE]) {
    assert.ok(
      Math.abs(
        similarity([magnitude, magnitude, 0], [magnitude, 0, magnitude]) - 0.5,
      ) < 1e-12,
    );
    assert.ok(
      Math.abs(
        similarity([magnitude, magnitude], [-magnitude, -magnitude]) + 1,
      ) < 1e-12,
    );
  }
  assert.equal(similarity([0, 0], [1, 1]), 0);
});

test("export rejects shared-file amplification before loading file bodies and does not affect other owners", async () => {
  const exportOwner = randomUUID();
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$2)",
    [exportOwner, randomBytes(32).toString("hex")],
  );
  const bytes = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: "#123456" },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  const file = await library.upload(
    exportOwner,
    bytes,
    "image/png",
    "export.png",
  );
  for (let i = 0; i < 97; i++) {
    await library.save(exportOwner, {
      requestId: randomUUID(),
      title: `Shared file reference ${i}`,
      source: { attachmentId: file.attachmentId },
      allowDuplicate: true,
    });
  }
  let bodiesRead = false;
  const guarded: Database = {
    ...db,
    transaction: (run) =>
      db.transaction((tx) =>
        run({
          query: async (sql, params) => {
            if (sql.includes("a.filename,a.mime,a.bytes")) {
              bodiesRead = true;
              // Fail before actually allocating the amplified payload, including
              // when this regression test runs against the vulnerable version.
              throw new Error("Export tried to load an oversized payload.");
            }
            return tx.query(sql, params);
          },
        }),
      ),
  };
  await assert.rejects(
    new Library(guarded).export(exportOwner),
    code("EXPORT_SIZE"),
  );
  assert.equal(bodiesRead, false);
  assert.ok((await library.export(other)).items.length > 0);
  assert.equal((await library.search(exportOwner, {})).total, 97);
});
