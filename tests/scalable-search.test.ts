import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate, type Database } from "../server/db.js";
import { Library } from "../server/library.js";
import { SearchIndexer } from "../server/search-index.js";
import {
  indexSearchBatch,
  searchIndexStatus,
  normalizedVector,
  embeddingVersion,
} from "../server/semantic.js";
import { AppError } from "../server/errors.js";
import { searchProvider, seedSearchLibrary } from "./search-fixture.js";

let db: Database, dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "drop-it-scalable-search-"));
  db = await openDatabase({ dataDir: dir });
  await migrate(db);
});
after(async () => {
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});
const scope = { view: "All drops" as const };
const errorCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;

test("10,000-drop cold index resumes in bounded background batches; warm searches page exact hybrid matches without loading all documents", async () => {
  const { owner, other } = await seedSearchLibrary(db);
  let maxBatch = 0,
    providerTexts = 0,
    maxRows = 0;
  const provider = searchProvider((texts) => {
    assert.ok(texts.every((text) => !text.includes("FOREIGN_PRIVATE_MARKER")));
    maxBatch = Math.max(maxBatch, texts.length);
    providerTexts += texts.length;
  });
  const observed: Database = {
    ...db,
    async query<T>(sql: string, params?: unknown[]) {
      const result = await db.query<T>(sql, params);
      maxRows = Math.max(maxRows, result.rows.length);
      return result;
    },
  };
  const library = new Library(observed, provider);
  await library.setPreferences(owner, { aiSearchEnabled: true });
  const cold = await library.search(owner, { query: "herbs" });
  assert.equal(cold.mode, "hybrid");
  assert.equal(cold.searchIndex?.total, 10000);
  assert.equal(cold.searchIndex?.indexed, 32);
  assert.equal(cold.searchIndex?.pending, 9968);
  assert.ok(
    cold.items.some((item) => item.title === "herbs literal identifier"),
  );
  assert.match(cold.searchNotice ?? "", /background/);
  // A fresh worker represents a process restart: work and progress are in SQL.
  const worker = new SearchIndexer(observed, async (_owner, run) =>
    run(provider),
  );
  try {
    for (let turn = 0; turn < 41; turn++) await worker.tick();
    assert.deepEqual(await searchIndexStatus(db, owner, scope), {
      total: 10000,
      indexed: 10000,
      pending: 0,
    });
    const before = providerTexts;
    const warm = await library.search(owner, { query: "herbs", limit: 100 });
    assert.equal(
      providerTexts,
      before + 1,
      "a warm query embeds only the query",
    );
    assert.equal(warm.total, 1001);
    assert.equal(warm.mode, "hybrid");
    assert.equal(warm.searchNotice, undefined);
    assert.equal(warm.items[0].title, "herbs literal identifier");
    assert.equal(warm.items[0].matchType, "keyword");
    const seen = new Set(warm.items.map((item) => item.id));
    for (let offset = 100; offset <= 1000; offset += 100) {
      const page = await library.search(owner, {
        query: "herbs",
        offset,
        limit: 100,
      });
      assert.equal(page.total, 1001);
      for (const item of page.items) {
        assert.ok(!seen.has(item.id));
        seen.add(item.id);
      }
    }
    assert.equal(seen.size, 1001);
    const beyond = await library.search(owner, {
      query: "herbs",
      offset: 1200,
    });
    assert.equal(beyond.total, 1001);
    assert.equal(beyond.items.length, 0);
    const filtered = await library.search(owner, {
      query: "herbs",
      category: "Garden",
      tag: "FOCUS",
      limit: 100,
    });
    assert.equal(filtered.total, 100);
    assert.ok(
      filtered.items.every(
        (item) => item.category === "Garden" && item.tags.includes("focus"),
      ),
    );
    const saved = await library.search(owner, {
      query: "herbs",
      view: "Saved",
    });
    assert.equal(saved.total, 1);
    const dated = await library.search(owner, {
      query: "herbs",
      after: "2026-01-07T22:30:00.000Z",
      before: "2026-01-07T23:00:00.000Z",
    });
    assert.equal(dated.total, 2);
    assert.equal(
      (await library.search(other, { query: "Record", mode: "keyword" })).total,
      0,
    );
    assert.equal(maxBatch, 32);
    assert.ok(
      maxRows <= 100,
      `SQL returned ${maxRows} rows instead of bounded pages`,
    );
  } finally {
    await worker.close();
  }
});

