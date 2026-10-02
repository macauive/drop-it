import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import sharp from "sharp";
import { PGlite } from "@electric-sql/pglite";
import { migrate, type Database, type Queryable } from "../server/db.js";
import { Library } from "../server/library.js";
import { Portability } from "../server/portability.js";
import { AppError } from "../server/errors.js";
import { archiveChunkBytes, previewLifetimeMs } from "../shared/portable.js";

let db: Database, library: Library, portability: Portability;
const owners: string[] = [];
before(async () => {
  const pg = new PGlite();
  await pg.waitReady;
  db = { query: (sql, params) => pg.query(sql, params), transaction: run => pg.transaction(run), close: () => pg.close() };
  await migrate(db);
  library = new Library(db);
  portability = new Portability(db);
});
after(async () => { await portability.close(); await db.close(); });
const owner = async () => {
  const id = randomUUID(); owners.push(id);
  await db.query("INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$2)", [id, "synthetic-unusable-password-hash"]);
  return id;
};
const input = async function* (text: string, block = 4093) {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; offset += block) yield bytes.subarray(offset, offset + block);
};
const exportOf = async (id: string, manager = portability) => {
  const lines: string[] = [];
  await manager.export(id, async line => { lines.push(line); });
  return lines.join("");
};
const sample = async (id: string, file = true) => {
  const bytes = Buffer.from("Synthetic original {source} \"quoted\"\n" + "🧪漢字 ".repeat(8000));
  const upload = file ? await library.upload(id, bytes, "text/plain", "synthetic.txt") : null;
  const saved = await library.save(id, { requestId: randomUUID(), title: "Synthetic preserved source", notes: "Personal synthetic note", tags: ["archive"],
    source: { originalText: "Original transcription", url: "https://example.com/guide#installation", ...(upload ? { attachmentId: upload.attachmentId } : {}) } });
  return { saved, bytes };
};
const count = async (id: string, table = "items") => {
  assert.ok(["items", "sources", "attachments", "portability_imports"].includes(table));
  const result = await db.query<{ count: string }>(`SELECT count(*) FROM ${table} WHERE owner=$1`, [id]);
  return Number(result.rows[0].count);
};
const apply = (id: string, preview: { previewId: string; requestId: string }, manager = portability) =>
  manager.apply(id, { previewId: preview.previewId, requestId: preview.requestId, confirm: true });
const errorCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
type RecordValue = { type: string; value?: Record<string, unknown>; [key: string]: unknown };
const mutate = (archive: string, change: (records: RecordValue[]) => void) => {
  const records = archive.trimEnd().split("\n").map(line => JSON.parse(line) as RecordValue);
  change(records);
  const preceding = records.slice(0, -1).map(row => JSON.stringify(row) + "\n").join("");
  records[records.length - 1].sha256 = createHash("sha256").update(preceding).digest("hex");
  return preceding + JSON.stringify(records[records.length - 1]) + "\n";
};

test("portable v3 streams shared originals once and atomically preserves sources, metadata, timestamps, bookmarks and Trash", async () => {
  const from = await owner(), to = await owner();
  const { saved, bytes } = await sample(from);
  const edited = await library.update(from, { id: saved.item.id, revision: saved.item.revision, isSaved: true, reviewedTranscription: "Reviewed synthetic correction" });
  const second = await library.save(from, { requestId: randomUUID(), title: "Same source, second idea", sourceId: saved.source.id });
  await library.delete(from, { id: second.item.id, revision: second.item.revision });
  const archive = await exportOf(from);
  const records = archive.trimEnd().split("\n").map(line => JSON.parse(line));
  assert.equal(records.filter(record => record.type === "file").length, 1);
  assert.ok(records.filter(record => record.type === "chunk").every(record => Buffer.from(record.data, "base64").length <= archiveChunkBytes));
  const preview = await portability.preview(to, input(archive, 17), "ndjson");
  assert.deepEqual([preview.items, preview.sources, preview.files, preview.fileBytes], [2, 1, 1, bytes.length]);
  assert.equal(await count(to), 0, "preview cannot write library data");
  assert.equal((await apply(to, preview)).imported, 2);
  const all = await library.search(to, { mode: "keyword" });
  const trash = await library.search(to, { mode: "keyword", view: "Trash" });
  assert.equal(all.total, 1); assert.equal(trash.total, 1);
  const imported = await library.get(to, all.items[0].id);
  assert.notEqual(imported.item.id, saved.item.id);
  assert.notEqual(imported.source.id, saved.source.id);
  assert.equal(imported.source.id, trash.items[0].sourceId);
  assert.equal(imported.source.url, "https://example.com/guide#installation");
  assert.equal(imported.source.originalText, "Original transcription");
  assert.equal(imported.item.reviewedTranscription, "Reviewed synthetic correction");
  assert.equal(imported.item.isSaved, true);
  assert.equal(new Date(imported.item.createdAt).toISOString(), new Date(edited.item.createdAt).toISOString());
  assert.equal(new Date(imported.item.transcriptionUpdatedAt!).toISOString(), new Date(edited.item.transcriptionUpdatedAt!).toISOString());
  assert.deepEqual((await library.file(to, imported.source.id)).bytes, bytes);
  await assert.rejects(library.get(from, imported.item.id), errorCode("NOT_FOUND"));
});

