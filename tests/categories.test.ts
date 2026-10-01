import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate, type Database } from "../server/db.js";
import { Library } from "../server/library.js";
import { categorySchema, saveSchema } from "../shared/schema.js";
import { digest } from "../server/library.js";

let dir: string, db: Database, library: Library;
const owner = randomUUID(),
  other = randomUUID();
const input = (title: string, category?: string) => ({
  requestId: randomUUID(),
  title,
  category,
  source: { originalText: title },
});
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "drop-it-categories-"));
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

test("category migration preserves old items and can run repeatedly", async () => {
  const legacy = await library.save(
    owner,
    input("Legacy category test", "Build"),
  );
  await db.query("ALTER TABLE items DROP CONSTRAINT items_category_check");
  await db.query(
    "ALTER TABLE items ADD CONSTRAINT items_category_check CHECK(category IN ('Learn','Build','Try','Buy','Read','Other'))",
  );
  await db.query("DELETE FROM schema_migrations WHERE version=2");
  await migrate(db);
  await migrate(db);
  assert.deepEqual(await library.get(owner, legacy.item.id), {
    item: legacy.item,
    source: legacy.source,
  });
  const saved = await library.save(
    owner,
    input("New topic after migration", "Photography"),
  );
  assert.equal(saved.item.category, "Photography");
});

test("categories are normalized, reusable, owner-scoped and independent of search filters", async () => {
  const a = await library.save(
    owner,
    input("Garden design", "  Home   Projects  "),
  );
  const b = await library.save(owner, input("Patio design", "home projects"));
  assert.equal(a.item.category, "Home Projects");
  assert.equal(b.item.category, "Home Projects");
  const foreign = await library.save(
    other,
    input("Other owner topic", "PRIVATE TOPIC"),
  );
  assert.equal(foreign.item.category, "PRIVATE TOPIC");
  const found = await library.search(owner, { category: "HOME PROJECTS" });
  assert.equal(found.total, 2);
  assert.ok(found.categories.includes("Photography"));
  assert.ok(!found.categories.includes("PRIVATE TOPIC"));
  const own = await library.save(
    owner,
    input("Independent category spelling", "private topic"),
  );
  assert.equal(own.item.category, "private topic");
  const updated = await library.update(owner, {
    id: own.item.id,
    revision: 1,
    category: "home PROJECTS",
  });
  assert.equal(updated.item.category, "Home Projects");
  assert.ok(
    !(
      await library.search(owner, { query: "no matching content" })
    ).categories.includes("private topic"),
  );
  assert.equal((await library.search(other, {})).categories.length, 1);
  const noCategory = await library.save(owner, input("Uncategorized test"));
  assert.equal(noCategory.item.category, "Uncategorized");
});

test("invalid category labels cannot be saved or used to bypass filtering", async () => {
  for (const category of [
    "",
    " ",
    "x".repeat(61),
    "<script>",
    "foo\nbar",
    "hidden\u202elabel",
    "--",
  ])
    assert.equal(categorySchema.safeParse(category).success, false);
  assert.equal(categorySchema.parse("Ｃｏｄｉｎｇ"), "Coding");
  assert.equal(categorySchema.parse("Café & Design"), "Café & Design");
  assert.equal(categorySchema.parse("学習と開発"), "学習と開発");
  await assert.rejects(
    library.save(owner, input("Unsafe category", "<script>")),
  );
  await assert.rejects(library.search(owner, { category: "' OR 1=1 --" }));
  const saved = await library.save(
    owner,
    input("Update category validation", "Security"),
  );
  await assert.rejects(
    library.update(owner, { id: saved.item.id, revision: 1, category: "a\nb" }),
  );
  assert.equal(
    (await library.get(owner, saved.item.id)).item.category,
    "Security",
  );
});

test("pre-migration retries with the old default still return their original item", async () => {
  const omitted = input("Old default retry");
  const legacyInput = { ...omitted, category: "Other" };
  const saved = await library.save(owner, legacyInput);
  assert.equal(
    digest(JSON.stringify(saveSchema.parse(legacyInput))),
    (
      await db.query<{ fingerprint: string }>(
        "SELECT fingerprint FROM save_requests WHERE owner=$1 AND request_id=$2",
        [owner, omitted.requestId],
      )
    ).rows[0].fingerprint,
  );
  const replay = await library.save(owner, omitted);
  assert.equal(replay.item.id, saved.item.id);
  assert.equal(replay.item.category, "Other");
  assert.equal(replay.replayed, true);
  await assert.rejects(
    library.save(owner, { ...omitted, title: "Changed content" }),
  );
});
