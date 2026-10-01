import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openDatabase, migrate, type Database } from "../server/db.js";
import { Library } from "../server/library.js";
import { cleanupExpired } from "../server/maintenance.js";
import { AppError } from "../server/errors.js";
import { importChatGPTFile } from "../server/files.js";

let dir: string, db: Database, library: Library;
const owner = randomUUID(),
  other = randomUUID();
const save = (title: string, extra: Record<string, unknown> = {}) => ({
  requestId: randomUUID(),
  title,
  source: { originalText: `Source for ${title}` },
  ...extra,
});
const isError = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "drop-it-test-"));
  db = await openDatabase({ dataDir: dir });
  await migrate(db);
  library = new Library(db);
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$3),($2,NULL,$3)",
    [owner, other, randomBytes(32).toString("hex")],
  );
});
after(async () => {
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});

test("persists source text separately from mutable summaries and supports search filters", async () => {
  const saved = await library.save(
    owner,
    save("Database weekend", {
      category: "Build",
      tags: ["Postgres", "postgres"],
      source: { originalText: "Build a database project with migrations" },
    }),
  );
  assert.deepEqual(saved.item.tags, ["postgres"]);
  await library.update(owner, {
    id: saved.item.id,
    revision: 1,
    summary: "A revised description",
    isSaved: true,
  });
  const reread = await library.get(owner, saved.item.id);
  assert.equal(
    reread.source.originalText,
    "Build a database project with migrations",
  );
  assert.equal(reread.item.summary, "A revised description");
  const found = await library.search(owner, {
    query: "database migrations",
    category: "Build",
    view: "Saved",
  });
  assert.equal(found.total, 1);
  assert.equal(found.items[0].id, saved.item.id);
  assert.equal((await library.search(owner, { query: "%" })).total, 0);
});

test("owner isolation covers reads, search, changes, source reuse, images and export", async () => {
  const pixels = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#286a53" },
  })
    .png()
    .toBuffer();
  const image = await library.upload(owner, pixels, "image/png");
  const saved = await library.save(
    owner,
    save("Private test source", {
      source: {
        originalText: "Ownership test",
        attachmentId: image.attachmentId,
      },
    }),
  );
  await assert.rejects(library.get(other, saved.item.id), isError("NOT_FOUND"));
  await assert.rejects(
    library.update(other, { id: saved.item.id, revision: 1, title: "Changed" }),
    isError("NOT_FOUND"),
  );
  await assert.rejects(
    library.delete(other, { id: saved.item.id, revision: 1 }),
    isError("NOT_FOUND"),
  );
  await assert.rejects(
    library.image(other, saved.source.id),
    isError("NOT_FOUND"),
  );
  await assert.rejects(
    library.save(other, {
      requestId: randomUUID(),
      title: "Wrong owner",
      sourceId: saved.source.id,
    }),
    isError("NOT_FOUND"),
  );
  await assert.rejects(
    library.save(
      other,
      save("Wrong attachment", {
        source: { attachmentId: image.attachmentId },
      }),
    ),
    isError("NOT_FOUND"),
  );
  assert.equal((await library.search(other, {})).total, 0);
  const exported = await library.export(other);
  assert.equal(exported.items.length, 0);
  assert.equal(exported.sources.length, 0);
});

test("concurrent retries save once; changed retry payloads are rejected", async () => {
  const input = save("Retry test");
  const [a, b] = await Promise.all([
    library.save(owner, input),
    library.save(owner, input),
  ]);
  assert.equal(a.item.id, b.item.id);
  assert.notEqual(a.replayed, b.replayed);
  assert.equal((await library.search(owner, { query: "Retry test" })).total, 1);
  await assert.rejects(
    library.save(owner, { ...input, title: "Different content" }),
    isError("REQUEST_REUSED"),
  );
  await library.delete(owner, { id: a.item.id, revision: 1 });
  await assert.rejects(library.save(owner, input), isError("IN_TRASH"));
});