test("import preview, cancellation and durable retries remain owner scoped", async () => {
  const from = await owner(), to = await owner(), other = await owner();
  await sample(from, false);
  const archive = await exportOf(from);
  const preview = await portability.preview(to, input(archive), "ndjson");
  await assert.rejects(apply(other, preview), errorCode("IMPORT_EXPIRED"));
  await portability.discard(other, preview.previewId);
  await assert.rejects(portability.apply(to, { ...preview, confirm: false }));
  const result = await apply(to, preview);
  assert.equal(result.replayed, false);
  const restarted = new Portability(db);
  try {
    assert.equal((await apply(to, preview, restarted)).replayed, true);
    assert.equal(await count(to), 1);
    assert.equal(await count(other), 0);
    const cancel = await restarted.preview(other, input(archive), "ndjson");
    await restarted.discard(other, cancel.previewId);
    await assert.rejects(apply(other, cancel, restarted), errorCode("IMPORT_EXPIRED"));
  } finally { await restarted.close(); }
});

test("portable import rejects corrupt files, executable URLs, traversal names, unknown fields, broken references and incomplete archives", async () => {
  const from = await owner(), to = await owner();
  await sample(from);
  const archive = await exportOf(from);
  const malicious = [
    mutate(archive, rows => { rows.find(row => row.type === "file")!.value!.sha256 = "0".repeat(64); }),
    mutate(archive, rows => { rows.find(row => row.type === "file")!.value!.filename = "../outside.txt"; }),
    mutate(archive, rows => { rows.find(row => row.type === "source")!.value!.url = "javascript:alert(1)"; }),
    mutate(archive, rows => { rows.find(row => row.type === "item")!.value!.owner = from; }),
    mutate(archive, rows => { rows.find(row => row.type === "item")!.value!.sourceId = randomUUID(); }),
    mutate(archive, rows => { rows.find(row => row.type === "chunk")!.index = 2; }),
    archive.split("\n").slice(0, -2).join("\n") + "\n",
    archive.replace("Synthetic preserved source", "Tampered source title"),
    archive + '{"type":"item"}\n',
  ];
  for (const invalidArchive of malicious) {
    await assert.rejects(portability.preview(to, input(invalidArchive, 101), "ndjson"));
    assert.equal(await count(to), 0);
    assert.equal(await count(to, "attachments"), 0);
  }
  const valid = await portability.preview(to, input(archive), "ndjson");
  await portability.discard(to, valid.previewId);
});

test("legacy v2 imports stream across UTF-8 and JSON boundaries and retain original bytes", async () => {
  const from = await owner(), to = await owner();
  const { saved, bytes } = await sample(from);
  await library.save(from, { requestId: randomUUID(), title: "Second source same attachment", allowDuplicate: true, source: {
    originalText: "Another source", attachmentId: saved.source.attachmentId,
  } });
  const legacy = JSON.stringify(await library.export(from));
  const preview = await portability.preview(to, input(legacy, 7), "json");
  assert.equal(preview.version, 2);
  assert.ok(preview.warnings.some(warning => warning.includes("no stored integrity checksum")));
  assert.equal(preview.files, 1, "legacy repeated bytes are deduplicated");
  await apply(to, preview);
  const all = await library.search(to, { mode: "keyword" });
  assert.equal(all.total, 2);
  assert.deepEqual((await library.file(to, all.items[0].sourceId)).bytes, bytes);
});

