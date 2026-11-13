import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate, type Database } from "../server/db.js";
import { Library } from "../server/library.js";
import { AppError } from "../server/errors.js";
import type { DraftContext, AIProvider } from "../server/ai.js";
import { Portability } from "../server/portability.js";
import { cleanupExpired } from "../server/maintenance.js";

let dir: string, db: Database;
const owner = randomUUID(),
  other = randomUUID();
const contexts: DraftContext[] = [];
const ai: AIProvider = {
  async draft(context) {
    contexts.push(context);
    return {
      title: "Article suggestion",
      summary: "A factual summary",
      category: "Reading",
      tags: ["docs"],
      extractedText: "",
      sourceUrl: "",
    };
  },
  async embed() {
    return [];
  },
};
const snapshot = (url: string) => ({
  provider: "firecrawl" as const,
  requestedUrl: url,
  finalUrl: url.split("#")[0],
  capturedAt: new Date().toISOString(),
  title: "Article",
  description: "A description",
  text: "UniqueSnapshotNeedle factual documentation. <script>untrusted()</script>",
  truncated: false,
});
const extractor = {
  async extract(url: string) {
    return snapshot(url);
  },
};
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "drop-it-pages-"));
  db = await openDatabase({ dataDir: dir });
  await migrate(db);
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$3),($2,NULL,$3)",
    [owner, other, "synthetic"],
  );
});
after(async () => {
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});
test("retrieval drafts without saving, preserves originals, isolates owners and indexes a separate immutable snapshot", async () => {
  const library = new Library(db, ai, {}, undefined, extractor);
  const source = {
    url: "https://example.org/article#selection",
    originalText: "Exact selected text\n",
  };
  const result = await library.draft(owner, { source, fetchPage: true });
  assert.ok(result.retrieval);
  assert.equal((await library.search(owner, {})).total, 0);
  assert.equal(contexts.at(-1)?.text, source.originalText);
  assert.equal(contexts.at(-1)?.page?.text, snapshot(source.url).text);
  const input = {
    ...result.draft,
    requestId: randomUUID(),
    title: "My edited title",
    notes: "Personal note",
    source: { ...source, retrievalId: result.retrieval.id },
  };
  const { extractedText: _text, sourceUrl: _url, ...fields } = input;
  void _text;
  void _url;
  await assert.rejects(library.save(other, fields), { code: "PAGE_EXPIRED" });
  await assert.rejects(
    library.save(owner, {
      ...fields,
      source: { ...fields.source, url: "https://example.org/different" },
    }),
    { code: "PAGE_EXPIRED" },
  );
  const saved = await library.save(owner, fields);
  assert.equal(saved.source.originalText, source.originalText);
  assert.equal(saved.source.url, source.url);
  assert.equal(saved.source.pageSnapshot?.text, snapshot(source.url).text);
  assert.equal(saved.item.notes, "Personal note");
  await library.update(owner, {
    id: saved.item.id,
    revision: 1,
    summary: "Changed",
    reviewedTranscription: "Reviewed selected text",
  });
  assert.deepEqual(
    (await library.get(owner, saved.item.id)).source,
    saved.source,
  );
  assert.equal(
    (
      await library.search(owner, {
        query: "UniqueSnapshotNeedle",
        mode: "keyword",
      })
    ).total,
    1,
  );
  assert.equal(
    (
      await library.search(other, {
        query: "UniqueSnapshotNeedle",
        mode: "keyword",
      })
    ).total,
    0,
  );
  assert.equal((await library.save(owner, fields)).item.id, saved.item.id);
  await assert.rejects(
    library.save(owner, { ...fields, requestId: randomUUID() }),
    { code: "DUPLICATE" },
  );
  assert.equal(
    (
      await library.save(owner, {
        ...fields,
        requestId: randomUUID(),
        allowDuplicate: true,
      })
    ).source.pageSnapshot?.text,
    snapshot(source.url).text,
  );
});
test("missing credentials and retrieval/AI failures preserve manual URL capture and never fetch files implicitly", async () => {
  for (const library of [
    new Library(db),
    new Library(db, undefined, {}, undefined, {
      async extract() {
        throw new AppError(
          429,
          "PAGE_LIMIT",
          "Usage exhausted. Save manually.",
        );
      },
    }),
  ]) {
    const source = {
      url: `https://example.org/${randomUUID()}`,
      originalText: "Selected text",
    };
    const result = await library.draft(owner, { source, fetchPage: true });
    assert.ok(result.retrievalNotice);
    assert.equal(result.draftNotice, undefined);
    assert.equal(result.retrieval, undefined);
    const saved = await library.save(owner, {
      title: "Manual",
      requestId: randomUUID(),
      source,
    });
    assert.equal(saved.source.originalText, source.originalText);
  }
  const noAI = new Library(db, undefined, {}, undefined, extractor);
  const r = await noAI.draft(other, {
    source: { url: "https://example.org/no-ai" },
    fetchPage: true,
  });
  assert.ok(r.retrieval);
  assert.ok(r.draftNotice);
  const library = new Library(db, ai, {}, undefined, {
    async extract() {
      throw new Error("Must not fetch automatically");
    },
  });
  await library.draft(owner, { source: { url: "https://example.org/manual" } });
  const previous = contexts.length;
  const rejected = await new Library(db, ai, {}, undefined, extractor).draft(
    owner,
    {
      source: { url: "https://example.org/?token=synthetic-secret" },
      fetchPage: true,
    },
  );
  assert.ok(rejected.retrievalNotice);
  assert.equal(
    contexts.length,
    previous,
    "Rejected retrieval must not call AI with a sensitive URL",
  );
  await assert.rejects(
    library.draft(owner, {
      source: { url: "https://example.org/file", attachmentId: randomUUID() },
      fetchPage: true,
    }),
    { code: "PAGE_INPUT" },
  );
});
test("expired references reject new saves but preserve successful retries; extraction admission is bounded", async () => {
  const fresh = randomUUID();
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,'synthetic')",
    [fresh],
  );
  const library = new Library(db, ai, {}, undefined, extractor);
  const source = { url: "https://example.org/retry" };
  const r = await library.draft(fresh, { source, fetchPage: true });
  assert.ok(r.retrieval);
  const input = {
    requestId: randomUUID(),
    title: "Retry",
    source: { ...source, retrievalId: r.retrieval.id },
  };
  const saved = await library.save(fresh, input);
  await db.query(
    "UPDATE page_captures SET created_at=now()-interval '25 hours' WHERE id=$1",
    [r.retrieval.id],
  );
  assert.equal((await library.save(fresh, input)).item.id, saved.item.id);
  await assert.rejects(
    library.save(fresh, {
      ...input,
      requestId: randomUUID(),
      allowDuplicate: true,
    }),
    { code: "PAGE_EXPIRED" },
  );
  for (let i = 0; i < 5; i++)
    assert.ok(
      (
        await library.draft(fresh, {
          source: { url: `https://example.org/limit${i}` },
          fetchPage: true,
        })
      ).retrieval,
    );
  assert.match(
    (
      await library.draft(fresh, {
        source: { url: "https://example.org/blocked" },
        fetchPage: true,
      })
    ).retrievalNotice ?? "",
    /usage limit/,
  );
});
test("portable backup retains the fetched snapshot separately from user source text", async () => {
  const portability = new Portability(db, new Library(db).limits);
  try {
    const lines: string[] = [];
    await portability.export(owner, async (line) => {
      lines.push(line);
    });
    const archive = lines.join("");
    const record = archive
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((row) => row.type === "source" && row.value.pageSnapshot);
    assert.equal(record.value.originalText, "Exact selected text\n");
    const target = randomUUID();
    await db.query(
      "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,'synthetic')",
      [target],
    );
    const input = async function* () {
      yield Buffer.from(archive);
    };
    const preview = await portability.preview(target, input(), "ndjson");
    await portability.apply(target, {
      previewId: preview.previewId,
      requestId: preview.requestId,
      confirm: true,
    });
    const library = new Library(db);
    const results = await library.search(target, {
      query: "UniqueSnapshotNeedle",
      mode: "keyword",
    });
    assert.equal(results.total, 2);
    assert.deepEqual(
      (await library.get(target, results.items[0].id)).source.pageSnapshot,
      record.value.pageSnapshot,
    );
  } finally {
    await portability.close();
  }
});

