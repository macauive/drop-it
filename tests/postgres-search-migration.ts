// Recreate v14 only inside the fixed, disposable synthetic benchmark database.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { openDatabase, migrate } from "../server/db.js";

const db = await openDatabase({
  dataDir: "/private/tmp",
  databaseUrl:
    "postgresql://synthetic_search_admin@127.0.0.1:55439/synthetic_search",
});
try {
  assert.equal(
    (
      await db.query(
        "SELECT id FROM users WHERE password_hash<>'synthetic-unusable-hash'",
      )
    ).rows.length,
    0,
  );
  const before = await db.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM items",
  );
  assert.equal(before.rows[0].count, 10001);
  await db.transaction(async (tx) => {
    await tx.query("DROP TRIGGER item_search_text ON items");
    await tx.query("DROP TRIGGER source_search_text ON sources");
    await tx.query(
      "DROP FUNCTION drop_it_item_search_text(),drop_it_source_search_text()",
    );
    await tx.query("ALTER TABLE items DROP COLUMN search_text");
    await tx.query("DROP TABLE search_index_jobs");
    await tx.query("ALTER TABLE users DROP COLUMN ai_search_epoch");
    await tx.query(
      "ALTER TABLE item_embeddings DROP COLUMN embedding,DROP COLUMN indexed_revision",
    );
    await tx.query("UPDATE users SET ai_search_enabled=true");
    await tx.query("DELETE FROM schema_migrations WHERE version=15");
  });
  const start = performance.now();
  await migrate(db);
  await migrate(db);
  assert.deepEqual(
    await db.query("SELECT count(*)::integer AS count FROM items"),
    before,
  );
  assert.equal(
    (await db.query("SELECT id FROM users WHERE ai_search_enabled")).rows
      .length,
    0,
  );
  assert.equal(
    (await db.query("SELECT id FROM items WHERE search_text=''")).rows.length,
    0,
  );
  const found = await db.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM items WHERE search_text LIKE '%herbs%'",
  );
  assert.equal(found.rows[0].count, 2);
  console.log(
    JSON.stringify({
      migration: "14 -> 15",
      drops: 10001,
      durationMs: Math.round(performance.now() - start),
      repeatable: true,
      textBackfill: "complete",
      consent: "requires renewed opt-in",
      statementTimeoutRaised: false,
    }),
  );
} finally {
  await db.close();
}