test("indexing respects its requested scope, suppresses stale edits/deletes, and discards work across disable/re-enable", async () => {
  const owner = randomUUID();
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,'synthetic')",
    [owner],
  );
  const library = new Library(db, searchProvider());
  const first = await library.save(owner, {
    requestId: randomUUID(),
    title: "topic-3",
    category: "Included",
    source: { originalText: "topic-3" },
  });
  await library.save(owner, {
    requestId: randomUUID(),
    title: "PRIVATE_EXCLUDED_MARKER",
    category: "Excluded",
    source: { originalText: "topic-0" },
  });
  await library.setPreferences(owner, { aiSearchEnabled: true });
  const { rows } = await db.query<{ epoch: number }>(
    "SELECT ai_search_epoch AS epoch FROM users WHERE id=$1",
    [owner],
  );
  const epoch = rows[0].epoch;
  await indexSearchBatch(
    db,
    searchProvider((texts) =>
      assert.ok(
        texts.every((text) => !text.includes("PRIVATE_EXCLUDED_MARKER")),
      ),
    ),
    owner,
    { ...scope, category: "Included" },
    epoch,
  );
  assert.deepEqual(await searchIndexStatus(db, owner, scope), {
    total: 2,
    indexed: 1,
    pending: 1,
  });
  const changed = await library.update(owner, {
    id: first.item.id,
    revision: 1,
    notes: "topic-4 changed",
  });
  await indexSearchBatch(
    db,
    {
      ...searchProvider(),
      async embed(texts) {
        await library.delete(owner, {
          id: first.item.id,
          revision: changed.item.revision,
        });
        return searchProvider().embed(texts);
      },
    },
    owner,
    { ...scope, category: "Included" },
    epoch,
  );
  assert.equal(
    (
      await db.query("SELECT item_id FROM item_embeddings WHERE owner=$1", [
        owner,
      ])
    ).rows.length,
    0,
  );
  await library.searchIndexer.enqueue(owner, scope, epoch);
  await assert.rejects(
    indexSearchBatch(
      db,
      {
        ...searchProvider(),
        async embed(texts) {
          await library.setPreferences(owner, { aiSearchEnabled: false });
          await library.setPreferences(owner, { aiSearchEnabled: true });
          return searchProvider().embed(texts);
        },
      },
      owner,
      scope,
      epoch,
    ),
    errorCode("AI_DISABLED"),
  );
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
});

test("worker backs off on provider failures and recovers expired leases without dropping progress", async () => {
  const owner = randomUUID();
  await db.query(
    "INSERT INTO users(id,singleton,password_hash,ai_search_enabled) VALUES($1,NULL,'synthetic',true)",
    [owner],
  );
  const library = new Library(db, searchProvider());
  await library.save(owner, {
    requestId: randomUUID(),
    title: "topic-3",
    source: { originalText: "topic-3" },
  });
  await library.searchIndexer.enqueue(owner, scope, 0);
  let fail = true,
    calls = 0;
  const worker = new SearchIndexer(db, async (_owner, run) =>
    run({
      ...searchProvider(),
      async embed(texts) {
        calls++;
        if (fail)
          throw new AppError(502, "AI_FAILED", "Synthetic provider failure");
        return searchProvider().embed(texts);
      },
    }),
  );
  try {
    await worker.tick();
    await worker.tick();
    assert.equal(calls, 1);
    await db.query(
      "UPDATE search_index_jobs SET retry_at=clock_timestamp()-interval '1 second',lease_token=$2,locked_until=clock_timestamp()-interval '1 second' WHERE owner=$1",
      [owner, randomUUID()],
    );
    fail = false;
    await worker.tick();
    assert.deepEqual(await searchIndexStatus(db, owner, scope), {
      total: 1,
      indexed: 1,
      pending: 0,
    });
    assert.equal(
      (
        await db.query("SELECT owner FROM search_index_jobs WHERE owner=$1", [
          owner,
        ])
      ).rows.length,
      0,
    );
  } finally {
    await worker.close();
  }
});

test("legacy cache reuse avoids new document uploads; invalid provider vectors cannot enter pgvector", async () => {
  const owner = randomUUID();
  await db.query(
    "INSERT INTO users(id,singleton,password_hash,ai_search_enabled) VALUES($1,NULL,'synthetic',true)",
    [owner],
  );
  const library = new Library(db, searchProvider());
  const saved = await library.save(owner, {
    requestId: randomUUID(),
    title: "topic-3",
    source: { originalText: "topic-3" },
  });
  await indexSearchBatch(db, searchProvider(), owner, scope, 0);
  await db.query(
    "UPDATE item_embeddings SET embedding=NULL,indexed_revision=NULL WHERE owner=$1",
    [owner],
  );
  await indexSearchBatch(
    db,
    searchProvider(() => assert.fail("unchanged legacy text was sent again")),
    owner,
    scope,
    0,
  );
  assert.deepEqual(await searchIndexStatus(db, owner, scope), {
    total: 1,
    indexed: 1,
    pending: 0,
  });
  await library.update(owner, {
    id: saved.item.id,
    revision: 1,
    title: "Changed",
  });
  await assert.rejects(
    indexSearchBatch(
      db,
      {
        ...searchProvider(),
        async embed() {
          return [[0]];
        },
      },
      owner,
      scope,
      0,
    ),
    errorCode("AI_FAILED"),
  );
  assert.equal(
    (
      await db.query(
        "SELECT item_id FROM item_embeddings WHERE owner=$1 AND model=$2",
        [owner, embeddingVersion],
      )
    ).rows.length,
    0,
  );
  for (const value of [1e308, 1e-308, Number.MIN_VALUE]) {
    const normalized = normalizedVector(
      Array.from({ length: 512 }, (_, index) => (index === 0 ? value : 0)),
    );
    assert.equal(normalized[0], 1);
  }
});

