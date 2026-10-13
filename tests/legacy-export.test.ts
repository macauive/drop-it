import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  migrate,
  openDatabase,
  type Database,
  type Queryable,
} from "../server/db.js";
import { AppError } from "../server/errors.js";
import { Library } from "../server/library.js";
import { Portability } from "../server/portability.js";
import { exportLibrary } from "./legacy-export-fixture.js";

let directory: string, db: Database, library: Library;
const fileChunkBytes = 65535;
const fixtureLimit = 16 * 1024 * 1024;
const legacyLimit = 384 * 1024 * 1024;
const syntheticPassword = "synthetic-unusable-legacy-export-password-hash";

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "drop-it-legacy-export-"));
  db = await openDatabase({ dataDir: directory });
  await migrate(db);
  library = new Library(db);
});
after(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const newOwner = async () => {
  const id = randomUUID();
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$2)",
    [id, syntheticPassword],
  );
  return id;
};
const saveSource = (owner: string, title: string, attachmentId?: string) =>
  library.save(owner, {
    requestId: randomUUID(),
    title,
    allowDuplicate: true,
    source: {
      originalText: `Synthetic original for ${title}`,
      ...(attachmentId ? { attachmentId } : {}),
    },
  });
const errorCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;

type QueryEvent = { sql: string; params: unknown[]; rows: unknown[] };
type QueryHooks = {
  before?: (sql: string, params: unknown[]) => void;
  after?: (event: QueryEvent) => unknown[] | void;
};
const observedDatabase = (hooks: QueryHooks): Database => {
  const wrap = (target: Queryable): Queryable => ({
    query: async <T>(sql: string, params: unknown[] = []) => {
      hooks.before?.(sql, params);
      const result = await target.query<T>(sql, params);
      const replacement = hooks.after?.({ sql, params, rows: result.rows });
      return { rows: (replacement ?? result.rows) as T[] };
    },
  });
  return {
    ...wrap(db),
    transaction: (run) => db.transaction((tx) => run(wrap(tx))),
    close: () => db.close(),
  };
};

