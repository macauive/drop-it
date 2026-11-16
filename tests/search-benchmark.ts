// Opt-in synthetic PostgreSQL benchmark. This fixed loopback database is a
// disposable pgvector container; never load environment files or production.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { openDatabase, migrate } from "../server/db.js";
import { Library } from "../server/library.js";
import { SearchIndexer } from "../server/search-index.js";
import { embeddingVersion, searchIndexStatus } from "../server/semantic.js";
import {
  seedSearchLibrary,
  searchProvider,
  seedSearchEmbeddings,
} from "./search-fixture.js";

const db = await openDatabase({
  dataDir: "/private/tmp",
  databaseUrl:
    "postgresql://synthetic_search_admin@127.0.0.1:55439/synthetic_search",
});
const provider = searchProvider();
const worker = new SearchIndexer(db, async (_owner, run) => run(provider));
try {
  // Refuse a reused database rather than overwriting or deleting any content.
  assert.equal(
    (
      await db.query(
        "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='users'",
      )
    ).rows.length,
    0,
  );
  await migrate(db);
  const { owner, other } = await seedSearchLibrary(db);
  const library = new Library(db, provider);
  await library.setPreferences(owner, { aiSearchEnabled: true });
  await seedSearchEmbeddings(db, owner, embeddingVersion, 64);
  const start = performance.now();
  const cold = await library.search(owner, { query: "herbs" });
  assert.equal(cold.searchIndex?.indexed, 9968);
  const coldMs = performance.now() - start;
  for (let turn = 0; turn < 1; turn++) await worker.tick();
  const status = await searchIndexStatus(db, owner, { view: "All drops" });
  assert.equal(status.indexed, 10000);
  const indexMs = performance.now() - start;
  const plan = await db.query("EXPLAIN (FORMAT JSON) SELECT id FROM items WHERE owner=$1 AND search_text LIKE '%herbs%'", [owner]);
  const literalIndexUsed = JSON.stringify(plan.rows).includes("items_search_text");
  assert.equal(literalIndexUsed, true);
  const timings: Record<string, number[]> = {
    keyword: [],
    semantic: [],
    hybrid: [],
  };
  for (let iteration = 0; iteration < 4; iteration++) {
    for (const mode of ["keyword", "semantic", "hybrid"] as const) {
      const before = performance.now();
      const result = await library.search(owner, {
        query: "herbs",
        mode,
        limit: 30,
      });
      timings[mode].push(Math.round(performance.now() - before));
      assert.equal(
        result.total,
        mode === "keyword" ? 1 : mode === "semantic" ? 1000 : 1001,
      );
      assert.equal(result.mode, mode);
      assert.ok(result.items.length <= 30);
      if (mode === "hybrid")
        assert.equal(result.items[0].title, "herbs literal identifier");
    }
  }
  assert.equal(
    (await library.search(other, { query: "Record", mode: "keyword" })).total,
    0,
  );
  console.log(
    JSON.stringify(
      {
        drops: 10000,
        literalIndexUsed,
        requestWith64PendingMs: Math.round(coldMs),
        prepareRemaining64Ms: Math.round(indexMs),
        warmRequestMs: timings,
        status,
        provider: "deterministic synthetic embeddings; no network AI calls",
      },
      null,
      2,
    ),
  );
} finally {
  await worker.close();
  await db.close();
}