test("indexed literal search preserves punctuation, long sources, edits, and source updates", async () => {
  const owner = randomUUID();
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,'synthetic')",
    [owner],
  );
  const library = new Library(db, searchProvider());
  const saved = await library.save(owner, {
    requestId: randomUUID(),
    title: "100% source_one !bang \\slash",
    source: { originalText: "x".repeat(7000) + " unique_long_source_match" },
  });
  for (const query of ["%", "_", "!", "\\", "unique_long_source_match"])
    assert.equal(
      (await library.search(owner, { query, mode: "keyword" })).total,
      1,
    );
  assert.equal(
    (await library.search(owner, { query: "not_present", mode: "keyword" }))
      .total,
    0,
  );
  await library.update(owner, {
    id: saved.item.id,
    revision: 1,
    title: "Replaced",
    reviewedTranscription: "corrected_transcription",
  });
  assert.equal(
    (await library.search(owner, { query: "%", mode: "keyword" })).total,
    0,
  );
  assert.equal(
    (
      await library.search(owner, {
        query: "unique_long_source_match",
        mode: "keyword",
      })
    ).total,
    0,
  );
  assert.equal(
    (
      await library.search(owner, {
        query: "corrected_transcription",
        mode: "keyword",
      })
    ).total,
    1,
  );
  await db.query(
    "UPDATE sources SET url='https://example.com/refreshed_source_marker' WHERE owner=$1 AND id=$2",
    [owner, saved.source.id],
  );
  assert.equal(
    (
      await library.search(owner, {
        query: "refreshed_source_marker",
        mode: "keyword",
      })
    ).total,
    1,
  );
  await library.setPreferences(owner, { aiSearchEnabled: true });
  const permission = await db.query<{ epoch: number }>(
    "SELECT ai_search_epoch AS epoch FROM users WHERE id=$1",
    [owner],
  );
  await indexSearchBatch(
    db,
    searchProvider(),
    owner,
    scope,
    permission.rows[0].epoch,
  );
  await db.query(
    "UPDATE sources SET page_snapshot=$3::jsonb WHERE owner=$1 AND id=$2",
    [
      owner,
      saved.source.id,
      JSON.stringify({ text: "new_page_snapshot_marker" }),
    ],
  );
  assert.equal(
    (
      await library.search(owner, {
        query: "new_page_snapshot_marker",
        mode: "keyword",
      })
    ).total,
    1,
  );
  assert.equal(
    (
      await db.query("SELECT item_id FROM item_embeddings WHERE owner=$1", [
        owner,
      ])
    ).rows.length,
    0,
  );
});

test("an existing search refreshes indexed matches while background embedding is busy", async () => {
  const { owner } = await seedSearchLibrary(db, 40);
  let hold = false,
    entered = () => {},
    release = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = {
    ...searchProvider(),
    async embed(texts: string[]) {
      if (hold) {
        entered();
        await gate;
      }
      return searchProvider().embed(texts);
    },
  };
  const library = new Library(db, provider);
  await library.setPreferences(owner, { aiSearchEnabled: true });
  const first = await library.search(owner, { query: "herbs" });
  assert.equal(first.searchIndex?.pending, 8);
  hold = true;
  const indexing = library.searchIndexer.tick();
  await started;
  try {
    const refresh = await library.search(owner, { query: "herbs" });
    assert.equal(refresh.mode, "hybrid");
    assert.equal(refresh.total, first.total);
    assert.equal(refresh.searchIndex?.pending, 8);
    assert.match(refresh.searchNotice ?? "", /background/);
    await library.setPreferences(owner, { aiSearchEnabled: false });
    assert.equal(
      (await library.search(owner, { query: "herbs" })).mode,
      "keyword",
    );
  } finally {
    release();
    await indexing;
    await library.searchIndexer.close();
  }
});
