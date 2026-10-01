import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate, type Database } from "../server/db.js";
import { Library } from "../server/library.js";
import { cleanupExpired } from "../server/maintenance.js";
import { searchSchema, updateSchema } from "../shared/schema.js";

async function fixture(
  run: (
    db: Database,
    library: Library,
    owner: string,
    other: string,
  ) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "drop-it-trash-"));
  const db = await openDatabase({ dataDir: dir });
  try {
    await migrate(db);
    const owner = randomUUID(),
      other = randomUUID();
    await db.query(
      "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$3),($2,NULL,$3)",
      [owner, other, randomBytes(32).toString("hex")],
    );
    await run(db, new Library(db), owner, other);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const input = (title: string) => ({
  requestId: randomUUID(),
  title,
  source: { originalText: title },
});
const code = (expected: string) => (e: unknown) =>
  (e as { code?: string }).code === expected;

test("bookmarks and Trash are independent, owner scoped, reversible, and revision guarded", () =>
  fixture(async (db, lib, owner, other) => {
    const drop = await lib.save(owner, input("Reference"));
    assert.equal(drop.item.isSaved, false);
    assert.equal(drop.item.trashedAt, null);
    assert.equal((await lib.search(owner, { view: "Saved" })).total, 0);
    const saved = await lib.update(owner, {
      id: drop.item.id,
      revision: 1,
      isSaved: true,
    });
    assert.equal((await lib.search(owner, { view: "Saved" })).total, 1);
    assert.equal((await lib.search(other, { view: "Saved" })).total, 0);
    await assert.rejects(
      lib.update(other, { id: drop.item.id, revision: 2, isSaved: false }),
      code("NOT_FOUND"),
    );
    await assert.rejects(
      lib.delete(owner, { id: drop.item.id, revision: 1 }),
      code("CONFLICT"),
    );
    await lib.delete(owner, {
      id: drop.item.id,
      revision: saved.item.revision,
    });
    const trash = await lib.get(owner, drop.item.id);
    assert.equal(trash.item.isSaved, true);
    assert.equal(
      new Date(trash.item.deleteAfter!).getTime() -
        new Date(trash.item.trashedAt!).getTime(),
      7 * 86400000,
    );
    const all = await lib.search(owner, {});
    assert.equal(all.total, 0);
    assert.deepEqual(all.counts, { "All drops": 0, Saved: 0, Trash: 1 });
    assert.equal(
      (await lib.search(owner, { view: "Trash", query: "Reference" })).total,
      1,
    );
    await lib.delete(owner, {
      id: drop.item.id,
      revision: trash.item.revision,
    });
    assert.deepEqual(
      (await lib.get(owner, drop.item.id)).item.trashedAt,
      trash.item.trashedAt,
    );
    await assert.rejects(
      lib.update(owner, {
        id: drop.item.id,
        revision: trash.item.revision,
        isSaved: false,
      }),
      code("IN_TRASH"),
    );
    await assert.rejects(
      lib.restore(other, { id: drop.item.id, revision: trash.item.revision }),
      code("NOT_FOUND"),
    );
    await assert.rejects(
      lib.restore(owner, { id: drop.item.id, revision: 1 }),
      code("CONFLICT"),
    );
    const restored = await lib.restore(owner, {
      id: drop.item.id,
      revision: trash.item.revision,
    });
    assert.equal(restored.item.trashedAt, null);
    assert.equal(restored.item.isSaved, true);
    await lib.update(owner, {
      id: drop.item.id,
      revision: restored.item.revision,
      isSaved: false,
    });
    assert.equal((await lib.search(owner, { view: "Saved" })).total, 0);
    assert.equal((await lib.search(owner, {})).total, 1);
    assert.equal(searchSchema.safeParse({ status: "Done" }).success, false);
    assert.equal(
      updateSchema.safeParse({
        id: drop.item.id,
        revision: 1,
        trashedAt: new Date().toISOString(),
      }).success,
      false,
    );
    assert.equal(
      (await db.query("SELECT id FROM sources WHERE id=$1", [drop.source.id]))
        .rows.length,
      1,
    );
  }));

test("legacy statuses migrate to unbookmarked drops with a fresh Trash window", () =>
  fixture(async (db, lib, owner) => {
    const entries = [];
    for (const title of ["Saved", "In progress", "Done", "Archived"])
      entries.push(await lib.save(owner, input(title)));
    await db.query("DROP INDEX items_trash_expiry");
    await db.query(
      "ALTER TABLE items DROP COLUMN is_saved, DROP COLUMN trashed_at, ADD COLUMN status text NOT NULL DEFAULT 'Saved' CHECK(status IN ('Saved','In progress','Done','Archived'))",
    );
    for (const entry of entries)
      await db.query(
        "UPDATE items SET status=$1,updated_at=now()-interval '90 days' WHERE id=$2",
        [entry.item.title, entry.item.id],
      );
    await db.query("DELETE FROM schema_migrations WHERE version=6");
    await migrate(db);
    const archive = await lib.get(owner, entries[3].item.id);
    assert.ok(
      new Date(archive.item.deleteAfter!).getTime() >
        Date.now() + 6.99 * 86400000,
    );
    assert.equal((await lib.search(owner, {})).total, 3);
    assert.equal((await lib.search(owner, { view: "Saved" })).total, 0);
    assert.equal((await lib.search(owner, { view: "Trash" })).total, 1);
    await migrate(db);
    assert.deepEqual(await lib.get(owner, entries[3].item.id), archive);
    assert.deepEqual(archive.source, entries[3].source);
  }));

test("expiry enforces the seven-day boundary and only cleans unreferenced owned files", () =>
  fixture(async (db, lib, owner, other) => {
    const bytes = Buffer.from("Original text fixture");
    const attachment = await lib.upload(
      owner,
      bytes,
      "text/plain",
      "fixture.txt",
    );
    const first = await lib.save(owner, {
      ...input("First"),
      source: { attachmentId: attachment.attachmentId },
    });
    const second = await lib.save(owner, {
      requestId: randomUUID(),
      title: "Second",
      sourceId: first.source.id,
    });
    const foreign = await lib.save(other, input("Unrelated"));
    await lib.delete(owner, { id: first.item.id, revision: 1 });
    await db.query(
      "UPDATE items SET trashed_at=now()-interval '7 days' WHERE id=$1",
      [first.item.id],
    );
    await assert.rejects(
      lib.restore(owner, { id: first.item.id, revision: 2 }),
      code("NOT_FOUND"),
    );
    assert.equal((await lib.search(owner, { view: "Trash" })).total, 0);
    await cleanupExpired(db);
    assert.equal(
      (await db.query("SELECT id FROM items WHERE id=$1", [first.item.id])).rows
        .length,
      0,
    );
    assert.deepEqual((await lib.file(owner, first.source.id)).bytes, bytes);
    assert.equal(
      (await lib.get(other, foreign.item.id)).item.title,
      "Unrelated",
    );
    await lib.delete(owner, { id: second.item.id, revision: 1 });
    await db.query(
      "UPDATE items SET trashed_at=now()-interval '6 days 23 hours' WHERE id=$1",
      [second.item.id],
    );
    await cleanupExpired(db);
    assert.equal((await lib.search(owner, { view: "Trash" })).total, 1);
    await db.query(
      "UPDATE items SET trashed_at=now()-interval '7 days' WHERE id=$1",
      [second.item.id],
    );
    await assert.rejects(lib.file(owner, first.source.id), code("NOT_FOUND"));
    const exported = await lib.export(owner);
    assert.equal(exported.items.length, 0);
    assert.equal(exported.sources.length, 0);
    await cleanupExpired(db);
    await cleanupExpired(db);
    assert.equal(
      (await db.query("SELECT id FROM sources WHERE id=$1", [first.source.id]))
        .rows.length,
      0,
    );
    assert.equal(
      (
        await db.query("SELECT id FROM attachments WHERE id=$1", [
          attachment.attachmentId,
        ])
      ).rows.length,
      0,
    );
  }));