test("duplicate sources need an explicit choice and canonical URLs match", async () => {
  const input = save("Duplicate test", {
    source: { url: "https://example.com/idea#first", originalText: "First" },
  });
  await library.save(owner, input);
  const copy = save("Duplicate test 2", {
    source: { url: "https://example.com/idea#second", originalText: "Second" },
  });
  await assert.rejects(library.save(owner, copy), isError("DUPLICATE"));
  assert.ok(
    (await library.save(owner, { ...copy, allowDuplicate: true })).item.id,
  );
});

test("optimistic revisions prevent lost edits and stale deletes", async () => {
  const saved = await library.save(owner, save("Revision test"));
  await library.update(owner, {
    id: saved.item.id,
    revision: 1,
    notes: "First edit",
  });
  await assert.rejects(
    library.update(owner, {
      id: saved.item.id,
      revision: 1,
      notes: "Lost edit",
    }),
    isError("CONFLICT"),
  );
  await assert.rejects(
    library.delete(owner, { id: saved.item.id, revision: 1 }),
    isError("CONFLICT"),
  );
  assert.equal(
    (await library.get(owner, saved.item.id)).item.notes,
    "First edit",
  );
});

test("deleting one item preserves shared original images until the last item is deleted", async () => {
  const bytes = await sharp({
    create: { width: 4, height: 4, channels: 3, background: "#557aaf" },
  })
    .png()
    .toBuffer();
  const attachment = await library.upload(owner, bytes, "image/png");
  const first = await library.save(
    owner,
    save("Shared source one", {
      source: {
        attachmentId: attachment.attachmentId,
        originalText: "Two independent ideas",
      },
    }),
  );
  const second = await library.save(owner, {
    requestId: randomUUID(),
    title: "Shared source two",
    sourceId: first.source.id,
  });
  await library.delete(owner, { id: first.item.id, revision: 1 });
  assert.deepEqual((await library.image(owner, second.source.id)).bytes, bytes);
  await library.delete(owner, { id: second.item.id, revision: 1 });
  assert.deepEqual((await library.image(owner, second.source.id)).bytes, bytes);
  await db.query(
    "UPDATE items SET trashed_at=now()-interval '7 days' WHERE id=ANY($1::uuid[])",
    [[first.item.id, second.item.id]],
  );
  await cleanupExpired(db);
  await assert.rejects(
    library.image(owner, second.source.id),
    isError("NOT_FOUND"),
  );
  assert.equal(
    (
      await db.query("SELECT id FROM attachments WHERE id=$1", [
        attachment.attachmentId,
      ])
    ).rows.length,
    0,
  );
});

test("rejects unexpected fields, executable URLs and forged or oversized files", async () => {
  await assert.rejects(
    library.save(owner, { ...save("Bad field"), owner: other }),
  );
  await assert.rejects(
    library.save(
      owner,
      save("Bad URL", { source: { url: "javascript:alert(1)" } }),
    ),
  );
  await assert.rejects(
    library.upload(owner, Buffer.from("<svg><script/></svg>"), "image/png"),
    isError("INVALID_IMAGE"),
  );
  await assert.rejects(
    library.upload(owner, Buffer.alloc(10 * 1024 * 1024 + 1), "image/png"),
    isError("FILE_SIZE"),
  );
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    library.upload(owner, png, "image/jpeg"),
    isError("INVALID_IMAGE"),
  );
});

test("file import refuses arbitrary and loopback destinations before network access", async () => {
  for (const url of [
    "http://127.0.0.1/private",
    "https://example.com/file",
    "https://files.oaiusercontent.com.evil.example/a",
    "https://files.oaiusercontent.com:444/a",
  ]) {
    await assert.rejects(
      importChatGPTFile(library, owner, {
        download_url: url,
        file_id: "test",
        filename: "test.png",
        mime_type: "image/png",
      }),
      isError("FILE_HOST"),
    );
  }
});

test("export includes original image bytes and survives database reopening", async () => {
  const expected = await library.export(owner);
  assert.ok(expected.items.length > 0);
  assert.ok(expected.sources.some((source) => source.imageBase64));
  await db.close();
  db = await openDatabase({ dataDir: dir });
  await migrate(db);
  library = new Library(db);
  const actual = await library.export(owner);
  assert.deepEqual(actual.items, expected.items);
  assert.deepEqual(actual.sources, expected.sources);
});