test("expired Trash is skipped at preview and is never resurrected when it expires before apply", async () => {
  const from = await owner(), to = await owner(), another = await owner();
  const { saved } = await sample(from, false);
  await db.query("UPDATE items SET created_at=now()-interval '10 days',updated_at=now()-interval '1 day',trashed_at=now()-interval '1 day' WHERE owner=$1 AND id=$2", [from, saved.item.id]);
  const archive = await exportOf(from);
  const oldArchive = mutate(archive, rows => { rows.find(row => row.type === "item")!.value!.trashedAt = new Date(Date.now() - 8 * 86400000).toISOString(); });
  const expired = await portability.preview(to, input(oldArchive), "ndjson");
  assert.equal(expired.items, 0); assert.equal(expired.expiredItems, 1);
  await apply(to, expired);
  assert.equal(await count(to), 0);
  assert.equal(await count(to, "sources"), 0);
  const nearlyExpiredArchive = mutate(archive, rows => { rows.find(row => row.type === "item")!.value!.trashedAt = new Date(Date.now() - 7 * 86400000 + 60000).toISOString(); });
  const preview = await portability.preview(another, input(nearlyExpiredArchive), "ndjson");
  assert.equal(preview.items, 1);
  const originalNow = Date.now;
  try {
    const future = originalNow() + 2 * 60000;
    Date.now = () => future;
    assert.equal((await apply(another, preview)).imported, 0);
    assert.equal(await count(another), 0);
    assert.equal(await count(another, "sources"), 0);
  } finally { Date.now = originalNow; }
  await portability.discard(another, preview.previewId);
});

test("capacity is rechecked at apply and a failed import rolls back every row", async () => {
  const from = await owner(), to = await owner(), rollbackOwner = await owner();
  await sample(from);
  const archive = await exportOf(from);
  const bounded = new Portability(db, { ownerDropCount: 1 });
  try {
    const preview = await bounded.preview(to, input(archive), "ndjson");
    await sample(to, false);
    await assert.rejects(apply(to, preview, bounded), errorCode("IMPORT_LIMIT"));
    assert.equal(await count(to), 1); assert.equal(await count(to, "attachments"), 0);
  } finally { await bounded.close(); }
  let fail = true;
  const wrapped: Database = { ...db, transaction: async run => db.transaction(async tx => {
    const fault: Queryable = { query: async (sql, params) => {
      if (fail && sql.startsWith("INSERT INTO items")) throw new Error("synthetic transaction failure");
      return tx.query(sql, params);
    } };
    return run(fault);
  }) };
  const transactional = new Portability(wrapped);
  try {
    const preview = await transactional.preview(rollbackOwner, input(archive), "ndjson");
    await assert.rejects(apply(rollbackOwner, preview, transactional));
    for (const table of ["items", "sources", "attachments", "portability_imports"]) assert.equal(await count(rollbackOwner, table), 0);
    fail = false;
    assert.equal((await apply(rollbackOwner, preview, transactional)).imported, 1);
  } finally { await transactional.close(); }
});

test("preview identifies existing sources without overwriting them and cleans up expiry", async () => {
  const from = await owner(), to = await owner();
  await sample(from, false); await sample(to, false);
  const archive = await exportOf(from);
  const preview = await portability.preview(to, input(archive), "ndjson");
  assert.equal(preview.duplicateItems, 1);
  await apply(to, preview);
  assert.equal(await count(to), 2);
  const next = await portability.preview(to, input(archive), "ndjson");
  await portability.expire(Date.now() + previewLifetimeMs + 1000);
  await assert.rejects(apply(to, next), errorCode("IMPORT_EXPIRED"));
});

test("portable export includes only the requested owner and aborts without a completion marker", async () => {
  const from = await owner(), other = await owner();
  await sample(from);
  const empty = await exportOf(other);
  assert.equal(JSON.parse(empty.trimEnd().split("\n").at(-1)!).items, 0);
  const controller = new AbortController();
  const lines: string[] = [];
  await assert.rejects(portability.export(from, async line => {
    lines.push(line); controller.abort();
  }, controller.signal));
  assert.equal(lines.some(line => JSON.parse(line).type === "end"), false);
  assert.ok((await exportOf(from)).includes('"type":"end"'), "aborted exports release their concurrency slot");
});

test("portable export avoids legacy source/file amplification beyond the old JSON export limit", async () => {
  const from = await owner(), to = await owner();
  const original = await sharp(randomBytes(1024 * 1024 * 3), {
    raw: { width: 1024, height: 1024, channels: 3 },
  }).png().toBuffer();
  const uploaded = await library.upload(from, original, "image/png", "synthetic-noise.png");
  // Separate source records deliberately reuse one owned original. The old
  // format repeats its base64 bytes per source, exceeding 384 MiB here.
  for (let index = 0; index < 100; index++) await library.save(from, {
    requestId: randomUUID(), title: `Synthetic source ${index}`, allowDuplicate: true,
    source: { attachmentId: uploaded.attachmentId, originalText: `Source ${index}` },
  });
  await assert.rejects(library.export(from), errorCode("EXPORT_SIZE"));
  const archive = await exportOf(from);
  assert.ok(Buffer.byteLength(archive) < 5 * 1024 * 1024);
  const preview = await portability.preview(to, input(archive), "ndjson");
  assert.equal(preview.items, 100);
  assert.equal(preview.sources, 100);
  assert.equal(preview.files, 1);
  assert.equal(preview.fileBytes, original.length);
  await portability.discard(to, preview.previewId);
});