test("concurrency and durable daily budgets bound retrieval, release failures, and clean expired pending captures", async () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids)
    await db.query(
      "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,'synthetic')",
      [id],
    );
  let started = 0;
  const resolvers: Array<() => void> = [];
  const library = new Library(db, undefined, {}, undefined, {
    async extract(url) {
      started++;
      await new Promise<void>((resolve) => resolvers.push(resolve));
      return snapshot(url);
    },
  });
  const capture = (id: string) =>
    library.draft(id, {
      source: { url: "https://example.org/concurrent" },
      fetchPage: true,
    });
  const first = capture(ids[0]),
    second = capture(ids[1]);
  // Admission is asynchronous; wait for the actual provider seam to begin.
  while (started < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.match((await capture(ids[0])).retrievalNotice ?? "", /busy/);
  assert.match((await capture(ids[2])).retrievalNotice ?? "", /busy/);
  resolvers.forEach((resolve) => resolve());
  assert.ok((await first).retrieval);
  assert.ok((await second).retrieval);
  await db.query(
    "INSERT INTO page_captures(id,owner,url,created_at) SELECT gen_random_uuid(),$1,'https://example.org/old',now()-interval '1 hour' FROM generate_series(1,30)",
    [ids[2]],
  );
  const restarted = new Library(db, undefined, {}, undefined, extractor);
  assert.match(
    (
      await restarted.draft(ids[2], {
        source: { url: "https://example.org/daily" },
        fetchPage: true,
      })
    ).retrievalNotice ?? "",
    /usage limit/,
  );
  await db.query(
    "UPDATE page_captures SET created_at=now()-interval '25 hours' WHERE owner=ANY($1::uuid[])",
    [ids],
  );
  await cleanupExpired(db);
  assert.equal(
    (
      await db.query(
        "SELECT id FROM page_captures WHERE owner=ANY($1::uuid[])",
        [ids],
      )
    ).rows.length,
    0,
  );
});
