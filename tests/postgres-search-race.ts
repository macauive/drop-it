// Opt-in, fixed synthetic container from search-benchmark.ts. No env loading.
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../server/db.js";
import { Library } from "../server/library.js";
import { indexSearchBatch } from "../server/semantic.js";
import { searchProvider } from "./search-fixture.js";
import { AppError } from "../server/errors.js";

const db = await openDatabase({
  dataDir: "/private/tmp",
  databaseUrl:
    "postgresql://synthetic_search_admin@127.0.0.1:55439/synthetic_search",
});
let release = () => {};
try {
  const { rows } = await db.query<{ owner: string }>(
    "SELECT owner FROM items GROUP BY owner HAVING count(*)=1",
  );
  assert.equal(rows.length, 1);
  const owner = rows[0].owner;
  const library = new Library(db, searchProvider());
  await library.setPreferences(owner, { aiSearchEnabled: true });
  const permission = await db.query<{ epoch: number }>(
    "SELECT ai_search_epoch AS epoch FROM users WHERE id=$1",
    [owner],
  );
  let entered = () => {};
  const atWrite = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observed: Database = {
    ...db,
    transaction: (run) =>
      db.transaction((tx) =>
        run({
          query: async (sql, params) => {
            if (sql.startsWith("INSERT INTO item_embeddings")) {
              entered();
              await gate;
            }
            return tx.query(sql, params);
          },
        }),
      ),
  };
  const indexing = indexSearchBatch(
    observed,
    searchProvider(),
    owner,
    { view: "All drops" },
    permission.rows[0].epoch,
  ).catch((error) => {
    if (!(error instanceof AppError && error.code === "AI_DISABLED"))
      throw error;
  });
  await atWrite;
  let disabled = false;
  const revoking = library
    .setPreferences(owner, { aiSearchEnabled: false })
    .then(() => {
      disabled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    disabled,
    false,
    "revocation must serialize with a guarded cache write",
  );
  release();
  await Promise.all([indexing, revoking]);
  assert.equal(
    (
      await db.query("SELECT item_id FROM item_embeddings WHERE owner=$1", [
        owner,
      ])
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await db.query("SELECT owner FROM search_index_jobs WHERE owner=$1", [
        owner,
      ])
    ).rows.length,
    0,
  );
  console.log(
    "PostgreSQL concurrent index-write / consent-revocation race passed; no vectors or jobs retained.",
  );
} finally {
  release();
  await db.close();
}