// Reject whole-file SELECTs before executing them, so this regression also
// fails safely against the previous buffered implementation.
const assertBoundedFileSelect = (sql: string) => {
  if (!/\bselect\b/i.test(sql) || !/\b(?:from|join)\s+attachments\b/i.test(sql))
    return;
  const expressions = sql
    .replace(/\boctet_length\s*\(\s*(?:\w+\.)?bytes\s*\)/gi, "file_length")
    .replace(
      /\bsubstring\s*\(\s*(?:\w+\.)?bytes\s+from\s+[^)]*\)/gi,
      "file_fragment",
    )
    .replace(/\bas\s+"?bytes"?\b/gi, "");
  assert.equal(
    /\b(?:\w+\.)?bytes\b/i.test(expressions),
    false,
    "export must not select an entire attachment body",
  );
  assert.equal(
    /\bselect\s+(?:\w+\.)?\*/i.test(expressions),
    false,
    "export must not select attachment bodies through a wildcard",
  );
};
const isFileRead = (sql: string) =>
  /\bsubstring\s*\(\s*(?:\w+\.)?bytes\b/i.test(sql);
const partialOutput = () => {
  const chunks: string[] = [];
  let bytes = 0;
  return {
    chunks,
    write: async (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      assert.ok(
        bytes <= fixtureLimit,
        "partial synthetic export stays bounded",
      );
      chunks.push(chunk);
    },
    assertIncomplete: () =>
      assert.throws(() => JSON.parse(chunks.join("")), SyntaxError),
  };
};

test("legacy JSON streams an accepted amplified archive with bounded reads and writes, and preflights larger archives", async () => {
  const owner = await newOwner();
  const original = await sharp(randomBytes(1024 * 1024 * 3), {
    raw: { width: 1024, height: 1024, channels: 3 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  assert.ok(original.length > 3 * 1024 * 1024);
  const uploaded = await library.upload(
    owner,
    original,
    "image/png",
    "synthetic-noise.png",
  );
  for (let index = 0; index < 90; index++)
    await saveSource(owner, `Amplified source ${index}`, uploaded.attachmentId);

  let reads = 0,
    returnedBytes = 0,
    writes = 0,
    emittedBytes = 0;
  let tail = "";
  const bounded = new Library(
    observedDatabase({
      before: (sql, params) => {
        assertBoundedFileSelect(sql);
        if (!isFileRead(sql)) return;
        reads++;
        assert.ok(
          params.includes(owner),
          "file read carries the authenticated owner",
        );
        assert.ok(params.includes(uploaded.attachmentId));
        const lengthParameter = /\bfor\s+\$(\d+)/i.exec(sql);
        assert.ok(
          lengthParameter,
          "file read has an explicit parameterized length",
        );
        const length = params[Number(lengthParameter[1]) - 1];
        assert.ok(
          typeof length === "number" && length > 0 && length <= fileChunkBytes,
        );
      },
      after: ({ sql, rows }) => {
        if (!isFileRead(sql)) return;
        assert.equal(rows.length, 1);
        const fragment = (rows[0] as { bytes: Uint8Array }).bytes;
        assert.ok(fragment.length > 0 && fragment.length <= fileChunkBytes);
        returnedBytes += fragment.length;
      },
    }),
  );
  await bounded.export(owner, async (chunk) => {
    writes++;
    const bytes = Buffer.byteLength(chunk);
    assert.ok(
      bytes <= Math.ceil(fileChunkBytes / 3) * 4,
      "the writer never receives a full source or archive body",
    );
    emittedBytes += bytes;
    assert.ok(emittedBytes < legacyLimit);
    tail = (tail + chunk).slice(-64);
  });
  assert.equal(reads, 90 * Math.ceil(original.length / fileChunkBytes));
  assert.equal(returnedBytes, 90 * original.length);
  assert.ok(writes > reads);
  assert.ok(emittedBytes > 300 * 1024 * 1024);
  assert.ok(emittedBytes < legacyLimit);
  assert.ok(tail.endsWith("]}"));

  for (let index = 90; index < 100; index++)
    await saveSource(owner, `Amplified source ${index}`, uploaded.attachmentId);
  reads = 0;
  writes = 0;
  await assert.rejects(
    bounded.export(owner, async () => {
      writes++;
    }),
    errorCode("EXPORT_SIZE"),
  );
  assert.equal(reads, 0, "oversized archives are rejected before file reads");
  assert.equal(
    writes,
    0,
    "oversized archives are rejected before response bytes",
  );
});

test("small legacy JSON preserves escaped metadata, original bytes and MIME/null conventions through import", async () => {
  const from = await newOwner(),
    to = await newOwner(),
    other = await newOwner();
  const imageBytes = await sharp({
    create: { width: 3, height: 3, channels: 3, background: "#527cab" },
  })
    .png()
    .toBuffer();
  const textBytes = Buffer.from(
    'Synthetic 🧪漢字, "quoted" \\ text\nsecond line\tvalue',
  );
  const image = await library.upload(
    from,
    imageBytes,
    "image/png",
    'image "quoted".png',
  );
  const text = await library.upload(
    from,
    textBytes,
    "text/plain",
    'text "quoted".txt',
  );
  const saved = await library.save(from, {
    requestId: randomUUID(),
    title: 'A "quoted" \\ title 🧪',
    summary: 'Summary with "quotes"\nand a second line',
    notes: "A note\twith a tab, \\ and 漢字",
    tags: ['quoted "tag"'],
    source: {
      originalText: 'Original "source"\nwith \\ and 🧪',
      attachmentId: text.attachmentId,
    },
  });
  await library.update(from, {
    id: saved.item.id,
    revision: saved.item.revision,
    isSaved: true,
    reviewedTranscription: 'Reviewed "source"\n漢字',
  });
  const imageItem = await saveSource(
    from,
    "Synthetic image item",
    image.attachmentId,
  );
  const plainItem = await saveSource(from, "Synthetic item without file");
  await saveSource(other, "Other owner sentinel");
  const archive = await exportLibrary(library, from);
  assert.equal(archive.version, 2);
  assert.deepEqual(
    new Set(archive.items.map((item) => item.id)),
    new Set([saved.item.id, imageItem.item.id, plainItem.item.id]),
  );
  const textSource = archive.sources.find(
    (source) => source.id === saved.source.id,
  )!;
  const imageSource = archive.sources.find(
    (source) => source.id === imageItem.source.id,
  )!;
  const plainSource = archive.sources.find(
    (source) => source.id === plainItem.source.id,
  )!;
  assert.deepEqual(
    [textSource.mime, textSource.filename, textSource.imageBase64],
    ["text/plain", 'text "quoted".txt', null],
  );
  assert.deepEqual(Buffer.from(textSource.fileBase64!, "base64"), textBytes);
  assert.deepEqual(
    [imageSource.mime, imageSource.filename, imageSource.fileBase64],
    ["image/png", 'image "quoted".png', null],
  );
  assert.deepEqual(Buffer.from(imageSource.imageBase64!, "base64"), imageBytes);
  assert.deepEqual(
    [
      plainSource.filename,
      plainSource.mime,
      plainSource.imageBase64,
      plainSource.fileBase64,
    ],
    [null, null, null, null],
  );
  const encoded = JSON.stringify(archive);
  assert.equal(encoded.includes(syntheticPassword), false);
  assert.equal(encoded.includes("Other owner sentinel"), false);
  for (const record of [...archive.items, ...archive.sources])
    assert.equal(
      Object.keys(record).some((key) =>
        /owner|password|recovery|token|secret|credential|cursor/i.test(key),
      ),
      false,
      "archive records exclude ownership and credential columns",
    );

  const portability = new Portability(db);
  try {
    const input = async function* () {
      const bytes = Buffer.from(encoded);
      for (let offset = 0; offset < bytes.length; offset += 37)
        yield bytes.subarray(offset, offset + 37);
    };
    const preview = await portability.preview(to, input(), "json");
    assert.deepEqual(
      [preview.version, preview.items, preview.sources, preview.files],
      [2, 3, 3, 2],
    );
    await portability.apply(to, {
      previewId: preview.previewId,
      requestId: preview.requestId,
      confirm: true,
    });
    const imported = await library.search(to, { mode: "keyword", limit: 10 });
    const restored = await library.get(
      to,
      imported.items.find((item) => item.title === saved.item.title)!.id,
    );
    assert.equal(restored.item.title, saved.item.title);
    assert.equal(restored.item.summary, saved.item.summary);
    assert.equal(restored.item.notes, saved.item.notes);
    assert.deepEqual(restored.item.tags, saved.item.tags);
    assert.equal(
      restored.item.reviewedTranscription,
      'Reviewed "source"\n漢字',
    );
    assert.equal(restored.item.isSaved, true);
    assert.equal(restored.source.originalText, saved.source.originalText);
    assert.deepEqual(
      (await library.file(to, restored.source.id)).bytes,
      textBytes,
    );
    const restoredImage = imported.items.find(
      (item) => item.title === imageItem.item.title,
    )!;
    assert.deepEqual(
      (await library.image(to, restoredImage.sourceId)).bytes,
      imageBytes,
    );
    await assert.rejects(
      library.get(other, restored.item.id),
      errorCode("NOT_FOUND"),
    );
  } finally {
    await portability.close();
  }
});

test("legacy base64 fragments preserve multibyte text for every final byte remainder", async () => {
  const owner = await newOwner();
  const expected = new Map<string, Buffer>();
  for (const remainder of [0, 1, 2]) {
    const text = "漢".repeat(22000) + "x".repeat(remainder);
    const bytes = Buffer.from(text);
    assert.ok(text.length < 50000 && bytes.length > fileChunkBytes);
    assert.equal(bytes.length % 3, remainder);
    const uploaded = await library.upload(
      owner,
      bytes,
      "text/plain",
      `remainder-${remainder}.txt`,
    );
    const saved = await saveSource(
      owner,
      `Remainder ${remainder}`,
      uploaded.attachmentId,
    );
    expected.set(saved.source.id, bytes);
  }
  let reads = 0;
  const exporter = new Library(
    observedDatabase({
      before: (sql) => {
        assertBoundedFileSelect(sql);
        if (isFileRead(sql)) reads++;
      },
    }),
  );
  const archive = await exportLibrary(exporter, owner);
  assert.equal(reads, 6, "each original crosses the file read boundary");
  for (const source of archive.sources) {
    const bytes = expected.get(source.id)!;
    assert.equal(source.imageBase64, null);
    assert.equal(source.mime, "text/plain");
    assert.equal(source.fileBase64, bytes.toString("base64"));
    assert.deepEqual(Buffer.from(source.fileBase64!, "base64"), bytes);
  }
});

test("legacy metadata paging preserves every item at identical microsecond timestamps and every source", async () => {
  const owner = await newOwner();
  const timestamp = "2026-10-13T01:02:03.123456Z";
  await db.query(
    `INSERT INTO sources(id,owner,original_text,url,fingerprint,created_at)
    SELECT gen_random_uuid(),$1,'Synthetic paged source '||n,'','synthetic-page-'||n,$2::timestamptz
    FROM generate_series(1,110) n`,
    [owner, timestamp],
  );
  await db.query(
    `WITH indexed AS (
      SELECT id,row_number() OVER(ORDER BY id) AS ordinal FROM sources WHERE owner=$1
    ) INSERT INTO items(id,owner,source_id,title,summary,category,tags,notes,created_at,updated_at)
    SELECT gen_random_uuid(),$1,id,'Paged item '||ordinal||' copy '||copy,'','Other','{}'::text[],'',$2::timestamptz,$2::timestamptz
    FROM indexed CROSS JOIN generate_series(1,2) copy WHERE copy=1 OR ordinal<=105`,
    [owner, timestamp],
  );
  const expectedItems = await db.query<{ id: string }>(
    "SELECT id FROM items WHERE owner=$1 ORDER BY created_at,id",
    [owner],
  );
  const expectedSources = await db.query<{ id: string }>(
    "SELECT id FROM sources WHERE owner=$1 ORDER BY id",
    [owner],
  );
  let itemPages = 0,
    sourcePages = 0,
    writes = 0;
  const exporter = new Library(
    observedDatabase({
      after: ({ rows }) => {
        if (!rows.length || typeof rows[0] !== "object" || rows[0] === null)
          return;
        if ("sourceId" in rows[0]) {
          itemPages++;
          assert.ok(rows.length <= 100, "item metadata pages stay bounded");
        } else if ("originalText" in rows[0]) {
          sourcePages++;
          assert.ok(rows.length <= 100, "source metadata pages stay bounded");
        }
      },
    }),
  );
  const stream = exporter.export.bind(exporter);
  exporter.export = (id, write, signal) =>
    stream(
      id,
      async (chunk) => {
        assert.ok(
          ++writes <= 1000,
          "pagination must advance instead of re-emitting a rounded cursor page",
        );
        await write(chunk);
      },
      signal,
    );
  const archive = await exportLibrary(exporter, owner);
  assert.equal(archive.items.length, 215);
  assert.equal(archive.sources.length, 110);
  assert.deepEqual(
    archive.items.map((item) => item.id),
    expectedItems.rows.map((item) => item.id),
  );
  assert.deepEqual(
    archive.sources.map((source) => source.id),
    expectedSources.rows.map((source) => source.id),
  );
  assert.equal(new Set(archive.items.map((item) => item.id)).size, 215);
  assert.equal(new Set(archive.sources.map((source) => source.id)).size, 110);
  assert.equal(itemPages, 3);
  assert.equal(sourcePages, 2);
});

test("legacy export waits for the writer before fetching subsequent metadata", async () => {
  const owner = await newOwner();
  await saveSource(owner, "Synthetic backpressure item");
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstWrite = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let metadataReads = 0,
    writes = 0;
  const exporter = new Library(
    observedDatabase({
      after: ({ rows }) => {
        if (
          rows.some(
            (row) =>
              typeof row === "object" &&
              row !== null &&
              ("sourceId" in row || "originalText" in row),
          )
        )
          metadataReads++;
      },
    }),
  );
  const pending = exporter.export(owner, async () => {
    if (++writes === 1) {
      entered();
      await blocked;
    }
  });
  try {
    await firstWrite;
    assert.equal(
      metadataReads,
      0,
      "the blocked writer prevents later metadata reads",
    );
    assert.equal(writes, 1);
  } finally {
    release();
  }
  await pending;
  assert.ok(metadataReads > 0);
});

test("legacy export aborts before queries and stops file reads and writes during a stream", async () => {
  const owner = await newOwner();
  const uploaded = await library.upload(
    owner,
    Buffer.from("漢".repeat(22000)),
    "text/plain",
    "abort.txt",
  );
  await saveSource(owner, "Synthetic aborted source", uploaded.attachmentId);
  let queries = 0,
    reads = 0,
    writes = 0;
  const exporter = new Library(
    observedDatabase({
      before: (sql) => {
        queries++;
        if (isFileRead(sql)) reads++;
      },
    }),
  );
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    exporter.export(
      owner,
      async () => {
        writes++;
      },
      alreadyAborted.signal,
    ),
  );
  assert.equal(queries, 0);
  assert.equal(writes, 0);

  const controller = new AbortController();
  const output = partialOutput();
  let writesAtAbort = 0;
  await assert.rejects(
    exporter.export(
      owner,
      async (chunk) => {
        writes++;
        await output.write(chunk);
        if (reads === 1) {
          writesAtAbort = writes;
          controller.abort();
        }
      },
      controller.signal,
    ),
  );
  assert.equal(reads, 1, "abort stops the next file fragment read");
  assert.equal(writes, writesAtAbort, "abort stops all later writer calls");
  output.assertIncomplete();
  assert.equal(
    (await exportLibrary(exporter, owner)).sources.length,
    1,
    "a failed export leaves the database usable",
  );
});

test("legacy export rejects malformed, truncated and hash-corrupt originals without completing JSON", async () => {
  for (const fault of ["malformed", "truncated", "hash"] as const) {
    const owner = await newOwner();
    const bytes = Buffer.from("Synthetic integrity fixture 🧪 ".repeat(10));
    const uploaded = await library.upload(
      owner,
      bytes,
      "text/plain",
      `integrity-${fault}.txt`,
    );
    await saveSource(
      owner,
      `Synthetic ${fault} original`,
      uploaded.attachmentId,
    );
    if (fault === "malformed")
      await db.query(
        "UPDATE attachments SET bytes=$3 WHERE owner=$1 AND id=$2",
        [owner, uploaded.attachmentId, Buffer.alloc(0)],
      );
    if (fault === "hash")
      await db.query(
        "UPDATE attachments SET digest=$3 WHERE owner=$1 AND id=$2",
        [owner, uploaded.attachmentId, "0".repeat(64)],
      );
    let reads = 0;
    const exporter = new Library(
      observedDatabase({
        before: (sql) => {
          assertBoundedFileSelect(sql);
          if (isFileRead(sql)) reads++;
        },
        after: ({ sql, rows }) => {
          if (fault !== "truncated" || !isFileRead(sql)) return;
          const row = rows[0] as { bytes: Uint8Array };
          return [
            { ...row, bytes: row.bytes.subarray(0, row.bytes.length - 1) },
          ];
        },
      }),
    );
    const output = partialOutput();
    await assert.rejects(
      exporter.export(owner, output.write),
      errorCode("EXPORT_INTEGRITY"),
    );
    assert.equal(reads, fault === "malformed" ? 0 : 1);
    output.assertIncomplete();
  }
});
